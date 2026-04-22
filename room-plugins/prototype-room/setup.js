// ---------------------------------------------------------------------------
// Initial state factory. Pulls together room config, inbound concept bundle
// context, the participant roster (with prototype-key assignment), missing
// required roles, and seeds the feed with onboarding entries. createInitialState
// is the single entry point the lifecycle hooks (init/onRoomStart/etc) call.
// ---------------------------------------------------------------------------

import path from 'node:path';

import { manifest } from './manifest.js';
import { PHASES } from './constants.js';
import { excerpt, safeTrim, sanitizeFileName, slugify, titleCase } from './text-utils.js';
import { buildConceptContext } from './handoff-context.js';

function getConfig(ctx) {
  const roomConfig = ctx?.roomConfig || {};
  return {
    outputDir: safeTrim(roomConfig.outputDir, 4000),
    readmeFileName: sanitizeFileName(roomConfig.readmeFileName || 'README.md', 'README.md'),
  };
}

function getMaxCycles(ctx) {
  const configured = Number(ctx?.limits?.maxCycles);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.max(1, Math.min(Math.trunc(configured), manifest.limits?.maxCycles?.max || 5));
  }
  return manifest.limits?.maxCycles?.default || 2;
}

function inferPrototypeBaseName(participant) {
  const displayName = safeTrim(participant?.displayName, 120).toLowerCase();
  if (displayName) {
    if (/(openai|gpt)/.test(displayName)) return 'openai';
    if (/(anthropic|claude)/.test(displayName)) return 'claude';
    if (/(google|gemini)/.test(displayName)) return 'gemini';
    if (/(deepseek)/.test(displayName)) return 'deepseek';
    if (/(meta|llama)/.test(displayName)) return 'llama';
    if (/(qwen)/.test(displayName)) return 'qwen';

    const displaySlug = slugify(displayName, '');
    if (displaySlug) return displaySlug;
  }

  const fields = [
    participant?.profile?.name,
    participant?.profile?.model,
    participant?.profile?.provider,
    participant?.agentId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/(openai|gpt)/.test(fields)) return 'openai';
  if (/(anthropic|claude)/.test(fields)) return 'claude';
  if (/(google|gemini)/.test(fields)) return 'gemini';
  if (/(deepseek)/.test(fields)) return 'deepseek';
  if (/(meta|llama)/.test(fields)) return 'llama';
  if (/(qwen)/.test(fields)) return 'qwen';

  return slugify(participant?.displayName || participant?.profile?.name || participant?.agentId || 'prototype');
}

function getParticipants(ctx) {
  const participants = Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role === 'prototyper')
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
          profile: participant.profile || null,
        }))
    : [];

  const counts = {};
  return participants.map((participant) => {
    const base = inferPrototypeBaseName(participant);
    counts[base] = (counts[base] || 0) + 1;
    const suffix = counts[base] > 1 ? `-${counts[base]}` : '';
    const prototypeKey = `${base}${suffix}`;
    return {
      ...participant,
      prototypeKey,
      prototypeLabel: participant.displayName || titleCase(prototypeKey),
    };
  });
}

function findMissingRoles(participants) {
  const minCount = manifest.roles?.minCount || {};
  const roleCounts = {};
  for (const participant of participants) {
    roleCounts[participant.role] = (roleCounts[participant.role] || 0) + 1;
  }
  return Object.entries(minCount)
    .filter(([role, min]) => (roleCounts[role] || 0) < min)
    .map(([role]) => role);
}

export function createInitialState(ctx) {
  const config = getConfig(ctx);
  const outputDir = config.outputDir ? path.resolve(config.outputDir) : '';
  const conceptContext = buildConceptContext(ctx);
  const participants = getParticipants(ctx).map((participant) => ({
    ...participant,
    prototypeDir: outputDir ? path.join(outputDir, participant.prototypeKey) : '',
    readmePath: outputDir ? path.join(outputDir, participant.prototypeKey, config.readmeFileName) : '',
  }));
  const objective = safeTrim(ctx?.objective, 2400) || 'No objective provided.';

  return {
    objective,
    config: {
      ...config,
      outputDir,
    },
    conceptContext,
    participants,
    phase: PHASES.BUILD,
    cycleCount: 1,
    maxCycles: getMaxCycles(ctx),
    rounds: [],
    reviewSyntheses: [],
    snapshots: {},
    feedEntries: [
      {
        displayName: 'Prototype Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Captured objective: ${excerpt(objective, 180)}`,
      },
      {
        displayName: 'Prototype Room',
        role: 'system',
        createdAt: Date.now(),
        content: outputDir
          ? `Prototype root directory: ${outputDir}`
          : 'Prototype Room needs an output directory from the room setup UI before it can start.',
      },
      ...(conceptContext ? [{
        displayName: 'Prototype Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Selected inbound concept: ${conceptContext.selectedConcept.title} (${conceptContext.selectedConcept.id}).`,
      }] : []),
    ],
    missingRoles: findMissingRoles(participants),
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    disconnectedAgents: [],
  };
}
