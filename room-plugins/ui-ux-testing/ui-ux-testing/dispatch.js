// ---------------------------------------------------------------------------
// Dispatch primitives: one-per-worker batch selection, SPEAK/FAN_OUT shape
// builder for dispatched batches, the semi_auto wrap (swap FAN_OUT → PAUSE
// and stash the decision for onResume), and the scenario lookup used by
// per-phase result processors.
// ---------------------------------------------------------------------------

import { DECISION_TYPES } from '../../core-room-support/room-contracts.js';

export function selectBatch(scenarios, parallelism) {
  const seen = new Set();
  const batch = [];
  for (const s of scenarios) {
    if (batch.length >= parallelism) break;
    if (!seen.has(s.assignedTo)) {
      seen.add(s.assignedTo);
      batch.push(s);
    }
  }
  return batch;
}

export function dispatchBatch(scenarios, promptFn, config, upstreamContext = '') {
  if (scenarios.length === 0) return null;
  if (scenarios.length === 1) {
    return {
      type: DECISION_TYPES.SPEAK,
      agentId: scenarios[0].assignedTo,
      message: promptFn(scenarios[0], config, upstreamContext),
    };
  }
  return {
    type: DECISION_TYPES.FAN_OUT,
    targets: scenarios.map((s) => ({
      agentId: s.assignedTo,
      message: promptFn(s, config, upstreamContext),
    })),
  };
}

export function wrapForSemiAuto(ctx, state, decision) {
  if (!decision) return decision;
  if (ctx.mode !== 'semi_auto') return decision;
  if (decision.type === DECISION_TYPES.STOP || decision.type === DECISION_TYPES.PAUSE) return decision;
  if (decision.type === DECISION_TYPES.FAN_OUT) {
    state.pendingFanOut = decision;
    return { type: DECISION_TYPES.PAUSE, reason: 'semi_auto_review' };
  }
  return decision;
}

export function findScenarioForAgent(state, agentId, ...statuses) {
  return state.scenarios.find(
    (s) => s.assignedTo === agentId && statuses.includes(s.status),
  );
}
