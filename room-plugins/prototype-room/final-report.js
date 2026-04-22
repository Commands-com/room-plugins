// ---------------------------------------------------------------------------
// Final-report assembly. buildPrototypeBundle packs the current room state
// into a prototype_bundle.v1 payload (summary, artifacts, leaderboard,
// per-prototype metadata, provenance); buildReportArtifacts turns the bundle
// into the artifacts list that getFinalReport surfaces to the control room.
// ---------------------------------------------------------------------------

import path from 'node:path';

import { normalizeList, safeTrim } from './text-utils.js';
import {
  getFirstParagraph,
  getMarkdownTitle,
  parseDecisionItems,
  parseMarkdownSections,
} from './markdown-utils.js';
import {
  collectPrototypeSnapshot,
  inferArtifactKind,
  pickPrototypeArtifacts,
} from './prototype-fs.js';

export function buildPrototypeBundle(state) {
  const snapshots = state.participants.map((participant) => collectPrototypeSnapshot(state, participant, { generatePreviewImage: true }));
  const latestSynthesis = state.reviewSyntheses.at(-1) || null;
  const ranked = latestSynthesis?.ranked || [];
  const leaderEntry = ranked[0] || null;
  const leaderSnapshot = leaderEntry
    ? snapshots.find((snapshot) => snapshot.agentId === leaderEntry.agentId)
    : snapshots.find((snapshot) => snapshot.status === 'ready') || snapshots[0] || null;
  const leaderReadme = leaderSnapshot?.readmeContent || '';
  const sections = parseMarkdownSections(leaderReadme);
  const title = getMarkdownTitle(leaderReadme, leaderSnapshot?.prototypeLabel || 'Prototype Bundle');
  const oneLiner = getFirstParagraph(
    leaderReadme,
    leaderEntry
      ? `${leaderEntry.prototypeLabel} is currently the leading prototype direction.`
      : `Prototype room captured ${snapshots.length} prototype${snapshots.length === 1 ? '' : 's'}.`,
  );
  const recommendedDirection = leaderEntry
    ? (
        leaderEntry.mustChange.length > 0
          ? `Use ${leaderEntry.prototypeLabel} as the leading direction, but address: ${leaderEntry.mustChange.slice(0, 2).join(' | ')}`
          : `Use ${leaderEntry.prototypeLabel} as the current leading direction.`
      )
    : 'Review the prototype summaries and pick the strongest direction to carry forward.';
  const artifacts = leaderSnapshot ? pickPrototypeArtifacts(leaderSnapshot, { primary: true }) : [];

  for (const snapshot of snapshots) {
    if (!leaderSnapshot || snapshot.agentId === leaderSnapshot.agentId) continue;
    for (const artifact of pickPrototypeArtifacts(snapshot)) {
      if (artifacts.length >= 12) break;
      if (!artifacts.some((existing) => existing.path === artifact.path)) {
        artifacts.push(artifact);
      }
    }
    if (artifacts.length >= 12) break;
  }

  const designDecisions = parseDecisionItems(sections.get('design decisions'));
  const constraints = normalizeList(sections.get('constraints'), 8, 600);
  const openQuestions = normalizeList(sections.get('open questions'), 8, 600);
  const nextSteps = normalizeList(sections.get('next bets') || sections.get('next steps'), 8, 600);

  return {
    contract: 'prototype_bundle.v1',
    summary: {
      title,
      oneLiner,
      recommendedDirection: safeTrim(recommendedDirection, 500),
    },
    artifacts,
    screens: [],
    flows: [],
    designDecisions,
    constraints,
    openQuestions,
    nextSteps: nextSteps.length > 0
      ? nextSteps
      : normalizeList(leaderEntry?.mustChange || [], 6, 600),
    prototypes: snapshots.map((snapshot) => ({
      id: snapshot.prototypeKey,
      title: snapshot.prototypeLabel,
      directory: snapshot.prototypeDir,
      summaryPath: snapshot.readmePath,
      status: snapshot.status,
      summary: getFirstParagraph(snapshot.readmeContent, snapshot.readmeExcerpt || ''),
      artifactPaths: pickPrototypeArtifacts(snapshot).map((artifact) => artifact.path),
      entryHtmlPath: snapshot.entryHtmlPath || '',
      previewImagePath: snapshot.previewImagePath || '',
      previewPath: snapshot.previewImagePath || snapshot.entryHtmlPath || '',
    })),
    leaderboard: ranked.map((entry) => ({
      rank: entry.rank,
      prototypeId: entry.prototypeKey,
      prototypeTitle: entry.prototypeLabel,
      averageScore: Number(entry.averageScore.toFixed(2)),
      reviewCount: entry.reviewCount,
      mustChangeCount: entry.mustChange.length,
      riskCount: entry.risks.length,
    })),
    provenance: {
      roomType: 'prototype_room',
      generatedAt: new Date().toISOString(),
      outputDir: state.config.outputDir,
      cycleCount: state.cycleCount,
      sourceConceptId: state.conceptContext?.selectedConcept?.id || null,
      sourceConceptTitle: state.conceptContext?.selectedConcept?.title || null,
    },
  };
}

export function buildReportArtifacts(state, bundle) {
  const artifacts = [];
  const seen = new Set();

  for (const artifact of Array.isArray(bundle?.artifacts) ? bundle.artifacts : []) {
    if (!artifact?.path || seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    artifacts.push({
      type: artifact.kind || inferArtifactKind(artifact.path),
      path: artifact.path,
      label: artifact.label || path.basename(artifact.path),
      ...(artifact.primary ? { primary: true } : {}),
    });
  }

  for (const participant of state.participants) {
    const snapshot = collectPrototypeSnapshot(state, participant);
    if (!snapshot.readmePath || seen.has(snapshot.readmePath)) continue;
    seen.add(snapshot.readmePath);
    artifacts.push({
      type: 'text',
      path: snapshot.readmePath,
      label: `${participant.prototypeLabel} summary`,
    });
  }

  return artifacts;
}
