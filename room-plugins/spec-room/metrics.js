// ---------------------------------------------------------------------------
// Metric emission + handoff bundle assembly. emitMetrics fans the current
// state through the dashboard panels declared in manifest.json;
// buildSpecBundle produces the spec_bundle.v1 payload the room hands off
// downstream on completion.
// ---------------------------------------------------------------------------

import { SPEC_TEXT_LIMITS } from './constants.js';
import { ROLE_FOCUS } from './constants.js';
import { safeTrim, titleCase, excerpt } from './text-utils.js';
import {
  renderSpecMarkdown,
  estimateImplementationHints,
} from './spec-model.js';

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => ({
    phase: round.label,
    contributor: response.displayName,
    role: titleCase(response.role),
    focus: ROLE_FOCUS[response.role]?.short || titleCase(response.role),
    status: response.status || 'submitted',
    summary: excerpt(response.response, 180) || 'No response summary available.',
  })));
}

function buildArtifactMetric(state) {
  if (!state.finalSpec) return null;
  return {
    blocks: [
      {
        title: state.finalSpec.title || 'Final Spec',
        language: 'markdown',
        content: renderSpecMarkdown(state.finalSpec, state),
        path: state.exportedSpecPath || undefined,
        footer: state.exportedSpecPath
          ? `Saved to ${state.exportedSpecPath}`
          : (state.exportError ? `Spec file issue: ${state.exportError}` : undefined),
      },
    ],
  };
}

export function buildSpecBundle(state) {
  const spec = state.finalSpec || state.draftSpec;
  if (!spec) return null;

  const markdown = state.currentSpecMarkdown || renderSpecMarkdown(spec, state);
  const primaryPath = state.exportedSpecPath || state.specFilePath || '';
  const recommendedDirection = spec.proposal?.[0]
    || spec.implementationPlan?.[0]
    || `Use ${spec.title} as the canonical ${titleCase(state.config.deliverableType)}.`;
  const implementationHints = estimateImplementationHints(spec);

  return {
    contract: 'spec_bundle.v1',
    data: {
      summary: {
        title: spec.title,
        oneLiner: spec.summary,
        recommendedDirection: safeTrim(recommendedDirection, SPEC_TEXT_LIMITS.shortItem),
      },
      artifacts: primaryPath
        ? [{
            kind: 'markdown',
            path: primaryPath,
            label: 'Canonical spec',
            primary: true,
          }]
        : [],
      spec: {
        title: spec.title,
        markdown,
        problem: spec.problem,
        goals: spec.goals || [],
        nonGoals: spec.nonGoals || [],
        assumptions: spec.assumptions || [],
        prerequisites: spec.prerequisites || [],
        proposal: spec.proposal || [],
        acceptanceCriteria: spec.acceptanceCriteria || [],
        implementationPlan: spec.implementationPlan || [],
        risks: spec.risks || [],
        openQuestions: spec.openQuestions || [],
      },
      deliverableType: state.config.deliverableType,
      audience: state.config.audience,
      detailLevel: state.config.detailLevel,
      implementationHints,
      provenance: {
        roomType: 'spec_room',
        generatedAt: new Date().toISOString(),
        specFilePath: primaryPath || null,
        passCount: state.passCount,
        sourcePrototypeId: state.prototypeContext?.selectedPrototype?.id || null,
        sourcePrototypeTitle: state.prototypeContext?.selectedPrototype?.title || null,
        sourcePrototypeEntryHtmlPath: state.prototypeContext?.selectedPrototype?.entryHtmlPath || null,
      },
    },
  };
}

export function emitMetrics(ctx, state) {
  const activeSpec = state.finalSpec || state.draftSpec;
  const completedContributors = new Set(
    state.rounds.flatMap((round) => round.responses.map((response) => response.agentId)),
  );

  const displayNameCounts = {};
  for (const participant of state.participants) {
    const name = participant.displayName || participant.agentId;
    displayNameCounts[name] = (displayNameCounts[name] || 0) + 1;
  }

  const contributorStatus = {};
  for (const participant of state.participants) {
    const baseName = participant.displayName || participant.agentId;
    const label = displayNameCounts[baseName] > 1
      ? `${baseName} (${participant.agentId})`
      : baseName;
    contributorStatus[label] = state.agentStatus[participant.agentId] || 'idle';
  }

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    specPhase: { active: state.phase },
    specProgress: { value: Math.max(state.passCount, 1), max: state.maxPasses },
    specCounts: {
      contributors: completedContributors.size,
      criteria: activeSpec?.acceptanceCriteria?.length || 0,
      questions: activeSpec?.openQuestions?.length || 0,
      tasks: activeSpec?.implementationPlan?.length || 0,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries },
    specArtifacts: buildArtifactMetric(state),
    finalArtifacts: buildArtifactMetric(state),
  });
}
