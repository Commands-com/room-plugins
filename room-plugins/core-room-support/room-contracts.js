export const REVIEWER_PHASES = Object.freeze({
  INITIAL_REVIEW: 'initial_review',
  HAS_OPEN_ISSUES: 'has_open_issues',
  CLEAN_REVIEW: 'clean_review',
  DONE: 'done',
  WITHDRAWN: 'withdrawn',
});

export const AGENT_ROLES = Object.freeze({
  IMPLEMENTER: 'implementer',
  REVIEWER: 'reviewer',
  WORKER: 'worker',
  CONTROLLER: 'controller',
});

export const DECISION_TYPES = Object.freeze({
  SPEAK: 'speak',
  FAN_OUT: 'fan_out',
  CONTINUE_FAN_OUT: 'continue_fan_out',
  PAUSE: 'pause',
  STOP: 'stop',
  AWAIT_APPROVAL: 'await_approval',
});

export const STOP_REASON = Object.freeze({
  USER_STOP: 'user_stop',
  FAILURE_LIMIT: 'failure_limit',
  TOKEN_BUDGET_EXHAUSTED: 'token_budget_exhausted',
  CONTEXT_LIMIT_REACHED: 'context_limit_reached',
  DURATION_LIMIT: 'duration_limit',
  TURN_LIMIT: 'turn_limit',
  CONVERGENCE: 'convergence',
  CONVERGENCE_WITH_OPEN_ISSUES: 'convergence_with_open_issues',
  CYCLE_LIMIT: 'cycle_limit',
  SYNC_FAILURE: 'sync_failure',
  PLUGIN_STOP: 'plugin_stop',
  STAGE_FAILED: 'stage_failed',
  PIPELINE_COMPLETE: 'pipeline_complete',
  NO_FEEDBACK_WINDOW: 'no_feedback_window',
  COLLECTION_IN_PROGRESS: 'collection_in_progress',
});
