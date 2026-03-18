/**
 * engine.js — Postgres-specific engine hooks for the sql-optimizer-core.
 *
 * This module defines all the engine-specific behavior that the shared core
 * needs to operate on Postgres: strategy types, plan shape comparison,
 * builder result normalization, winner block rendering, baseline display,
 * and prompt target builders.
 */

import {
  STRATEGY_TYPES, RISK_CATEGORIES,
} from './constants.js';
import {
  normalizeStringArray, safeTrim, optionalFiniteNumber,
  findCandidateById,
  buildAuditSummaryLines,
} from '../../sql-optimizer-core/index.js';
import {
  buildBaselineTargets, buildDiscoveryTargets, buildCycleTargets,
  buildAuditTargets, buildRetestTargets,
} from './planning.js';

// ---------------------------------------------------------------------------
// Strategy type detection
// ---------------------------------------------------------------------------

function detectStrategyTypeFromSQL(sql) {
  if (!sql || typeof sql !== 'string') return 'rewrite';
  return /CREATE\s+INDEX/i.test(sql) ? 'index' : 'rewrite';
}

// ---------------------------------------------------------------------------
// Postgres EXPLAIN plan shape comparison
// ---------------------------------------------------------------------------

function determinePlanShapeChanged(candidate) {
  const baseline = candidate?.baseline;
  const result = candidate?.result;
  if (!baseline || !result) return false;

  const strategyType = candidate?.strategyType || 'index';

  if (strategyType === 'index') {
    const baselineNodes = new Set(Array.isArray(baseline.leafAccessNodes) ? baseline.leafAccessNodes : []);
    const candidateNodes = new Set(Array.isArray(result.leafAccessNodes) ? result.leafAccessNodes : []);
    if (baselineNodes.size === 0 && candidateNodes.size === 0) return false;
    if (baselineNodes.size !== candidateNodes.size) return true;
    for (const node of baselineNodes) {
      if (!candidateNodes.has(node)) return true;
    }
    return false;
  }

  if (strategyType === 'rewrite') {
    if (baseline.planStructureHash && result.planStructureHash
      && baseline.planStructureHash !== result.planStructureHash) {
      return true;
    }
    const baselineSet = new Set(Array.isArray(baseline.planNodeSet) ? baseline.planNodeSet : []);
    const candidateSet = new Set(Array.isArray(result.planNodeSet) ? result.planNodeSet : []);
    if (baselineSet.size === 0 && candidateSet.size === 0) return false;
    if (baselineSet.size !== candidateSet.size) return true;
    for (const node of baselineSet) {
      if (!candidateSet.has(node)) return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Postgres-specific builder result extension
// ---------------------------------------------------------------------------

function extendBuilderResult(normalized, raw) {
  // Add Postgres EXPLAIN fields to baseline
  normalized.baseline.leafAccessNodes = normalizeStringArray(raw?.baseline?.leafAccessNodes, 20);
  normalized.baseline.planNodeSet = normalizeStringArray(raw?.baseline?.planNodeSet, 40);
  normalized.baseline.planStructureHash = safeTrim(raw?.baseline?.planStructureHash, 120);
  normalized.baseline.sharedHitBlocks = optionalFiniteNumber(raw?.baseline?.sharedHitBlocks);
  normalized.baseline.sharedReadBlocks = optionalFiniteNumber(raw?.baseline?.sharedReadBlocks);

  // Add Postgres EXPLAIN fields to candidate
  normalized.candidate.leafAccessNodes = normalizeStringArray(
    raw?.candidate?.leafAccessNodes ?? raw?.leafAccessNodes, 20);
  normalized.candidate.planNodeSet = normalizeStringArray(
    raw?.candidate?.planNodeSet ?? raw?.planNodeSet, 40);
  normalized.candidate.planStructureHash = safeTrim(
    raw?.candidate?.planStructureHash ?? raw?.planStructureHash, 120);
  normalized.candidate.sharedHitBlocks = optionalFiniteNumber(raw?.candidate?.sharedHitBlocks);
  normalized.candidate.sharedReadBlocks = optionalFiniteNumber(raw?.candidate?.sharedReadBlocks);

  return normalized;
}

// ---------------------------------------------------------------------------
// Postgres-specific winner block rendering
// ---------------------------------------------------------------------------

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
  if (candidate._planDivergenceWarning) {
    lines.push('--');
    lines.push('-- ⚠ PLAN DIVERGENCE: The harness query plan differs from the source DB.');
    lines.push('-- Speedup was measured in a scaled-down harness — verify on production.');
  }

  const auditLines = buildAuditSummaryLines(candidate);
  if (auditLines.length > 0) {
    lines.push('--');
    lines.push(...auditLines);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Postgres-specific baseline rows
// ---------------------------------------------------------------------------

function buildEngineBaselineRows(state) {
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

  if (state.totalRowsLoaded) {
    rows.push({ metric: 'Rows Loaded', value: state.totalRowsLoaded.toLocaleString() });
  }

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

// ---------------------------------------------------------------------------
// Postgres-specific extra metrics (winner code blocks, data quality)
// ---------------------------------------------------------------------------

function buildEngineMetrics(state, _config) {
  const dataTierLabels = { 0: 'demo', 1: 'seed (Tier 1)', 2: 'sampled (Tier 2)', 3: 'synthetic (Tier 3)' };
  const metrics = {
    dataQuality: {
      tier: state.dataTier != null ? state.dataTier : null,
      tierLabel: dataTierLabels[state.dataTier] || 'unknown',
      warnings: Array.isArray(state.dataWarnings) ? [...state.dataWarnings] : [],
    },
  };

  // Winner queries (rewrite)
  const rewriteWinnerId = state.bestByStrategyType?.rewrite;
  if (rewriteWinnerId) {
    const winner = findCandidateById(state, rewriteWinnerId);
    if (winner) {
      const content = buildWinnerBlock(winner, 'Rewrite Winner');
      if (content) {
        const cycleTag = winner.cycleIndex != null ? ` · cycle ${winner.cycleIndex}` : '';
        metrics.winnerQueries = {
          title: 'Optimized Query',
          blocks: [{ title: `${winner.proposalId} — rewrite`, subtitle: `winner${cycleTag}`, language: 'sql', content }],
        };
      }
    }
  }

  // Winner indexes
  const indexWinnerId = state.bestByStrategyType?.index;
  if (indexWinnerId) {
    const winner = findCandidateById(state, indexWinnerId);
    if (winner) {
      const content = buildWinnerBlock(winner, 'Index Winner');
      if (content) {
        const cycleTag = winner.cycleIndex != null ? ` · cycle ${winner.cycleIndex}` : '';
        metrics.winnerIndexes = {
          title: 'Proposed Index',
          blocks: [{ title: `${winner.proposalId} — index`, subtitle: `winner${cycleTag}`, language: 'sql', content }],
        };
      }
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Export the engine hooks object
// ---------------------------------------------------------------------------

export function createPostgresEngine() {
  return {
    strategyTypes: STRATEGY_TYPES,
    defaultStrategyType: 'index',
    riskCategories: RISK_CATEGORIES,
    determinePlanShapeChanged,
    detectStrategyTypeFromSQL,
    extendBuilderResult,
    buildWinnerBlock,
    buildEngineBaselineRows,
    buildEngineMetrics,
    targetBuilders: {
      baseline: buildBaselineTargets,
      planning: buildDiscoveryTargets,
      cycle: buildCycleTargets,
      audit: buildAuditTargets,
      retest: buildRetestTargets,
    },
  };
}
