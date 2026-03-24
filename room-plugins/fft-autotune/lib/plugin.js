import { buildCompatibilityReport, ensureScaffoldedWorkspace, getConfig } from './config.js';
import { assignLanes } from './envelope.js';
import { PHASES } from './constants.js';
import { chooseStopReason, evaluateImprovement, mergeCycleArtifacts, recomputeFrontier, updateDiversity } from './candidates.js';
import { getMissingBaselineBucketKeys, getMissingWinnerBucketKeys } from './buckets.js';
import { loadFrontierSnapshot, persistFrontierSnapshot } from './frontier-snapshot.js';
import { createInitialState, derivePartialPhase, advancePhase, setPhase } from './phases.js';
import { fallbackSeedProposals, winnerMutationProposals, enqueueProposals, selectActivePromotedProposals, buildPendingDecision } from './planning.js';
import { emitStateMetrics } from './report.js';

const MAX_REPAIR_RESPONSE_LEN = 512 * 1024;
const BUILDER_RESPONSE_LANES = new Set(['builder', 'builder_explorer_auditor']);
const SCHEMA_REPAIR_RESULT_LANES = new Set(['builder', 'builder_explorer_auditor', 'auditor', 'auditor_explorer']);
const SCHEMA_REPAIR_SIGNAL_PATTERNS = [
  /"proposalId"\s*:/,
  /"bucketKey"\s*:/,
  /"compile"\s*:/,
  /"validation"\s*:/,
  /"benchmark"\s*:/,
  /"buckets"\s*:/,
  /"bench"\s*:/,
  /"winner_unchanged"\s*:/,
  /"file"\s*:/,
  /"medianNs"\s*:/,
];

function seedStateFromPriorFrontier(state, config) {
  const snapshot = loadFrontierSnapshot(config);
  if (!snapshot.ok || !snapshot.found || snapshot.seededCount === 0) {
    return snapshot;
  }

  state.baselines = {
    ...(state.baselines || {}),
    ...(snapshot.baselines || {}),
  };
  state.baselineSources = {
    ...(state.baselineSources || {}),
    ...(snapshot.baselineSources || {}),
  };

  const existingCandidateIds = new Set((state.candidates || []).map((candidate) => candidate.candidateId));
  for (const candidate of snapshot.seededCandidates || []) {
    if (!existingCandidateIds.has(candidate.candidateId)) {
      state.candidates.push(candidate);
    }
  }

  state.bestByBucket = {
    ...(state.bestByBucket || {}),
    ...(snapshot.bestByBucket || {}),
  };
  state.frontierIds = Array.from(new Set([
    ...(state.frontierIds || []),
    ...(snapshot.frontierIds || []),
  ]));

  return snapshot;
}

function buildStopDecision(ctx, state, config, reason) {
  setPhase(state, PHASES.COMPLETE);
  state.pendingFanOut = null;
  ctx.setState(state);
  emitStateMetrics(ctx, state);
  persistFrontierSnapshotSafely(state, config);
  return {
    type: 'stop',
    reason,
  };
}

function persistFrontierSnapshotSafely(state, config) {
  if ((state?.frontierIds || []).length === 0) {
    return;
  }
  try {
    persistFrontierSnapshot(state, config);
  } catch {
    // Best effort only; do not block room completion on snapshot persistence.
  }
}

function collectSchemaRepairBuilderResponses(state, ctx, responses) {
  return (Array.isArray(responses) ? responses : [])
    .filter((response) => BUILDER_RESPONSE_LANES.has(state.lanesByAgentId[response.agentId] || 'worker'))
    .map((response) => {
      const participant = (ctx.participants || []).find((item) => item.agentId === response.agentId);
      const raw = typeof response.response === 'string' ? response.response : '';
      return {
        agentId: response.agentId,
        displayName: participant?.displayName || response.agentId,
        response: raw.length > MAX_REPAIR_RESPONSE_LEN ? raw.slice(0, MAX_REPAIR_RESPONSE_LEN) : raw,
      };
    })
    .filter((entry) => {
      const text = entry.response.trim();
      return text.length > 0 && SCHEMA_REPAIR_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
    });
}

function finishSearchCycle(ctx, state, config) {
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
    return buildStopDecision(ctx, state, config, stopReason);
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
  setPhase(state, PHASES.SEARCH_PLANNING);
  state.pendingFanOut = 'planning';
  ctx.setState(state);
  emitStateMetrics(ctx, state);
  return buildPendingDecision(ctx, state, config);
}

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
    const scaffoldResult = ensureScaffoldedWorkspace(config);
    const report = buildCompatibilityReport(config);

    if (!report.compatible || scaffoldResult.errors.length > 0) {
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return {
        type: 'stop',
        reason: 'global_preflight_failed',
      };
    }

    seedStateFromPriorFrontier(state, config);

    if (getMissingBaselineBucketKeys(state, config).length === 0 && state.frontierIds.length > 0) {
      state.cycleIndex = 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.SEARCH_PLANNING);
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
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
      state.pendingFanOut = 'planning';
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
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.pendingFanOut === 'reexplore') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        return buildStopDecision(
          ctx,
          state,
          config,
          state.frontierIds.length > 0 && getMissingWinnerBucketKeys(state, config).length === 0
            ? 'convergence'
            : 'convergence_with_open_issues',
        );
      }

      setPhase(state, PHASES.CANDIDATE_CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.pendingFanOut === 'planning') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      if (state.proposalBacklog.length === 0) {
        enqueueProposals(
          state,
          fallbackSeedProposals(config, new Set(getMissingWinnerBucketKeys(state, config))),
          config,
        );
      }
      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        return buildStopDecision(
          ctx,
          state,
          config,
          state.frontierIds.length > 0 && getMissingWinnerBucketKeys(state, config).length === 0
            ? 'convergence'
            : 'convergence_with_open_issues',
        );
      }

      setPhase(state, PHASES.CANDIDATE_CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.pendingFanOut === 'cycle') {
      const candidateCountBefore = state.candidates.length;
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      const builtNewCandidates = state.candidates.length > candidateCountBefore;

      if (builtNewCandidates) {
        state.schemaRepairBuilderResponses = [];
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'audit';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      const schemaRepairBuilderResponses = collectSchemaRepairBuilderResponses(state, ctx, responses);
      if (schemaRepairBuilderResponses.length > 0) {
        state.schemaRepairBuilderResponses = schemaRepairBuilderResponses;
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'schema_repair';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      return finishSearchCycle(ctx, state, config);
    }

    if (state.pendingFanOut === 'audit') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    if (state.pendingFanOut === 'schema_repair') {
      const { proposals } = mergeCycleArtifacts(state, responses, config, {
        acceptResultLanes: SCHEMA_REPAIR_RESULT_LANES,
      });
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
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

  function shutdown(ctx) {
    const state = ctx?.getState?.();
    if (!state) return;
    const config = getConfig(ctx);
    persistFrontierSnapshotSafely(state, config);
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
