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

export function derivePartialPhase(state, event, config) {
  const lane = state.lanesByAgentId[event?.agentId] || 'worker';

  if (lane === 'auditor' || lane === 'auditor_explorer') {
    return PHASES.STATIC_AUDIT;
  }

  if (lane === 'builder' || lane === 'builder_explorer_auditor') {
    const worker = {
      agentId: event?.agentId || 'worker',
      assignedLane: lane,
    };
    const envelope = parseWorkerEnvelope(event?.detail?.response || '', worker, config);
    const hasBenchmarkResults = envelope.results.some((result) =>
      result?.benchmark?.ok
      || Number.isFinite(result?.benchmark?.medianNs)
      || Number.isFinite(result?.benchmark?.p95Ns)
    );
    if (hasBenchmarkResults) {
      return PHASES.BENCHMARK;
    }
    return PHASES.COMPILE_VALIDATE;
  }

  return null;
}

export function createInitialState(ctx) {
  return {
    phase: PHASES.PREFLIGHT,
    reachedPhases: [PHASES.PREFLIGHT],
    cycleIndex: 0,
    lanesByAgentId: {},
    workersByLane: {},
    workerCount: ctx.participants.filter((participant) =>
      ['worker', 'explorer', 'builder', 'auditor'].includes(participant.role),
    ).length,
    proposalBacklog: [],
    activePromotedProposals: [],
    reexploreAttempts: 0,
    discoveryNotes: [],
    candidates: [],
    baselines: {},
    baselineArtifacts: {},
    baselineAttempts: {},
    frontierIds: [],
    bestByBucket: {},
    pendingFanOut: null,
    plateauCount: 0,
    bestImprovementPct: 0,
    degradedDiversity: false,
  };
}
