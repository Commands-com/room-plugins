// ---------------------------------------------------------------------------
// Review model. Parses "## Target: <concept>" blocks out of reviewer
// responses, pulls per-dimension scores from "### Dimension Scores" lines,
// and provides summarization + numeric helpers used by the synthesis step
// and the concept-bundle builder.
// ---------------------------------------------------------------------------

import { DECISION_DIMENSIONS, DIMENSION_ALIAS_TO_ID } from './constants.js';
import {
  canonicalDimensionKey,
  canonicalKey,
  normalizeList,
  safeTrim,
} from './text-utils.js';
import {
  sectionToItems,
  sectionToScore,
  splitHeadingSections,
} from './markdown-utils.js';

export function findParticipantForTarget(state, targetName) {
  const key = canonicalKey(targetName);
  return state.participants.find((participant) => (
    canonicalKey(participant.conceptKey) === key
    || canonicalKey(participant.displayName) === key
  )) || null;
}

export function parseDimensionScores(lines) {
  const scores = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = safeTrim(
      String(line ?? '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, ''),
      240,
    );
    if (!text) continue;

    const match = text.match(/^([^:—-]+?)\s*(?::|—|-)\s*(.+)$/);
    if (!match) continue;

    const dimensionId = DIMENSION_ALIAS_TO_ID.get(canonicalDimensionKey(match[1]));
    if (!dimensionId) continue;

    const scoreMatch = String(match[2]).match(/\b(10|[1-9])(?:\.\d+)?\b/);
    if (!scoreMatch) continue;
    scores[dimensionId] = Number(scoreMatch[1]);
  }

  return scores;
}

export function averageNumbers(values) {
  const numeric = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (numeric.length === 0) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

export function toRoundedNumber(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

export function resolveOverallReviewScore(review) {
  if (typeof review?.score === 'number' && Number.isFinite(review.score)) {
    return review.score;
  }
  return averageNumbers(Object.values(review?.dimensionScores || {}));
}

export function buildDimensionAverageSummary(reviews) {
  return Object.fromEntries(DECISION_DIMENSIONS.map((dimension) => {
    const values = reviews
      .map((review) => review?.dimensionScores?.[dimension.id])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    return [dimension.id, {
      label: dimension.label,
      average: toRoundedNumber(averageNumbers(values)),
      reviewCount: values.length,
    }];
  }));
}

function inferModelFamilyFromFields(fields) {
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  if (/(openai|gpt)/.test(text)) return 'gpt';
  if (/(anthropic|claude)/.test(text)) return 'claude';
  if (/(google|gemini)/.test(text)) return 'gemini';
  return '';
}

function inferJudgeLens(participant) {
  const text = [
    participant?.displayName,
    participant?.profile?.name,
    participant?.profile?.model,
  ].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('gardener')) return 'gardener';
  if (text.includes('visitor')) return 'visitor';
  if (text.includes('explorer')) return 'explorer';
  return null;
}

export function buildJudgeMetadata(participant) {
  if (!participant) return null;
  const provider = safeTrim(participant?.profile?.provider, 80) || null;
  const model = safeTrim(participant?.profile?.model, 120) || null;
  const modelFamily = inferModelFamilyFromFields([
    participant.displayName,
    participant?.profile?.name,
    provider,
    model,
    participant.agentId,
  ]) || null;

  return {
    agentId: participant.agentId,
    displayName: participant.displayName,
    conceptKey: participant.conceptKey,
    modelFamily,
    provider,
    model,
    lens: inferJudgeLens(participant),
  };
}

export function parseReviewTargets(responseText, state) {
  const text = String(responseText || '').replace(/\r\n/g, '\n');
  const targetMatches = Array.from(text.matchAll(/^##\s*Target:\s*(.+)$/gim));
  if (targetMatches.length === 0) return [];

  return targetMatches.map((match, index) => {
    const targetName = safeTrim(match[1], 120);
    const start = match.index + match[0].length;
    const end = index + 1 < targetMatches.length ? targetMatches[index + 1].index : text.length;
    const block = text.slice(start, end);
    const sections = splitHeadingSections(block, '###');
    const participant = findParticipantForTarget(state, targetName);
    if (!participant) return null;
    const dimensionScores = parseDimensionScores(sections.get('dimension scores'));
    return {
      targetAgentId: participant.agentId,
      targetConceptKey: participant.conceptKey,
      score: sectionToScore(sections.get('score')),
      dimensionScores,
      keep: sectionToItems(sections.get('keep'), 10, 400),
      mustChange: sectionToItems(sections.get('must change'), 10, 400),
      risks: sectionToItems(sections.get('risks'), 10, 400),
      whyItWinsOrLoses: sectionToItems(sections.get('why it wins or loses'), 5, 400),
    };
  }).filter(Boolean);
}

export function summarizeReviewRound(round, state) {
  const parsed = (round?.responses || []).map((response) => ({
    reviewer: response,
    targets: parseReviewTargets(response.response, state),
  }));

  const reviewBlockCount = parsed.reduce((sum, entry) => sum + entry.targets.length, 0);
  const mustChangeCount = parsed.reduce((sum, entry) => (
    sum + entry.targets.reduce((inner, target) => inner + target.mustChange.length, 0)
  ), 0);

  return {
    parsed,
    reviewBlockCount,
    mustChangeCount,
  };
}

export function mergeUnique(items, maxItems = 8) {
  return normalizeList(items, maxItems, 400);
}
