// ---------------------------------------------------------------------------
// Round + feed bookkeeping. A "round" is the set of responses collected from
// participants during one (phase, passIndex) tuple. These helpers are small,
// pure-ish state mutators — they live apart from the factory so the prompt
// builders and phase-flow module can share them without pulling in the
// lifecycle hooks.
// ---------------------------------------------------------------------------

import { SPEC_TEXT_LIMITS } from './constants.js';
import { safeTrim, titleCase } from './text-utils.js';

function buildRoundLabel(phase, passIndex) {
  return `Pass ${passIndex} — ${titleCase(phase)}`;
}

export function ensureRound(state, phase, passIndex = state.passCount) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.passIndex === passIndex);
  if (!round) {
    round = {
      phase,
      passIndex,
      label: buildRoundLabel(phase, passIndex),
      responses: [],
    };
    state.rounds.push(round);
  }
  return round;
}

export function getLatestRound(state, phase) {
  return state.rounds
    .filter((entry) => entry.phase === phase)
    .sort((left, right) => right.passIndex - left.passIndex)[0] || null;
}

export function appendFeed(state, content, extra = {}) {
  const entry = {
    displayName: extra.displayName || 'Spec Room',
    role: extra.role || 'system',
    agentId: extra.agentId || null,
    createdAt: typeof extra.createdAt === 'number' ? extra.createdAt : Date.now(),
    content: safeTrim(content, 1200),
  };
  if (!entry.content) return;
  state.feedEntries.push(entry);
  if (state.feedEntries.length > 60) {
    state.feedEntries = state.feedEntries.slice(-60);
  }
}

export function updateAgentStatuses(state, agentIds, status) {
  for (const agentId of agentIds) {
    state.agentStatus[agentId] = status;
  }
}

export function getRoundResponseMap(round) {
  const responses = new Map();
  for (const response of round?.responses || []) {
    if (!response?.agentId) continue;
    responses.set(response.agentId, response);
  }
  return responses;
}

export function upsertRoundResponse(round, participant, response) {
  const responseMap = getRoundResponseMap(round);
  responseMap.set(participant.agentId, {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    response: safeTrim(response.response, SPEC_TEXT_LIMITS.storedResponse),
    status: response.rejected ? `rejected: ${safeTrim(response.rejectionReason, 120)}` : (response.status || 'submitted'),
  });
  round.responses = Array.from(responseMap.values());
}

export function getCompletedAgentIdsForCurrentPass(state) {
  const round = ensureRound(state, state.phase, state.passCount);
  const completed = new Set(Array.from(getRoundResponseMap(round).keys()));

  for (const [agentId, status] of Object.entries(state.agentStatus || {})) {
    if (status === 'submitted') completed.add(agentId);
  }

  return completed;
}

export function mergeResponsesIntoRound(state, phase, responses) {
  const round = ensureRound(state, phase, state.passCount);

  for (const response of Array.isArray(responses) ? responses : []) {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId);
    if (!participant) continue;
    upsertRoundResponse(round, participant, response);
  }

  updateAgentStatuses(
    state,
    state.participants.map((participant) => participant.agentId),
    'idle',
  );
}

export function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.passCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
    rejected: response.status?.startsWith('rejected:'),
    rejectionReason: response.status?.startsWith('rejected:') ? response.status.slice('rejected:'.length).trim() : '',
  }));
}
