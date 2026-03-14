/**
 * fft-autotune plugin.test.js — Plugin tested in isolation with mock ctx.
 *
 * Tests lifecycle, convergence, reexplore fan-out, and state transitions.
 */

import { createPlugin } from '../lib/plugin.js';
import { createInitialState } from '../lib/phases.js';
import { buildCompatibilityReport } from '../lib/config.js';
import {
  selectActivePromotedProposals,
  enqueueProposals,
  winnerMutationProposals,
  buildTriedCandidatesSummary,
  buildReexplorationTargets,
  buildPlanningTargets,
  buildPendingDecision,
} from '../lib/planning.js';
import { applyAuditSeverityPolicy, chooseStopReason, recomputeFrontier, mergeCycleArtifacts } from '../lib/candidates.js';
import { buildBaselineRows } from '../lib/report.js';
import { getExpectedBucketKeys, getMissingWinnerBucketKeys } from '../lib/buckets.js';
import { PHASES } from '../lib/constants.js';

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

function makeMockCtx(overrides = {}) {
  let state = null;
  return {
    roomId: 'room_test',
    objective: 'Optimize FFT kernels for Apple Silicon',
    participants: overrides.participants || [
      { agentId: 'explorer_1', displayName: 'Explorer', role: 'explorer' },
      { agentId: 'builder_1', displayName: 'Builder', role: 'builder' },
      { agentId: 'auditor_1', displayName: 'Auditor', role: 'auditor' },
    ],
    limits: { maxCycles: 6, maxTurns: 120, ...overrides.limits },
    roomConfig: {
      workspacePath: '/tmp/fft-workspace',
      targetSizes: [64, 256, 1024],
      targetArch: 'apple_silicon_neon',
      candidateLanguage: 'c',
      compilerCommand: 'clang',
      compilerFlags: ['-O3', '-ffast-math', '-march=native'],
      sourceContextPaths: [],
      benchmarkCommand: '',
      outputDir: '/tmp/fft-workspace/.commands/fft-autotune',
      ...overrides.roomConfig,
    },
    orchestratorConfig: overrides.orchestratorConfig || {},
    getState: () => (state != null ? JSON.parse(JSON.stringify(state)) : null),
    setState: (s) => { state = s != null ? JSON.parse(JSON.stringify(s)) : null; },
    setCycle: overrides.setCycle || vi.fn(),
    emitMetrics: overrides.emitMetrics || vi.fn(),
    getFinalReport: vi.fn().mockReturnValue({}),
  };
}

function makeConfig(overrides = {}) {
  return {
    workspacePath: '/tmp/fft-workspace',
    targetSizes: [64, 256, 1024],
    targetArch: 'apple_silicon_neon',
    candidateLanguage: 'c',
    compilerCommand: 'clang',
    compilerFlags: ['-O3', '-ffast-math', '-march=native'],
    sourceContextPaths: [],
    benchmarkCommand: '',
    outputDir: '/tmp/fft-workspace/.commands/fft-autotune',
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
    ...overrides,
  };
}

function makeAllBaselines() {
  return {
    'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 1200 },
    'n256-apple_silicon_neon': { bucketKey: 'n256-apple_silicon_neon', medianNs: 5000 },
    'n1024-apple_silicon_neon': { bucketKey: 'n1024-apple_silicon_neon', medianNs: 20000 },
  };
}

function makeCandidate(bucketKey, overrides = {}) {
  return {
    candidateId: overrides.candidateId || `candidate-${bucketKey}-1`,
    cycle: overrides.cycle || 1,
    bucketKey,
    family: overrides.family || 'cooley_tukey_shallow',
    status: overrides.status || 'benchmarked',
    proposedByWorkerId: 'explorer_1',
    implementedByWorkerId: 'builder_1',
    auditedByWorkerIds: ['auditor_1'],
    lane: 'builder',
    treeSpec: 'balanced radix-4 then radix-2 cleanup',
    leafSizes: [4, 8],
    permutationStrategy: 'bit_reverse_postpass',
    twiddleStrategy: 'precompute_table',
    simdStrategy: 'neon',
    compile: { ok: true, command: 'clang ...', exitCode: 0, stderrPath: '', binaryPath: '/tmp/a.out' },
    validation: { ok: true, sampleCount: 64, maxError: 0.0004, tolerance: 0.001, failureReason: '', validationPath: '/tmp/v.json' },
    benchmark: {
      ok: true,
      warmups: 5,
      trials: 30,
      medianNs: overrides.medianNs || 1000,
      p95Ns: overrides.p95Ns || 1100,
      cvPct: overrides.cvPct || 2.0,
      speedupVsBaseline: overrides.speedupVsBaseline || 1.1,
      samplePath: '/tmp/b.json',
    },
    reportedBucketBaseline: null,
    audit: {
      openHighConfidenceFindings: overrides.openHighConfidenceFindings || 0,
      openMediumConfidenceFindings: 0,
      findingsPath: '',
    },
    artifactPaths: ['/tmp/fft-workspace/out.c'],
    notes: overrides.notes || '',
    hasBucketBaseline: overrides.hasBucketBaseline !== undefined ? overrides.hasBucketBaseline : true,
  };
}

function makeProposal(bucketKey, family, overrides = {}) {
  const size = parseInt(bucketKey.match(/^n(\d+)/)?.[1] || '64', 10);
  return {
    bucketKey,
    size,
    family,
    treeSpec: overrides.treeSpec || 'balanced radix-4 then radix-2 cleanup',
    leafSizes: overrides.leafSizes || [4, 8],
    permutationStrategy: overrides.permutationStrategy || 'bit_reverse_postpass',
    twiddleStrategy: overrides.twiddleStrategy || 'precompute_table',
    simdStrategy: overrides.simdStrategy || 'neon',
    notes: overrides.notes || '',
    proposedByWorkerId: 'explorer_1',
    lane: 'explorer',
  };
}

// ---------------------------------------------------------------------------
// Envelope parsing — alternate field names
// ---------------------------------------------------------------------------

import { parseWorkerEnvelope } from '../lib/envelope.js';

