export const PHASES = Object.freeze({
  PREFLIGHT: 'preflight',
  BASELINE: 'baseline',
  SEARCH_PLANNING: 'search_planning',
  CANDIDATE_CODEGEN: 'candidate_codegen',
  STATIC_AUDIT: 'static_audit',
  COMPILE_VALIDATE: 'compile_validate',
  BENCHMARK: 'benchmark',
  FRONTIER_REFINE: 'frontier_refine',
  COMPLETE: 'complete',
});

export const PHASE_ORDER = Object.freeze({
  [PHASES.PREFLIGHT]: 0,
  [PHASES.BASELINE]: 1,
  [PHASES.SEARCH_PLANNING]: 2,
  [PHASES.CANDIDATE_CODEGEN]: 3,
  [PHASES.STATIC_AUDIT]: 4,
  [PHASES.COMPILE_VALIDATE]: 5,
  [PHASES.BENCHMARK]: 6,
  [PHASES.FRONTIER_REFINE]: 7,
  [PHASES.COMPLETE]: 8,
});

export const DEFAULTS = Object.freeze({
  plannedCandidatesPerCycle: 9,
  promoteTopK: 3,
  validationSamples: 64,
  benchmarkWarmups: 5,
  benchmarkTrials: 30,
  maxRetestCandidates: 2,
  plateauCycles: 2,
  targetImprovementPct: 5,
  maxAuditFindingsPerCandidate: 5,
  maxCandidatesPerFamily: 3,
  targetArch: 'apple_silicon_neon',
  candidateLanguage: 'c',
  compilerCommand: 'clang',
  compilerFlags: ['-O3', '-ffast-math', '-march=native'],
  sourceContextPaths: [],
  benchmarkCommand: '',
  outputDir: '.commands/fft-autotune',
});

export const DEFAULT_FAMILIES = Object.freeze([
  Object.freeze({
    family: 'cooley_tukey_shallow',
    treeSpec: 'balanced radix-4 then radix-2 cleanup',
    leafSizes: [4, 8],
    permutationStrategy: 'bit_reverse_postpass',
    twiddleStrategy: 'precompute_table',
    simdStrategy: 'neon',
  }),
  Object.freeze({
    family: 'stockham_autosort',
    treeSpec: 'uniform stockham stages',
    leafSizes: [4],
    permutationStrategy: 'autosort',
    twiddleStrategy: 'stage_local',
    simdStrategy: 'neon',
  }),
  Object.freeze({
    family: 'split_radix_hybrid',
    treeSpec: 'split-radix with radix-4 leaves',
    leafSizes: [4, 8],
    permutationStrategy: 'recursive_inplace',
    twiddleStrategy: 'fused_twiddle_blocks',
    simdStrategy: 'neon',
  }),
]);

export const IMPLEMENTATION_FIDELITY_PATTERNS = Object.freeze([
  /fallback direct dft/i,
  /direct dft rather than/i,
  /not realize the requested fft family/i,
  /rather than a true .*fft/i,
  /not a true .*fft/i,
  /implementation fidelity mismatch/i,
]);

export const SIMD_GAP_PATTERNS = Object.freeze([
  /no explicit neon intrinsics/i,
  /scalar implementation on apple silicon target/i,
  /scalar fallback/i,
  /missing neon/i,
  /neon.*not yet/i,
  /simd gap/i,
  /lacks? neon/i,
]);

export const NONBLOCKING_FIDELITY_PATTERNS = Object.freeze([
  /diverge[s]? from promoted metadata/i,
  /fidelity still differs from the promoted/i,
  /rather than the promoted permutation\/leaf metadata/i,
  /promoted postpass bit-reversal/i,
  /promoted permutation\/leaf description/i,
]);

export const METHODOLOGY_GAP_PATTERNS = Object.freeze([
  /not apples-to-apples/i,
  /warmed before timing/i,
  /baseline still computes twiddles in-band/i,
  /warm-start throughput/i,
  /methodolog(?:y|ical)/i,
  /small-n result is not stable/i,
  /needs confirmation/i,
  /audit rerun/i,
]);

export const SOURCE_FILE_EXTENSIONS = Object.freeze([
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.m',
  '.mm',
]);

export const CODE_SNIPPET_CHAR_LIMIT = 16000;
