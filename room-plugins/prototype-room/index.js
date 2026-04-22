// ---------------------------------------------------------------------------
// Prototype Room plugin — entry file.
//
// Wires the module graph under ./prototype-room/ into a plugin descriptor:
//   manifest        — parsed manifest.json (re-exported so the loader can
//                     deep-compare it against manifest.json on disk)
//   constants       — PHASES + TEXT_LIMITS + extension/dir sets
//   text-utils      — generic string helpers
//   markdown-utils  — markdown parsing + {{placeholder}} rendering
//   handoff-context — inbound concept_bundle context blocks
//   prototype-fs    — filesystem side: dirs, snapshots, preview images
//   rounds          — round + feed bookkeeping
//   review-model    — review parsing + synthesis + feedback builders
//   setup           — ctx → initial state
//   prompts         — prompt templates + phase target builders
//   metrics         — emitMetrics + dashboard artifact blocks
//   final-report    — prototype_bundle.v1 assembly
//   phase-flow      — issuePhaseDecision + continueFromCollectedResponses
//
// The loader (room/plugin-registry.js) deep-compares the module's exported
// manifest against manifest.json on disk, so the named export must be the
// parsed JSON and match byte-for-byte through canonicalizeJson.
// ---------------------------------------------------------------------------

import { manifest } from './manifest.js';
import { PHASES } from './constants.js';
import { createInitialState } from './setup.js';
import {
  appendFeed,
  ensureRound,
  getPhaseResponses,
  mergeResponsesIntoRound,
  updateAgentStatuses,
  upsertRoundResponse,
} from './rounds.js';
import {
  ensurePrototypeDirectories,
  refreshSnapshots,
} from './prototype-fs.js';
import { buildPendingTargetsForPhase } from './prompts.js';
import {
  continueFromCollectedResponses,
  issuePhaseDecision,
  stopForMissingOutputDir,
  stopForMissingRoles,
} from './phase-flow.js';
import { emitMetrics } from './metrics.js';
import { buildPrototypeBundle, buildReportArtifacts } from './final-report.js';

function createPlugin() {
  return {
    init(ctx) {
      const state = createInitialState(ctx);
      refreshSnapshots(state);
      ctx.setState(state);
      emitMetrics(ctx, state);
    },

    onRoomStart(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.missingRoles.length > 0) {
        return stopForMissingRoles(ctx, state);
      }
      if (!state.config.outputDir) {
        return stopForMissingOutputDir(ctx, state);
      }
      const seededCount = ensurePrototypeDirectories(state);
      refreshSnapshots(state);
      if (seededCount > 0) {
        appendFeed(state, `Seeded ${seededCount} prototype summary file${seededCount === 1 ? '' : 's'} to make the first build pass easier to start.`);
      }
      return issuePhaseDecision(ctx, state, PHASES.BUILD);
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState() || createInitialState(ctx);
      mergeResponsesIntoRound(state, state.phase, responses);
      if (state.phase === PHASES.BUILD || state.phase === PHASES.REVIEW || state.phase === PHASES.IMPROVE) {
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
        const round = ensureRound(state, state.phase, state.cycleCount);
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
        refreshSnapshots(state);
        emitMetrics(ctx, state);
        return null;
      }

      return null;
    },

    async onResume(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      refreshSnapshots(state);
      emitMetrics(ctx, state);
      if (state.phase === PHASES.COMPLETE) return null;

      const activeFanOut = typeof ctx.getActiveFanOut === 'function'
        ? ctx.getActiveFanOut()
        : null;

      if (activeFanOut?.pendingAgentIds?.length > 0) {
        updateAgentStatuses(state, activeFanOut.completedAgentIds || [], 'submitted');
        updateAgentStatuses(state, activeFanOut.pendingAgentIds, 'assigned');
        appendFeed(state, `Resuming ${state.phase} cycle work — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`);
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
      return targets.length > 0 ? { ...pendingDecision, targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state?.participants?.length) return null;

      const bundle = buildPrototypeBundle(state);
      const artifacts = buildReportArtifacts(state, bundle);
      const leader = bundle.leaderboard?.[0] || null;

      return {
        summary: {
          title: bundle.summary.title,
          highlights: [
            bundle.summary.oneLiner,
            leader
              ? `${leader.prototypeTitle} is currently ranked #1 at ${leader.averageScore} / 10.`
              : `Captured ${bundle.prototypes.length} prototype${bundle.prototypes.length === 1 ? '' : 's'}.`,
            bundle.summary.recommendedDirection,
          ].filter(Boolean).slice(0, 6),
          outcome: state.phase === PHASES.COMPLETE ? 'prototype_bundle_ready' : 'prototype_bundle_partial',
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
            contract: 'prototype_bundle.v1',
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
