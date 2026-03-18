import { PHASES } from './constants.js';
import { findCandidateById } from './candidates.js';
import { safeTrim } from './utils.js';

// ---------------------------------------------------------------------------
// Proposal management (engine-agnostic)
// ---------------------------------------------------------------------------

export function enqueueProposals(state, proposals, _config) {
  if (!Array.isArray(proposals) || proposals.length === 0) return;

  const existingIds = new Set([
    ...state.proposalBacklog.map((p) => p.proposalId),
    ...state.activePromotedProposals.map((p) => p.proposalId),
    ...state.candidates.map((c) => c.proposalId),
  ]);

  for (const proposal of proposals) {
    if (!proposal.proposalId || existingIds.has(proposal.proposalId)) continue;
    if (!proposal.applySQL && proposal.strategyType !== 'rewrite') continue;
    if (proposal.strategyType === 'rewrite' && !proposal.targetQuery && !proposal.applySQL) continue;
    existingIds.add(proposal.proposalId);
    state.proposalBacklog.push(proposal);
  }
}

export function selectActivePromotedProposals(state, config) {
  const topK = config.promoteTopK || 2;
  state.activePromotedProposals = state.proposalBacklog.splice(0, topK);
}

// ---------------------------------------------------------------------------
// Mutation hint generation (engine-agnostic scaffolding)
// ---------------------------------------------------------------------------

export function buildRecentFailureDiagnostics(state) {
  return state.candidates
    .filter((c) => c.status === 'rejected')
    .sort((a, b) => (b.cycleIndex || 0) - (a.cycleIndex || 0))
    .slice(0, 5)
    .map((c) => ({
      proposalId: c.proposalId,
      strategyType: c.strategyType,
      rejectedReason: c.rejectedReason || 'unknown',
      speedupPct: c.speedupPct,
      notes: c.notes,
    }));
}

export function buildFrontierSummary(state) {
  return state.frontierIds
    .map((id) => findCandidateById(state, id))
    .filter(Boolean)
    .map((c) => `  - ${c.proposalId} (${c.strategyType}): ${c.speedupPct?.toFixed(1)}% speedup`);
}

export function buildDataWarningsSection(state) {
  const warnings = state.dataWarnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  const lines = ['## Data Quality Warnings'];
  for (const w of warnings) {
    lines.push(`- ${w}`);
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------------------
// Schema repair target builder (engine-agnostic)
// ---------------------------------------------------------------------------

export function buildSchemaRepairTargets(ctx, state, _config) {
  const repairResponses = state.schemaRepairBuilderResponses || [];
  const summaries = repairResponses.map((r) =>
    `Builder ${r.displayName}: ${safeTrim(r.response, 2000)}`,
  ).join('\n\n---\n\n');

  return ctx.participants.filter((p) => p.role === 'auditor').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Auditor in a SQL Query Optimization room.`,
      `The builder's cycle did not produce any new candidate artifacts.`,
      `Below are the builder responses. Review them for schema issues, connection problems,`,
      `or other errors that prevented successful benchmarking.`,
      '',
      `## Builder Responses`,
      summaries,
      '',
      `If you can extract valid results from the builder responses, format them as JSON.`,
      `Otherwise, explain what went wrong so the next cycle can adapt.`,
      '',
      `Reply with JSON matching the builder result format if possible, or an audit with findings.`,
    ].join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Decision router
// Engine provides targetBuilders: { baseline, planning, cycle, audit, retest }
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx
 * @param {object} state
 * @param {object} config
 * @param {object} engine — { targetBuilders: { baseline, planning, cycle, audit, retest } }
 */
export function buildPendingDecision(ctx, state, config, engine) {
  const builders = engine?.targetBuilders || {};

  if (state.pendingFanOut === 'baseline' || state.phase === PHASES.BASELINE) {
    const targets = builders.baseline?.(ctx, state, config);
    return targets ? { type: 'fan_out', targets } : null;
  }
  if (state.pendingFanOut === 'planning' || state.phase === PHASES.ANALYSIS) {
    const targets = builders.planning?.(ctx, state, config);
    return targets ? { type: 'fan_out', targets } : null;
  }
  if (state.pendingFanOut === 'cycle' || state.phase === PHASES.CODEGEN) {
    const targets = builders.cycle?.(ctx, state, config);
    return targets ? { type: 'fan_out', targets } : null;
  }
  if (state.pendingFanOut === 'audit' || state.phase === PHASES.STATIC_AUDIT) {
    const targets = builders.audit?.(ctx, state, config);
    return targets ? { type: 'fan_out', targets } : null;
  }
  if (state.pendingFanOut === 'schema_repair') {
    return { type: 'fan_out', targets: buildSchemaRepairTargets(ctx, state, config) };
  }
  if (state.pendingFanOut === 'retest') {
    const targets = builders.retest?.(ctx, state, config);
    return targets ? { type: 'fan_out', targets } : null;
  }
  if (state.pendingFanOut === 'synthesis') {
    const targets = builders.synthesis?.(ctx, state, config);
    return targets ? { type: 'fan_out', targets } : null;
  }
  return null;
}
