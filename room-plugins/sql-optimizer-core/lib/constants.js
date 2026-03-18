export const PHASES = Object.freeze({
  PREFLIGHT: 'preflight',
  BASELINE: 'baseline',
  ANALYSIS: 'analysis',
  CODEGEN: 'codegen',
  STATIC_AUDIT: 'static_audit',
  FRONTIER_REFINE: 'frontier_refine',
  SYNTHESIS: 'synthesis',
  COMPLETE: 'complete',
});

export const PHASE_ORDER = Object.freeze({
  [PHASES.PREFLIGHT]: 0,
  [PHASES.BASELINE]: 1,
  [PHASES.ANALYSIS]: 2,
  [PHASES.CODEGEN]: 3,
  [PHASES.STATIC_AUDIT]: 4,
  [PHASES.FRONTIER_REFINE]: 5,
  [PHASES.SYNTHESIS]: 6,
  [PHASES.COMPLETE]: 7,
});

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH_SPEEDUP_WITH_PLAN_CHANGE: 2.0,
  ACCEPT_WITHOUT_PLAN_CHANGE: 5.0,
  CV_DISCARD_THRESHOLD: 20,
  BASELINE_DRIFT_THRESHOLD: 15,
  RETEST_CONFIRMATION_TOLERANCE: 20,
});
