// ---------------------------------------------------------------------------
// Round + feed bookkeeping. A round is the set of responses collected during
// one (phase, cycleIndex) tuple. This module owns the feed log and the
// agent-status map; phase-flow composes these helpers to manage transitions.
// ---------------------------------------------------------------------------

import { TEXT_LIMITS } from './constants.js';
import { excerpt, safeTrim, titleCase } from './text-utils.js';

function createRound(phase, cycleIndex) {
  return {
    phase,
    cycleIndex,
    label: `Cycle ${cycleIndex} — ${titleCase(phase)}`,
    responses: [],
  };
}

export function ensureRound(state, phase, cycleIndex) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.cycleIndex === cycleIndex);
  if (!round) {
    round = createRound(phase, cycleIndex);
    state.rounds.push(round);
  }
  return round;
}

export function upsertRoundResponse(round, participant, response) {
  const text = safeTrim(response?.response, TEXT_LIMITS.response);
  const next = {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    conceptKey: participant.conceptKey,
    response: text,
    status: safeTrim(response?.status, 120) || 'submitted',
    summary: excerpt(text, 220) || 'No response summary available.',
  };

  const index = round.responses.findIndex((entry) => entry.agentId === participant.agentId);
  if (index >= 0) {
    round.responses[index] = next;
  } else {
    round.responses.push(next);
  }
}

export function updateAgentStatuses(state, agentIds, status) {
  for (const agentId of agentIds) {
    if (!agentId) continue;
    state.agentStatus[agentId] = status;
  }
}

export function appendFeed(state, content, meta = {}) {
  state.feedEntries.push({
    id: `feed-${state.feedEntries.length + 1}`,
    content: safeTrim(content, 4000),
    createdAt: Date.now(),
    displayName: meta.displayName || 'Explore Room',
    role: meta.role || 'system',
    agentId: meta.agentId || null,
  });
}

export function mergeResponsesIntoRound(state, phase, responses) {
  const round = ensureRound(state, phase, state.cycleCount);
  for (const response of Array.isArray(responses) ? responses : []) {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId);
    if (!participant) continue;
    upsertRoundResponse(round, participant, response);
  }
  updateAgentStatuses(state, state.participants.map((participant) => participant.agentId), 'idle');
}

export function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
  }));
}
