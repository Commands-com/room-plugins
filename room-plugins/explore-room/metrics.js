// ---------------------------------------------------------------------------
// Metric emission. emitMetrics packs the dashboard payload: phase state,
// concept counts (flows/boundaries), contributor statuses, leaderboard +
// contribution tables, the feed log, and artifact blocks (per-cycle concept
// briefs + the synthesis markdown once it exists).
// ---------------------------------------------------------------------------

import { PHASES } from './constants.js';
import { excerpt, titleCase } from './text-utils.js';
import { ensureRound } from './rounds.js';
import {
  buildConceptMarkdown,
  getLatestConcepts,
  parseConceptResponse,
} from './concept-model.js';

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => {
    const concept = (round.phase === PHASES.EXPLORE || round.phase === PHASES.REFINE)
      ? parseConceptResponse(response.response, { conceptKey: response.conceptKey, displayName: response.displayName, agentId: response.agentId })
      : null;
    return {
      phase: `Cycle ${round.cycleIndex} — ${titleCase(round.phase)}`,
      contributor: response.displayName,
      concept: concept?.title || (round.phase === PHASES.REVIEW ? response.conceptKey : '-'),
      status: titleCase(response.status),
      summary: excerpt(response.response, 220) || 'No response summary available.',
    };
  }));
}

function buildLeaderboardRows(state) {
  const ranked = state.synthesis?.ranked || [];
  if (ranked.length === 0) {
    return getLatestConcepts(state).map((concept) => ({
      rank: '-',
      concept: concept.title,
      score: '-',
      reviews: '-',
      mustChange: '-',
      risks: '-',
      status: 'Awaiting review',
    }));
  }

  return ranked.map((entry) => ({
    rank: String(entry.rank),
    concept: entry.title,
    score: entry.reviewCount > 0 ? entry.averageScore.toFixed(1) : '-',
    reviews: String(entry.reviewCount),
    mustChange: String(entry.mustChange.length),
    risks: String(entry.risks.length),
    status: entry.rank === 1
      ? (entry.mustChange.length === 0 ? 'Selected concept, no required changes' : 'Selected concept')
      : 'Alternative direction',
  }));
}

function buildArtifactBlocks(state) {
  const conceptBlocks = state.rounds
    .filter((round) => round.phase === PHASES.EXPLORE || round.phase === PHASES.REFINE)
    .flatMap((round) => round.responses.map((response) => {
      const participant = state.participants.find((entry) => entry.agentId === response.agentId) || {
        agentId: response.agentId,
        displayName: response.displayName,
        conceptKey: response.conceptKey,
      };
      const concept = parseConceptResponse(response.response, participant);
      return {
        title: `Cycle ${round.cycleIndex}: ${concept.title} (${concept.conceptKey})`,
        language: 'markdown',
        content: buildConceptMarkdown(concept),
      };
    }));

  if (state.synthesis?.markdown) {
    conceptBlocks.push({
      title: 'Explore Room Synthesis',
      language: 'markdown',
      content: state.synthesis.markdown,
    });
  }

  return conceptBlocks;
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
    const label = displayNameCounts[baseName] > 1 ? `${baseName} (${participant.agentId})` : baseName;
    contributorStatus[label] = state.agentStatus[participant.agentId] || 'idle';
  }

  const selected = state.synthesis?.selected || null;
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    explorePhase: { active: state.phase },
    conceptCounts: {
      concepts: getLatestConcepts(state).length,
      reviews: ensureRound(state, PHASES.REVIEW, state.cycleCount).responses.length,
      flows: selected?.requiredUserFlows?.length || 0,
      boundaries: selected?.implementationBoundaries?.length || 0,
    },
    contributorStatus,
    leaderboardTable: { rows: buildLeaderboardRows(state) },
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    conceptArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: state.phase === PHASES.COMPLETE ? buildArtifactBlocks(state) : [] },
  });
}