describe('parseWorkerEnvelope — alternate field names', () => {
  const worker = { agentId: 'builder_1', assignedLane: 'builder' };
  const config = makeConfig();

  it('parses compileEvidence/validationEvidence/benchmarkEvidence wrappers', () => {
    const response = JSON.stringify({
      summary: 'built candidates',
      candidates: [{
        specId: 'cycle2-n64-1',
        bucket: 'n64',
        dftSize: 64,
        familyName: 'cooley_tukey_shallow',
        treeDescription: 'Split(64, Leaf(8), Leaf(8))',
        simdStrategy: 'neon',
        compileEvidence: {
          compileCommand: 'clang -O3 ...',
          compileReturnCode: 0,
          compiledBinaryPath: '/tmp/fft-workspace/a.out',
        },
        validationEvidence: {
          validationReturnCode: 0,
          validationJson: {
            ok: true,
            sampleCount: 64,
            maxError: 0.0001,
            tolerance: 0.001,
          },
        },
        benchmarkEvidence: {
          benchmarkJson: {
            ok: true,
            warmups: 5,
            trials: 30,
            medianNs: 48.0,
            p95Ns: 52.0,
            cvPct: 3.0,
          },
        },
        artifactPaths: [],
        notes: 'NEON candidate',
      }],
    });

    const envelope = parseWorkerEnvelope(response, worker, config);
    expect(envelope.results).toHaveLength(1);

    const result = envelope.results[0];
    expect(result.proposalId).toBe('cycle2-n64-1');
    expect(result.bucketKey).toBe('n64-apple_silicon_neon');
    expect(result.family).toBe('cooley_tukey_shallow');
    expect(result.treeSpec).toBe('Split(64, Leaf(8), Leaf(8))');
    expect(result.compile.ok).toBe(true);
    expect(result.compile.command).toBe('clang -O3 ...');
    expect(result.compile.binaryPath).toBe('/tmp/fft-workspace/a.out');
    expect(result.validation.ok).toBe(true);
    expect(result.validation.maxError).toBeCloseTo(0.0001);
    expect(result.benchmark.ok).toBe(true);
    expect(result.benchmark.medianNs).toBeCloseTo(48.0);
  });

  it('still parses the standard field names', () => {
    const response = JSON.stringify({
      summary: 'built candidate',
      results: [{
        proposalId: 'cycle1-n64-1',
        bucketKey: 'n64-apple_silicon_neon',
        family: 'stockham_autosort',
        treeSpec: 'uniform stockham stages',
        simdStrategy: 'neon',
        compile: { ok: true, command: 'clang', exitCode: 0, binaryPath: '/tmp/fft-workspace/b.out', stderrPath: '' },
        validation: { ok: true, sampleCount: 64, maxError: 0.0002, tolerance: 0.001, validationPath: '/tmp/fft-workspace/v.json' },
        benchmark: { ok: true, warmups: 5, trials: 30, medianNs: 50.0, p95Ns: 55.0, cvPct: 2.0, samplePath: '/tmp/fft-workspace/b.json' },
        baselineBenchmarks: [],
        artifactPaths: [],
        notes: 'standard format',
      }],
    });

    const envelope = parseWorkerEnvelope(response, worker, config);
    expect(envelope.results).toHaveLength(1);

    const result = envelope.results[0];
    expect(result.proposalId).toBe('cycle1-n64-1');
    expect(result.bucketKey).toBe('n64-apple_silicon_neon');
    expect(result.compile.ok).toBe(true);
    expect(result.validation.ok).toBe(true);
    expect(result.benchmark.ok).toBe(true);
    expect(result.benchmark.medianNs).toBeCloseTo(50.0);
  });

  it('parses flat compiled/validated/benchmarked fallback fields', () => {
    const response = JSON.stringify({
      summary: 'flat baseline format',
      results: [{
        proposalId: 'baseline-n1024-1',
        bucketKey: 'n1024-apple_silicon_neon',
        family: 'baseline_reference',
        isBaseline: true,
        treeSpec: 'iterative radix-4 baseline',
        compiled: true,
        compileCommand: 'clang -O3 ...',
        compiledBinaryPath: '/tmp/fft-workspace/baseline.bin',
        validated: true,
        sampleCount: 64,
        maxError: 0.00012,
        tolerance: 0.001,
        validationPath: '/tmp/fft-workspace/baseline.validation.json',
        benchmarked: true,
        warmups: 5,
        trials: 30,
        medianNs: 1517.0,
        p95Ns: 1620.0,
        cvPct: 4.2,
        samplePath: '/tmp/fft-workspace/baseline.bench.json',
        baselineBenchmarks: [{
          bucketKey: 'n1024-apple_silicon_neon',
          medianNs: 1517.0,
          p95Ns: 1620.0,
          cvPct: 4.2,
        }],
        artifactPaths: [],
      }],
    });

    const envelope = parseWorkerEnvelope(response, worker, config);
    const result = envelope.results[0];
    expect(result.compile.ok).toBe(true);
    expect(result.compile.binaryPath).toBe('/tmp/fft-workspace/baseline.bin');
    expect(result.validation.ok).toBe(true);
    expect(result.validation.validationPath).toBe('/tmp/fft-workspace/baseline.validation.json');
    expect(result.benchmark.ok).toBe(true);
    expect(result.benchmark.medianNs).toBeCloseTo(1517.0);
  });

  it('resolves bare bucket names like "n64" to full bucket key', () => {
    const response = JSON.stringify({
      summary: 'test',
      results: [{
        bucket: 'n256',
        dftSize: 256,
        compile: { ok: true, command: 'clang', exitCode: 0, binaryPath: '/tmp/fft-workspace/c.out' },
        validation: { ok: true, sampleCount: 64, maxError: 0.0001, tolerance: 0.001, validationPath: '/tmp/fft-workspace/v2.json' },
        benchmark: { ok: true, medianNs: 400, p95Ns: 450, cvPct: 2.0, samplePath: '/tmp/fft-workspace/b2.json' },
        baselineBenchmarks: [],
        artifactPaths: [],
      }],
    });

    const envelope = parseWorkerEnvelope(response, worker, config);
    expect(envelope.results[0].bucketKey).toBe('n256-apple_silicon_neon');
  });
});

