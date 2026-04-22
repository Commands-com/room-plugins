// ---------------------------------------------------------------------------
// Shared constants for the Explore Room plugin: phase tokens, response size
// limits, the scored decision dimensions (compoundingValue, usefulness, ...)
// and a pre-built alias→id map for fuzzy matching reviewer scores against
// dimension labels in markdown responses.
// ---------------------------------------------------------------------------

import { canonicalDimensionKey } from './text-utils.js';

export const PHASES = {
  EXPLORE: 'explore',
  REFINE: 'refine',
  REVIEW: 'review',
  SYNTHESIZE: 'synthesize',
  COMPLETE: 'complete',
};

export const TEXT_LIMITS = {
  response: 60000,
  summary: 1200,
  item: 800,
  paragraph: 2400,
};

export const DECISION_DIMENSIONS = Object.freeze([
  Object.freeze({ id: 'compoundingValue', label: 'Compounding Value', aliases: ['compounding value', 'compounding_value', 'compounding'] }),
  Object.freeze({ id: 'usefulnessClarity', label: 'Usefulness & Clarity', aliases: ['usefulness clarity', 'usefulness & clarity', 'usefulness_clarity', 'usefulness', 'clarity'] }),
  Object.freeze({ id: 'noveltySurprise', label: 'Novelty & Surprise', aliases: ['novelty surprise', 'novelty & surprise', 'novelty_surprise', 'novelty', 'surprise'] }),
  Object.freeze({ id: 'feasibility', label: 'Feasibility', aliases: ['feasibility'] }),
  Object.freeze({ id: 'legibility', label: 'Legibility', aliases: ['legibility'] }),
  Object.freeze({ id: 'continuity', label: 'Continuity', aliases: ['continuity'] }),
  Object.freeze({ id: 'shareability', label: 'Shareability', aliases: ['shareability', 'shareable', 'shareable potential'] }),
]);

export const DIMENSION_ALIAS_TO_ID = new Map(
  DECISION_DIMENSIONS.flatMap((dimension) => [
    [canonicalDimensionKey(dimension.label), dimension.id],
    ...dimension.aliases.map((alias) => [canonicalDimensionKey(alias), dimension.id]),
  ]),
);
