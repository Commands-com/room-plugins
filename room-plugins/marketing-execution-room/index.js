// ---------------------------------------------------------------------------
// Marketing Execution Room plugin — entry file.
//
// Deconstructed layout:
//   manifest        — manifest.json loader
//   constants       — phases + text limits
//   utils           — generic trimming / markdown helpers
//   execution-model — project scan, handoff parsing, asset collection
//   state           — config parsing, round bookkeeping, initial state
//   prompts         — prompt templates + phase target builders
//   metrics         — dashboard/report metric emitters
//   final-report    — marketing_execution_bundle.v1 assembly
//   phase-flow      — decision issuance and phase transitions
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import path from 'node:path';

import { manifest } from './manifest.js';
import { PHASES } from './constants.js';
import {
  continueFromCollectedResponses,
  issuePhaseDecision,
  stopForMissingPaths,
  stopForMissingRoles,
} from './phase-flow.js';
import { seedSummaryFile } from './execution-model.js';
import { buildBundle } from './final-report.js';
import { emitMetrics } from './metrics.js';
import { buildPendingTargetsForPhase } from './prompts.js';
import {
  appendFeed,
  createInitialState,
  ensureRound,
  getPhaseResponses,
  mergeResponsesIntoRound,
  updateAgentStatuses,
  upsertRoundResponse,
} from './state.js';

function createPlugin() {
  return {
    init(ctx) {
      const state = createInitialState(ctx, manifest);
      ctx.setState(state);
      emitMetrics(ctx, state);
    },

    onRoomStart(ctx) {
      const state = ctx.getState() || createInitialState(ctx, manifest);
      if (state.missingRoles.length > 0) return stopForMissingRoles(ctx, state);
      const missingPathsDecision = stopForMissingPaths(ctx, state);
      if (missingPathsDecision) return missingPathsDecision;
      seedSummaryFile(state);
      return issuePhaseDecision(ctx, state, PHASES.WRITE);
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState() || createInitialState(ctx, manifest);
      mergeResponsesIntoRound(state, state.phase, responses);
      if (state.phase === PHASES.WRITE || state.phase === PHASES.REVIEW || state.phase === PHASES.REVISE) {
        return continueFromCollectedResponses(ctx, state);
      }
      appendFeed(state, `Unexpected fan-out completion while in phase "${state.phase}".`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return { type: 'stop', reason: `unexpected_fan_out_phase:${state.phase}` };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState() || createInitialState(ctx, manifest);
      appendFeed(state, `Received unexpected single-turn response from ${turnResult?.agentId || 'unknown agent'}.`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return { type: 'stop', reason: 'unexpected_single_turn' };
    },

    onEvent(ctx, event) {
      const state = ctx.getState() || createInitialState(ctx, manifest);
      if (event?.type === 'fan_out_partial' && event.agentId) {
        if (event.progress?.completedAgentIds) updateAgentStatuses(state, event.progress.completedAgentIds, 'submitted');
        if (event.progress?.pendingAgentIds) updateAgentStatuses(state, event.progress.pendingAgentIds, 'assigned');
        state.agentStatus[event.agentId] = 'submitted';
        const round = ensureRound(state, state.phase, state.cycleCount);
        const participant = state.participants.find((entry) => entry.agentId === event.agentId);
        if (participant && event.detail?.response) {
          upsertRoundResponse(round, participant, { response: event.detail.response, status: 'submitted' });
        }
        appendFeed(state, `${event.displayName || event.agentId} submitted a partial response.`, {
          displayName: event.displayName || event.agentId,
          role: 'participant',
          agentId: event.agentId,
        });
        ctx.setState(state);
        emitMetrics(ctx, state);
        return null;
      }
      if (event?.type === 'participant_disconnected' && event.agentId) {
        state.agentStatus[event.agentId] = 'disconnected';
        appendFeed(state, `${event.agentId} disconnected.`, {
          displayName: event.agentId,
          role: 'participant',
          agentId: event.agentId,
        });
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'pause', reason: `participant_disconnected:${event.agentId}` };
      }
      return null;
    },

    async onResume(ctx) {
      const state = ctx.getState() || createInitialState(ctx, manifest);
      emitMetrics(ctx, state);
      if (state.phase === PHASES.COMPLETE) return null;
      const activeFanOut = typeof ctx.getActiveFanOut === 'function' ? ctx.getActiveFanOut() : null;
      if (activeFanOut?.pendingAgentIds?.length > 0) {
        updateAgentStatuses(state, activeFanOut.completedAgentIds || [], 'submitted');
        updateAgentStatuses(state, activeFanOut.pendingAgentIds, 'assigned');
        appendFeed(state, `Resuming ${state.phase} pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'continue_fan_out' };
      }
      const targets = buildPendingTargetsForPhase(state, state.phase);
      if (targets.length > 0) return issuePhaseDecision(ctx, state, state.phase, { pendingOnly: true });
      const responses = getPhaseResponses(state, state.phase);
      if (responses.length > 0) return continueFromCollectedResponses(ctx, state);
      return null;
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (!pendingDecision || pendingDecision.type !== 'fan_out' || !state) return pendingDecision;
      const targets = buildPendingTargetsForPhase(state, state.phase);
      return targets.length > 0 ? { ...pendingDecision, targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) return null;
      const bundle = buildBundle(state);
      const artifacts = [];
      if (state.summaryPath && existsSync(state.summaryPath)) {
        artifacts.push({ type: 'markdown', path: state.summaryPath, label: path.basename(state.summaryPath), primary: true });
      }
      for (const artifact of bundle.artifacts) {
        artifacts.push({ type: artifact.kind, path: artifact.path, label: artifact.label, primary: false });
      }
      return {
        summary: {
          title: bundle.summary.title,
          highlights: [
            bundle.summary.oneLiner,
            bundle.summary.recommendedDirection,
            bundle.assetInventory[0] || '',
          ].filter(Boolean),
          outcome: state.phase === PHASES.COMPLETE ? 'marketing_execution_ready' : 'marketing_execution_partial',
        },
        metrics: {
          cycles: state.cycleCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts,
        handoffPayloads: [
          {
            contract: 'marketing_execution_bundle.v1',
            data: bundle,
          },
        ],
      };
    },

    shutdown() {
      // No-op.
    },
  };
}

export default { manifest, createPlugin };
export { manifest, createPlugin };
