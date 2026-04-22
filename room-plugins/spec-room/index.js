// ---------------------------------------------------------------------------
// Spec Room plugin — entry file.
//
// Wires the module graph under ./spec-room/ into a plugin descriptor:
//   manifest         — parsed manifest.json (re-exported for the loader
//                      deep-compare against manifest.json on disk)
//   constants        — PHASES + caps + role focus + complexity heuristics
//   text-utils       — generic string helpers (safeTrim, inferTitle, …)
//   handoff-context  — inbound prototype + feedback bundle builders
//   spec-model       — spec shape, render, parse, review parsing, hints
//   setup            — ctx → initial state
//   rounds           — round + feed bookkeeping
//   prompts          — prompt templates + phase target builders
//   metrics          — emitMetrics + spec_bundle.v1 payload builder
//   phase-flow       — issuePhaseDecision + continueFromCollectedResponses
//
// The loader (room/plugin-registry.js) deep-compares the module's exported
// manifest against manifest.json on disk, so the named export must be the
// parsed JSON and match byte-for-byte through canonicalizeJson.
// ---------------------------------------------------------------------------

import { manifest } from './manifest.js';
import { PHASES } from './constants.js';
import { createInitialState } from './setup.js';
import {
  ensureRound,
  appendFeed,
  updateAgentStatuses,
  upsertRoundResponse,
  mergeResponsesIntoRound,
  getPhaseResponses,
} from './rounds.js';
import { buildPendingTargetsForPhase } from './prompts.js';
import {
  issuePhaseDecision,
  stopForMissingRoles,
  stopForMissingSpecPath,
  ensureSpecDirectory,
  continueFromCollectedResponses,
} from './phase-flow.js';
import { emitMetrics, buildSpecBundle } from './metrics.js';

function createPlugin() {
  return {
    init(ctx) {
      const state = createInitialState(ctx);
      ctx.setState(state);
      emitMetrics(ctx, state);
    },

    onRoomStart(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.missingRoles.length > 0) {
        return stopForMissingRoles(ctx, state);
      }
      if (!state.specFilePath) {
        return stopForMissingSpecPath(ctx, state);
      }
      ensureSpecDirectory(state);
      return issuePhaseDecision(ctx, state, PHASES.WRITE);
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState() || createInitialState(ctx);
      mergeResponsesIntoRound(state, state.phase, responses);
      if (state.phase === PHASES.WRITE || state.phase === PHASES.REVIEW || state.phase === PHASES.REVISE) {
        return continueFromCollectedResponses(ctx, state);
      }

      appendFeed(state, `Unexpected fan-out completion while in phase "${state.phase}".`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `unexpected_fan_out_phase:${state.phase}`,
      };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState() || createInitialState(ctx);
      appendFeed(
        state,
        `Received unexpected single-turn response from ${turnResult?.agentId || 'unknown agent'}.`,
      );
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: 'unexpected_single_turn',
      };
    },

    onEvent(ctx, event) {
      const state = ctx.getState() || createInitialState(ctx);

      if (event?.type === 'fan_out_partial' && event.agentId) {
        if (event.progress?.completedAgentIds) {
          updateAgentStatuses(state, event.progress.completedAgentIds, 'submitted');
        }
        if (event.progress?.pendingAgentIds) {
          updateAgentStatuses(state, event.progress.pendingAgentIds, 'assigned');
        }
        state.agentStatus[event.agentId] = 'submitted';
        const round = ensureRound(state, state.phase, state.passCount);
        const participant = state.participants.find((entry) => entry.agentId === event.agentId);
        if (participant && event.detail?.response) {
          upsertRoundResponse(round, participant, {
            response: event.detail.response,
            status: 'submitted',
          });
        }
        appendFeed(
          state,
          `${event.displayName || event.agentId} submitted a partial response.`,
          {
            displayName: event.displayName || event.agentId,
            role: 'participant',
            agentId: event.agentId,
          },
        );
        ctx.setState(state);
        emitMetrics(ctx, state);
        return null;
      }

      if (event?.type === 'participant_disconnected' && event.agentId) {
        state.agentStatus[event.agentId] = 'disconnected';
        if (!state.disconnectedAgents.includes(event.agentId)) {
          state.disconnectedAgents.push(event.agentId);
        }
        appendFeed(state, `${event.agentId} disconnected.`, {
          displayName: event.agentId,
          role: 'participant',
          agentId: event.agentId,
        });
        ctx.setState(state);
        emitMetrics(ctx, state);
        return {
          type: 'pause',
          reason: `participant_disconnected:${event.agentId}`,
        };
      }

      if (event?.type === 'user_edit_state') {
        emitMetrics(ctx, state);
        return null;
      }

      return null;
    },

    async onResume(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      emitMetrics(ctx, state);
      if (state.phase === PHASES.COMPLETE) return null;

      const activeFanOut = typeof ctx.getActiveFanOut === 'function'
        ? ctx.getActiveFanOut()
        : null;

      if (activeFanOut?.pendingAgentIds?.length > 0) {
        updateAgentStatuses(state, activeFanOut.completedAgentIds || [], 'submitted');
        updateAgentStatuses(state, activeFanOut.pendingAgentIds, 'assigned');
        appendFeed(
          state,
          state.phase === PHASES.WRITE
            ? `Resuming write pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`
            : (state.phase === PHASES.REVIEW
                ? `Resuming review pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`
                : `Resuming revise pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`),
        );
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'continue_fan_out' };
      }

      const targets = buildPendingTargetsForPhase(state, state.phase);
      if (targets.length > 0) {
        return issuePhaseDecision(ctx, state, state.phase, { pendingOnly: true });
      }

      const phaseResponses = getPhaseResponses(state, state.phase);
      if (phaseResponses.length > 0) {
        return continueFromCollectedResponses(ctx, state);
      }

      return null;
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (!pendingDecision || pendingDecision.type !== 'fan_out' || !state) {
        return pendingDecision;
      }

      const targets = buildPendingTargetsForPhase(state, state.phase);
      return targets.length > 0 ? { type: 'fan_out', targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) return null;

      const bundle = buildSpecBundle(state);
      if (!bundle) return null;

      return {
        summary: {
          title: bundle.data.summary.title,
          highlights: [
            bundle.data.summary.oneLiner,
            bundle.data.summary.recommendedDirection,
            bundle.data.spec.acceptanceCriteria?.length
              ? `${bundle.data.spec.acceptanceCriteria.length} acceptance criteria defined.`
              : null,
          ].filter(Boolean).slice(0, 6),
          outcome: state.phase === PHASES.COMPLETE ? 'spec_bundle_ready' : 'spec_bundle_partial',
        },
        metrics: {
          cycles: state.passCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts: bundle.data.artifacts.map((artifact) => ({
          type: artifact.kind || 'file',
          path: artifact.path,
          label: artifact.label,
          ...(artifact.primary ? { primary: true } : {}),
        })),
        handoffPayloads: [bundle],
      };
    },

    shutdown() {
      // No-op.
    },
  };
}

export default { manifest, createPlugin };
export { manifest, createPlugin };
