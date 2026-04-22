export const PLUGIN_ID = 'quality_room';
export const TURN_LOG_MAX_CONTENT_LENGTH = 20_000;
export const HANDOFF_TEXT_LIMIT = 220;
export const HANDOFF_LIST_LIMIT = 4;

export const QUALITY_CATEGORIES = Object.freeze([
  'correctness',
  'simplicity',
  'maintainability',
  'verification',
  'scope_discipline',
]);

export const VALID_GRADES = new Set(['A', 'B', 'C', 'D', 'F']);
export const SEVERITY_ORDER = Object.freeze({
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
});