describe('mergeCycleArtifacts baseline recovery', () => {
  it('recovers a missing bucket baseline from a non-baseline result when explicitly reported', () => {
    const state = createInitialState(makeMockCtx());
    state.cycleIndex = 3;
    state.lanesByAgentId = { builder_1: 'builder' };
    state.activePromotedProposals = [{
      proposalId: 'cycle3-n1024-1',
      bucketKey: 'n1024-apple_silicon_neon',
      size: 1024,
      family: 'stockham_radix4',
      treeSpec: 'stockham radix-4',
      leafSizes: [4],
      permutationStrategy: 'stockham_autosort',
      twiddleStrategy: 'precompute_static_const',
      simdStrategy: 'neon',
      proposedByWorkerId: 'explorer_1',
      lane: 'explorer',
      notes: '',
    }];

    const config = makeConfig({
      workspacePath: '',
      outputDir: '',
    });

    const responses = [{
      agentId: 'builder_1',
      response: JSON.stringify({
        summary: 'built n1024 candidate',
        results: [{
          proposalId: 'cycle3-n1024-1',
          bucketKey: 'n1024-apple_silicon_neon',
          family: 'stockham_radix4',
          treeSpec: 'stockham radix-4',
          permutationStrategy: 'stockham_autosort',
          twiddleStrategy: 'precompute_static_const',
          simdStrategy: 'scalar',
          compile: {
            ok: true,
            command: 'clang -O3 ...',
            exitCode: 0,
            stderrPath: '',
            binaryPath: '/tmp/fft-workspace/cycle3-n1024.bin',
          },
          validation: {
            ok: true,
            sampleCount: 64,
            maxError: 0.0001,
            tolerance: 0.001,
            failureReason: '',
            validationPath: '/tmp/fft-workspace/cycle3-n1024.validation.json',
          },
          benchmark: {
            ok: true,
            warmups: 5,
            trials: 30,
            medianNs: 1400,
            p95Ns: 1500,
            cvPct: 4.0,
            speedupVsBaseline: null,
            samplePath: '/tmp/fft-workspace/cycle3-n1024.bench.json',
          },
          baselineBenchmarks: [{
            bucketKey: 'n1024-apple_silicon_neon',
            medianNs: 1517,
            p95Ns: 1620,
            cvPct: 4.2,
          }],
          artifactPaths: [
            '/tmp/fft-workspace/cycle3-n1024.bin',
            '/tmp/fft-workspace/cycle3-n1024.validation.json',
            '/tmp/fft-workspace/cycle3-n1024.bench.json',
          ],
          notes: 'reported explicit bucket baseline',
        }],
        candidateProposals: [],
        audits: [],
      }),
    }];

    mergeCycleArtifacts(state, responses, config);
    const candidate = state.candidates[state.candidates.length - 1];

    expect(state.baselines['n1024-apple_silicon_neon']?.medianNs).toBeCloseTo(1517);
    expect(candidate?.bucketKey).toBe('n1024-apple_silicon_neon');
    expect(candidate?.benchmark.speedupVsBaseline).toBeCloseTo(1517 / 1400);
  });
});

// ---------------------------------------------------------------------------
// createInitialState
// ---------------------------------------------------------------------------

