// ---------------------------------------------------------------------------
// Concept model. Parses concept brief markdown (## Title, ## One Liner, ...)
// into structured records, renders records back to markdown for downstream
// prompts/artifacts, and provides lookups over the current cycle's concepts.
// ---------------------------------------------------------------------------

import { PHASES, TEXT_LIMITS } from './constants.js';
import { safeTrim, titleCase } from './text-utils.js';
import {
  sectionToItems,
  sectionToParagraph,
  splitHeadingSections,
} from './markdown-utils.js';
import { ensureRound } from './rounds.js';

export function parseConceptResponse(responseText, participant) {
  const sections = splitHeadingSections(responseText, '##');
  const title = sectionToParagraph(sections.get('title'), 200) || titleCase(participant.conceptKey);
  return {
    agentId: participant.agentId,
    displayName: participant.displayName,
    conceptKey: participant.conceptKey,
    title,
    oneLiner: sectionToParagraph(sections.get('one liner'), 300),
    targetUser: sectionToParagraph(sections.get('target user'), 300),
    problem: sectionToParagraph(sections.get('problem'), 700),
    coreValue: sectionToParagraph(sections.get('core value'), 400),
    requiredUserFlows: sectionToItems(sections.get('required user flows'), 10, 400),
    prototypeFocus: sectionToItems(sections.get('prototype focus'), 10, 400),
    nonMockFunctionality: sectionToItems(sections.get('non mock functionality'), 10, 400),
    implementationBoundaries: sectionToItems(sections.get('implementation boundaries'), 10, 400),
    risks: sectionToItems(sections.get('risks'), 8, 400),
    whyThisCouldWin: sectionToParagraph(sections.get('why this could win'), 500),
    openQuestions: sectionToItems(sections.get('open questions'), 8, 400),
    markdown: safeTrim(responseText, TEXT_LIMITS.response),
  };
}

export function getConceptPhaseForCycle(cycleIndex) {
  return cycleIndex <= 1 ? PHASES.EXPLORE : PHASES.REFINE;
}

export function getConceptsForCycle(state, cycleIndex = state.cycleCount) {
  const round = ensureRound(state, getConceptPhaseForCycle(cycleIndex), cycleIndex);
  return round.responses.map((response) => {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId) || {
      agentId: response.agentId,
      displayName: response.displayName,
      conceptKey: response.conceptKey,
    };
    return parseConceptResponse(response.response, participant);
  });
}

export function getLatestConcepts(state) {
  return getConceptsForCycle(state, state.cycleCount);
}

export function getParticipantConceptForCycle(state, participant, cycleIndex) {
  return getConceptsForCycle(state, cycleIndex).find((concept) => concept.agentId === participant.agentId) || null;
}

export function buildConceptMarkdown(candidate) {
  return [
    `# ${candidate.title}`,
    '',
    candidate.oneLiner || '_No one-liner provided._',
    '',
    '## Target User',
    candidate.targetUser || '- None yet.',
    '',
    '## Problem',
    candidate.problem || '- None yet.',
    '',
    '## Core Value',
    candidate.coreValue || '- None yet.',
    '',
    '## Required User Flows',
    ...(candidate.requiredUserFlows.length > 0 ? candidate.requiredUserFlows.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Prototype Focus',
    ...(candidate.prototypeFocus.length > 0 ? candidate.prototypeFocus.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Non-Mock Functionality',
    ...(candidate.nonMockFunctionality.length > 0 ? candidate.nonMockFunctionality.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Implementation Boundaries',
    ...(candidate.implementationBoundaries.length > 0 ? candidate.implementationBoundaries.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Risks',
    ...(candidate.risks.length > 0 ? candidate.risks.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Why This Could Win',
    candidate.whyThisCouldWin || '- None yet.',
    '',
    '## Open Questions',
    ...(candidate.openQuestions.length > 0 ? candidate.openQuestions.map((item) => `- ${item}`) : ['- None yet.']),
  ].join('\n');
}
