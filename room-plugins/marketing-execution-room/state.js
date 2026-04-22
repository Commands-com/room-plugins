import path from 'node:path';

import { TEXT_LIMITS } from './constants.js';
import {
  collectProjectContext,
  extractPlanContext,
} from './execution-model.js';
import { excerpt, safeTrim } from './utils.js';

export function getConfig(ctx) {
  const roomConfig = ctx?.roomConfig || {};
  return {
    projectDir: safeTrim(roomConfig.projectDir, 4000),
    outputDir: safeTrim(roomConfig.outputDir, 4000),
    fileName: safeTrim(roomConfig.fileName || 'marketing-execution.md', 240) || 'marketing-execution.md',
  };
}

export function getParticipants(ctx) {
  return Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role)
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
        }))
    : [];
}

export function findRequiredParticipant(state, role) {
  return state.participants.find((participant) => participant.role === role) || null;
}

export function findMissingRoles(state, manifest) {
  const required = manifest.roles?.required || [];
  return required.filter((role) => !findRequiredParticipant(state, role));
}

export function createRound(phase, cycleIndex) {
  return { phase, cycleIndex, responses: [] };
}

export function ensureRound(state, phase, cycleIndex = state.cycleCount) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.cycleIndex === cycleIndex);
  if (!round) {
    round = createRound(phase, cycleIndex);
    state.rounds.push(round);
  }
  return round;
}

export function getRound(state, phase, cycleIndex = state.cycleCount) {
  return state.rounds.find((entry) => entry.phase === phase && entry.cycleIndex === cycleIndex) || null;
}

export function upsertRoundResponse(round, participant, response) {
  const next = {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    response: safeTrim(response?.response, TEXT_LIMITS.response),
    status: safeTrim(response?.status, 120) || 'submitted',
    summary: excerpt(response?.response, 220) || 'No response summary available.',
  };
  const index = round.responses.findIndex((entry) => entry.agentId === participant.agentId);
  if (index >= 0) round.responses[index] = next;
  else round.responses.push(next);
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
    content: safeTrim(content, 2400),
    createdAt: Date.now(),
    displayName: meta.displayName || 'Marketing Execution Room',
    role: meta.role || 'system',
    agentId: meta.agentId || null,
  });
}

export function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
  }));
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

export function createInitialState(ctx, manifest) {
  const config = getConfig(ctx);
  const projectDir = config.projectDir ? path.resolve(config.projectDir) : '';
  const outputDir = config.outputDir ? path.resolve(config.outputDir) : '';
  const objective = safeTrim(ctx?.objective, 2400) || 'Marketing execution';
  const participants = getParticipants(ctx);
  const state = {
    objective,
    config: { ...config, projectDir, outputDir },
    summaryPath: outputDir ? path.join(outputDir, config.fileName) : '',
    participants,
    author: participants.find((participant) => participant.role === 'operator') || null,
    reviewers: participants.filter((participant) => participant.role !== 'operator'),
    phase: 'write',
    cycleCount: 1,
    maxCycles: Math.max(
      1,
      Math.min(
        Number(ctx?.limits?.maxCycles) || manifest.limits?.maxCycles?.default || 4,
        manifest.limits?.maxCycles?.max || 6,
      ),
    ),
    rounds: [],
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    projectContext: collectProjectContext(projectDir),
    planContext: extractPlanContext(ctx),
    feedEntries: [],
    missingRoles: [],
  };
  state.missingRoles = findMissingRoles(state, manifest);
  appendFeed(state, `Marketing execution room ready for ${objective}.`);
  if (state.projectContext.summary) appendFeed(state, `Project read: ${state.projectContext.summary}`);
  if (state.planContext?.oneLiner) appendFeed(state, `Marketing plan context: ${state.planContext.oneLiner}`);
  return state;
}
