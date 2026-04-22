// ---------------------------------------------------------------------------
// Metric emission for the dashboard panels declared in manifest.json.
// emitMetrics builds the artifact blocks (per-prototype + synthesis), the
// leaderboard rows, contribution table rows, and snapshot-derived counters
// before fanning the whole package through ctx.emitMetrics.
// ---------------------------------------------------------------------------

import { excerpt, titleCase } from './text-utils.js';
import { collectPrototypeSnapshot } from './prototype-fs.js';
import {
  buildLeaderboardRows,
  getLatestReviewRound,
  summarizeReviewRound,
} from './review-model.js';

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => ({
    phase: round.label,
    contributor: response.displayName,
    prototype: titleCase(response.prototypeKey),
    status: response.status || 'submitted',
    summary: excerpt(response.response, 220) || 'No response summary available.',
  })));
}

function buildArtifactBlocks(state) {
  const prototypeBlocks = state.participants.map((participant) => {
    const snapshot = state.snapshots[participant.agentId] || collectPrototypeSnapshot(state, participant);
    const readmeBody = snapshot.readmeContent || '_Summary file missing._';
    const fileTree = snapshot.treeLines.length > 0
      ? snapshot.treeLines.join('\n')
      : '_No visible files yet._';

    return {
      title: `${participant.prototypeLabel} (${participant.prototypeKey})`,
      language: 'markdown',
      path: snapshot.hasReadme ? snapshot.readmePath : undefined,
      footer: `${snapshot.fileCount} visible file${snapshot.fileCount === 1 ? '' : 's'} in ${snapshot.prototypeDir}`,
      content: [
        `# ${participant.prototypeLabel}`,
        '',
        `- Prototype key: \`${participant.prototypeKey}\``,
        `- Directory: \`${participant.prototypeDir}\``,
        `- Summary file: \`${participant.readmePath}\``,
        `- Status: ${titleCase(snapshot.status)}`,
        snapshot.issue ? `- Issue: ${snapshot.issue}` : '',
        '',
        '## Visible Files',
        fileTree,
        '',
        '## Summary File',
        readmeBody,
      ].filter(Boolean).join('\n'),
    };
  });

  const synthesisBlocks = state.reviewSyntheses.map((synthesis) => ({
    title: `Cycle ${synthesis.cycleIndex} Review Synthesis`,
    language: 'markdown',
    content: synthesis.markdown,
  }));

  return [...prototypeBlocks, ...synthesisBlocks];
}

export function emitMetrics(ctx, state) {
  const displayNameCounts = {};
  for (const participant of state.participants) {
    const name = participant.displayName || participant.agentId;
    displayNameCounts[name] = (displayNameCounts[name] || 0) + 1;
  }

  const contributorStatus = {};
  for (const participant of state.participants) {
    const baseName = participant.displayName || participant.agentId;
    const label = displayNameCounts[baseName] > 1
      ? `${baseName} (${participant.agentId})`
      : baseName;
    contributorStatus[label] = state.agentStatus[participant.agentId] || 'idle';
  }

  const reviewSummary = summarizeReviewRound(getLatestReviewRound(state), state);
  const snapshots = state.participants.map((participant) => state.snapshots[participant.agentId]).filter(Boolean);
  const latestSynthesis = state.reviewSyntheses.at(-1) || null;

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    prototypePhase: { active: state.phase },
    prototypeProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    prototypeCounts: {
      prototypes: snapshots.filter((snapshot) => snapshot.status === 'ready').length,
      files: snapshots.reduce((sum, snapshot) => sum + (snapshot.fileCount || 0), 0),
      reviews: latestSynthesis?.reviewBlockCount || reviewSummary.reviewBlockCount,
      changes: latestSynthesis?.mustChangeCount || reviewSummary.mustChangeCount,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    leaderboardTable: { rows: buildLeaderboardRows(state) },
    roomFeed: { entries: state.feedEntries },
    prototypeArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: buildArtifactBlocks(state) },
  });
}
