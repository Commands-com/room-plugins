// ---------------------------------------------------------------------------
// Concept-bundle handoff context. Reads the inbound concept_bundle.v1 payload
// (produced by the Explore Room) and builds the normalized conceptContext
// object that the initial state carries, plus the human-readable block that
// prompt builders splice into every prompt.
// ---------------------------------------------------------------------------

import { normalizeList, safeTrim } from './text-utils.js';

export function getInboundConceptBundle(ctx) {
  const payloads = Array.isArray(ctx?.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const payload = payloads.find((entry) => entry?.contract === 'concept_bundle.v1' && entry?.data && typeof entry.data === 'object');
  return payload?.data || null;
}

export function buildConceptContext(ctx) {
  const bundle = getInboundConceptBundle(ctx);
  if (!bundle?.selectedConcept || typeof bundle.selectedConcept !== 'object') return null;

  const selected = bundle.selectedConcept;
  return {
    seedMode: safeTrim(bundle?.seed?.resolvedMode, 120),
    seedModeLabel: safeTrim(bundle?.seed?.resolvedModeLabel, 160),
    seedGuidance: safeTrim(bundle?.seed?.guidance, 1200),
    recommendedDirection: safeTrim(bundle?.summary?.recommendedDirection, 500),
    oneLiner: safeTrim(bundle?.summary?.oneLiner, 500),
    selectedConcept: {
      id: safeTrim(selected?.id, 120),
      title: safeTrim(selected?.title, 200) || safeTrim(selected?.id, 120) || 'Selected Concept',
      oneLiner: safeTrim(selected?.oneLiner, 500),
      targetUser: safeTrim(selected?.targetUser, 500),
      problem: safeTrim(selected?.problem, 1000),
      coreValue: safeTrim(selected?.coreValue, 500),
      requiredUserFlows: normalizeList(selected?.requiredUserFlows, 10, 400),
      prototypeFocus: normalizeList(selected?.prototypeFocus, 10, 400),
      nonMockFunctionality: normalizeList(selected?.nonMockFunctionality, 10, 400),
      implementationBoundaries: normalizeList(selected?.implementationBoundaries, 10, 400),
      improvementTargets: normalizeList(selected?.improvementTargets, 10, 400),
    },
  };
}

export function buildConceptContextBlock(state) {
  const conceptContext = state.conceptContext;
  const selectedConcept = conceptContext?.selectedConcept;
  if (!selectedConcept) return '';

  return [
    'Seed concept context:',
    `- Selected concept: ${selectedConcept.title} (${selectedConcept.id})`,
    conceptContext.seedModeLabel ? `- Explore-room interpretation: ${conceptContext.seedModeLabel}` : '',
    selectedConcept.oneLiner ? `- One-liner: ${selectedConcept.oneLiner}` : '',
    selectedConcept.targetUser ? `- Target user: ${selectedConcept.targetUser}` : '',
    selectedConcept.problem ? `- Problem: ${selectedConcept.problem}` : '',
    selectedConcept.coreValue ? `- Core value: ${selectedConcept.coreValue}` : '',
    selectedConcept.requiredUserFlows.length > 0 ? `- Required user flows: ${selectedConcept.requiredUserFlows.join(' | ')}` : '',
    selectedConcept.prototypeFocus.length > 0 ? `- Prototype focus: ${selectedConcept.prototypeFocus.join(' | ')}` : '',
    selectedConcept.nonMockFunctionality.length > 0 ? `- Non-mock functionality: ${selectedConcept.nonMockFunctionality.join(' | ')}` : '',
    selectedConcept.implementationBoundaries.length > 0 ? `- Implementation boundaries: ${selectedConcept.implementationBoundaries.join(' | ')}` : '',
    selectedConcept.improvementTargets.length > 0 ? `- Improvement targets: ${selectedConcept.improvementTargets.join(' | ')}` : '',
    conceptContext.oneLiner ? `- Bundle summary: ${conceptContext.oneLiner}` : '',
    conceptContext.recommendedDirection ? `- Carry-forward guidance: ${conceptContext.recommendedDirection}` : '',
    conceptContext.seedGuidance ? `- Seed guidance: ${conceptContext.seedGuidance}` : '',
    'All prototypes in this room must stay within this selected concept.',
    'Do not invent a different business or product thesis.',
    'Compete on execution quality, UX, information architecture, and interaction model inside this concept.',
  ].filter(Boolean).join('\n');
}
