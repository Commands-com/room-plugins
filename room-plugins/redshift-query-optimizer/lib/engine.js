/**
 * engine.js — Redshift-specific engine hooks for the sql-optimizer-core.
 *
 * Defines strategy types, plan shape comparison, builder result normalization,
 * winner block rendering, baseline display, and prompt target builders.
 *
 * Key difference from Postgres: only 'rewrite' is a measured strategy type.
 * 'sort_dist' is advisory — audited but never benchmarked or frontier-ranked.
 */

import {
  STRATEGY_TYPES, MEASURED_STRATEGY_TYPES, RISK_CATEGORIES,
  CONFIDENCE_THRESHOLDS as RS_CONFIDENCE_THRESHOLDS,
} from './constants.js';

// Redshift returns 9999999999999999... when the planner overflows cost estimation.
// Treat anything above 1e15 as a sentinel — not a real cost.
const COST_SENTINEL_THRESHOLD = 1e15;
import {
  normalizeStringArray, safeTrim, optionalFiniteNumber,
  findCandidateById,
  buildAuditSummaryLines, buildCommonBaselineRows, buildWinnerBlockHeader,
} from '../../sql-optimizer-core/index.js';
import {
  buildBaselineTargets, buildDiscoveryTargets, buildCycleTargets,
  buildAuditTargets, buildRetestTargets, buildSynthesisTargets,
} from './planning.js';

// ---------------------------------------------------------------------------
// Robust CV computation — resistant to WLM queue outliers
// ---------------------------------------------------------------------------

/**
 * Compute MAD-based CV from raw timings. On a shared Redshift cluster, WLM
 * queuing creates occasional spikes that inflate standard deviation.
 * MAD (Median Absolute Deviation) is robust to these outliers.
 *
 * Returns undefined if raw timings are not available (caller falls back to
 * the reported cvPct).
 */
function computeRobustCV(baselines) {
  const timings = baselines?.trials || baselines?.timings;
  if (!Array.isArray(timings)) return undefined;
  const values = timings.filter(Number.isFinite);
  if (values.length < 4) return undefined;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  if (median <= 0) return undefined;

  const deviations = sorted.map((t) => Math.abs(t - median)).sort((a, b) => a - b);
  const dMid = Math.floor(deviations.length / 2);
  const mad = deviations.length % 2 === 0
    ? (deviations[dMid - 1] + deviations[dMid]) / 2
    : deviations[dMid];

  return (mad / median) * 100;
}

// ---------------------------------------------------------------------------
// Strategy type detection
// ---------------------------------------------------------------------------

function detectStrategyTypeFromSQL(sql) {
  if (!sql || typeof sql !== 'string') return 'rewrite';
  // sort_dist recommendations are ALTER TABLE ... SORTKEY/DISTKEY/DISTSTYLE
  if (/ALTER\s+TABLE\s+.+\s+(COMPOUND\s+)?SORTKEY/i.test(sql)) return 'sort_dist';
  if (/ALTER\s+TABLE\s+.+\s+DIST(KEY|STYLE)/i.test(sql)) return 'sort_dist';
  return 'rewrite';
}

// ---------------------------------------------------------------------------
// Redshift EXPLAIN plan shape comparison
// ---------------------------------------------------------------------------

