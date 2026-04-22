import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES } from './constants.js';
import {
  collectArtifactFiles,
  readSummaryMarkdown,
  summarizeReviews,
} from './execution-model.js';
import { ensureRound, getRound } from './state.js';
import { normalizeList, renderPromptTemplate } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(__dirname, 'prompts');

const promptTemplates = {
  write: readFileSync(path.join(promptsDir, 'write.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
  revise: readFileSync(path.join(promptsDir, 'revise.md'), 'utf-8'),
};

export function buildPlanContextBlock(state) {
  if (!state.planContext) return 'No inbound marketing plan bundle provided.';
  const plan = state.planContext;
  return [
    plan.title ? `Title: ${plan.title}` : '',
    plan.oneLiner ? `Summary: ${plan.oneLiner}` : '',
    plan.recommendedDirection ? `Recommended direction: ${plan.recommendedDirection}` : '',
    plan.positioning ? `Positioning: ${plan.positioning}` : '',
    plan.audience ? `Audience: ${plan.audience}` : '',
    plan.messagingPillars.length > 0 ? `Messaging pillars:\n- ${plan.messagingPillars.join('\n- ')}` : '',
    plan.channelPriorities.length > 0 ? `Channel priorities:\n- ${plan.channelPriorities.join('\n- ')}` : '',
    plan.campaignBets.length > 0 ? `Campaign bets:\n- ${plan.campaignBets.join('\n- ')}` : '',
    plan.assetPlan.length > 0 ? `Asset plan:\n- ${plan.assetPlan.join('\n- ')}` : '',
    plan.launchPlan.length > 0 ? `Launch plan:\n- ${plan.launchPlan.join('\n- ')}` : '',
    plan.successMetrics.length > 0 ? `Success metrics:\n- ${plan.successMetrics.join('\n- ')}` : '',
    plan.risks.length > 0 ? `Risks:\n- ${plan.risks.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildAssetInventoryBlock(state) {
  const files = collectArtifactFiles(state.config.outputDir, state.summaryPath);
  if (files.length === 0) return '- No non-summary assets found yet.';
  return files.map((file) => `- ${path.relative(state.config.outputDir, file)}`).join('\n');
}

export function buildWritePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    objective: state.objective,
    project_context: state.projectContext?.block || 'No project context available.',
    plan_context: buildPlanContextBlock(state),
    summary_path: state.summaryPath,
    output_dir: state.config.outputDir,
  });
}

export function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    project_context: state.projectContext?.block || 'No project context available.',
    plan_context: buildPlanContextBlock(state),
    summary_markdown: readSummaryMarkdown(state) || '_Execution summary file missing or empty._',
    asset_inventory: buildAssetInventoryBlock(state),
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
    project_context: state.projectContext?.block || 'No project context available.',
    plan_context: buildPlanContextBlock(state),
    summary_path: state.summaryPath,
    output_dir: state.config.outputDir,
    summary_markdown: readSummaryMarkdown(state) || '_Execution summary file missing or empty._',
    asset_inventory: buildAssetInventoryBlock(state),
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
