// ---------------------------------------------------------------------------
// Prompt template loading + per-phase prompt builders + target assembly.
//
// Three markdown templates under ./prompts/ are loaded at module-load time
// and rendered via {{placeholder}} substitution. Each builder threads the
// shared concept-context block and any review-synthesis/leaderboard/feedback
// context needed for the phase.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES } from './constants.js';
import { titleCase } from './text-utils.js';
import { renderPromptTemplate } from './markdown-utils.js';
import { buildConceptContextBlock } from './handoff-context.js';
import { collectPrototypeSnapshot } from './prototype-fs.js';
import { getCompletedAgentIdsForCurrentPass } from './rounds.js';
import {
  buildCompetitiveGuidance,
  buildFeedbackForParticipant,
  buildLeaderboardSummary,
  buildSynthesisSummaryForParticipant,
} from './review-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(__dirname, 'prompts');

const promptTemplates = {
  build: readFileSync(path.join(promptsDir, 'build.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
  improve: readFileSync(path.join(promptsDir, 'improve.md'), 'utf-8'),
};

function buildPeerCatalog(state, participant) {
  const peers = state.participants.filter((entry) => entry.agentId !== participant.agentId);
  if (peers.length === 0) return '- None.';

  return peers.map((peer) => {
    const snapshot = state.snapshots[peer.agentId] || collectPrototypeSnapshot(state, peer);
    const lines = [
      `### ${peer.prototypeKey}`,
      `- Label: ${peer.prototypeLabel}`,
      `- Directory: ${peer.prototypeDir}`,
      `- Summary file: ${peer.readmePath}`,
      snapshot.entryHtmlPath ? `- Canonical HTML entry: ${snapshot.entryHtmlPath}` : '- Canonical HTML entry: (missing)',
      `- Status: ${titleCase(snapshot.status)}`,
      snapshot.issue ? `- Issue: ${snapshot.issue}` : '',
      `- Visible files: ${snapshot.fileCount}`,
      '',
      'Visible file tree:',
      ...(snapshot.treeLines.length > 0 ? snapshot.treeLines : ['- None yet.']),
      '',
      'Summary excerpt:',
      snapshot.readmeExcerpt ? snapshot.readmeExcerpt : '(missing summary file)',
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
}

function buildSelfSnapshot(state, participant) {
  const snapshot = state.snapshots[participant.agentId] || collectPrototypeSnapshot(state, participant);
  return [
    `- Directory: ${participant.prototypeDir}`,
    `- Summary file: ${participant.readmePath}`,
    snapshot.entryHtmlPath ? `- Canonical HTML entry: ${snapshot.entryHtmlPath}` : '- Canonical HTML entry: (missing)',
    `- Status: ${titleCase(snapshot.status)}`,
    snapshot.issue ? `- Issue: ${snapshot.issue}` : '',
    `- Visible files: ${snapshot.fileCount}`,
    '',
    'Visible file tree:',
    ...(snapshot.treeLines.length > 0 ? snapshot.treeLines : ['- None yet.']),
    '',
    'Current summary excerpt:',
    snapshot.readmeExcerpt ? snapshot.readmeExcerpt : '(missing summary file)',
  ].filter(Boolean).join('\n');
}

function buildBuildPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.build, {
    display_name: participant.displayName,
    objective: state.objective,
    concept_context: buildConceptContextBlock(state),
    prototype_label: participant.prototypeLabel,
    prototype_key: participant.prototypeKey,
    prototype_dir: participant.prototypeDir,
    readme_path: participant.readmePath,
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    concept_context: buildConceptContextBlock(state),
    prototype_label: participant.prototypeLabel,
    prototype_dir: participant.prototypeDir,
    peer_catalog: buildPeerCatalog(state, participant),
  });
}

function buildImprovePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.improve, {
    display_name: participant.displayName,
    objective: state.objective,
    concept_context: buildConceptContextBlock(state),
    prototype_label: participant.prototypeLabel,
    prototype_dir: participant.prototypeDir,
    readme_path: participant.readmePath,
    self_snapshot: buildSelfSnapshot(state, participant),
    leaderboard_summary: buildLeaderboardSummary(state),
    synthesis_summary: buildSynthesisSummaryForParticipant(state, participant),
    competitive_guidance: buildCompetitiveGuidance(state, participant),
    review_feedback: buildFeedbackForParticipant(state, participant),
  });
}

export function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE || phase === PHASES.SYNTHESIZE) return [];

  return state.participants.map((participant) => ({
    agentId: participant.agentId,
    message: phase === PHASES.BUILD
      ? buildBuildPrompt(state, participant)
      : (phase === PHASES.REVIEW
          ? buildReviewPrompt(state, participant)
          : buildImprovePrompt(state, participant)),
  }));
}

export function buildPendingTargetsForPhase(state, phase) {
  const completed = getCompletedAgentIdsForCurrentPass(state);
  return buildTargetsForPhase(state, phase)
    .filter((target) => !completed.has(target.agentId));
}
