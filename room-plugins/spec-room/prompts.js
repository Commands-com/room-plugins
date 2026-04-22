// ---------------------------------------------------------------------------
// Prompt template loading + per-phase prompt builders + target assembly.
//
// The three markdown templates under ./prompts/ are loaded at module-load
// time (same pattern as the original index.js) and rendered via a small
// {{placeholder}} substitution. Each phase builder splices the shared
// prototype/feedback context blocks onto the tail of the rendered prompt.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES, ROLE_FOCUS } from './constants.js';
import { titleCase } from './text-utils.js';
import {
  getLatestRound,
  getCompletedAgentIdsForCurrentPass,
} from './rounds.js';
import {
  appendPrototypeContext,
  appendFeedbackContext,
} from './handoff-context.js';
import {
  renderSpecMarkdown,
  buildReviewFeedback,
} from './spec-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(__dirname, 'prompts');

const promptTemplates = {
  write: readFileSync(path.join(promptsDir, 'research.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'critique.md'), 'utf-8'),
  revise: readFileSync(path.join(promptsDir, 'final-write.md'), 'utf-8'),
};

function formatConfigSummary(config) {
  const lines = [
    `Deliverable type: ${titleCase(config.deliverableType)}`,
    `Audience: ${titleCase(config.audience)}`,
    `Detail level: ${titleCase(config.detailLevel)}`,
  ];

  if (config.mustInclude.length > 0) {
    lines.push(`Must include: ${config.mustInclude.map((item) => `"${item}"`).join(', ')}`);
  }
  if (config.knownConstraints.length > 0) {
    lines.push(`Known constraints: ${config.knownConstraints.map((item) => `"${item}"`).join(', ')}`);
  }

  return lines.join('\n');
}

function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

function buildWritePrompt(state, participant) {
  const prompt = renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    role_title: titleCase(participant.role),
    role_focus: ROLE_FOCUS[participant.role]?.write || ROLE_FOCUS.implementer.write,
    config_summary: formatConfigSummary(state.config),
    objective: state.objective,
    spec_file_path: state.specFilePath,
  });
  return appendFeedbackContext(appendPrototypeContext(prompt, state), state);
}

function buildReviewPrompt(state, participant) {
  const prompt = renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    role_title: titleCase(participant.role),
    role_focus: ROLE_FOCUS[participant.role]?.review || 'Review the current spec from your assigned lens.',
    config_summary: formatConfigSummary(state.config),
    objective: state.objective,
    spec_file_path: state.specFilePath,
    spec_markdown: state.currentSpecMarkdown || renderSpecMarkdown(state.draftSpec, state),
  });
  return appendFeedbackContext(appendPrototypeContext(prompt, state), state);
}

function buildRevisePrompt(state, participant) {
  const latestReviewRound = getLatestRound(state, PHASES.REVIEW);
  const prompt = appendFeedbackContext(appendPrototypeContext(renderPromptTemplate(promptTemplates.revise, {
    display_name: participant.displayName,
    role_title: titleCase(participant.role),
    role_focus: ROLE_FOCUS[participant.role]?.revise || ROLE_FOCUS.implementer.revise,
    config_summary: formatConfigSummary(state.config),
    objective: state.objective,
    spec_file_path: state.specFilePath,
    spec_markdown: state.currentSpecMarkdown || renderSpecMarkdown(state.draftSpec, state),
    review_feedback: buildReviewFeedback(latestReviewRound),
  }), state), state);

  if (!state.finalRevisionPass) return prompt;

  return `${prompt}\nThis is the final revise pass before the room stops. Apply the highest-value requested changes now.`;
}

export function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE) return [];

  if (phase === PHASES.WRITE || phase === PHASES.REVISE) {
    const author = state.participants.find((participant) => participant.agentId === state.authorAgentId);
    if (!author) return [];
    return [{
      agentId: author.agentId,
      message: phase === PHASES.WRITE
        ? buildWritePrompt(state, author)
        : buildRevisePrompt(state, author),
    }];
  }

  return state.participants
    .filter((participant) => state.reviewerAgentIds.includes(participant.agentId))
    .map((participant) => ({
      agentId: participant.agentId,
      message: buildReviewPrompt(state, participant),
    }));
}

export function buildPendingTargetsForPhase(state, phase) {
  const completed = getCompletedAgentIdsForCurrentPass(state);
  return buildTargetsForPhase(state, phase)
    .filter((target) => !completed.has(target.agentId));
}