function determinePlanShapeChanged(candidate) {
  const baseline = candidate?.baseline;
  const result = candidate?.result;
  if (!baseline || !result) return false;

  // Compare step type sets
  const baselineSteps = new Set(Array.isArray(baseline.stepTypes) ? baseline.stepTypes : []);
  const candidateSteps = new Set(Array.isArray(result.stepTypes) ? result.stepTypes : []);
  if (baselineSteps.size === 0 && candidateSteps.size === 0) return false;
  if (baselineSteps.size !== candidateSteps.size) return true;
  for (const step of baselineSteps) {
    if (!candidateSteps.has(step)) return true;
  }

  // Compare distribution steps (data movement patterns)
  const baselineDist = (baseline.distSteps || []).sort().join(',');
  const candidateDist = (result.distSteps || []).sort().join(',');
  if (baselineDist !== candidateDist) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Redshift-specific builder result extension
// ---------------------------------------------------------------------------

function sanitizeCost(value) {
  const n = optionalFiniteNumber(value);
  if (!Number.isFinite(n)) return undefined;
  // Redshift sentinel for planner overflow — not a meaningful cost.
  return n >= COST_SENTINEL_THRESHOLD ? undefined : n;
}

function normalizeTrials(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(Number.isFinite).slice(0, 100);
}

function extendBuilderResult(normalized, raw) {
  // Add Redshift-specific fields to baseline
  normalized.baseline.stepTypes = normalizeStringArray(raw?.baseline?.stepTypes, 30);
  normalized.baseline.distSteps = normalizeStringArray(raw?.baseline?.distSteps, 20);
  normalized.baseline.totalCost = sanitizeCost(raw?.baseline?.totalCost);
  normalized.baseline.bytesScanned = optionalFiniteNumber(raw?.baseline?.bytesScanned);
  normalized.baseline.rowsReturned = optionalFiniteNumber(raw?.baseline?.rowsReturned);
  normalized.baseline.planText = safeTrim(raw?.baseline?.planText, 8000);
  normalized.baseline.trials = normalizeTrials(raw?.baseline?.trials || raw?.baseline?.timings);

  // Add Redshift-specific fields to candidate
  normalized.candidate.stepTypes = normalizeStringArray(
    raw?.candidate?.stepTypes ?? raw?.stepTypes, 30);
  normalized.candidate.distSteps = normalizeStringArray(
    raw?.candidate?.distSteps ?? raw?.distSteps, 20);
  normalized.candidate.totalCost = sanitizeCost(
    raw?.candidate?.totalCost ?? raw?.totalCost);
  normalized.candidate.bytesScanned = optionalFiniteNumber(
    raw?.candidate?.bytesScanned ?? raw?.bytesScanned);
  normalized.candidate.rowsReturned = optionalFiniteNumber(
    raw?.candidate?.rowsReturned ?? raw?.rowsReturned);
  normalized.candidate.planText = safeTrim(
    raw?.candidate?.planText ?? raw?.planText, 8000);
  normalized.candidate.trials = normalizeTrials(
    raw?.candidate?.trials ?? raw?.candidate?.timings ?? raw?.trials ?? raw?.timings);

  return normalized;
}

// ---------------------------------------------------------------------------
// Redshift-specific winner block rendering
// ---------------------------------------------------------------------------

function buildWinnerBlock(candidate, label) {
  const header = buildWinnerBlockHeader(candidate, label);
  if (!header) return null;

  const lines = [];
  if (candidate.strategyType === 'sort_dist') {
    lines.push(`-- ${header.label} [ADVISORY — not benchmarked]`);
    lines.push(`-- Recommendation:`);
    lines.push(candidate.applySQL || '-- no SQL available');
    lines.push(`-- Risk: ${header.risk}`);
    if (candidate.rationale) {
      lines.push(`-- Rationale: ${candidate.rationale}`);
    }
    lines.push(`-- NOTE: Requires table rebuild. Test on a staging cluster before production.`);
  } else {
    lines.push(`-- ${header.label}`);
    lines.push(`-- Optimized Query:`);
    lines.push(candidate.targetQuery || candidate.applySQL || '-- no SQL available');
    lines.push(`-- Speedup: ${header.speedup} (${header.baselineMs} → ${header.candidateMs}) — measured on cluster`);
    lines.push(`-- Risk: ${header.risk}`);

    // Distribution step changes
    const baselineDist = candidate.baseline?.distSteps || [];
    const candidateDist = candidate.result?.distSteps || [];
    if (baselineDist.length > 0 || candidateDist.length > 0) {
      const removed = baselineDist.filter((d) => !candidateDist.includes(d));
      const added = candidateDist.filter((d) => !baselineDist.includes(d));
      if (removed.length > 0) lines.push(`-- Eliminated redistribution: ${removed.join(', ')}`);
      if (added.length > 0) lines.push(`-- Added redistribution: ${added.join(', ')}`);
    }

    // Bytes scanned comparison
    const baselineBytes = candidate.baseline?.bytesScanned;
    const candidateBytes = candidate.result?.bytesScanned;
    if (Number.isFinite(baselineBytes) && Number.isFinite(candidateBytes) && baselineBytes > 0) {
      const reduction = ((baselineBytes - candidateBytes) / baselineBytes * 100).toFixed(1);
      lines.push(`-- Bytes scanned: ${reduction}% ${candidateBytes < baselineBytes ? 'reduction' : 'increase'}`);
    }
  }

  if (candidate.deployNotes) {
    lines.push(`-- ${candidate.deployNotes}`);
  }

  const auditLines = buildAuditSummaryLines(candidate);
  if (auditLines.length > 0) {
    lines.push('--');
    lines.push(...auditLines);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Redshift-specific baseline rows
// ---------------------------------------------------------------------------

function buildEngineBaselineRows(state) {
  const b = state?.baselines;
  if (!b) return [];

  const rows = buildCommonBaselineRows(b);
  if (Array.isArray(b.stepTypes) && b.stepTypes.length > 0) {
    rows.push({ metric: 'Plan Steps', value: b.stepTypes.join(', ') });
  }
  if (Array.isArray(b.distSteps) && b.distSteps.length > 0) {
    rows.push({ metric: 'Redistribution', value: b.distSteps.join(', ') });
  }
  if (Number.isFinite(b.totalCost) && b.totalCost < COST_SENTINEL_THRESHOLD) {
    rows.push({ metric: 'Total Cost', value: b.totalCost.toLocaleString() });
  } else if (Number.isFinite(b.totalCost)) {
    rows.push({ metric: 'Total Cost', value: 'N/A (planner overflow)' });
  }
  if (Number.isFinite(b.bytesScanned)) rows.push({ metric: 'Bytes Scanned', value: formatBytes(b.bytesScanned) });
  if (Array.isArray(b.trials) && b.trials.length > 0) {
    rows.push({ metric: 'Trials', value: b.trials.map((t) => t.toFixed(2)).join(', ') + ' ms' });
  }

  return rows;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Redshift-specific extra metrics
// ---------------------------------------------------------------------------

function buildRecommendedPlanMetric(state) {
  const plan = state.synthesisResult;
  if (!plan || !Array.isArray(plan.ranking) || plan.ranking.length === 0) return null;

  const candidateMap = new Map(
    (state.candidates || []).map((c) => [c.proposalId || c.candidateId, c]),
  );

  const blocks = plan.ranking.map((entry) => {
    const candidate = candidateMap.get(entry.proposalId);
    if (!candidate) return null;

    const type = candidate.strategyType === 'sort_dist' ? 'ADVISORY' : 'rewrite';
    const sql = candidate.targetQuery || candidate.applySQL || '-- no SQL';
    const speedup = Number.isFinite(candidate.speedupPct)
      ? `${candidate.speedupPct.toFixed(1)}% speedup`
      : type === 'ADVISORY' ? 'not benchmarked' : 'no measurement';

    const lines = [
      `-- ${speedup}`,
      sql,
    ];
    if (entry.rationale) {
      lines.push(`-- Rationale: ${entry.rationale}`);
    }

    const votes = (plan.votes || [])
      .filter((v) => (v.ranking || []).some((r) => r.proposalId === entry.proposalId))
      .map((v) => {
        const r = v.ranking.find((r2) => r2.proposalId === entry.proposalId);
        return `${v.role}=#${r?.rank || '?'}`;
      });
    const voteStr = votes.length > 0 ? `votes: ${votes.join(', ')}` : '';

    return {
      title: `#${entry.rank} — ${entry.proposalId} (${type})`,
      subtitle: voteStr,
      language: 'sql',
      content: lines.join('\n'),
    };
  }).filter(Boolean);

  if (blocks.length === 0) return null;

  const assessment = plan.overallAssessment || '';
  if (assessment) {
    blocks.push({
      title: 'Overall Assessment',
      subtitle: `${(plan.votes || []).length} agent(s) voted`,
      language: 'text',
      content: assessment,
    });
  }

  return { title: 'Recommended Deployment Plan', blocks };
}

function buildEngineMetrics(state, _config) {
  const metrics = {};

  // Recommended deployment plan (from synthesis phase)
  const recommendedPlan = buildRecommendedPlanMetric(state);
  if (recommendedPlan) {
    metrics.recommendedPlan = recommendedPlan;
  }

  // Winner rewrites
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

  // Advisory sort/dist key recommendations (not in frontier, separate panel)
  const advisoryCandidates = (state.candidates || []).filter(
    (c) => c.strategyType === 'sort_dist' && c.status !== 'rejected',
  );
  if (advisoryCandidates.length > 0) {
    const blocks = advisoryCandidates.map((c) => {
      const content = buildWinnerBlock(c, c.proposalId || 'Sort/Dist Key');
      if (!content) return null;
      const cycleTag = c.cycleIndex != null ? `cycle ${c.cycleIndex}` : '';
      const statusTag = c.status === 'audited' ? 'audited' : c.status || '';
      return {
        title: `${c.proposalId} — sort_dist`,
        subtitle: [cycleTag, statusTag].filter(Boolean).join(' · '),
        language: 'sql',
        content,
      };
    }).filter(Boolean);

    if (blocks.length > 0) {
      metrics.advisoryRecommendations = {
        title: 'Table Design Recommendations',
        blocks,
      };
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Export the engine hooks object
// ---------------------------------------------------------------------------

export function createRedshiftEngine() {
  return {
    strategyTypes: STRATEGY_TYPES,
    measuredStrategyTypes: MEASURED_STRATEGY_TYPES,
    defaultStrategyType: 'rewrite',
    riskCategories: RISK_CATEGORIES,
    confidenceThresholds: { ...RS_CONFIDENCE_THRESHOLDS, computeRobustCV },
    computeRobustCV,
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
      synthesis: buildSynthesisTargets,
    },
  };
}