describe('createInitialState', () => {
  it('includes reexploreAttempts in initial state', () => {
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    expect(state.reexploreAttempts).toBe(0);
  });

  it('initializes with preflight phase', () => {
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    expect(state.phase).toBe(PHASES.PREFLIGHT);
    expect(state.reachedPhases).toContain(PHASES.PREFLIGHT);
  });

  it('counts worker participants', () => {
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    expect(state.workerCount).toBe(3);
  });

  it('starts with empty candidates and frontier', () => {
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    expect(state.candidates).toEqual([]);
    expect(state.frontierIds).toEqual([]);
    expect(state.proposalBacklog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

describe('bucket helpers', () => {
  it('returns expected bucket keys for target sizes', () => {
    const config = makeConfig();
    const keys = getExpectedBucketKeys(config);
    expect(keys).toEqual([
      'n64-apple_silicon_neon',
      'n256-apple_silicon_neon',
      'n1024-apple_silicon_neon',
    ]);
  });

  it('identifies missing winner buckets', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'candidate-n64-1',
      'n256-apple_silicon_neon': 'candidate-n256-1',
    };
    const missing = getMissingWinnerBucketKeys(state, config);
    expect(missing).toEqual(['n1024-apple_silicon_neon']);
  });

  it('returns empty when all buckets have winners', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
      'n1024-apple_silicon_neon': 'c3',
    };
    const missing = getMissingWinnerBucketKeys(state, config);
    expect(missing).toEqual([]);
  });
});

describe('compatibility setup gating', () => {
  it('treats a missing output directory as a hard failure so Make Compatible is shown', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'fft-compat-'));

    try {
      const report = buildCompatibilityReport(makeConfig({
        workspacePath,
        outputDir: path.join(workspacePath, '.commands', 'missing-fft-autotune'),
      }));

      expect(report.compatible).toBe(false);
      expect(report.hardFailures.some((failure) => failure.id === 'output_dir_missing')).toBe(true);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// selectActivePromotedProposals
// ---------------------------------------------------------------------------

describe('selectActivePromotedProposals', () => {
  it('promotes proposals from backlog', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 1;
    state.baselines = makeAllBaselines();
    state.proposalBacklog = [
      makeProposal('n64-apple_silicon_neon', 'cooley_tukey_shallow'),
      makeProposal('n256-apple_silicon_neon', 'stockham_autosort'),
    ];
    selectActivePromotedProposals(state, config);
    expect(state.activePromotedProposals).toHaveLength(2);
    expect(state.proposalBacklog).toHaveLength(0);
  });

  it('returns empty when backlog is empty', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 1;
    state.baselines = makeAllBaselines();
    state.proposalBacklog = [];
    selectActivePromotedProposals(state, config);
    expect(state.activePromotedProposals).toHaveLength(0);
  });

  it('prioritizes missing winner buckets', () => {
    const config = makeConfig({ promoteTopK: 1 });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 1;
    state.baselines = makeAllBaselines();
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner' }),
      makeCandidate('n256-apple_silicon_neon', { candidateId: 'c2', status: 'winner' }),
    ];
    state.frontierIds = ['c1', 'c2'];
    state.proposalBacklog = [
      makeProposal('n64-apple_silicon_neon', 'split_radix_hybrid'),
      makeProposal('n1024-apple_silicon_neon', 'stockham_autosort'),
    ];
    selectActivePromotedProposals(state, config);
    expect(state.activePromotedProposals).toHaveLength(1);
    expect(state.activePromotedProposals[0].bucketKey).toBe('n1024-apple_silicon_neon');
  });

  it('respects maxCandidatesPerFamily limit', () => {
    const config = makeConfig({ promoteTopK: 5, maxCandidatesPerFamily: 1 });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 1;
    state.baselines = makeAllBaselines();
    state.proposalBacklog = [
      makeProposal('n64-apple_silicon_neon', 'cooley_tukey_shallow'),
      makeProposal('n256-apple_silicon_neon', 'cooley_tukey_shallow'),
      makeProposal('n1024-apple_silicon_neon', 'stockham_autosort'),
    ];
    selectActivePromotedProposals(state, config);
    const families = state.activePromotedProposals.map((p) => p.family);
    const cooleyCount = families.filter((f) => f === 'cooley_tukey_shallow').length;
    expect(cooleyCount).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// chooseStopReason
// ---------------------------------------------------------------------------

describe('chooseStopReason', () => {
  it('returns null when not converged and under cycle limit', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 1;
    state.plateauCount = 0;
    state.frontierIds = ['c1'];
    state.candidates = [makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1' })];
    const reason = chooseStopReason(state, config, { maxCycles: 6 });
    expect(reason).toBeNull();
  });

  it('returns convergence_with_open_issues on plateau with missing buckets', () => {
    const config = makeConfig({ plateauCycles: 2 });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 3;
    state.plateauCount = 2;
    state.frontierIds = ['c1'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    state.candidates = [makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner' })];
    const reason = chooseStopReason(state, config, { maxCycles: 6 });
    expect(reason).toBe('convergence_with_open_issues');
  });

  it('returns convergence on plateau with all buckets covered and no audit issues', () => {
    const config = makeConfig({ plateauCycles: 2, targetSizes: [64] });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 3;
    state.plateauCount = 2;
    state.frontierIds = ['c1'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    state.candidates = [makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner' })];
    const reason = chooseStopReason(state, config, { maxCycles: 6 });
    expect(reason).toBe('convergence');
  });

  it('returns cycle_limit when cycle index reaches max with frontier', () => {
    const config = makeConfig({ targetSizes: [64] });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.cycleIndex = 6;
    state.plateauCount = 0;
    state.frontierIds = ['c1'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    state.candidates = [makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner' })];
    const reason = chooseStopReason(state, config, { maxCycles: 6 });
    expect(reason).toBe('cycle_limit');
  });
});

// ---------------------------------------------------------------------------
// recomputeFrontier
// ---------------------------------------------------------------------------

describe('recomputeFrontier', () => {
  it('promotes eligible candidates to frontier', () => {
    const config = makeConfig({ targetSizes: [64] });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.baselines = {
      'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 1200 },
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', hasBucketBaseline: true }),
    ];
    recomputeFrontier(state, config);
    expect(state.frontierIds).toContain('c1');
    expect(state.bestByBucket['n64-apple_silicon_neon']).toBe('c1');
  });

  it('excludes candidates slower than baseline from frontier', () => {
    const config = makeConfig({ targetSizes: [64] });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.baselines = {
      'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 1200 },
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        hasBucketBaseline: true,
        medianNs: 2000,
        speedupVsBaseline: 0.6, // 40% slower than baseline
      }),
    ];
    recomputeFrontier(state, config);
    expect(state.frontierIds).toEqual([]);
    expect(state.bestByBucket).toEqual({});
  });

  it('excludes candidates with open audit findings', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.baselines = makeAllBaselines();
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', hasBucketBaseline: true }),
      makeCandidate('n1024-apple_silicon_neon', {
        candidateId: 'c2',
        hasBucketBaseline: true,
        openHighConfidenceFindings: 1,
      }),
    ];
    recomputeFrontier(state, config);
    expect(state.frontierIds).toContain('c1');
    expect(state.frontierIds).not.toContain('c2');
  });

  it('preserves frontier for buckets with baselines when other buckets lack baselines', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.baselines = {
      'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 1200 },
      // n256 and n1024 missing — should NOT wipe n64 frontier
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner', hasBucketBaseline: true }),
      makeCandidate('n256-apple_silicon_neon', { candidateId: 'c2', status: 'frontier', hasBucketBaseline: false }),
    ];
    state.frontierIds = ['c1', 'c2'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1', 'n256-apple_silicon_neon': 'c2' };
    recomputeFrontier(state, config);

    // n64 winner preserved
    expect(state.frontierIds).toContain('c1');
    expect(state.bestByBucket['n64-apple_silicon_neon']).toBe('c1');

    // n256 without baseline excluded from frontier and demoted
    expect(state.frontierIds).not.toContain('c2');
    expect(state.bestByBucket['n256-apple_silicon_neon']).toBeUndefined();
    const c2 = state.candidates.find((c) => c.candidateId === 'c2');
    expect(c2.status).toBe('benchmarked');
  });

  it('keeps ne10 reference results out of the frontier even when they beat baseline', () => {
    const config = makeConfig({ targetSizes: [1024] });
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.baselines = {
      'n1024-apple_silicon_neon': { bucketKey: 'n1024-apple_silicon_neon', medianNs: 5500 },
    };
    state.candidates = [
      makeCandidate('n1024-apple_silicon_neon', {
        candidateId: 'c1',
        family: 'ne10_neon_reference',
        hasBucketBaseline: true,
        medianNs: 5249,
        speedupVsBaseline: 5500 / 5249,
      }),
    ];

    recomputeFrontier(state, config);

    expect(state.frontierIds).toEqual([]);
    expect(state.bestByBucket).toEqual({});
    expect(state.candidates[0].status).toBe('benchmarked');
  });
});

// ---------------------------------------------------------------------------
// applyAuditSeverityPolicy
// ---------------------------------------------------------------------------

describe('applyAuditSeverityPolicy', () => {
  it('downgrades metadata and methodology-only audit blockers for correct benchmarked candidates', () => {
    const candidate = makeCandidate('n64-apple_silicon_neon', {
      candidateId: 'c1',
      family: 'cooley_tukey_shallow',
      medianNs: 76.12,
      speedupVsBaseline: 2.18,
      openHighConfidenceFindings: 1,
      notes: [
        'Code diverges from promoted metadata on permutation/leaf strategy.',
        'SpeedupPct is not apples-to-apples because candidate setup is warmed before timing while baseline still computes twiddles in-band.',
        'Small-N result is not stable enough; audit rerun changed the median.',
      ].join(' '),
    });

    applyAuditSeverityPolicy(candidate, { simdStrategy: 'neon' });

    expect(candidate.audit.openHighConfidenceFindings).toBe(0);
    expect(candidate.audit.openMediumConfidenceFindings).toBeGreaterThanOrEqual(1);
    expect(candidate.notes).toContain('Metadata/permutation fidelity mismatch treated as non-blocking');
    expect(candidate.notes).toContain('Benchmark methodology or small-N stability concern treated as non-blocking');
  });
});

// ---------------------------------------------------------------------------
// buildTriedCandidatesSummary
// ---------------------------------------------------------------------------

describe('buildTriedCandidatesSummary', () => {
  it('keeps the most recent unique attempts instead of truncating by bucket order', () => {
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.candidates = [];

    for (let cycle = 1; cycle <= 30; cycle += 1) {
      state.candidates.push(makeCandidate('n64-apple_silicon_neon', {
        candidateId: `n64-${cycle}`,
        cycle,
        family: cycle === 30 ? 'stockham_autosort' : 'cooley_tukey_shallow',
      }));
    }

    for (let cycle = 1; cycle <= 5; cycle += 1) {
      state.candidates.push(makeCandidate('n1024-apple_silicon_neon', {
        candidateId: `n1024-${cycle}`,
        cycle,
        family: 'split_radix_hybrid',
      }));
    }

    const summary = JSON.parse(buildTriedCandidatesSummary(state));

    expect(summary).toHaveLength(3);
    expect(summary.map((row) => `${row.bucketKey}::${row.family}`)).toEqual([
      'n1024-apple_silicon_neon::split_radix_hybrid',
      'n64-apple_silicon_neon::stockham_autosort',
      'n64-apple_silicon_neon::cooley_tukey_shallow',
    ]);
    expect(summary.find((row) => row.bucketKey === 'n64-apple_silicon_neon' && row.family === 'cooley_tukey_shallow')?.cycle)
      .toBe(29);
  });
});

// ---------------------------------------------------------------------------
// buildBaselineRows
// ---------------------------------------------------------------------------

describe('buildBaselineRows', () => {
  it('emits scalar baseline and Ne10 reference rows per bucket', () => {
    const config = makeConfig({ targetSizes: [64] });
    const ctx = makeMockCtx({ roomConfig: { targetSizes: [64] } });
    const state = createInitialState(ctx);
    state.baselines = {
      'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 98.28, cvPct: 8.86 },
    };
    state.baselineArtifacts = {
      'n64-apple_silicon_neon': {
        bucketKey: 'n64-apple_silicon_neon',
        family: 'baseline_reference',
        implementedByWorkerId: 'builder_1',
      },
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'ne10-ref',
        cycle: 2,
        family: 'ne10_neon_reference',
        medianNs: 60.51,
        speedupVsBaseline: 98.28 / 60.51,
        notes: 'cached Ne10 adapter',
      }),
    ];

    const rows = buildBaselineRows(state, config);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      bucketKey: 'n64-apple_silicon_neon',
      kind: 'scalar_baseline',
      family: 'baseline_reference',
      medianNs: 98,
      status: 'ready',
      owner: 'builder_1',
    });
    expect(rows[1]).toMatchObject({
      bucketKey: 'n64-apple_silicon_neon',
      kind: 'ne10_reference',
      family: 'ne10_neon_reference',
      medianNs: 61,
      status: 'ready',
      owner: 'builder_1',
    });
    expect(rows[1].deltaVsScalarPct).toBeCloseTo(62.4, 1);
  });
});

// ---------------------------------------------------------------------------
// buildPlanningTargets
// ---------------------------------------------------------------------------

describe('buildPlanningTargets', () => {
  it('includes baseline headroom context and exploit-first guidance in cycle 1', () => {
    const ctx = makeMockCtx({ roomConfig: { targetSizes: [64] } });
    const config = makeConfig({ targetSizes: [64] });
    const state = createInitialState(ctx);
    state.lanesByAgentId = { explorer_1: 'explorer', builder_1: 'builder', auditor_1: 'auditor' };
    state.workersByLane = { explorer: ['explorer_1'], builder: ['builder_1'], auditor: ['auditor_1'] };
    state.cycleIndex = 1;
    state.baselines = {
      'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 166.15 },
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'ne10-ref',
        cycle: 0,
        family: 'ne10_neon_reference',
        medianNs: 59.23,
        speedupVsBaseline: 166.15 / 59.23,
      }),
    ];

    const targets = buildPlanningTargets(ctx, state, config);
    const explorerMessage = targets.find((target) => target.agentId === 'explorer_1')?.message || '';

    expect(explorerMessage).toContain('Canonical scalar baselines and Ne10 reference headroom by bucket');
    expect(explorerMessage).toContain('"bucketKey": "n64-apple_silicon_neon"');
    expect(explorerMessage).toContain('"scalarMedianNs": 166');
    expect(explorerMessage).toContain('"ne10MedianNs": 59');
    expect(explorerMessage).toContain('This is the first planning cycle after fresh baselines. Be exploit-first, not novelty-first.');
    expect(explorerMessage).toContain('At most one proposal per bucket may be a broad wildcard family.');
    expect(explorerMessage).toContain('Do not spend n64 slots on transpose-heavy matrix families');
  });
});

