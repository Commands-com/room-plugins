// ---------------------------------------------------------------------------
// Shared constants for the Prototype Room plugin: phase tokens, filesystem
// scanning limits, artifact file-extension sets, and QuickLook preview
// configuration for generated PNG thumbnails.
// ---------------------------------------------------------------------------

export const PHASES = {
  BUILD: 'build',
  REVIEW: 'review',
  SYNTHESIZE: 'synthesize',
  IMPROVE: 'improve',
  COMPLETE: 'complete',
};

export const TEXT_LIMITS = {
  response: 100000,
  summary: 1200,
  readme: 16000,
  tree: 120,
  feedbackSection: 2400,
};

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
export const NONE_KEYS = new Set(['none', 'none yet', 'n a', 'na', 'nothing', 'nope']);
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
export const HTML_EXTENSIONS = new Set(['.html', '.htm']);
export const TEXT_ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.json']);
export const GENERATED_PREVIEW_DIR = '.commands-preview';
export const QUICKLOOK_PREVIEW_SIZE = 1200;
export const QUICKLOOK_TIMEOUT_MS = 5000;
