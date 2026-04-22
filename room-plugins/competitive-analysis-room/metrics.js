import path from 'node:path';

import { parseAnalysis, readAnalysisMarkdown } from './analysis-model.js';
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
  const markdown = readAnalysisMarkdown(state);
  return markdown ? [{
    title: path.basename(state.analysisPath),
    language: 'markdown',
    path: state.analysisPath,
    content: markdown,
  }] : [];
}

export function emitMetrics(ctx, state) {
  const parsed = parseAnalysis(readAnalysisMarkdown(state));
  const contributorStatus = {};
  for (const participant of state.participants) {
    contributorStatus[participant.displayName] = state.agentStatus[participant.agentId] || 'idle';
  }
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    analysisPhase: { active: state.phase },
    analysisProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    analysisCounts: {
      competitors: parsed.competitorSet.length,
      channels: parsed.likelyChannels.length,
      risks: parsed.risks.length,
      questions: parsed.openQuestions.length,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    analysisArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: state.phase === 'complete' ? buildArtifactBlocks(state) : [] },
  });
}
