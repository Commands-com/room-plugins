// ---------------------------------------------------------------------------
// Seed-mode resolution. Explore Room can run in "domain_search" mode (treat
// the objective as a search space) or "refine_seeded_concept" mode (treat
// the objective as an already-selected concept to sharpen). This module
// infers the default from the objective wording, builds the guidance string
// that the prompts render, and assembles the config view saved into state.
// ---------------------------------------------------------------------------

import { safeTrim } from './text-utils.js';

function inferSeedModeFromObjective(objective) {
  const text = safeTrim(objective, 2400);
  if (!text) return 'domain_search';

  const normalized = text.toLowerCase();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  let score = 0;

  if (text.length >= 80) score += 2;
  if (wordCount >= 8) score += 2;
  if (/[.:;!?]/.test(text)) score += 1;
  if (/\b(app|product|platform|tool|room|workflow|pipeline|feature|dashboard|system|prototype)\b/.test(normalized)) score += 1;
  if (/\b(help|helps|let|lets|allow|allows|build|create|design|manage|save|compare|prototype|orchestrate|plan)\b/.test(normalized)) score += 1;
  if (/\b(that|which|for)\b/.test(normalized)) score += 1;
  if (wordCount <= 3) score -= 2;

  return score >= 2 ? 'refine_seeded_concept' : 'domain_search';
}

function buildSeedGuidance(seedMode) {
  if (seedMode === 'refine_seeded_concept') {
    return [
      'Treat the seed as an already-selected concept.',
      'Keep the underlying business and product thesis fixed.',
      'Your job is to identify the product core, required user flows, prototype focus, non-mock functionality, and implementation boundaries that matter most for the prototype room.',
      'Refine and sharpen the concept for prototyping; do not reinvent it into a different business.',
    ].join(' ');
  }

  return [
    'Treat the seed as a space to search.',
    'Your job is to find the single best product concept worth sending into Prototype Room next.',
    'Choose the best business/product concept, then make the prototype-driving components explicit.',
  ].join(' ');
}

export function getConfig(ctx, objective) {
  const roomConfig = ctx?.roomConfig || {};
  const modeMap = {
    auto: 'auto',
    'domain search': 'domain_search',
    domain_search: 'domain_search',
    'refine seeded concept': 'refine_seeded_concept',
    refine_seeded_concept: 'refine_seeded_concept',
  };
  const requestedMode = modeMap[safeTrim(roomConfig.seedMode, 80).toLowerCase()] || 'auto';
  const labelMap = {
    auto: 'Auto',
    domain_search: 'Domain Search',
    refine_seeded_concept: 'Refine Seeded Concept',
  };
  const resolvedMode = requestedMode === 'auto'
    ? inferSeedModeFromObjective(objective)
    : requestedMode;
  const resolvedLabel = labelMap[resolvedMode] || 'Auto';
  return {
    requestedSeedMode: requestedMode,
    requestedSeedModeLabel: labelMap[requestedMode] || 'Auto',
    seedMode: resolvedMode,
    seedModeLabel: requestedMode === 'auto'
      ? `Auto (detected: ${resolvedLabel})`
      : resolvedLabel,
    resolvedSeedModeLabel: resolvedLabel,
    seedGuidance: buildSeedGuidance(resolvedMode),
  };
}
