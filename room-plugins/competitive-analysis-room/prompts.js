import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES } from './constants.js';
import { readAnalysisMarkdown, summarizeReviews } from './analysis-model.js';
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

export function buildWritePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_dir: state.config.projectDir,
    project_context: buildProjectContextBlock(state),
    analysis_path: state.analysisPath,
  });
}

export function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_dir: state.config.projectDir,
    project_context: buildProjectContextBlock(state),
    analysis_markdown: readAnalysisMarkdown(state) || '_Analysis file missing or empty._',
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
    project_dir: state.config.projectDir,
    project_context: buildProjectContextBlock(state),
    analysis_path: state.analysisPath,
    analysis_markdown: readAnalysisMarkdown(state) || '_Analysis file missing or empty._',
    review_feedback: buildReviewFeedbackBlock(state),
  });
}

export function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE) return [];
  if (phase === PHASES.WRITE || phase === PHASES.REVISE) {
    return state.author ? [{
      agentId: state.author.agentId,
      message: phase === PHASES.WRITE
        ? buildWritePrompt(state, state.author)
        : buildRevisePrompt(state, state.author),
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