// ---------------------------------------------------------------------------
// winnerMutationProposals
// ---------------------------------------------------------------------------

describe('winnerMutationProposals', () => {
  it('returns empty when no frontier winners', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.frontierIds = [];
    state.candidates = [];
    const proposals = winnerMutationProposals(state, config, new Set(['n1024-apple_silicon_neon']));
    expect(proposals).toHaveLength(0);
  });

  it('generates mutations of frontier winners for missing buckets', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.frontierIds = ['c1'];
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
      }),
    ];
    const missing = new Set(['n1024-apple_silicon_neon']);
    const proposals = winnerMutationProposals(state, config, missing);

    expect(proposals.length).toBeGreaterThan(0);
    // All proposals target the missing bucket
    for (const p of proposals) {
      expect(p.bucketKey).toBe('n1024-apple_silicon_neon');
      expect(p.size).toBe(1024);
    }
    // Should have leaf, twiddle, and permutation mutations
    const notes = proposals.map((p) => p.notes);
    expect(notes.some((n) => n.includes('leafSizes'))).toBe(true);
    expect(notes.some((n) => n.includes('twiddle'))).toBe(true);
    expect(notes.some((n) => n.includes('permutation'))).toBe(true);
    // All are cross-bucket transfers since winner is n64
    expect(notes.every((n) => n.includes('cross-bucket transfer'))).toBe(true);
  });

  it('generates same-bucket mutations when winner bucket is in preferred set', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.frontierIds = ['c1'];
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
      }),
    ];
    const preferred = new Set(['n64-apple_silicon_neon']);
    const proposals = winnerMutationProposals(state, config, preferred);

    expect(proposals.length).toBeGreaterThan(0);
    const notes = proposals.map((p) => p.notes);
    expect(notes.every((n) => n.includes('same-bucket mutation'))).toBe(true);
  });

  it('skips mutations identical to the winner', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.frontierIds = ['c1'];
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
      }),
    ];
    const preferred = new Set(['n64-apple_silicon_neon']);
    const proposals = winnerMutationProposals(state, config, preferred);

    // No mutation should have the exact same leafSizes as the winner
    const winnerLeaves = state.candidates[0].leafSizes.join('-');
    const leafMutations = proposals.filter((p) => p.notes.includes('leafSizes'));
    for (const p of leafMutations) {
      expect(p.leafSizes.join('-')).not.toBe(winnerLeaves);
    }
  });

  it('preserves winner family in all mutations', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    state.frontierIds = ['c1'];
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
        family: 'stockham_autosort',
      }),
    ];
    const preferred = new Set(['n1024-apple_silicon_neon']);
    const proposals = winnerMutationProposals(state, config, preferred);

    for (const p of proposals) {
      expect(p.family).toBe('stockham_autosort');
    }
  });
});

// ---------------------------------------------------------------------------
// buildReexplorationTargets
// ---------------------------------------------------------------------------

