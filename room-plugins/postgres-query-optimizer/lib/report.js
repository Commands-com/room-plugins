import { getConfig } from './config.js';
import { computeBestImprovementPct, findCandidateById, sortCandidatesForFrontier } from './candidates.js';

export function buildFrontierRows(state) {
  return state.frontierIds
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter(Boolean)
    .map((candidate) => ({
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
      owner: candidate.owner || '',
    }));
}

export function buildCandidateRows(state) {
  return sortCandidatesForFrontier(state.candidates).map((candidate) => ({
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
    owner: candidate.owner || '',
    notes: candidate.rejectedReason || candidate.notes || '',
  }));
}

function countCandidateSummary(state) {
  return {
    proposed: state.proposalBacklog.length + state.activePromotedProposals.length + state.candidates.length,
    promoted: state.activePromotedProposals.length + state.candidates.length,
    benchmarked: state.candidates.filter((c) => Number.isFinite(c.result?.medianMs)).length,
    frontier: state.frontierIds.length,
    rejected: state.candidates.filter((c) => c.status === 'rejected').length,
  };
}

function buildAuditSummaryLines(candidate) {
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

function buildWinnerBlock(candidate, label) {
  if (!candidate) return null;
  const speedup = Number.isFinite(candidate.speedupPct)
    ? `${candidate.speedupPct.toFixed(1)}%`
    : 'N/A';
  const baselineMs = Number.isFinite(candidate.baseline?.medianMs)
    ? `${candidate.baseline.medianMs.toFixed(1)}ms`
    : '?';
  const candidateMs = Number.isFinite(candidate.result?.medianMs)
    ? `${candidate.result.medianMs.toFixed(1)}ms`
    : '?';
  const risk = Number.isFinite(candidate.riskScore) ? `${candidate.riskScore}/10` : '?';

  const lines = [];
  if (candidate.strategyType === 'index') {
    lines.push(`-- ${label}`);
    lines.push(`-- Deploy with:`);
    lines.push(candidate.deploySQL || candidate.applySQL || '-- no SQL available');
    lines.push(`-- Speedup: ${speedup} (${baselineMs} → ${candidateMs}) — benchmarked independently`);
    lines.push(`-- Risk: ${risk}`);
    if (Number.isFinite(candidate.indexSizeBytes)) {
      lines.push(`-- Storage: ~${(candidate.indexSizeBytes / (1024 * 1024)).toFixed(1)}MB`);
    }
  } else {
    lines.push(`-- ${label}`);
    lines.push(`-- Optimized Query:`);
    lines.push(candidate.targetQuery || candidate.applySQL || '-- no SQL available');
    lines.push(`-- Speedup: ${speedup} (${baselineMs} → ${candidateMs})`);
    lines.push(`-- Risk: ${risk}`);
  }
  if (candidate.deployNotes) {
    lines.push(`-- ${candidate.deployNotes}`);
  }

  // Plan divergence warning
  if (candidate._planDivergenceWarning) {
    lines.push('--');
    lines.push('-- ⚠ PLAN DIVERGENCE: The harness query plan differs from the source DB.');
    lines.push('-- Speedup was measured in a scaled-down harness — verify on production with');
    lines.push('-- EXPLAIN (ANALYZE) after deploying. The actual speedup may differ.');
  }

  // Append audit findings with verified/heuristic distinction
  const auditLines = buildAuditSummaryLines(candidate);
  if (auditLines.length > 0) {
    lines.push('--');
    lines.push(...auditLines);
  }

  return lines.join('\n');
}

function buildWinnerQueriesMetric(state) {
  return buildWinnerQueriesWithSafe(state);
}

function buildWinnerIndexesMetric(state) {
  const indexWinnerId = state.bestByStrategyType?.index;
  if (!indexWinnerId) return null;
  const winner = findCandidateById(state, indexWinnerId);
  if (!winner) return null;
  const content = buildWinnerBlock(winner, 'Index Winner');
  if (!content) return null;

  const blocks = [{
    title: `${winner.proposalId} — ${winner.strategyType}`,
    subtitle: 'winner',
    language: 'sql',
    content,
  }];

  // If the winner exceeds risk threshold, also show the best safe alternative
  const safeWinnerId = state.safeBestByStrategyType?.index;
  if (safeWinnerId && safeWinnerId !== indexWinnerId) {
    const safeWinner = findCandidateById(state, safeWinnerId);
    if (safeWinner) {
      const safeContent = buildWinnerBlock(safeWinner, 'Lower-Risk Alternative');
      if (safeContent) {
        blocks.push({
          title: `${safeWinner.proposalId} — ${safeWinner.strategyType}`,
          subtitle: 'lower risk',
          language: 'sql',
          content: safeContent,
        });
      }
    }
  }

  return {
    title: 'Proposed Index',
    blocks,
  };
}

function buildWinnerQueriesWithSafe(state) {
  const rewriteWinnerId = state.bestByStrategyType?.rewrite;
  if (!rewriteWinnerId) return null;
  const winner = findCandidateById(state, rewriteWinnerId);
  if (!winner) return null;
  const content = buildWinnerBlock(winner, 'Rewrite Winner');
  if (!content) return null;

  const blocks = [{
    title: `${winner.proposalId} — ${winner.strategyType}`,
    subtitle: 'winner',
    language: 'sql',
    content,
  }];

  const safeWinnerId = state.safeBestByStrategyType?.rewrite;
  if (safeWinnerId && safeWinnerId !== rewriteWinnerId) {
    const safeWinner = findCandidateById(state, safeWinnerId);
    if (safeWinner) {
      const safeContent = buildWinnerBlock(safeWinner, 'Lower-Risk Alternative');
      if (safeContent) {
        blocks.push({
          title: `${safeWinner.proposalId} — ${safeWinner.strategyType}`,
          subtitle: 'lower risk',
          language: 'sql',
          content: safeContent,
        });
      }
    }
  }

  return {
    title: 'Optimized Query',
    blocks,
  };
}

function buildBaselineRows(state) {
  const b = state?.baselines;
  if (!b) return [];

  const rows = [];
  if (Number.isFinite(b.medianMs)) rows.push({ metric: 'Median', value: `${b.medianMs.toFixed(2)} ms` });
  if (Number.isFinite(b.p95Ms)) rows.push({ metric: 'P95', value: `${b.p95Ms.toFixed(2)} ms` });
  if (Number.isFinite(b.cvPct)) rows.push({ metric: 'CV%', value: `${b.cvPct.toFixed(1)}%` });
  if (Array.isArray(b.leafAccessNodes) && b.leafAccessNodes.length > 0) {
    rows.push({ metric: 'Leaf Access', value: b.leafAccessNodes.join(', ') });
  }
  if (Array.isArray(b.planNodeSet) && b.planNodeSet.length > 0) {
    rows.push({ metric: 'Plan Nodes', value: b.planNodeSet.join(', ') });
  }
  if (b.planStructureHash) rows.push({ metric: 'Plan Hash', value: b.planStructureHash });
  if (Number.isFinite(b.sharedHitBlocks)) rows.push({ metric: 'Shared Hit Blocks', value: b.sharedHitBlocks.toLocaleString() });
  if (Number.isFinite(b.sharedReadBlocks)) rows.push({ metric: 'Shared Read Blocks', value: b.sharedReadBlocks.toLocaleString() });
  if (Array.isArray(b.trials) && b.trials.length > 0) {
    rows.push({ metric: 'Trials', value: b.trials.map((t) => t.toFixed(2)).join(', ') + ' ms' });
  }

  // Actual rows loaded into harness
  if (state.totalRowsLoaded) {
    rows.push({ metric: 'Rows Loaded', value: state.totalRowsLoaded.toLocaleString() });
  }

  // Plan fidelity — use the preflight comparison result (authoritative,
  // both sides normalized for parallelism) rather than re-comparing hashes
  // from different code paths.
  if (state.sourceBaseline) {
    if (state.planDivergence) {
      rows.push({ metric: 'Plan Fidelity', value: '⚠ DIVERGED — results may not transfer' });
      if (state.planDivergence.onlyInSource?.length > 0) {
        rows.push({ metric: 'Source-only Nodes', value: state.planDivergence.onlyInSource.join(', ') });
      }
      if (state.planDivergence.onlyInHarness?.length > 0) {
        rows.push({ metric: 'Harness-only Nodes', value: state.planDivergence.onlyInHarness.join(', ') });
      }
    } else {
      rows.push({ metric: 'Plan Fidelity', value: 'Matched (source = harness)' });
    }
  }

  return rows;
}

export function emitStateMetrics(ctx, state) {
  const config = getConfig(ctx);
  const baselineMs = Number.isFinite(state.baselines?.medianMs)
    ? Number(state.baselines.medianMs.toFixed(1))
    : null;

  // Build data quality info for report consumers
  const dataTierLabels = { 0: 'demo', 1: 'seed (Tier 1)', 2: 'sampled (Tier 2)', 3: 'synthetic (Tier 3)' };
  const dataQuality = {
    tier: state.dataTier != null ? state.dataTier : null,
    tierLabel: dataTierLabels[state.dataTier] || 'unknown',
    warnings: Array.isArray(state.dataWarnings) ? [...state.dataWarnings] : [],
  };

  ctx.emitMetrics({
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
    baselines: { rows: buildBaselineRows(state) },
    dataQuality,
    frontier: { rows: buildFrontierRows(state) },
    candidates: { rows: buildCandidateRows(state) },
    winnerQueries: buildWinnerQueriesMetric(state),
    winnerIndexes: buildWinnerIndexesMetric(state),
  });
}
