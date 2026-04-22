// ---------------------------------------------------------------------------
// concept_bundle.v1 assembly. Turns the synthesis ranking into the
// downstream payload: selected concept + alternatives + candidates (with
// reviewer breakdown + dimension averages), leaderboard, judge panel, and
// provenance. synthesizeConcepts is invoked if it hasn't already run.
// ---------------------------------------------------------------------------

import { DECISION_DIMENSIONS } from './constants.js';
import {
  buildJudgeMetadata,
  mergeUnique,
  toRoundedNumber,
} from './review-model.js';
import { synthesizeConcepts } from './synthesis.js';

function buildCandidateRecord(entry) {
  return {
    rank: entry.rank,
    id: entry.conceptKey,
    title: entry.title,
    oneLiner: entry.oneLiner,
    targetUser: entry.targetUser,
    problem: entry.problem,
    coreValue: entry.coreValue,
    requiredUserFlows: entry.requiredUserFlows,
    prototypeFocus: entry.prototypeFocus,
    nonMockFunctionality: entry.nonMockFunctionality,
    implementationBoundaries: entry.implementationBoundaries,
    risks: entry.risks,
    openQuestions: entry.openQuestions,
    whyThisCouldWin: entry.whyThisCouldWin,
    keep: entry.keep,
    mustChange: entry.mustChange,
    whyItWinsOrLoses: entry.whyItWinsOrLoses,
    aggregateScores: {
      overall: toRoundedNumber(entry.averageScore),
      reviewCount: entry.reviewCount,
      dimensions: entry.dimensionAverages,
    },
    reviewerBreakdown: entry.reviewerBreakdown,
  };
}

export function buildConceptBundle(state) {
  const synthesis = state.synthesis || synthesizeConcepts(state);
  const selected = synthesis.selected;
  const judgePanel = state.participants
    .map((participant) => buildJudgeMetadata(participant))
    .filter(Boolean);
  const candidates = synthesis.ranked.map((entry) => buildCandidateRecord(entry));
  if (!selected) {
    return {
      contract: 'concept_bundle.v1',
      summary: {
        title: 'No concept selected',
        oneLiner: '',
        recommendedDirection: 'Run Explore Room again with more concrete concept briefs.',
      },
      seed: {
        objective: state.objective,
        requestedMode: state.config.requestedSeedMode,
        requestedModeLabel: state.config.requestedSeedModeLabel,
        resolvedMode: state.config.seedMode,
        resolvedModeLabel: state.config.resolvedSeedModeLabel,
        guidance: state.config.seedGuidance,
      },
      selectedConcept: null,
      alternatives: [],
      candidates: [],
      leaderboard: [],
      judgePanel,
      decision: {
        selectedConceptId: null,
        selectedConceptTitle: null,
        scoringDimensions: DECISION_DIMENSIONS.map((dimension) => ({
          id: dimension.id,
          label: dimension.label,
        })),
        reviewBlockCount: synthesis.reviewBlockCount || 0,
        candidateCount: 0,
      },
      provenance: {
        roomType: 'explore_room',
        generatedAt: new Date().toISOString(),
        seedMode: state.config.seedMode,
        requestedSeedMode: state.config.requestedSeedMode,
        cycleCount: state.cycleCount,
        objective: state.objective,
      },
    };
  }

  return {
    contract: 'concept_bundle.v1',
    summary: {
      title: selected.title,
      oneLiner: selected.oneLiner,
      recommendedDirection: selected.mustChange.length > 0
        ? (state.config.seedMode === 'refine_seeded_concept'
            ? `Prototype the seeded concept using ${selected.title} as the guide, but address: ${selected.mustChange.slice(0, 2).join(' | ')}`
            : `Prototype ${selected.title}, but address: ${selected.mustChange.slice(0, 2).join(' | ')}`)
        : (state.config.seedMode === 'refine_seeded_concept'
            ? `Prototype the seeded concept using ${selected.title} as the guide.`
            : `Prototype ${selected.title}.`),
    },
    seed: {
      objective: state.objective,
      requestedMode: state.config.requestedSeedMode,
      requestedModeLabel: state.config.requestedSeedModeLabel,
      resolvedMode: state.config.seedMode,
      resolvedModeLabel: state.config.resolvedSeedModeLabel,
      guidance: state.config.seedGuidance,
    },
    selection: {
      mode: state.config.seedMode,
      conceptId: selected.conceptKey,
      conceptTitle: selected.title,
      rationale: mergeUnique([
        selected.whyThisCouldWin,
        ...selected.whyItWinsOrLoses,
        ...selected.keep,
      ], 6),
    },
    selectedConcept: {
      id: selected.conceptKey,
      title: selected.title,
      oneLiner: selected.oneLiner,
      targetUser: selected.targetUser,
      problem: selected.problem,
      coreValue: selected.coreValue,
      requiredUserFlows: selected.requiredUserFlows,
      prototypeFocus: selected.prototypeFocus,
      nonMockFunctionality: selected.nonMockFunctionality,
      implementationBoundaries: selected.implementationBoundaries,
      risks: selected.risks,
      openQuestions: selected.openQuestions,
      whyThisCouldWin: selected.whyThisCouldWin,
      improvementTargets: selected.mustChange,
      aggregateScores: {
        overall: toRoundedNumber(selected.averageScore),
        reviewCount: selected.reviewCount,
        dimensions: selected.dimensionAverages,
      },
      reviewerBreakdown: selected.reviewerBreakdown,
    },
    alternatives: synthesis.ranked.slice(1).map((entry) => ({
      id: entry.conceptKey,
      title: entry.title,
      oneLiner: entry.oneLiner,
      averageScore: Number(entry.averageScore.toFixed(2)),
      aggregateScores: {
        overall: toRoundedNumber(entry.averageScore),
        reviewCount: entry.reviewCount,
        dimensions: entry.dimensionAverages,
      },
      whyItLost: entry.mustChange[0] || entry.risks[0] || '',
    })),
    candidates,
    leaderboard: synthesis.ranked.map((entry) => ({
      rank: entry.rank,
      conceptId: entry.conceptKey,
      conceptTitle: entry.title,
      averageScore: Number(entry.averageScore.toFixed(2)),
      reviewCount: entry.reviewCount,
      mustChangeCount: entry.mustChange.length,
      riskCount: entry.risks.length,
      dimensionAverages: entry.dimensionAverages,
    })),
    judgePanel,
    decision: {
      selectedConceptId: selected.conceptKey,
      selectedConceptTitle: selected.title,
      scoringDimensions: DECISION_DIMENSIONS.map((dimension) => ({
        id: dimension.id,
        label: dimension.label,
      })),
      reviewBlockCount: synthesis.reviewBlockCount,
      candidateCount: candidates.length,
    },
    provenance: {
      roomType: 'explore_room',
      generatedAt: new Date().toISOString(),
      seedMode: state.config.seedMode,
      requestedSeedMode: state.config.requestedSeedMode,
      cycleCount: state.cycleCount,
      objective: state.objective,
    },
  };
}