describe('buildReexplorationTargets', () => {
  it('generates prompts for all participants', () => {
    const ctx = makeMockCtx();
    const config = makeConfig();
    const state = createInitialState(ctx);
    state.lanesByAgentId = {
      explorer_1: 'explorer',
      builder_1: 'builder',
      auditor_1: 'auditor',
    };
    state.workersByLane = {
      explorer: ['explorer_1'],
      builder: ['builder_1'],
      auditor: ['auditor_1'],
    };
    state.cycleIndex = 2;
    state.baselines = makeAllBaselines();
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
    };
    state.frontierIds = ['c1', 'c2'];
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner' }),
      makeCandidate('n256-apple_silicon_neon', { candidateId: 'c2', status: 'winner' }),
      makeCandidate('n1024-apple_silicon_neon', {
        candidateId: 'c3',
        openHighConfidenceFindings: 1,
        notes: 'audit blocked',
      }),
    ];

    const targets = buildReexplorationTargets(ctx, state, config);
    expect(targets).toHaveLength(3);

    const agentIds = targets.map((t) => t.agentId);
    expect(agentIds).toContain('explorer_1');
    expect(agentIds).toContain('builder_1');
    expect(agentIds).toContain('auditor_1');
  });

  it('includes missing bucket info and prior attempts in prompts', () => {
    const ctx = makeMockCtx();
    const config = makeConfig();
    const state = createInitialState(ctx);
    state.lanesByAgentId = { explorer_1: 'explorer', builder_1: 'builder', auditor_1: 'auditor' };
    state.workersByLane = { explorer: ['explorer_1'], builder: ['builder_1'], auditor: ['auditor_1'] };
    state.cycleIndex = 2;
    state.baselines = makeAllBaselines();
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    state.frontierIds = ['c1'];
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner' }),
      makeCandidate('n1024-apple_silicon_neon', {
        candidateId: 'c3',
        openHighConfidenceFindings: 1,
        notes: 'twiddle sign error',
      }),
    ];

    const targets = buildReexplorationTargets(ctx, state, config);
    const explorerMsg = targets.find((t) => t.agentId === 'explorer_1').message;

    expect(explorerMsg).toContain('n1024-apple_silicon_neon');
    expect(explorerMsg).toContain('n256-apple_silicon_neon');
    expect(explorerMsg).toContain('twiddle sign error');
    expect(explorerMsg).toContain('proposal backlog is exhausted');
    // Should include winner info for adaptation
    expect(explorerMsg).toContain('Winning families from solved buckets');
    expect(explorerMsg).toContain('cooley_tukey_shallow');
  });

  it('gives lane-specific instructions', () => {
    const ctx = makeMockCtx();
    const config = makeConfig();
    const state = createInitialState(ctx);
    state.lanesByAgentId = { explorer_1: 'explorer', builder_1: 'builder', auditor_1: 'auditor' };
    state.workersByLane = { explorer: ['explorer_1'], builder: ['builder_1'], auditor: ['auditor_1'] };
    state.cycleIndex = 2;
    state.baselines = makeAllBaselines();

    const targets = buildReexplorationTargets(ctx, state, config);
    const auditorMsg = targets.find((t) => t.agentId === 'auditor_1').message;
    const builderMsg = targets.find((t) => t.agentId === 'builder_1').message;
    const explorerMsg = targets.find((t) => t.agentId === 'explorer_1').message;

    expect(auditorMsg).toContain('root causes');
    expect(builderMsg).toContain('compile, validate, and benchmark cleanly');
    expect(explorerMsg).toContain('structurally different');
  });
});

// ---------------------------------------------------------------------------
// buildPendingDecision — reexplore
// ---------------------------------------------------------------------------

