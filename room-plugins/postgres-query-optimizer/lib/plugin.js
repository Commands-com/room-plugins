import { buildCompatibilityReport, getConfig } from './config.js';
import { assignLanes } from './envelope.js';
import { PHASES } from './constants.js';
import {
  chooseStopReason,
  evaluateImprovement,
  mergeCycleArtifacts,
  recomputeFrontier,
} from './candidates.js';
import {
  checkDockerAvailability,
  createNetwork,
  startContainer,
  waitForReady,
  loadSchema,
  loadData,
  createSnapshot,
  getConnectionString,
  teardown,
} from './harness.js';
import { createInitialState, derivePartialPhase, advancePhase, setPhase } from './phases.js';
import {
  buildPendingDecision,
  enqueueProposals,
  selectActivePromotedProposals,
} from './planning.js';
import { emitStateMetrics } from './report.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILDER_RESPONSE_LANES = new Set(['builder']);
const SCHEMA_REPAIR_SIGNAL_PATTERNS = [
  /"proposalId"\s*:/,
  /"baseline"\s*:/,
  /"candidate"\s*:/,
  /"medianMs"\s*:/,
  /"speedupPct"\s*:/,
];
const MAX_REPAIR_RESPONSE_LEN = 512 * 1024;

function collectSchemaRepairBuilderResponses(state, ctx, responses) {
  return (Array.isArray(responses) ? responses : [])
    .filter((r) => BUILDER_RESPONSE_LANES.has(state.lanesByAgentId[r.agentId] || 'builder'))
    .map((r) => {
      const participant = (ctx.participants || []).find((p) => p.agentId === r.agentId);
      const raw = typeof r.response === 'string' ? r.response : '';
      return {
        agentId: r.agentId,
        displayName: participant?.displayName || r.agentId,
        response: raw.length > MAX_REPAIR_RESPONSE_LEN ? raw.slice(0, MAX_REPAIR_RESPONSE_LEN) : raw,
      };
    })
    .filter((entry) => {
      const text = entry.response.trim();
      return text.length > 0 && SCHEMA_REPAIR_SIGNAL_PATTERNS.some((p) => p.test(text));
    });
}

function finishSearchCycle(ctx, state, config) {
  recomputeFrontier(state, config);
  evaluateImprovement(state);

  const stopReason = chooseStopReason(state, config, ctx.limits);
  if (stopReason) {
    setPhase(state, PHASES.COMPLETE);
    state.pendingFanOut = null;
    ctx.setState(state);
    emitStateMetrics(ctx, state);
    return { type: 'stop', reason: stopReason };
  }

  // Replenish proposals if empty
  if (state.proposalBacklog.length === 0) {
    // Planning phase will generate new proposals
  }

  state.cycleIndex += 1;
  ctx.setCycle(state.cycleIndex);
  setPhase(state, PHASES.ANALYSIS);
  state.pendingFanOut = 'planning';
  ctx.setState(state);
  emitStateMetrics(ctx, state);
  return buildPendingDecision(ctx, state, config);
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

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

    // ---- Preflight: compatibility check ----
    const report = buildCompatibilityReport(config);
    if (!report.compatible) {
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return { type: 'stop', reason: 'global_preflight_failed' };
    }

    // ---- Preflight: Docker harness setup ----
    try {
      const roomId = ctx.roomId || 'default';

      // Docker check
      const docker = checkDockerAvailability();
      if (!docker.ok) {
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'docker_unavailable' };
      }

      // Determine demo mode
      const isDemoMode = config.demoMode;
      state.demoMode = isDemoMode;

      // Create network + start container
      createNetwork(roomId);
      const { containerId, containerNameStr, port } = startContainer(roomId, config);

      // Wait for Postgres to be ready
      const ready = waitForReady(containerNameStr);
      if (!ready) {
        teardown(roomId);
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'container_start_failed' };
      }

      // Load schema
      const schemaResult = loadSchema(containerNameStr, config);
      if (!schemaResult.ok) {
        teardown(roomId);
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'schema_load_failed' };
      }

      // Load data
      const dataResult = loadData(containerNameStr, config);
      state.dataTier = dataResult.tier === 'demo' ? 0
        : dataResult.tier === 'seed' ? 1
        : dataResult.tier === 'sampled' ? 2
        : 3;

      // Create snapshot
      let snapshotPath = null;
      try {
        const outputDir = config.outputDir || '.commands/postgres-tuner';
        snapshotPath = createSnapshot(containerNameStr, outputDir);
      } catch {
        // Snapshot failure is non-fatal — we can still proceed without restore capability
      }

      // Get connection string for builder prompts
      const connStr = getConnectionString(containerNameStr);

      state.harnessState = {
        containerId,
        containerName: containerNameStr,
        port,
        snapshotPath,
        connectionString: connStr,
      };
    } catch (err) {
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return { type: 'stop', reason: `harness_error: ${err.message}` };
    }

    // ---- Transition to BASELINE ----
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

    // ---- BASELINE fan-out complete ----
    if (state.pendingFanOut === 'baseline') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      state.cycleIndex = 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.ANALYSIS);
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    // ---- ANALYSIS/PLANNING fan-out complete ----
    if (state.pendingFanOut === 'planning') {
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
          reason: state.frontierIds.length > 0 ? 'convergence' : 'no_proposals',
        };
      }

      setPhase(state, PHASES.CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    // ---- CODEGEN/CYCLE fan-out complete ----
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

      // Check for schema repair opportunity
      const schemaRepairResponses = collectSchemaRepairBuilderResponses(state, ctx, responses);
      if (schemaRepairResponses.length > 0) {
        state.schemaRepairBuilderResponses = schemaRepairResponses;
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'schema_repair';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      return finishSearchCycle(ctx, state, config);
    }

    // ---- AUDIT fan-out complete ----
    if (state.pendingFanOut === 'audit') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- SCHEMA REPAIR fan-out complete ----
    if (state.pendingFanOut === 'schema_repair') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    return null;
  }

  function onEvent(ctx, event) {
    // Partial fan-out phase advancement
    if (event?.type === 'fan_out_partial') {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.pendingFanOut !== 'cycle') return null;
      const config = getConfig(ctx);
      const nextPhase = derivePartialPhase(state, event, config);
      if (!nextPhase) return null;
      const previousPhase = state.phase;
      advancePhase(state, nextPhase);
      if (state.phase !== previousPhase) {
        ctx.setState(state);
        emitStateMetrics(ctx, state);
      }
      return null;
    }

    // Participant disconnected
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

    // User state edits
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
    const state = ctx.getState();
    if (state?.harnessState?.containerName) {
      try {
        teardown(ctx.roomId || 'default');
      } catch {
        // Best-effort teardown
      }
    }
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
