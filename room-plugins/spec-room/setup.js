// ---------------------------------------------------------------------------
// Ctx → initial state. Normalizes room config (deliverable type, audience,
// detail level, outputs), filters participants by recognized roles, selects
// an author + reviewer order, resolves spec file target, and attaches
// inbound prototype + feedback context before returning the state blob
// the plugin operates on for the rest of its lifetime.
// ---------------------------------------------------------------------------

import path from 'node:path';

import { PHASES } from './constants.js';
import { manifest } from './manifest.js';
import {
  safeTrim,
  dedupeList,
  excerpt,
  sanitizeFileName,
} from './text-utils.js';
import {
  buildPrototypeContext,
  buildFeedbackContext,
} from './handoff-context.js';

const DELIVERABLE_TYPE_MAP = {
  product_spec: 'product_spec',
  'product spec': 'product_spec',
  technical_spec: 'technical_spec',
  'technical spec': 'technical_spec',
  implementation_plan: 'implementation_plan',
  'implementation plan': 'implementation_plan',
};

const AUDIENCE_MAP = {
  mixed: 'mixed',
  engineering: 'engineering',
  product: 'product',
};

const DETAIL_LEVEL_MAP = {
  concise: 'concise',
  balanced: 'balanced',
  detailed: 'detailed',
};

const ROLE_ORDER = { planner: 1, critic: 2, researcher: 3, implementer: 4 };

const ALLOWED_ROLES = new Set(['implementer', 'planner', 'critic', 'researcher']);

function getConfig(ctx) {
  const roomConfig = ctx?.roomConfig || {};
  return {
    deliverableType: DELIVERABLE_TYPE_MAP[safeTrim(roomConfig.deliverableType, 80).toLowerCase()] || 'technical_spec',
    audience: AUDIENCE_MAP[safeTrim(roomConfig.audience, 80).toLowerCase()] || 'engineering',
    detailLevel: DETAIL_LEVEL_MAP[safeTrim(roomConfig.detailLevel, 80).toLowerCase()] || 'detailed',
    mustInclude: dedupeList(roomConfig.mustInclude || [], 8),
    knownConstraints: dedupeList(roomConfig.knownConstraints || [], 8),
    outputDir: safeTrim(roomConfig.outputDir, 4000),
    fileName: safeTrim(roomConfig.fileName, 240),
  };
}

function getParticipants(ctx) {
  return Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role && ALLOWED_ROLES.has(participant.role))
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
        }))
    : [];
}

export function findMissingRoles(participants) {
  const counts = {};
  for (const participant of participants) {
    counts[participant.role] = (counts[participant.role] || 0) + 1;
  }

  const minCount = manifest.roles?.minCount || {};
  return Object.entries(minCount)
    .filter(([role, min]) => (counts[role] || 0) < min)
    .map(([role]) => role);
}

function selectAuthor(participants) {
  return participants.find((participant) => participant.role === 'implementer')
    || participants[0]
    || null;
}

function selectReviewers(participants, authorAgentId) {
  return participants
    .filter((participant) => participant.agentId !== authorAgentId)
    .sort((left, right) => {
      const leftRank = ROLE_ORDER[left.role] || 99;
      const rightRank = ROLE_ORDER[right.role] || 99;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.displayName.localeCompare(right.displayName);
    });
}

function getMaxPasses(ctx) {
  const configured = Number(ctx?.limits?.maxCycles);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.max(1, Math.min(Math.trunc(configured), manifest.limits?.maxCycles?.max || 4));
  }
  return manifest.limits?.maxCycles?.default || 4;
}

function buildSpecFileTarget(config) {
  if (!config.outputDir || !config.fileName) return null;
  const fileName = sanitizeFileName(config.fileName, 'spec-room');
  const outputDir = path.resolve(config.outputDir);
  return {
    outputDir,
    path: path.join(outputDir, fileName),
  };
}

export function createInitialState(ctx) {
  const participants = getParticipants(ctx);
  const objective = safeTrim(ctx?.objective, 2400) || 'No objective provided.';
  const config = getConfig(ctx);
  const author = selectAuthor(participants);
  const reviewers = selectReviewers(participants, author?.agentId || null);
  const specTarget = buildSpecFileTarget(config);
  const prototypeContext = buildPrototypeContext(ctx);
  const feedbackContext = buildFeedbackContext(ctx);

  return {
    objective,
    config,
    participants,
    authorAgentId: author?.agentId || null,
    reviewerAgentIds: reviewers.map((participant) => participant.agentId),
    maxPasses: getMaxPasses(ctx),
    passCount: 0,
    phase: PHASES.WRITE,
    rounds: [],
    draftSpec: null,
    finalSpec: null,
    currentSpecMarkdown: '',
    specFilePath: specTarget?.path || '',
    exportedSpecPath: '',
    exportError: '',
    finalRevisionPass: false,
    prototypeContext,
    feedbackContext,
    missingRoles: findMissingRoles(participants),
    feedEntries: [
      {
        displayName: 'Spec Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Captured objective: ${excerpt(objective, 180)}`,
      },
      {
        displayName: 'Spec Room',
        role: 'system',
        createdAt: Date.now(),
        content: specTarget
          ? `Canonical spec file: ${specTarget.path}`
          : 'Spec Room needs an export directory and export file name from the room setup UI before it can start.',
      },
      ...(prototypeContext ? [{
        displayName: 'Spec Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Selected inbound prototype: ${prototypeContext.selectedPrototype.title} (${prototypeContext.selectedPrototype.id})${prototypeContext.selectedPrototype.entryHtmlPath ? ` at ${prototypeContext.selectedPrototype.entryHtmlPath}` : ''}`,
      }] : []),
      ...(feedbackContext ? [{
        displayName: 'Spec Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Feedback context loaded: ${feedbackContext.themes.length} theme(s) from ${feedbackContext.window.messageCount} message(s) across ${feedbackContext.window.channelCount} channel(s)`,
      }] : []),
    ],
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    disconnectedAgents: [],
  };
}