describe('buildPendingDecision', () => {
  it('routes baseline, planning, build, and audit phases to the intended roles only', () => {
    const ctx = makeMockCtx();
    const config = makeConfig();
    const state = createInitialState(ctx);
    state.lanesByAgentId = { explorer_1: 'explorer', builder_1: 'builder', auditor_1: 'auditor' };
    state.workersByLane = { explorer: ['explorer_1'], builder: ['builder_1'], auditor: ['auditor_1'] };
    state.activePromotedProposals = [
      makeProposal('n64-apple_silicon_neon', 'cooley_tukey_shallow'),
    ];
    state.baselines = makeAllBaselines();

    state.pendingFanOut = 'baseline';
    expect(buildPendingDecision(ctx, state, config)?.targets.map((target) => target.agentId)).toEqual(['builder_1']);

    state.pendingFanOut = 'planning';
    expect(buildPendingDecision(ctx, state, config)?.targets.map((target) => target.agentId)).toEqual(['explorer_1']);

    state.pendingFanOut = 'cycle';
    expect(buildPendingDecision(ctx, state, config)?.targets.map((target) => target.agentId)).toEqual(['builder_1']);

    state.pendingFanOut = 'audit';
    expect(buildPendingDecision(ctx, state, config)?.targets.map((target) => target.agentId)).toEqual(['auditor_1']);
  });

  it('returns fan_out for reexplore pendingFanOut', () => {
    const ctx = makeMockCtx();
    const config = makeConfig();
    const state = createInitialState(ctx);
    state.pendingFanOut = 'reexplore';
    state.lanesByAgentId = { explorer_1: 'explorer', builder_1: 'builder', auditor_1: 'auditor' };
    state.workersByLane = { explorer: ['explorer_1'], builder: ['builder_1'], auditor: ['auditor_1'] };
    state.cycleIndex = 2;

    const decision = buildPendingDecision(ctx, state, config);
    expect(decision).not.toBeNull();
    expect(decision.type).toBe('fan_out');
    expect(decision.targets).toHaveLength(3);
  });

  it('returns null for unknown pendingFanOut', () => {
    const ctx = makeMockCtx();
    const config = makeConfig();
    const state = createInitialState(ctx);
    state.pendingFanOut = 'unknown';

    const decision = buildPendingDecision(ctx, state, config);
    expect(decision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plugin lifecycle — reexplore handler (pendingFanOut = 'reexplore')
// ---------------------------------------------------------------------------

describe('plugin onFanOutComplete — reexplore handler', () => {
  it('continues to cycle after reexplore produces new proposals', () => {
    const plugin = createPlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'reexplore';
    state.cycleIndex = 3;
    state.phase = PHASES.SEARCH_PLANNING;
    state.reexploreAttempts = 1;
    state.proposalBacklog = [];
    state.activePromotedProposals = [];
    state.baselines = makeAllBaselines();
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner', hasBucketBaseline: true }),
      makeCandidate('n256-apple_silicon_neon', { candidateId: 'c2', status: 'winner', hasBucketBaseline: true }),
    ];
    state.frontierIds = ['c1', 'c2'];
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
    };
    ctx.setState(state);

    // Reexplore responses include new n1024 proposals
    const responses = [
      {
        agentId: 'explorer_1',
        response: JSON.stringify({
          summary: 'proposing stockham for n1024',
          candidateProposals: [{
            bucketKey: 'n1024-apple_silicon_neon',
            size: 1024,
            family: 'stockham_autosort',
            treeSpec: 'uniform stockham stages',
            leafSizes: [4],
            permutationStrategy: 'autosort',
            twiddleStrategy: 'stage_local',
            simdStrategy: 'neon',
            notes: 'avoids twiddle sign issues from cooley-tukey',
          }],
          audits: [],
          results: [],
        }),
      },
      {
        agentId: 'builder_1',
        response: '{"summary":"no proposals","candidateProposals":[],"audits":[],"results":[]}',
      },
      {
        agentId: 'auditor_1',
        response: '{"summary":"no proposals","candidateProposals":[],"audits":[],"results":[]}',
      },
    ];

    const decision = plugin.onFanOutComplete(ctx, responses);

    const updatedState = ctx.getState();
    expect(updatedState.pendingFanOut).toBe('cycle');
    expect(updatedState.phase).toBe(PHASES.CANDIDATE_CODEGEN);
    expect(updatedState.activePromotedProposals).toHaveLength(1);
    expect(updatedState.activePromotedProposals[0].bucketKey).toBe('n1024-apple_silicon_neon');
    expect(decision).not.toBeNull();
    expect(decision.type).toBe('fan_out');
  });

  it('stops when reexplore produces no new proposals', () => {
    const plugin = createPlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'reexplore';
    state.cycleIndex = 3;
    state.phase = PHASES.SEARCH_PLANNING;
    state.reexploreAttempts = 1;
    state.proposalBacklog = [];
    state.activePromotedProposals = [];
    state.baselines = makeAllBaselines();
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', { candidateId: 'c1', status: 'winner', hasBucketBaseline: true }),
    ];
    state.frontierIds = ['c1'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    ctx.setState(state);

    const responses = [
      { agentId: 'explorer_1', response: '{"summary":"nothing","candidateProposals":[],"audits":[],"results":[]}' },
      { agentId: 'builder_1', response: '{"summary":"nothing","candidateProposals":[],"audits":[],"results":[]}' },
      { agentId: 'auditor_1', response: '{"summary":"nothing","candidateProposals":[],"audits":[],"results":[]}' },
    ];

    const decision = plugin.onFanOutComplete(ctx, responses);

    expect(decision.type).toBe('stop');
    expect(decision.reason).toBe('convergence_with_open_issues');
    const updatedState = ctx.getState();
    expect(updatedState.phase).toBe(PHASES.COMPLETE);
  });
});

describe('plugin onRoomStart', () => {
  it('self-scaffolds a safe missing output directory before baseline fan-out', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'fft-room-start-'));
    const outputDir = path.join(workspacePath, '.commands', 'fft-autotune');
    const plugin = createPlugin();
    const ctx = makeMockCtx({
      roomConfig: {
        workspacePath,
        outputDir,
      },
    });

    try {
      plugin.init(ctx);
      const decision = plugin.onRoomStart(ctx);

      expect(decision?.type).toBe('fan_out');
      expect(decision?.targets.map((target) => target.agentId)).toEqual(['builder_1']);
      expect(fs.existsSync(path.join(outputDir, 'harness.c'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'ne10_adapter.c'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'third_party', 'ne10', 'UPSTREAM_COMMIT.txt'))).toBe(true);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin lifecycle — cycle convergence via chooseStopReason
// ---------------------------------------------------------------------------

describe('plugin onFanOutComplete — convergence paths', () => {
  it('stops with convergence when plateau reached and all buckets won', () => {
    const plugin = createPlugin();
    const ctx = makeMockCtx({
      roomConfig: { targetSizes: [64] },
    });
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.cycleIndex = 3;
    state.phase = PHASES.BENCHMARK;
    state.proposalBacklog = [];
    state.activePromotedProposals = [];
    state.baselines = {
      'n64-apple_silicon_neon': { bucketKey: 'n64-apple_silicon_neon', medianNs: 1200 },
    };
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
        hasBucketBaseline: true,
        medianNs: 1000,
      }),
    ];
    state.frontierIds = ['c1'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    // refreshBaselineCoverage will compute speedup = 1200/1000 = 1.2 → 20% improvement.
    // Set bestImprovementPct >= 20 so evaluateImprovement increments plateauCount.
    state.bestImprovementPct = 20;
    state.plateauCount = 1; // will become 2 after evaluateImprovement (no improvement)
    state.reexploreAttempts = 0;
    ctx.setState(state);

    const responses = [
      { agentId: 'builder_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'auditor_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'explorer_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
    ];

    const decision = plugin.onFanOutComplete(ctx, responses);

    expect(decision.type).toBe('stop');
    expect(decision.reason).toBe('convergence');
    const updatedState = ctx.getState();
    expect(updatedState.reexploreAttempts).toBe(0);
  });

  it('triggers reexplore instead of stopping when plateau hits with missing winners', () => {
    const plugin = createPlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.cycleIndex = 3;
    state.phase = PHASES.BENCHMARK;
    state.proposalBacklog = [];
    state.activePromotedProposals = [];
    state.baselines = makeAllBaselines();
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
        hasBucketBaseline: true,
        medianNs: 1000,
      }),
      makeCandidate('n256-apple_silicon_neon', {
        candidateId: 'c2',
        status: 'winner',
        hasBucketBaseline: true,
        medianNs: 4000,
      }),
    ];
    state.frontierIds = ['c1', 'c2'];
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
    };
    // refreshBaselineCoverage: n64 speedup=1200/1000=1.2 (20%), n256=5000/4000=1.25 (25%)
    // Set bestImprovementPct >= 25 so plateau increments
    state.bestImprovementPct = 25;
    state.plateauCount = 1; // will become 2 → would trigger plateau stop
    state.reexploreAttempts = 0;
    ctx.setState(state);

    const responses = [
      { agentId: 'builder_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'auditor_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'explorer_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
    ];

    const decision = plugin.onFanOutComplete(ctx, responses);

    // Instead of stopping, should redirect to reexplore
    const updatedState = ctx.getState();
    expect(decision.type).toBe('fan_out');
    expect(updatedState.pendingFanOut).toBe('reexplore');
    expect(updatedState.reexploreAttempts).toBe(1);
    expect(updatedState.phase).toBe(PHASES.SEARCH_PLANNING);
  });

  it('respects maxCycles and does not reexplore beyond the limit', () => {
    const plugin = createPlugin();
    const ctx = makeMockCtx({ limits: { maxCycles: 4 } });
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.cycleIndex = 4; // at maxCycles
    state.phase = PHASES.BENCHMARK;
    state.proposalBacklog = [];
    state.activePromotedProposals = [];
    state.baselines = makeAllBaselines();
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
        hasBucketBaseline: true,
        medianNs: 1000,
      }),
    ];
    state.frontierIds = ['c1'];
    state.bestByBucket = { 'n64-apple_silicon_neon': 'c1' };
    state.bestImprovementPct = 20;
    state.plateauCount = 0;
    state.reexploreAttempts = 0; // attempts available but cycle limit reached
    ctx.setState(state);

    const responses = [
      { agentId: 'builder_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'auditor_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'explorer_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
    ];

    const decision = plugin.onFanOutComplete(ctx, responses);

    // Should stop, not reexplore, because cycleIndex >= maxCycles
    expect(decision.type).toBe('stop');
    expect(decision.reason).toBe('convergence_with_open_issues');
    expect(ctx.getState().reexploreAttempts).toBe(0);
  });

  it('stops with convergence_with_open_issues after reexplore attempts exhausted', () => {
    const plugin = createPlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.cycleIndex = 5;
    state.phase = PHASES.BENCHMARK;
    state.proposalBacklog = [];
    state.activePromotedProposals = [];
    state.baselines = makeAllBaselines();
    state.candidates = [
      makeCandidate('n64-apple_silicon_neon', {
        candidateId: 'c1',
        status: 'winner',
        hasBucketBaseline: true,
        medianNs: 1000,
      }),
      makeCandidate('n256-apple_silicon_neon', {
        candidateId: 'c2',
        status: 'winner',
        hasBucketBaseline: true,
        medianNs: 4000,
      }),
    ];
    state.frontierIds = ['c1', 'c2'];
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
    };
    state.bestImprovementPct = 25;
    state.plateauCount = 1;
    state.reexploreAttempts = 2; // already exhausted
    ctx.setState(state);

    const responses = [
      { agentId: 'builder_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'auditor_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
      { agentId: 'explorer_1', response: '{"summary":"empty","results":[],"candidateProposals":[],"audits":[]}' },
    ];

    const decision = plugin.onFanOutComplete(ctx, responses);

    expect(decision.type).toBe('stop');
    expect(decision.reason).toBe('convergence_with_open_issues');
  });
});

