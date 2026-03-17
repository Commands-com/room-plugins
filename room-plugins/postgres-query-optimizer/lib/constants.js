export const PHASES = Object.freeze({
  PREFLIGHT: 'preflight',
  BASELINE: 'baseline',
  ANALYSIS: 'analysis',
  CODEGEN: 'codegen',
  STATIC_AUDIT: 'static_audit',
  FRONTIER_REFINE: 'frontier_refine',
  COMPLETE: 'complete',
});

export const PHASE_ORDER = Object.freeze({
  [PHASES.PREFLIGHT]: 0,
  [PHASES.BASELINE]: 1,
  [PHASES.ANALYSIS]: 2,
  [PHASES.CODEGEN]: 3,
  [PHASES.STATIC_AUDIT]: 4,
  [PHASES.FRONTIER_REFINE]: 5,
  [PHASES.COMPLETE]: 6,
});

export const STRATEGY_TYPES = Object.freeze(['index', 'rewrite']);

export const DEFAULTS = Object.freeze({
  plannedCandidatesPerCycle: 4,
  promoteTopK: 2,
  maxRetestCandidates: 1,
  maxRiskScore: 7,
  targetImprovementPct: 20,
  warmupRuns: 3,
  benchmarkTrials: 10,
  plateauCycles: 2,
  scaleFactor: 100000,
  postgresVersion: '16',
  schemaSource: 'introspect',
  outputDir: '.commands/postgres-tuner',
  containerMemory: '1g',
  containerCpus: '2',
});

export const BENCHMARK_GUCS = Object.freeze([
  'shared_buffers=256MB',
  'work_mem=64MB',
  'effective_cache_size=512MB',
  'random_page_cost=1.1',
  'synchronous_commit=off',
  'max_parallel_workers_per_gather=0',
  'jit=off',
  'statement_timeout=30000',
]);

export const VOLATILE_FUNCTION_PATTERNS = Object.freeze([
  /\brandom\s*\(/i,
  /\bclock_timestamp\s*\(/i,
  /\bnextval\s*\(/i,
  /\buuid_generate_v[14]\s*\(/i,
  /\bgen_random_uuid\s*\(/i,
  /\btxid_current\s*\(/i,
  /\bpg_backend_pid\s*\(/i,
]);

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH_SPEEDUP_WITH_PLAN_CHANGE: 2.0,
  ACCEPT_WITHOUT_PLAN_CHANGE: 5.0,
  CV_DISCARD_THRESHOLD: 20,
  BASELINE_DRIFT_THRESHOLD: 15,
  RETEST_CONFIRMATION_TOLERANCE: 20,
});

export const RISK_CATEGORIES = Object.freeze([
  'lock_contention',
  'storage_overhead',
  'write_amplification',
  'plan_instability',
  'migration_complexity',
]);

export const LEAF_ACCESS_NODE_TYPES = Object.freeze([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Tid Scan',
  'Tid Range Scan',
  'Subquery Scan',
  'Function Scan',
  'Values Scan',
  'CTE Scan',
  'Foreign Scan',
  'Custom Scan',
]);

export const POSTGRES_VERSIONS = Object.freeze(['14', '15', '16', '17']);
