import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES } from './constants.js';
import { readPlanMarkdown, summarizeReviews } from './plan-model.js';
import { ensureRound, getRound } from './state.js';
import { normalizeList, renderPromptTemplate } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(__dirname, 'prompts');

const promptTemplates = {
  write: readFileSync(path.join(promptsDir, 'write.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
  revise: readFileSync(path.join(promptsDir, 'revise.md'), 'utf-8'),
};

export function buildProjectContextBlock(state) {
  return state.projectContext?.block || 'No project context available.';
}

export function buildCompetitiveContextBlock(state) {
  if (!state.competitiveContext) return 'No inbound competitive analysis bundle provided.';
  const context = state.competitiveContext;
  return [
    context.title ? `Title: ${context.title}` : '',
    context.oneLiner ? `Summary: ${context.oneLiner}` : '',
    context.recommendedDirection ? `Recommended direction: ${context.recommendedDirection}` : '',
    context.positioningGap ? `Positioning gap: ${context.positioningGap}` : '',
    context.competitorSet.length > 0 ? `Competitors:\n- ${context.competitorSet.join('\n- ')}` : 'Competitors: none listed',
    context.likelyChannels.length > 0 ? `Likely channels:\n- ${context.likelyChannels.join('\n- ')}` : 'Likely channels: none listed',
    context.messagingStrengths.length > 0 ? `Messaging strengths:\n- ${context.messagingStrengths.join('\n- ')}` : '',
    context.messagingWeaknesses.length > 0 ? `Messaging weaknesses:\n- ${context.messagingWeaknesses.join('\n- ')}` : '',
    context.patternsToAvoid.length > 0 ? `Patterns to avoid:\n- ${context.patternsToAvoid.join('\n- ')}` : '',
    context.recommendedMoves.length > 0 ? `Recommended moves:\n- ${context.recommendedMoves.join('\n- ')}` : '',
    context.risks.length > 0 ? `Risks:\n- ${context.risks.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildWritePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_context: buildProjectContextBlock(state),
    competitive_context: buildCompetitiveContextBlock(state),
    plan_path: state.planPath,
  });
}

export function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_context: buildProjectContextBlock(state),
    competitive_context: buildCompetitiveContextBlock(state),
    plan_markdown: readPlanMarkdown(state) || '_Marketing plan file missing or empty._',
  });
}

export function buildReviewFeedbackBlock(state) {
  const round = getRound(state, PHASES.REVIEW, state.cycleCount);
  if (!round || round.responses.length === 0) return '- None yet.';
  const summary = summarizeReviews(round);
  return [
    '## Keep',
    ...(summary.parsed.flatMap((entry) => entry.review.keep).length > 0
      ? normalizeList(summary.parsed.flatMap((entry) => entry.review.keep), 12, 500).map((item) => `- ${item}`)
      : ['- None.']),
    '',
    '## Must Change',
    ...(summary.mustChange.length > 0 ? summary.mustChange.map((item) => `- ${item}`) : ['- None.']),
    '',
    '## Risks',
    ...(summary.risks.length > 0 ? summary.risks.map((item) => `- ${item}`) : ['- None.']),
    '',
    '## Opportunities',
    ...(summary.opportunities.length > 0 ? summary.opportunities.map((item) => `- ${item}`) : ['- None.']),
  ].join('\n');
}

export function buildRevisePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.revise, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_context: buildProjectContextBlock(state),
    competitive_context: buildCompetitiveContextBlock(state),
    plan_path: state.planPath,
    plan_markdown: readPlanMarkdown(state) || '_Marketing plan file missing or empty._',
    review_feedback: buildReviewFeedbackBlock(state),
  });
}

export function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE) return [];
  if (phase === PHASES.WRITE || phase === PHASES.REVISE) {
    return state.author ? [{
      agentId: state.author.agentId,
      message: phase === PHASES.WRITE ? buildWritePrompt(state, state.author) : buildRevisePrompt(state, state.author),
    }] : [];
  }
  if (phase === PHASES.REVIEW) {
    return state.reviewers.map((participant) => ({
      agentId: participant.agentId,
      message: buildReviewPrompt(state, participant),
    }));
  }
  return [];
}

export function buildPendingTargetsForPhase(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  const completed = new Set(round.responses.map((response) => response.agentId));
  return buildTargetsForPhase(state, phase).filter((target) => !completed.has(target.agentId));
}