// ---------------------------------------------------------------------------
// Plugin lifecycle — reexplore guard conditions
// ---------------------------------------------------------------------------

describe('reexplore guard conditions', () => {
  it('reexploreAttempts counter increments correctly', () => {
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);
    expect(state.reexploreAttempts).toBe(0);

    // Simulate first reexplore trigger
    state.reexploreAttempts = (state.reexploreAttempts || 0) + 1;
    expect(state.reexploreAttempts).toBe(1);

    // Simulate second reexplore trigger
    state.reexploreAttempts = (state.reexploreAttempts || 0) + 1;
    expect(state.reexploreAttempts).toBe(2);

    // Guard condition: should block at 2
    const shouldReexplore = state.reexploreAttempts < 2;
    expect(shouldReexplore).toBe(false);
  });

  it('reexplore guard requires missing winner buckets', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);

    // All buckets won
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
      'n1024-apple_silicon_neon': 'c3',
    };
    const missing = getMissingWinnerBucketKeys(state, config);
    expect(missing).toHaveLength(0);

    // Guard condition: should not reexplore when no missing buckets
    const shouldReexplore = missing.length > 0 && (state.reexploreAttempts || 0) < 2;
    expect(shouldReexplore).toBe(false);
  });

  it('reexplore guard passes when missing buckets and attempts available', () => {
    const config = makeConfig();
    const ctx = makeMockCtx();
    const state = createInitialState(ctx);

    // n1024 missing
    state.bestByBucket = {
      'n64-apple_silicon_neon': 'c1',
      'n256-apple_silicon_neon': 'c2',
    };
    state.reexploreAttempts = 0;
    const missing = getMissingWinnerBucketKeys(state, config);
    expect(missing).toHaveLength(1);

    const shouldReexplore = missing.length > 0 && (state.reexploreAttempts || 0) < 2;
    expect(shouldReexplore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scaffold — harness scaffolding
// ---------------------------------------------------------------------------

describe('scaffold', () => {
  let fs, path, os;
  beforeAll(async () => {
    fs = await import('node:fs');
    path = await import('node:path');
    os = await import('node:os');
  });

  it('scaffoldWorkspace writes harness, usage, and the Ne10 reference pack', async () => {
    const { scaffoldWorkspace } = await import('../lib/scaffold.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fft-scaffold-test-'));
    try {
      const actions = scaffoldWorkspace(tmpDir);
      expect(actions.length).toBeGreaterThanOrEqual(4);

      const harness = fs.readFileSync(path.join(tmpDir, 'harness.c'), 'utf-8');
      expect(harness).toContain('#ifndef DFT_SIZE');
      expect(harness).toContain('void DFT_FUNC(');
      expect(harness).toContain('reference_dft');
      expect(harness).toContain('fill_validation_case');
      expect(harness).toContain('write_benchmark_json');

      const usage = fs.readFileSync(path.join(tmpDir, 'HARNESS_USAGE.txt'), 'utf-8');
      expect(usage).toContain('-DDFT_SIZE=');
      expect(usage).toContain('-DDFT_FUNC=');

      const ne10Usage = fs.readFileSync(path.join(tmpDir, 'NE10_USAGE.txt'), 'utf-8');
      expect(ne10Usage).toContain('ne10_adapter.c');
      expect(ne10Usage).toContain('third_party/ne10');
      expect(ne10Usage).toContain('-std=gnu11');

      const adapter = fs.readFileSync(path.join(tmpDir, 'ne10_adapter.c'), 'utf-8');
      expect(adapter).toContain('ne10_fft_alloc_c2c_float32_neon');
      expect(adapter).toContain('ne10_get_cached_cfg');
      expect(adapter).toContain('ne10_release_cached_plans');
      expect(adapter).toContain('void dft_1024');

      const upstreamCommit = fs.readFileSync(path.join(tmpDir, 'third_party', 'ne10', 'UPSTREAM_COMMIT.txt'), 'utf-8');
      expect(upstreamCommit).toContain('Pinned commit:');
      expect(upstreamCommit).toContain('projectNe10/Ne10');

      const vendoredHeader = fs.readFileSync(path.join(tmpDir, 'third_party', 'ne10', 'inc', 'NE10_types.h'), 'utf-8');
      expect(vendoredHeader).toContain('ne10_fft_cpx_float32_t');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scaffoldWorkspace overwrites stale or modified harness files', async () => {
    const { scaffoldWorkspace } = await import('../lib/scaffold.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fft-scaffold-test-'));
    try {
      scaffoldWorkspace(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'harness.c'), '// user modified');

      const actions = scaffoldWorkspace(tmpDir);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toContain('Updated');

      const harness = fs.readFileSync(path.join(tmpDir, 'harness.c'), 'utf-8');
      expect(harness).toContain('#ifndef DFT_SIZE');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scaffoldWorkspace is no-op when files already match', async () => {
    const { scaffoldWorkspace } = await import('../lib/scaffold.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fft-scaffold-test-'));
    try {
      scaffoldWorkspace(tmpDir);
      const actions = scaffoldWorkspace(tmpDir);
      expect(actions).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('getHarnessCompileHint includes output dir and compiler', async () => {
    const { getHarnessCompileHint } = await import('../lib/scaffold.js');
    const hint = getHarnessCompileHint({
      outputDir: '/workspace/.commands/fft-autotune',
      compilerCommand: 'clang',
      compilerFlags: ['-O3', '-ffast-math', '-march=native'],
      validationSamples: 64,
      benchmarkWarmups: 5,
      benchmarkTrials: 30,
    });
    expect(hint).toContain('/workspace/.commands/fft-autotune/harness.c');
    expect(hint).toContain('-DDFT_SIZE=');
    expect(hint).toContain('-DDFT_FUNC=');
    expect(hint).toContain('Do NOT write custom harnesses');
    expect(hint).toContain('/workspace/.commands/fft-autotune/third_party/ne10');
    expect(hint).toContain('NE10_USAGE.txt');
  });
});
