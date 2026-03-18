// Shared core library for SQL optimizer room plugins.
// Engine-specific rooms import from here and provide engine hooks.

export {
  safeTrim, clampInt, optionalFiniteNumber, optionalInteger,
  normalizeStringArray, isSafeSubpath, isReadOnlyQuery, sanitizeSQL, extractQueryTableRefs,
} from './lib/utils.js';

export {
  PHASES, PHASE_ORDER, CONFIDENCE_THRESHOLDS,
} from './lib/constants.js';

export {
  setPhase, advancePhase, derivePartialPhase, createInitialState,
} from './lib/phases.js';

export {
  extractJson, assignLanes, parseWorkerEnvelope,
} from './lib/envelope.js';

export {
  isConfidentMeasurement, mergeCycleArtifacts, mergeRetestResults,
  sortCandidatesForFrontier, recomputeFrontier,
  computeBestImprovementPct, evaluateImprovement,
  chooseStopReason, selectRetestCandidates, findCandidateById,
} from './lib/candidates.js';

export {
  buildFrontierRows, buildCandidateRows, countCandidateSummary,
  buildAuditSummaryLines, buildSolutionsMetric, emitStateMetrics,
} from './lib/report.js';

export {
  enqueueProposals, selectActivePromotedProposals,
  buildRecentFailureDiagnostics, buildFrontierSummary,
  buildDataWarningsSection, buildSchemaRepairTargets, buildPendingDecision,
} from './lib/planning.js';
