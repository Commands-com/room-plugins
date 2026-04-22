// ---------------------------------------------------------------------------
// UI/UX Testing plugin-wide constants. PHASES is a frozen map of phase
// tokens used throughout the state machine; TURN_LOG_MAX caps the size of
// any individual turnLog entry to prevent unbounded state growth.
// ---------------------------------------------------------------------------

export const PLUGIN_ID = 'ui_ux_testing';
export const TURN_LOG_MAX = 20_000;

export const PHASES = Object.freeze({
  DISCOVERY: 'discovery',
  SCENARIO_PLANNING: 'scenario_planning',
  TEST_WRITING: 'test_writing',
  TEST_EXECUTION: 'test_execution',
  FIX_RETRY: 'fix_retry',
  EVALUATION: 'evaluation',
  COMPLETE: 'complete',
});
