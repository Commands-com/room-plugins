// ---------------------------------------------------------------------------
// Initial state factory. Resolves room config (seed mode) + participant
// roster (with concept-key slug assignment) + cycle limits from manifest,
// and seeds the feed with the opening system entry.
// ---------------------------------------------------------------------------

import { manifest } from './manifest.js';
import { PHASES } from './constants.js';
import { safeTrim } from './text-utils.js';
import { getConfig } from './seed-mode.js';

function inferConceptBaseName(participant) {
  const displayName = safeTrim(participant?.displayName, 120).toLowerCase();
  if (displayName) {
    if (/(openai|gpt)/.test(displayName)) return 'openai';
    if (/(anthropic|claude)/.test(displayName)) return 'claude';
    if (/(google|gemini)/.test(displayName)) return 'gemini';
    const fallback = displayName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (fallback) return fallback;
  }

  const fields = [
    participant?.profile?.name,
    participant?.profile?.model,
    participant?.profile?.provider,
    participant?.agentId,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(openai|gpt)/.test(fields)) return 'openai';
  if (/(anthropic|claude)/.test(fields)) return 'claude';
  if (/(google|gemini)/.test(fields)) return 'gemini';
  return safeTrim(participant?.displayName || participant?.agentId || 'concept', 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'concept';
}

function getParticipants(ctx) {
  const participants = Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role === 'explorer')
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
          profile: participant.profile || null,
        }))
    : [];

  const counts = {};
  return participants.map((participant) => {
    const base = inferConceptBaseName(participant);
    counts[base] = (counts[base] || 0) + 1;
    const suffix = counts[base] > 1 ? `-${counts[base]}` : '';
    return {
      ...participant,
      conceptKey: `${base}${suffix}`,
    };
  });
}

function findMissingRoles(participants) {
  const minCount = manifest.roles?.minCount || {};
  const counts = {};
  for (const participant of participants) {
    counts[participant.role] = (counts[participant.role] || 0) + 1;
  }
  return Object.entries(minCount)
    .filter(([role, min]) => (counts[role] || 0) < min)
    .map(([role]) => role);
}

export function createInitialState(ctx) {
  const participants = getParticipants(ctx);
  const objective = safeTrim(ctx?.objective, 2400) || 'No seed provided.';
  const config = getConfig(ctx, objective);
  const configuredMaxCycles = Number(ctx?.limits?.maxCycles);
  const manifestDefault = manifest.limits?.maxCycles?.default || 2;
  const manifestMax = manifest.limits?.maxCycles?.max || 5;
  const maxCycles = Number.isFinite(configuredMaxCycles)
    ? Math.max(1, Math.min(Math.trunc(configuredMaxCycles), manifestMax))
    : manifestDefault;
  return {
    objective,
    config,
    participants,
    phase: PHASES.EXPLORE,
    cycleCount: 1,
    maxCycles,
    rounds: [],
    synthesis: null,
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    missingRoles: findMissingRoles(participants),
    feedEntries: [
      {
        id: 'feed-1',
        content: `Explore Room ready. Seed mode: ${config.seedModeLabel}.`,
        createdAt: Date.now(),
        displayName: 'Explore Room',
        role: 'system',
        agentId: null,
      },
    ],
  };
}
