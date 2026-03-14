import { buildCompatibilityReport, getConfig } from './config.js';
import { assignLanes } from './envelope.js';
import { PHASES } from './constants.js';
import { chooseStopReason, evaluateImprovement, mergeCycleArtifacts, recomputeFrontier, updateDiversity } from './candidates.js';
import { getMissingWinnerBucketKeys } from './buckets.js';
import { createInitialState, derivePartialPhase, advancePhase, setPhase } from './phases.js';
import { fallbackSeedProposals, winnerMutationProposals, enqueueProposals, selectActivePromotedProposals, buildPendingDecision } from './planning.js';
import { emitStateMetrics } from './report.js';

export function createPlugin() {
  function init(ctx) {
    const state = createInitialState(ctx);
    const { lanesByAgentId, workersByLane } = assignLanes(ctx.participants || []);
    state.lanesByAgentId = lanesByAgentId;
    state.workersByLane = workersByLane;
    state.workerCount = Object.keys(lanesByAgentId).length;
    ctx.setState(state);
    emitStateMetrics(ctx, state);
  }

  function onRoomStart(ctx) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);
    const report = buildCompatibilityReport(config);

    if (!report.compatible) {
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return {
        type: 'stop',
        reason: 'global_preflight_failed',
      };
    }

    setPhase(state, PHASES.BASELINE);
    state.pendingFanOut = 'baseline';
    state.proposalBacklog = [];
    ctx.setCycle(0);
    ctx.setState(state);
    emitStateMetrics(ctx, state);
    return buildPendingDecision(ctx, state, config);
  }

  function onTurnResult() {
    return null;
  }

  function onFanOutComplete(ctx, responses) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);

    if (state.pendingFanOut === 'baseline') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      if (state.proposalBacklog.length === 0) {
        enqueueProposals(
          state,
          fallbackSeedProposals(config, new Set(getMissingWinnerBucketKeys(state, config))),
          config,
        );
      }
      state.cycleIndex = 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.SEARCH_PLANNING);
      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return {
          type: 'stop',
          reason: 'convergence_with_open_issues',
        };
      }
      setPhase(state, PHASES.CANDIDATE_CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.pendingFanOut === 'discovery') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      if (state.proposalBacklog.length === 0) {
        enqueueProposals(
          state,
          fallbackSeedProposals(config, new Set(getMissingWinnerBucketKeys(state, config))),
          config,
        );
      }
      state.cycleIndex = 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.SEARCH_PLANNING);
      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return {
          type: 'stop',
          reason: 'convergence_with_open_issues',
        };
      }
      setPhase(state, PHASES.CANDIDATE_CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.pendingFanOut === 'reexplore') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        setPhase(state, PHASES.COMPLETE);
        state.pendingFanOut = null;
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return {
          type: 'stop',
          reason: state.frontierIds.length > 0 && getMissingWinnerBucketKeys(state, config).length === 0
            ? 'convergence'
            : 'convergence_with_open_issues',
        };
      }

      setPhase(state, PHASES.CANDIDATE_CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.pendingFanOut === 'cycle') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      recomputeFrontier(state, config);
      updateDiversity(state);
      evaluateImprovement(state);

      const stopReason = chooseStopReason(state, config, ctx.limits);
      if (stopReason) {
        if (
          stopReason === 'convergence_with_open_issues'
          && getMissingWinnerBucketKeys(state, config).length > 0
          && (state.reexploreAttempts || 0) < 2
          && state.cycleIndex < (ctx.limits?.maxCycles || 6)
        ) {
          state.reexploreAttempts = (state.reexploreAttempts || 0) + 1;
          setPhase(state, PHASES.SEARCH_PLANNING);
          state.pendingFanOut = 'reexplore';
          ctx.setState(state);
          emitStateMetrics(ctx, state);
          return buildPendingDecision(ctx, state, config);
        }

        setPhase(state, PHASES.COMPLETE);
        state.pendingFanOut = null;
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return {
          type: 'stop',
          reason: stopReason,
        };
      }

      if (state.proposalBacklog.length === 0) {
        const missingSet = new Set(getMissingWinnerBucketKeys(state, config));
        enqueueProposals(state, winnerMutationProposals(state, config, missingSet), config);
        if (state.proposalBacklog.length === 0) {
          enqueueProposals(state, fallbackSeedProposals(config, missingSet), config);
        }
      }

      state.cycleIndex += 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.FRONTIER_REFINE);
      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        const missingWinnerBuckets = getMissingWinnerBucketKeys(state, config);
        if (missingWinnerBuckets.length > 0 && (state.reexploreAttempts || 0) < 2) {
          state.reexploreAttempts = (state.reexploreAttempts || 0) + 1;
          setPhase(state, PHASES.SEARCH_PLANNING);
          state.pendingFanOut = 'reexplore';
          ctx.setState(state);
          emitStateMetrics(ctx, state);
          return buildPendingDecision(ctx, state, config);
        }

        setPhase(state, PHASES.COMPLETE);
        state.pendingFanOut = null;
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return {
          type: 'stop',
          reason: state.frontierIds.length > 0 && missingWinnerBuckets.length === 0
            ? 'convergence'
            : 'convergence_with_open_issues',
        };
      }

      setPhase(state, PHASES.CANDIDATE_CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    return null;
  }

  function onEvent(ctx, event) {
    if (event?.type === 'fan_out_partial') {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.pendingFanOut !== 'cycle') {
        return null;
      }
      const config = getConfig(ctx);
      const nextPhase = derivePartialPhase(state, event, config);
      if (!nextPhase) {
        return null;
      }
      const previousPhase = state.phase;
      advancePhase(state, nextPhase);
      if (state.phase !== previousPhase) {
        ctx.setState(state);
        emitStateMetrics(ctx, state);
      }
      return null;
    }

    if (event?.type === 'participant_disconnected') {
      const state = ctx.getState() || createInitialState(ctx);
      setPhase(state, PHASES.FRONTIER_REFINE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return {
        type: 'pause',
        reason: `participant disconnected: ${event.agentId}`,
      };
    }

    if (event?.type === 'user_edit_state') {
      const state = ctx.getState() || createInitialState(ctx);
      if (event.edits && typeof event.edits === 'object') {
        if (Array.isArray(event.edits.activePromotedProposals)) {
          state.activePromotedProposals = event.edits.activePromotedProposals;
        }
        if (Array.isArray(event.edits.proposalBacklog)) {
          state.proposalBacklog = event.edits.proposalBacklog;
        }
      }
      ctx.setState(state);
      emitStateMetrics(ctx, state);
    }

    return null;
  }

  function onResume(ctx) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);
    return buildPendingDecision(ctx, state, config);
  }

  function refreshPendingDecision(ctx, pendingDecision) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);
    return buildPendingDecision(ctx, state, config) || pendingDecision;
  }

  function shutdown() {
    // No-op.
  }

  return {
    init,
    onRoomStart,
    onTurnResult,
    onFanOutComplete,
    onEvent,
    onResume,
    refreshPendingDecision,
    shutdown,
  };
}
