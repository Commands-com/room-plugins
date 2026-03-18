import { PHASES, PHASE_ORDER } from './constants.js';
import { parseWorkerEnvelope } from './envelope.js';

function markPhaseReached(state, phase) {
  if (!phase) return;
  if (!Array.isArray(state.reachedPhases)) {
    state.reachedPhases = [];
  }
  if (!state.reachedPhases.includes(phase)) {
    state.reachedPhases.push(phase);
  }
}

export function setPhase(state, phase) {
  state.phase = phase;
  markPhaseReached(state, phase);
}

export function advancePhase(state, nextPhase) {
  const currentRank = PHASE_ORDER[state.phase] ?? -1;
  const nextRank = PHASE_ORDER[nextPhase] ?? -1;
  if (nextRank > currentRank) {
    for (const [phase, rank] of Object.entries(PHASE_ORDER)) {
      if (rank > currentRank && rank < nextRank) {
        markPhaseReached(state, phase);
      }
    }
    setPhase(state, nextPhase);
  }
}

export function derivePartialPhase(state, event, config, engine) {
  const lane = state.lanesByAgentId[event?.agentId] || 'builder';

  if (lane === 'auditor') {
    return PHASES.STATIC_AUDIT;
  }

  if (lane === 'builder') {
    const worker = {
      agentId: event?.agentId || 'worker',
      assignedLane: lane,
    };
    const envelope = parseWorkerEnvelope(event?.detail?.response || '', worker, config, engine);
    const hasBenchmarkResults = envelope.results.some((result) =>
      Number.isFinite(result?.candidate?.medianMs)
      || Number.isFinite(result?.speedupPct)
    );
    if (hasBenchmarkResults) {
      return PHASES.CODEGEN;
    }
  }

  return null;
}

/**
 * Create the initial orchestrator state.
 * @param {object} ctx — room context (participants, etc.)
 * @param {object} [engineState] — engine-specific initial state fields
 */
export function createInitialState(ctx, engineState) {
  return {
    phase: PHASES.PREFLIGHT,
    reachedPhases: [PHASES.PREFLIGHT],
    cycleIndex: 0,
    lanesByAgentId: {},
    workersByLane: {},
    workerCount: ctx.participants.filter((p) =>
      ['explorer', 'builder', 'auditor'].includes(p.role),
    ).length,
    // Search
    proposalBacklog: [],
    activePromotedProposals: [],
    discoveryNotes: [],
    candidates: [],
    baselines: {},
    frontierIds: [],
    bestByStrategyType: {},
    safeBestByStrategyType: {},
    pendingFanOut: null,
    schemaRepairBuilderResponses: [],
    plateauCount: 0,
    bestImprovementPct: 0,
    // Engine-specific fields
    ...engineState,
  };
}
