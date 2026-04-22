export const PHASES = {
  WRITE: 'write',
  REVIEW: 'review',
  REVISE: 'revise',
  COMPLETE: 'complete',
};

export const TEXT_LIMITS = {
  response: 60000,
  markdown: 40000,
  paragraph: 2400,
  item: 600,
};

export const NONE_KEYS = new Set(['none', 'none yet', 'n a', 'na', 'nothing', 'nope']);
