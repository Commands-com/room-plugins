import path from 'node:path';

import {
  collectArtifactFiles,
  parseSummary,
  readSummaryMarkdown,
} from './execution-model.js';
import { titleCase } from './utils.js';

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => ({
    phase: `Pass ${round.cycleIndex} — ${titleCase(round.phase)}`,
    contributor: response.displayName,
    role: titleCase(response.role),
    status: titleCase(response.status),
    summary: response.summary,
  })));
}

function buildArtifactBlocks(state) {
  const markdown = readSummaryMarkdown(state);
  return markdown ? [{
    title: path.basename(state.summaryPath),
    language: 'markdown',
    path: state.summaryPath,
    content: markdown,
  }] : [];
}

export function emitMetrics(ctx, state) {
  const parsed = parseSummary(readSummaryMarkdown(state));
  const contributorStatus = {};
  for (const participant of state.participants) {
    contributorStatus[participant.displayName] = state.agentStatus[participant.agentId] || 'idle';
  }
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    executionPhase: { active: state.phase },
    executionProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    executionCounts: {
      assets: collectArtifactFiles(state.config.outputDir, state.summaryPath).length,
      priorities: parsed.selectedPriorities.length,
      risks: parsed.risks.length,
      questions: parsed.openQuestions.length,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    executionArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: state.phase === 'complete' ? buildArtifactBlocks(state) : [] },
  });
}
