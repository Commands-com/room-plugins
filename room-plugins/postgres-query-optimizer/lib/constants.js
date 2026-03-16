export const PHASES = {
  PREFLIGHT: 'preflight',
  BASELINE: 'baseline',
  ANALYSIS: 'analysis',
  CODEGEN: 'codegen',
  STATIC_AUDIT: 'static_audit',
  EXECUTE_VALIDATE: 'execute_validate',
  EXPLAIN_ANALYZE: 'explain_analyze',
  FRONTIER_REFINE: 'frontier_refine',
  COMPLETE: 'complete',
};

export const DEFAULTS = {
  plannedCandidatesPerCycle: 4,
  promoteTopK: 2,
  maxRetestCandidates: 1,
  maxRiskScore: 7,
  targetImprovementPct: 20,
};
