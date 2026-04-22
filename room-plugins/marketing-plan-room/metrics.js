import path from 'node:path';

import { parsePlan, readPlanMarkdown } from './plan-model.js';
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
  const markdown = readPlanMarkdown(state);
  return markdown ? [{
    title: path.basename(state.planPath),
    language: 'markdown',
    path: state.planPath,
    content: markdown,
  }] : [];
}

export function emitMetrics(ctx, state) {
  const parsed = parsePlan(readPlanMarkdown(state));
  const contributorStatus = {};
  for (const participant of state.participants) {
    contributorStatus[participant.displayName] = state.agentStatus[participant.agentId] || 'idle';
  }
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    planPhase: { active: state.phase },
    planProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    planCounts: {
      channels: parsed.channelPriorities.length,
      campaigns: parsed.campaignBets.length,
      assets: parsed.assetPlan.length,
      metrics: parsed.successMetrics.length,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    planArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: state.phase === 'complete' ? buildArtifactBlocks(state) : [] },
  });
}
