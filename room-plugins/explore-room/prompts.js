// ---------------------------------------------------------------------------
// Prompt template loading + per-phase prompt builders + target assembly.
//
// Three markdown templates under ./prompts/ are loaded at module-load time
// and rendered via {{placeholder}} substitution. Each builder splices in the
// seed-mode label/guidance, the current cycle, and (for refine/review) the
// peer context or selected-concept context.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES } from './constants.js';
import { safeTrim } from './text-utils.js';
import { renderPromptTemplate } from './markdown-utils.js';
import { ensureRound } from './rounds.js';
import {
  buildConceptMarkdown,
  getLatestConcepts,
  getParticipantConceptForCycle,
} from './concept-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(__dirname, 'prompts');

const promptTemplates = {
  explore: readFileSync(path.join(promptsDir, 'explore.md'), 'utf-8'),
  refine: readFileSync(path.join(promptsDir, 'refine.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
};

function buildPeerCatalog(state, participant) {
  const peers = getLatestConcepts(state).filter((candidate) => candidate.agentId !== participant.agentId);
  if (peers.length === 0) return '- None.';
  return peers.map((candidate) => [
    `### ${candidate.conceptKey}`,
    `- Title: ${candidate.title}`,
    candidate.oneLiner ? `- One-liner: ${candidate.oneLiner}` : '',
    candidate.targetUser ? `- Target user: ${candidate.targetUser}` : '',
    candidate.problem ? `- Problem: ${candidate.problem}` : '',
    candidate.coreValue ? `- Core value: ${candidate.coreValue}` : '',
    candidate.requiredUserFlows.length > 0 ? `- Required user flows: ${candidate.requiredUserFlows.join(' | ')}` : '',
    candidate.prototypeFocus.length > 0 ? `- Prototype focus: ${candidate.prototypeFocus.join(' | ')}` : '',
    candidate.nonMockFunctionality.length > 0 ? `- Non-mock functionality: ${candidate.nonMockFunctionality.join(' | ')}` : '',
    candidate.implementationBoundaries.length > 0 ? `- Implementation boundaries: ${candidate.implementationBoundaries.join(' | ')}` : '',
    candidate.risks.length > 0 ? `- Risks: ${candidate.risks.join(' | ')}` : '',
    candidate.whyThisCouldWin ? `- Why this could win: ${candidate.whyThisCouldWin}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function buildExplorePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.explore, {
    display_name: participant.displayName,
    objective: state.objective,
    seed_mode_label: state.config.seedModeLabel,
    seed_guidance: state.config.seedGuidance,
  });
}

function buildRefinePrompt(state, participant) {
  const selected = state.synthesis?.selected || null;
  const previousConcept = state.cycleCount > 1
    ? getParticipantConceptForCycle(state, participant, state.cycleCount - 1)
    : null;

  return renderPromptTemplate(promptTemplates.refine, {
    display_name: participant.displayName,
    objective: state.objective,
    seed_mode_label: state.config.seedModeLabel,
    seed_guidance: state.config.seedGuidance,
    cycle_index: String(state.cycleCount),
    max_cycles: String(state.maxCycles),
    selected_concept_markdown: selected ? buildConceptMarkdown(selected) : '_No selected concept yet._',
    synthesis_markdown: safeTrim(state.synthesis?.markdown, 12000) || '_No synthesis yet._',
    previous_concept_markdown: previousConcept ? buildConceptMarkdown(previousConcept) : '_No previous concept brief yet._',
    refinement_targets: selected?.mustChange?.length
      ? selected.mustChange.map((item) => `- ${item}`).join('\n')
      : '- None yet.',
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    seed_mode_label: state.config.seedModeLabel,
    seed_guidance: state.config.seedGuidance,
    cycle_index: String(state.cycleCount),
    peer_catalog: buildPeerCatalog(state, participant),
  });
}

export function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE || phase === PHASES.SYNTHESIZE) return [];
  return state.participants.map((participant) => ({
    agentId: participant.agentId,
    message: phase === PHASES.EXPLORE
      ? buildExplorePrompt(state, participant)
      : phase === PHASES.REFINE
        ? buildRefinePrompt(state, participant)
        : buildReviewPrompt(state, participant),
  }));
}

export function buildPendingTargetsForPhase(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  const completed = new Set(round.responses.map((response) => response.agentId));
  return buildTargetsForPhase(state, phase).filter((target) => !completed.has(target.agentId));
}
