// Strategy types: 'rewrite' is measured and enters the frontier.
// 'sort_dist' is advisory — audited but never benchmarked or ranked.
export const STRATEGY_TYPES = Object.freeze(['rewrite', 'sort_dist']);

// Only measured strategy types participate in the frontier.
export const MEASURED_STRATEGY_TYPES = Object.freeze(['rewrite']);

export const DEFAULTS = Object.freeze({
  plannedCandidatesPerCycle: 4,
  promoteTopK: 2,
  maxRetestCandidates: 2,
  maxRiskScore: 7,
  targetImprovementPct: 20,
  warmupRuns: 2,
  benchmarkTrials: 5,
  plateauCycles: 2,
  // Parity: full EXCEPT ALL for results under this row count,
  // grouped checksums above it.
  parityFullThreshold: 100000,
  // Timeouts
  queryTimeoutMs: 120000,
  metadataTimeoutMs: 30000,
});

// Redshift-specific risk categories for auditors.
export const RISK_CATEGORIES = Object.freeze([
  'redistribute_cost',
  'result_set_size',
  'wlm_queue_impact',
  'concurrency_scaling',
  'maintenance_window',
]);

// Redshift EXPLAIN plan step types we look for to characterise plans.
export const PLAN_STEP_TYPES = Object.freeze([
  'XN Seq Scan',
  'XN Index Scan',
  'XN Index Only Scan',
  'XN Hash Join',
  'XN Merge Join',
  'XN Nested Loop',
  'XN Sort',
  'XN Aggregate',
  'XN HashAggregate',
  'XN GroupAggregate',
  'XN Subquery Scan',
  'XN Unique',
  'XN Limit',
  'XN Window',
  'XN Network',
  'XN Materialize',
]);

// Distribution step types that indicate data movement.
export const DIST_STEP_TYPES = Object.freeze([
  'DS_DIST_NONE',
  'DS_DIST_ALL_NONE',
  'DS_DIST_INNER',
  'DS_DIST_OUTER',
  'DS_DIST_ALL_INNER',
  'DS_DIST_BOTH',
  'DS_BCAST_INNER',
]);

// Confidence thresholds — tuned for on-cluster measurement.
// Higher CV threshold than Postgres because Redshift has more variance
// from shared cluster resources, WLM queuing, and cache effects.
export const CONFIDENCE_THRESHOLDS = Object.freeze({
  // Redshift has more variance; accept slightly higher CV before discarding.
  CV_DISCARD_THRESHOLD: 25,
  // Speedup multiplier thresholds.
  HIGH_SPEEDUP_WITH_PLAN_CHANGE: 2.0,
  ACCEPT_WITHOUT_PLAN_CHANGE: 5.0,
  BASELINE_DRIFT_THRESHOLD: 20,
  RETEST_CONFIRMATION_TOLERANCE: 25,
});
