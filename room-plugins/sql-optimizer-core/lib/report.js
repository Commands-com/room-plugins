import { computeBestImprovementPct, findCandidateById, sortCandidatesForFrontier } from './candidates.js';

function resolveOwnerName(ownerId, ctx) {
  if (!ownerId || !ctx) return ownerId || '';
  const participant = ctx.getParticipant?.(ownerId);
  return participant?.displayName || ownerId;
}

export function buildFrontierRows(state, ctx) {
  return state.frontierIds
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter(Boolean)
    .map((candidate) => ({
      cycle: candidate.cycleIndex ?? '',
      strategyType: candidate.strategyType,
      proposalId: candidate.proposalId,
      medianMs: Number.isFinite(candidate.result?.medianMs)
        ? Number(candidate.result.medianMs.toFixed(1))
        : '',
      speedupPct: Number.isFinite(candidate.speedupPct)
        ? Number(candidate.speedupPct.toFixed(1))
        : '',
      indexSizeMb: Number.isFinite(candidate.indexSizeBytes)
        ? Number((candidate.indexSizeBytes / (1024 * 1024)).toFixed(2))
        : '',
      riskScore: Number.isFinite(candidate.riskScore) ? candidate.riskScore : '',
      auditFindings: (candidate.auditFindings || []).length,
      telemetryBacked: Boolean(candidate.telemetryAvailable),
      status: candidate.status,
      owner: resolveOwnerName(candidate.owner, ctx),
    }));
}

export function buildCandidateRows(state, ctx) {
  return sortCandidatesForFrontier(state.candidates).map((candidate) => ({
    cycle: candidate.cycleIndex ?? '',
    strategyType: candidate.strategyType,
    proposalId: candidate.proposalId,
    medianMs: Number.isFinite(candidate.result?.medianMs)
      ? Number(candidate.result.medianMs.toFixed(1))
      : '',
    speedupPct: Number.isFinite(candidate.speedupPct)
      ? Number(candidate.speedupPct.toFixed(1))
      : '',
    status: candidate.status,
    riskScore: Number.isFinite(candidate.riskScore) ? candidate.riskScore : '',
    auditFindings: (candidate.auditFindings || []).length,
    telemetryBacked: Boolean(candidate.telemetryAvailable),
    owner: resolveOwnerName(candidate.owner, ctx),
    notes: candidate.rejectedReason || candidate.notes || '',
  }));
}

export function countCandidateSummary(state) {
  return {
    proposed: state.proposalBacklog.length + state.activePromotedProposals.length + state.candidates.length,
    promoted: state.activePromotedProposals.length + state.candidates.length,
    benchmarked: state.candidates.filter((c) => Number.isFinite(c.result?.medianMs)).length,
    frontier: state.frontierIds.length,
    rejected: state.candidates.filter((c) => c.status === 'rejected').length,
  };
}

export function buildAuditSummaryLines(candidate) {
  const lines = [];
  const findings = candidate.auditFindings || [];
  if (findings.length === 0) return lines;

  const assessmentType = candidate.telemetryAvailable ? 'verified (production telemetry)' : 'heuristic';
  lines.push(`-- Audit Assessment: ${assessmentType}`);

  for (const finding of findings) {
    const confidence = finding.confidence || 'heuristic';
    const marker = confidence === 'verified' ? '✓' : '?';
    lines.push(`--   [${marker} ${finding.severity || 'medium'}] ${finding.category || 'general'}: ${finding.detail || 'no detail'}`);
    if (finding.recommendation) {
      lines.push(`--     → ${finding.recommendation}`);
    }
  }
  return lines;
}

/**
 * Build the solutions metric — all candidates with SQL, grouped by cycle.
 * @param {object} state
 * @param {object} engine — { buildWinnerBlock: (candidate, label) => string|null }
 */
export function buildSolutionsMetric(state, engine) {
  const buildWinnerBlock = engine?.buildWinnerBlock;
  if (!buildWinnerBlock) return null;

  const frontierSet = new Set(state.frontierIds || []);
  const measuredTypes = engine?.measuredStrategyTypes;
  const withSQL = state.candidates.filter(
    (c) => (c.applySQL || c.targetQuery || c.deploySQL)
      && (!measuredTypes || measuredTypes.includes(c.strategyType)),
  );
  if (withSQL.length === 0) return null;

  // Best first: frontier winners on top, then by speedup descending, then by cycle.
  withSQL.sort((a, b) => {
    const aFrontier = frontierSet.has(a.candidateId) ? 1 : 0;
    const bFrontier = frontierSet.has(b.candidateId) ? 1 : 0;
    if (aFrontier !== bFrontier) return bFrontier - aFrontier;
    const aSpeed = a.speedupPct ?? -Infinity;
    const bSpeed = b.speedupPct ?? -Infinity;
    if (aSpeed !== bSpeed) return bSpeed - aSpeed;
    return (a.cycleIndex ?? 0) - (b.cycleIndex ?? 0);
  });

  const blocks = withSQL.map((candidate) => {
    const content = buildWinnerBlock(candidate, candidate.proposalId || candidate.candidateId);
    if (!content) return null;

    const tags = [];
    if (frontierSet.has(candidate.candidateId)) tags.push('frontier');
    if (candidate.status === 'rejected') tags.push('rejected');
    else if (candidate.status) tags.push(candidate.status);
    const cycleTag = candidate.cycleIndex != null ? `cycle ${candidate.cycleIndex}` : '';
    const subtitle = [cycleTag, ...tags].filter(Boolean).join(' · ');

    return {
      title: `${candidate.proposalId || candidate.candidateId} — ${candidate.strategyType}`,
      subtitle,
      language: 'sql',
      content,
    };
  }).filter(Boolean);

  if (blocks.length === 0) return null;
  return { title: 'Solutions', blocks };
}

/**
 * Emit all dashboard/report metrics.
 * @param {object} ctx — room context with emitMetrics
 * @param {object} state
 * @param {object} config
 * @param {object} engine — { buildWinnerBlock, buildEngineBaselineRows, buildEngineMetrics }
 */
export function emitStateMetrics(ctx, state, config, engine) {
  const baselineMs = Number.isFinite(state.baselines?.medianMs)
    ? Number(state.baselines.medianMs.toFixed(1))
    : null;

  const baselineRows = engine?.buildEngineBaselineRows
    ? engine.buildEngineBaselineRows(state)
    : [];

  const metrics = {
    currentPhase: {
      active: state.phase,
      reached: Array.isArray(state.reachedPhases) ? [...state.reachedPhases] : [state.phase],
    },
    candidateSummary: countCandidateSummary(state),
    cycleProgress: {
      value: state.cycleIndex,
      max: ctx.limits?.maxCycles || 4,
    },
    bestImprovementPct: {
      value: computeBestImprovementPct(state),
      max: 100,
    },
    baselineMs,
    baselines: { rows: baselineRows },
    frontier: { rows: buildFrontierRows(state, ctx) },
    candidates: { rows: buildCandidateRows(state, ctx) },
    solutions: buildSolutionsMetric(state, engine),
  };

  // Let engine add extra metrics (winnerQueries, winnerIndexes, dataQuality, etc.)
  if (engine?.buildEngineMetrics) {
    Object.assign(metrics, engine.buildEngineMetrics(state, config));
  }

  ctx.emitMetrics(metrics);
}
