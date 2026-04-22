// ---------------------------------------------------------------------------
// Cycle synthesis. Aggregates per-target review blocks into a ranked list
// (averageScore, dimension averages, reviewer breakdown, merged keep/
// mustChange/risks) and builds the synthesis markdown that downstream
// refine prompts and the final concept_bundle read from.
// ---------------------------------------------------------------------------

import { PHASES } from './constants.js';
import { ensureRound } from './rounds.js';
import { getLatestConcepts } from './concept-model.js';
import { DECISION_DIMENSIONS } from './constants.js';
import {
  averageNumbers,
  buildDimensionAverageSummary,
  buildJudgeMetadata,
  mergeUnique,
  resolveOverallReviewScore,
  summarizeReviewRound,
  toRoundedNumber,
} from './review-model.js';

function buildSynthesisMarkdown(state, ranked) {
  if (!Array.isArray(ranked) || ranked.length === 0) return 'No concept synthesis available.';
  const leader = ranked[0];
  return [
    `# Explore Room Synthesis`,
    '',
    `Cycle: **${state.cycleCount} / ${state.maxCycles}**`,
    '',
    `Seed interpretation: **${state.config.seedModeLabel}**`,
    '',
    state.config.seedGuidance,
    '',
    `Selected concept: **${leader.title}**`,
    '',
    '## Why This Direction',
    leader.oneLiner ? `- ${leader.oneLiner}` : '- No one-liner provided.',
    leader.whyThisCouldWin ? `- ${leader.whyThisCouldWin}` : '- No explicit rationale provided.',
    '',
    '## Prototype Focus',
    ...(leader.prototypeFocus.length > 0 ? leader.prototypeFocus.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Required User Flows',
    ...(leader.requiredUserFlows.length > 0 ? leader.requiredUserFlows.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Non-Mock Functionality',
    ...(leader.nonMockFunctionality.length > 0 ? leader.nonMockFunctionality.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Implementation Boundaries',
    ...(leader.implementationBoundaries.length > 0 ? leader.implementationBoundaries.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Leaderboard',
    ...ranked.map((entry) => `- #${entry.rank} ${entry.title} — ${entry.averageScore.toFixed(1)} / 10 (${entry.reviewCount} reviews)`),
  ].join('\n');
}

export function synthesizeConcepts(state) {
  const concepts = getLatestConcepts(state);
  const reviewSummary = summarizeReviewRound(ensureRound(state, PHASES.REVIEW, state.cycleCount), state);
  const ranking = concepts.map((concept) => {
    const reviews = reviewSummary.parsed.flatMap((entry) => (
      entry.targets
        .filter((target) => target.targetAgentId === concept.agentId)
        .map((target) => ({
          ...target,
          reviewer: buildJudgeMetadata(
            state.participants.find((participant) => participant.agentId === entry.reviewer.agentId)
            || entry.reviewer,
          ),
        }))
    ));
    const scored = reviews
      .map((review) => ({
        ...review,
        resolvedScore: resolveOverallReviewScore(review),
      }))
      .filter((review) => typeof review.resolvedScore === 'number');
    const averageScore = averageNumbers(scored.map((review) => review.resolvedScore)) || 0;
    const dimensionAverages = buildDimensionAverageSummary(reviews);
    return {
      ...concept,
      averageScore,
      reviewCount: scored.length,
      dimensionAverages,
      reviewerBreakdown: reviews.map((review) => ({
        reviewer: review.reviewer,
        overallScore: toRoundedNumber(resolveOverallReviewScore(review)),
        dimensionScores: Object.fromEntries(DECISION_DIMENSIONS.map((dimension) => [
          dimension.id,
          typeof review.dimensionScores?.[dimension.id] === 'number'
            ? review.dimensionScores[dimension.id]
            : null,
        ])),
        keep: review.keep,
        mustChange: review.mustChange,
        risks: review.risks,
        whyItWinsOrLoses: review.whyItWinsOrLoses,
      })),
      keep: mergeUnique(reviews.flatMap((review) => review.keep), 10),
      mustChange: mergeUnique(reviews.flatMap((review) => review.mustChange), 10),
      risks: mergeUnique(reviews.flatMap((review) => review.risks), 10),
      whyItWinsOrLoses: mergeUnique(reviews.flatMap((review) => review.whyItWinsOrLoses), 8),
    };
  }).sort((left, right) => {
    if (right.averageScore !== left.averageScore) return right.averageScore - left.averageScore;
    if (left.mustChange.length !== right.mustChange.length) return left.mustChange.length - right.mustChange.length;
    return left.title.localeCompare(right.title);
  }).map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));

  const selected = ranking[0] || null;
  const synthesis = {
    cycleIndex: state.cycleCount,
    ranked: ranking,
    selected,
    reviewBlockCount: reviewSummary.reviewBlockCount,
    mustChangeCount: reviewSummary.mustChangeCount,
    markdown: buildSynthesisMarkdown(state, ranking),
  };
  state.synthesis = synthesis;
  return synthesis;
}
