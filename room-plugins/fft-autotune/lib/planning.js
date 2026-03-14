import { DEFAULT_FAMILIES } from './constants.js';
import { getExpectedBucketKeys, getMissingBaselineBucketKeys, getMissingWinnerBucketKeys } from './buckets.js';
import { findCandidateById } from './candidates.js';
import { getHarnessCompileHint } from './scaffold.js';
import { isPowerOfTwo, resolveBucketKey, safeTrim } from './utils.js';

export function resolveBucketSize(bucketKey, fallbackSize) {
  const match = String(bucketKey || '').match(/^n(\d+)-/);
  if (!match) return fallbackSize;
  const parsed = Number(match[1]);
  return isPowerOfTwo(parsed) ? parsed : fallbackSize;
}

export function buildBaselineBootstrapSpecs(state, config) {
  return getMissingBaselineBucketKeys(state, config).map((bucketKey) => ({
    bucketKey,
    size: resolveBucketSize(bucketKey, config.targetSizes[0] || 64),
    family: 'baseline_reference',
    notes: 'same-run baseline bootstrap required before frontier ranking',
  }));
}

export function buildRecentFailureDiagnostics(state) {
  return state.candidates
    .filter((candidate) =>
      (!candidate.validation?.ok)
      || (candidate.audit?.openHighConfidenceFindings || 0) > 0
      || (candidate.audit?.openMediumConfidenceFindings || 0) > 0,
    )
    .sort((left, right) => {
      const cycleDelta = (right.cycle || 0) - (left.cycle || 0);
      if (cycleDelta !== 0) return cycleDelta;
      return (left.bucketKey || '').localeCompare(right.bucketKey || '');
    })
    .slice(0, 8)
    .map((candidate) => ({
      cycle: candidate.cycle,
      bucketKey: candidate.bucketKey,
      family: candidate.family,
      validationOk: Boolean(candidate.validation?.ok),
      maxError: Number.isFinite(candidate.validation?.maxError)
        ? Number(candidate.validation.maxError.toPrecision(6))
        : undefined,
      tolerance: Number.isFinite(candidate.validation?.tolerance)
        ? Number(candidate.validation.tolerance.toPrecision(6))
        : undefined,
      failureReason: candidate.validation?.failureReason || '',
      firstFailInputLabel: candidate.validation?.firstFailInputLabel || '',
      firstFailIndex: Number.isInteger(candidate.validation?.firstFailIndex)
        ? candidate.validation.firstFailIndex
        : undefined,
      firstFailError: Number.isFinite(candidate.validation?.firstFailError)
        ? Number(candidate.validation.firstFailError.toPrecision(6))
        : undefined,
      orderingHint: candidate.validation?.orderingHint || '',
      suspectedIssue: candidate.validation?.suspectedIssue || '',
      diagnosticSummary: candidate.validation?.diagnosticSummary || '',
      highConfidenceIssues: candidate.audit?.openHighConfidenceFindings || 0,
      mediumConfidenceIssues: candidate.audit?.openMediumConfidenceFindings || 0,
      notes: safeTrim(candidate.notes, 240),
    }));
}

function formatFailureBand(maxError, tolerance) {
  if (!Number.isFinite(maxError) || !Number.isFinite(tolerance) || tolerance <= 0) {
    return '';
  }
  const ratio = maxError / tolerance;
  if (ratio < 1) return '<1x_tol';
  if (ratio < 1.25) return '1.0-1.25x_tol';
  if (ratio < 1.5) return '1.25-1.5x_tol';
  if (ratio < 2) return '1.5-2x_tol';
  if (ratio < 5) return '2-5x_tol';
  return '>=5x_tol';
}

function buildCandidateFailureSignature(candidate) {
  if (!candidate) return '';
  if (candidate.compile && candidate.compile.ok === false) {
    return ['compile_failed', candidate.bucketKey || '', safeTrim(candidate.notes, 120)].filter(Boolean).join('::');
  }
  if (!candidate.validation?.ok) {
    return [
      candidate.validation?.failureReason || 'validation_failed',
      candidate.validation?.orderingHint || 'no_ordering_hint',
      candidate.validation?.suspectedIssue || 'no_suspected_issue',
      formatFailureBand(candidate.validation?.maxError, candidate.validation?.tolerance),
    ].filter(Boolean).join('::');
  }
  if ((candidate.audit?.openHighConfidenceFindings || 0) > 0) {
    return [
      'audit_blocked',
      candidate.validation?.orderingHint || 'no_ordering_hint',
      safeTrim(candidate.notes, 120),
    ].filter(Boolean).join('::');
  }
  return '';
}

export function buildRepairDirectives(state, config) {
  const directives = [];
  const missingWinnerBuckets = new Set(getMissingWinnerBucketKeys(state, config));

  for (const bucketKey of getExpectedBucketKeys(config)) {
    if (!missingWinnerBuckets.has(bucketKey)) continue;
    const candidates = state.candidates
      .filter((candidate) =>
        candidate.bucketKey === bucketKey
        && (!candidate.validation?.ok || (candidate.audit?.openHighConfidenceFindings || 0) > 0),
      );
    if (candidates.length < 2) continue;

    const bySignature = new Map();
    for (const candidate of candidates) {
      const signature = buildCandidateFailureSignature(candidate);
      if (!signature) continue;
      const current = bySignature.get(signature) || [];
      current.push(candidate);
      bySignature.set(signature, current);
    }

    let selectedSignature = '';
    let selectedCandidates = [];
    for (const [signature, signatureCandidates] of bySignature.entries()) {
      if (signatureCandidates.length < 2) continue;
      if (signatureCandidates.length > selectedCandidates.length) {
        selectedSignature = signature;
        selectedCandidates = signatureCandidates;
        continue;
      }
      if (signatureCandidates.length === selectedCandidates.length) {
        const latestCycle = Math.max(...signatureCandidates.map((candidate) => candidate.cycle || 0));
        const selectedLatestCycle = selectedCandidates.length > 0
          ? Math.max(...selectedCandidates.map((candidate) => candidate.cycle || 0))
          : -1;
        if (latestCycle > selectedLatestCycle) {
          selectedSignature = signature;
          selectedCandidates = signatureCandidates;
        }
      }
    }

    if (selectedCandidates.length < 2) continue;

    const latestCandidate = [...selectedCandidates].sort((left, right) => (right.cycle || 0) - (left.cycle || 0))[0];
    directives.push({
      bucketKey,
      signature: selectedSignature,
      repeatCount: selectedCandidates.length,
      family: latestCandidate.family,
      suspectedIssue: latestCandidate.validation?.suspectedIssue || '',
      orderingHint: latestCandidate.validation?.orderingHint || '',
      failureReason: latestCandidate.validation?.failureReason || '',
      latestCycle: latestCandidate.cycle || 0,
      latestNotes: safeTrim(latestCandidate.notes, 240),
    });
  }

  return directives.sort((left, right) => {
    if (right.repeatCount !== left.repeatCount) return right.repeatCount - left.repeatCount;
    if (right.latestCycle !== left.latestCycle) return right.latestCycle - left.latestCycle;
    return left.bucketKey.localeCompare(right.bucketKey);
  });
}

function buildPromptFrontierRows(state) {
  return state.frontierIds
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter(Boolean)
    .map((candidate) => ({
      bucketKey: candidate.bucketKey,
      family: candidate.family,
      medianNs: Number.isFinite(candidate.benchmark?.medianNs) ? Math.round(candidate.benchmark.medianNs) : '',
      speedupPct: Number.isFinite(candidate.benchmark?.speedupVsBaseline)
        ? Number(((candidate.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
        : '',
      status: candidate.status,
      owner: candidate.implementedByWorkerId || '',
    }));
}

function latestNe10ReferenceCandidate(state, bucketKey) {
  return state.candidates
    .filter((candidate) =>
      candidate.bucketKey === bucketKey
      && candidate.family === 'ne10_neon_reference'
      && candidate.benchmark?.ok,
    )
    .sort((left, right) => {
      const cycleDelta = (right.cycle || 0) - (left.cycle || 0);
      if (cycleDelta !== 0) return cycleDelta;
      return (left.benchmark?.medianNs || Number.POSITIVE_INFINITY)
        - (right.benchmark?.medianNs || Number.POSITIVE_INFINITY);
    })[0] || null;
}

function buildPlanningBaselineSummary(state, config) {
  const rows = getExpectedBucketKeys(config).map((bucketKey) => {
    const scalar = state.baselines[bucketKey] || null;
    const ne10 = latestNe10ReferenceCandidate(state, bucketKey);
    return {
      bucketKey,
      scalarMedianNs: Number.isFinite(scalar?.medianNs) ? Math.round(scalar.medianNs) : null,
      ne10MedianNs: Number.isFinite(ne10?.benchmark?.medianNs) ? Math.round(ne10.benchmark.medianNs) : null,
      ne10SpeedupPct: Number.isFinite(ne10?.benchmark?.speedupVsBaseline)
        ? Number(((ne10.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
        : null,
    };
  });
  return JSON.stringify(rows, null, 2);
}

function getLaneParticipantViews(ctx, state) {
  const laneCounts = new Map();
  return ctx.participants
    .map((participant) => {
      const lane = state.lanesByAgentId[participant.agentId] || '';
      if (!lane) return null;
      const laneIndex = laneCounts.get(lane) || 0;
      laneCounts.set(lane, laneIndex + 1);
      return { participant, lane, laneIndex };
    })
    .filter(Boolean);
}

function buildParticipantModelLabel(participant) {
  const profile = participant?.profile;
  if (!profile || typeof profile !== 'object') return '';
  return [profile.provider, profile.model].filter(Boolean).join(' / ');
}

function buildExplorerFocus(participant, laneIndex) {
  const providerModel = `${participant?.profile?.provider || ''} ${participant?.profile?.model || ''}`.toLowerCase();
  if (providerModel.includes('gemini') || providerModel.includes('google')) {
    return 'Push search breadth: propose structurally different decompositions and unexpected family mutations.';
  }
  if (providerModel.includes('gpt') || providerModel.includes('openai')) {
    return 'Bias toward implementation-friendly candidates that are likely to compile, validate, and benchmark cleanly.';
  }
  if (
    providerModel.includes('claude')
    || providerModel.includes('anthropic')
    || providerModel.includes('opus')
  ) {
    return 'Act as an adversarial explorer: target fragile buckets, edge cases, and local-minimum escape plans.';
  }

  const fallbackFocus = [
    'Push search breadth: propose structurally different decompositions and unexpected family mutations.',
    'Bias toward implementation-friendly candidates that are likely to compile, validate, and benchmark cleanly.',
    'Act as an adversarial explorer: target fragile buckets, edge cases, and local-minimum escape plans.',
  ];
  return fallbackFocus[laneIndex % fallbackFocus.length];
}

function buildLanePromptPreamble(participant, lane, laneIndex) {
  const lines = [`Participant: ${participant.displayName || participant.agentId}`];
  const modelLabel = buildParticipantModelLabel(participant);
  if (modelLabel) {
    lines.push(`Model context: ${modelLabel}`);
  }

  if (lane === 'explorer') {
    lines.push(`Exploration focus: ${buildExplorerFocus(participant, laneIndex)}`);
  } else if (lane === 'builder' || lane === 'builder_explorer_auditor') {
    lines.push('Build focus: generate runnable artifacts, preserve requested family metadata, and emit exact evidence.');
  } else if (lane === 'auditor' || lane === 'auditor_explorer') {
    lines.push('Audit focus: be adversarial about correctness, fidelity, and benchmark methodology.');
  }

  return lines;
}

export function buildDiscoveryTargets(ctx, state, config) {
  return getLaneParticipantViews(ctx, state).map(({ participant, lane, laneIndex }) => {
      const sourceContextHint = config.sourceContextPaths.length > 0
        ? `Focus first on these paths under the workspace: ${config.sourceContextPaths.join(', ')}`
        : 'Search the workspace for FFT code, benchmark harnesses, validation helpers, and compile scripts.';

      return {
        agentId: participant.agentId,
        message: [
          `You are the ${lane} role for an FFT autotune room.`,
          ...buildLanePromptPreamble(participant, lane, laneIndex),
          '',
          `Objective: ${ctx.objective}`,
          `Workspace: ${config.workspacePath}`,
          `Target sizes: ${config.targetSizes.join(', ')}`,
          `Target architecture: ${config.targetArch}`,
          `Compiler command: ${config.compilerCommand}`,
          `Compiler flags: ${config.compilerFlags.join(' ')}`,
          sourceContextHint,
          '',
          'Inspect the workspace and reply with JSON only using this shape:',
          '{',
          '  "summary": "short workspace summary",',
          '  "candidateProposals": [',
          '    {',
          '      "bucketKey": "n64-apple_silicon_neon",',
          '      "size": 64,',
          '      "family": "cooley_tukey_shallow",',
          '      "treeSpec": "balanced radix-4 then radix-2 cleanup",',
          '      "leafSizes": [4, 8],',
          '      "permutationStrategy": "bit_reverse_postpass",',
          '      "twiddleStrategy": "precompute_table",',
          '      "simdStrategy": "neon",',
          '      "notes": "why this family is promising for this bucket"',
          '    }',
          '  ],',
          '  "audits": [],',
          '  "results": []',
          '}',
          '',
          'Propose 2-4 diverse FFT families across the target sizes. Keep the JSON valid.',
        ].join('\n'),
      };
    });
}

export function buildBaselineTargets(ctx, state, config) {
  const missingBaselineBuckets = buildBaselineBootstrapSpecs(state, config);
  const baselineText = JSON.stringify(missingBaselineBuckets, null, 2);

  return getLaneParticipantViews(ctx, state)
    .filter(({ lane }) => lane === 'builder' || lane === 'builder_explorer_auditor')
    .map(({ participant, lane, laneIndex }) => ({
      agentId: participant.agentId,
      message: [
        `You are the ${lane} role for FFT baseline bootstrap.`,
        ...buildLanePromptPreamble(participant, lane, laneIndex),
        '',
        `Objective: ${ctx.objective}`,
        `Workspace: ${config.workspacePath}`,
        `Output directory: ${config.outputDir}`,
        `Compiler: ${config.compilerCommand} ${config.compilerFlags.join(' ')}`,
        `Validation samples: ${config.validationSamples}`,
        `Benchmark warmups: ${config.benchmarkWarmups}`,
        `Benchmark trials: ${config.benchmarkTrials}`,
        '',
        '=== HARNESS (MANDATORY) ===',
        getHarnessCompileHint(config),
        'Read HARNESS_USAGE.txt in the output directory for full details.',
        '',
        '=== Ne10 NEON REFERENCE BENCHMARK (MANDATORY) ===',
        'A pinned Ne10 NEON FFT reference pack is scaffolded into the output directory.',
        'After establishing each scalar baseline, ALSO compile and benchmark the Ne10 adapter for the same bucket.',
        'This establishes the NEON performance ceiling — how fast a known-good NEON FFT runs on this machine.',
        'Read NE10_USAGE.txt for the exact compile command. The adapter uses harness.c like any other candidate.',
        'Report each Ne10 benchmark as a regular (non-baseline) result with family "ne10_neon_reference" and isBaseline: false.',
        'Do NOT mark Ne10 results as isBaseline: true — the scalar reference is the canonical baseline.',
        'The gap between the scalar baseline and the Ne10 speedupVsBaseline tells you how much NEON headroom exists.',
        'If Ne10 is not faster than the auto-vectorized scalar baseline for a given bucket, NEON intrinsics will not help for that size.',
        '',
        'This startup phase is baseline-only. Do not propose new search candidates yet.',
        '',
        'Establish a fresh same-run baseline for every missing bucket below before candidate ranking begins:',
        baselineText,
        '',
        'For each bucket: (1) compile + validate + benchmark a scalar reference, (2) compile + validate + benchmark the Ne10 adapter.',
        'A baseline must come from compile + validate + benchmark evidence produced in this run.',
        'You may reuse existing workspace source only if you compile, validate, and benchmark it again now.',
        'If no suitable scalar baseline exists, generate a straightforward correct iterative radix-4 DIF reference implementation for that bucket.',
        'Your baseline .c file must export: void dft_<N>(const complex float* input, complex float* output);',
        'Compile it with harness.c using the command above. Do NOT write a custom harness.',
        '',
        'Reply with JSON only using this shape:',
        '{',
        '  "summary": "what baseline artifacts were created",',
        '  "results": [',
        '    {',
        '      "proposalId": "baseline-n64-1",',
        '      "bucketKey": "n64-apple_silicon_neon",',
        '      "family": "baseline_reference",',
        '      "isBaseline": true,',
        '      "treeSpec": "reference or baseline implementation",',
        '      "leafSizes": [8],',
        '      "permutationStrategy": "natural_order",',
        '      "twiddleStrategy": "baseline_table",',
        '      "simdStrategy": "scalar",',
        '      "compile": { "ok": true, "command": "clang ...", "exitCode": 0, "binaryPath": "...", "stderrPath": "" },',
        '      "validation": { "ok": true, "sampleCount": 64, "maxError": 0.0, "tolerance": 0.001, "failureReason": "", "validationPath": "path/to/validation.json" },',
        '      "benchmark": { "ok": true, "warmups": 5, "trials": 30, "medianNs": 13800, "p95Ns": 14200, "cvPct": 2.8, "samplePath": "..." },',
        '      "baselineBenchmarks": [ { "bucketKey": "n64-apple_silicon_neon", "medianNs": 13800, "p95Ns": 14200, "cvPct": 2.8 } ],',
        '      "artifactPaths": ["path/to/baseline.c", "path/to/validation.json", "path/to/bench.json"],',
        '      "notes": "fresh same-run baseline"',
        '    }',
        '  ],',
        '  "candidateProposals": [],',
        '  "audits": []',
        '}',
        '',
        'If a baseline bucket fails, report the real failure diagnostics instead of omitting the bucket.',
      ].join('\n'),
    }));
}

export function buildTriedCandidatesSummary(state) {
  if (state.candidates.length === 0) return '[]';
  const seen = new Set();
  const rows = [...state.candidates]
    .sort((a, b) => {
      const cycleDelta = (b.cycle || 0) - (a.cycle || 0);
      if (cycleDelta !== 0) return cycleDelta;
      return (b.bucketKey || '').localeCompare(a.bucketKey || '');
    })
    .filter((candidate) => {
      const key = [
        candidate.bucketKey,
        candidate.family,
        candidate.treeSpec,
        candidate.simdStrategy,
      ].join('::');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24)
    .sort((a, b) => {
      const bucketCmp = (a.bucketKey || '').localeCompare(b.bucketKey || '');
      if (bucketCmp !== 0) return bucketCmp;
      const cycleDelta = (b.cycle || 0) - (a.cycle || 0);
      if (cycleDelta !== 0) return cycleDelta;
      return (a.family || '').localeCompare(b.family || '');
    })
    .map((c) => ({
      cycle: c.cycle,
      bucketKey: c.bucketKey,
      family: c.family,
      treeSpec: c.treeSpec,
      simdStrategy: c.simdStrategy,
      status: c.status,
      medianNs: Number.isFinite(c.benchmark?.medianNs) ? Math.round(c.benchmark.medianNs) : null,
      speedupPct: Number.isFinite(c.benchmark?.speedupVsBaseline)
        ? Number(((c.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
        : null,
      issues: c.audit?.openHighConfidenceFindings || 0,
    }));
  return JSON.stringify(rows, null, 2);
}

export function buildCycleTargets(ctx, state, config) {
  const frontierRows = buildPromptFrontierRows(state).slice(0, 6);
  const frontierText = frontierRows.length > 0
    ? JSON.stringify(frontierRows, null, 2)
    : '[]';
  const promotedText = JSON.stringify(state.activePromotedProposals, null, 2);
  const baselineText = JSON.stringify(state.baselines, null, 2);
  const diagnostics = buildRecentFailureDiagnostics(state);
  const diagnosticsText = diagnostics.length > 0
    ? JSON.stringify(diagnostics, null, 2)
    : '[]';
  const repairDirectives = buildRepairDirectives(state, config);
  const repairText = repairDirectives.length > 0
    ? JSON.stringify(repairDirectives, null, 2)
    : '[]';
  const missingBaselineBuckets = getMissingBaselineBucketKeys(state, config);
  const missingBaselineText = missingBaselineBuckets.length > 0
    ? JSON.stringify(missingBaselineBuckets, null, 2)
    : '[]';
  const triedCandidatesText = buildTriedCandidatesSummary(state);

  return getLaneParticipantViews(ctx, state)
    .filter(({ lane }) => lane === 'builder' || lane === 'builder_explorer_auditor')
    .map(({ participant, lane, laneIndex }) => ({
      agentId: participant.agentId,
      message: [
        `You are the ${lane} role in cycle ${state.cycleIndex}.`,
        ...buildLanePromptPreamble(participant, lane, laneIndex),
        '',
        `Workspace: ${config.workspacePath}`,
        `Output directory: ${config.outputDir}`,
        `Compiler: ${config.compilerCommand} ${config.compilerFlags.join(' ')}`,
        `Validation samples: ${config.validationSamples}`,
        `Benchmark warmups: ${config.benchmarkWarmups}`,
        `Benchmark trials: ${config.benchmarkTrials}`,
        `Benchmark override: ${config.benchmarkCommand || '(none)'}`,
        '',
        '=== HARNESS (MANDATORY) ===',
        getHarnessCompileHint(config),
        '',
        '=== NEON STRATEGY ===',
        'Before writing a NEON candidate, check the Ne10 reference benchmark for this bucket (established during baseline).',
        'If the Ne10 NEON number is not meaningfully faster than the scalar baseline, do NOT attempt NEON intrinsics for this bucket — the auto-vectorizer already saturates the hardware.',
        'If NEON headroom exists, study the intrinsics patterns in third_party/ne10/modules/dsp/ (especially NE10_fft_float32.neonintrinsic.c and NE10_fft.neonintrinsic.h) before writing your candidate.',
        'If you claim "simdStrategy": "neon", the source must include real arm_neon.h intrinsics. Scalar C compiled with -march=native is NOT a NEON implementation.',
        '',
        'Implement, compile, validate, and benchmark these promoted FFT specs:',
        promotedText,
        '',
        'Known baseline measurements by bucket:',
        baselineText,
        '',
        'Buckets still missing a fresh same-run baseline:',
        missingBaselineText,
        '',
        'Recent validation and audit diagnostics from this room:',
        diagnosticsText,
        '',
        'Buckets in repair mode due to repeated failure signatures:',
        repairText,
        '',
        'All candidates tried so far in this room for context:',
        triedCandidatesText,
        '',
        'Reply with JSON only using this shape:',
        '{',
        '  "summary": "what you built",',
        '  "results": [',
        '    {',
        '      "proposalId": "cycle1-n64-1",',
        '      "bucketKey": "n64-apple_silicon_neon",',
        '      "family": "cooley_tukey_shallow",',
        '      "treeSpec": "balanced radix-4 then radix-2 cleanup",',
        '      "leafSizes": [4, 8],',
        '      "permutationStrategy": "bit_reverse_postpass",',
        '      "twiddleStrategy": "precompute_table",',
        '      "simdStrategy": "neon",',
        '      "compile": { "ok": true, "command": "clang -O3 ... -DDFT_SIZE=64 -DDFT_FUNC=dft_64 my_fft.c harness.c -o out.bin -lm", "exitCode": 0, "binaryPath": "...", "stderrPath": "" },',
        '      "validation": { "ok": true, "sampleCount": 64, "maxError": 0.0004, "tolerance": 0.001, "failureReason": "", "validationPath": "path/to/validation.json", "firstFailInputLabel": "single_tone_bin_1", "firstFailIndex": 17, "firstFailExpected": "0.0 + 0.0i", "firstFailActual": "0.0012 - 0.0003i", "firstFailError": 0.00124, "orderingHint": "matches after bit reversal", "suspectedIssue": "output permutation mismatch", "diagnosticSummary": "deterministic vectors pass except natural-order compare" },',
        '      "benchmark": { "ok": true, "warmups": 5, "trials": 30, "medianNs": 12345, "p95Ns": 13000, "cvPct": 2.1, "speedupVsBaseline": 1.12, "samplePath": "..." },',
        '      "baselineBenchmarks": [ { "bucketKey": "n64-apple_silicon_neon", "medianNs": 13800, "p95Ns": 14200, "cvPct": 2.8 } ],',
        '      "artifactPaths": ["path/to/code.c", "path/to/bench.json"],',
        '      "notes": "brief notes"',
        '    }',
        '  ],',
        '  "candidateProposals": [],',
        '  "audits": []',
        '}',
        '',
        'This is the build phase. Do not spend response budget on fresh exploration or speculative audits here.',
        'Your FFT .c file must export: void dft_<N>(const complex float* input, complex float* output);',
        'Compile with harness.c using the command above. Do NOT write a custom harness or benchmark loop.',
        'The harness handles validation (deterministic vectors + random), benchmark (warmups, trials, timing), and JSON output.',
        'Read the validation.json and benchmark.json produced by the harness to fill in the result fields above.',
        'If any requested bucket is still missing a same-run baseline, establish that baseline before expecting frontier eligibility for any bucket.',
        'If validation fails, emit the diagnostic fields above using real workspace evidence instead of only "max error exceeded tolerance".',
        'Use the recent diagnostics to target the likely bug class: permutation/order, twiddle sign, stride/indexing, normalization, or accumulation precision.',
        'If a promoted bucket is in repair mode, treat the task as fixing the recorded bug signature in that bucket. Prefer mutating the most recent failing artifact or harness over inventing a fresh unrelated family.',
        'If the implementation diverges from the promoted leaf sizes, permutation strategy, or tree shape, report the ACTUAL built metadata honestly in the result JSON and explain the divergence in notes.',
        'If the implementation does not actually use NEON intrinsics yet, report "simdStrategy": "scalar" honestly. A scalar-but-correct FFT is acceptable as an intermediate candidate and should not be hidden.',
        'Do not silently swap to a different algorithm family or fallback direct DFT while keeping the original FFT metadata.',
        '',
        'Use real compile, validation, and benchmark evidence from the workspace. Keep the JSON valid.',
      ].join('\n'),
    }));
}

export function buildPlanningTargets(ctx, state, config) {
  const frontierRows = buildPromptFrontierRows(state).slice(0, 6);
  const frontierText = frontierRows.length > 0
    ? JSON.stringify(frontierRows, null, 2)
    : '[]';
  const diagnostics = buildRecentFailureDiagnostics(state);
  const diagnosticsText = diagnostics.length > 0
    ? JSON.stringify(diagnostics, null, 2)
    : '[]';
  const repairDirectives = buildRepairDirectives(state, config);
  const repairText = repairDirectives.length > 0
    ? JSON.stringify(repairDirectives, null, 2)
    : '[]';
  const missingBaselineBuckets = getMissingBaselineBucketKeys(state, config);
  const missingBaselineText = missingBaselineBuckets.length > 0
    ? JSON.stringify(missingBaselineBuckets, null, 2)
    : '[]';
  const triedCandidatesText = buildTriedCandidatesSummary(state);
  const backlogPreview = state.proposalBacklog.slice(0, 12).map((proposal) => ({
    bucketKey: proposal.bucketKey,
    family: proposal.family,
    treeSpec: proposal.treeSpec,
    simdStrategy: proposal.simdStrategy,
    notes: proposal.notes || '',
  }));
  const backlogText = backlogPreview.length > 0
    ? JSON.stringify(backlogPreview, null, 2)
    : '[]';
  const baselineSummaryText = buildPlanningBaselineSummary(state, config);
  const exploitFirstInstructions = state.cycleIndex <= 1
    ? [
        'This is the first planning cycle after fresh baselines. Be exploit-first, not novelty-first.',
        'For every unresolved bucket, include at least one grounded proposal that directly follows the scalar baseline shape or the Ne10 reference shape for that same bucket.',
        'At most one proposal per bucket may be a broad wildcard family. Use wildcard slots only after you include a grounded exploit-first proposal for that bucket.',
        'Do not spend n64 slots on transpose-heavy matrix families (four-step/six-step) unless the room already has evidence they beat the simpler radix-based plans.',
        'If the Ne10 reference materially beats the scalar baseline for a bucket, prefer direct NEON lowering, Ne10-shaped mixed-radix plans, or minimal mutations of the baseline tree before proposing exotic constant-geometry layouts.',
      ]
    : [
        'Keep planning exploit-first unless the room has already plateaued on a bucket.',
        'Prefer incumbent mutations or baseline/Ne10-shaped lowerings before proposing broad new families.',
        'Use at most one wildcard family per bucket unless repeated repairs show the incumbent direction is exhausted.',
      ];

  return getLaneParticipantViews(ctx, state)
    .filter(({ lane }) => lane === 'explorer' || lane === 'auditor_explorer' || lane === 'builder_explorer_auditor')
    .map(({ participant, lane, laneIndex }) => ({
      agentId: participant.agentId,
      message: [
        `You are the ${lane} role in search planning for cycle ${state.cycleIndex}.`,
        ...buildLanePromptPreamble(participant, lane, laneIndex),
        '',
        `Workspace: ${config.workspacePath}`,
        `Target architecture: ${config.targetArch}`,
        `Target sizes: ${config.targetSizes.join(', ')}`,
        '',
        'Current frontier:',
        frontierText,
        '',
        'Existing proposal backlog (highest priority first):',
        backlogText,
        '',
        'Canonical scalar baselines and Ne10 reference headroom by bucket:',
        baselineSummaryText,
        '',
        'Buckets still missing a fresh same-run baseline:',
        missingBaselineText,
        '',
        'Recent validation and audit diagnostics from this room:',
        diagnosticsText,
        '',
        'Buckets in repair mode due to repeated failure signatures:',
        repairText,
        '',
        'All candidates tried so far in this room (do NOT re-propose these):',
        triedCandidatesText,
        '',
        'Reply with JSON only using this shape:',
        '{',
        '  "summary": "short planning summary",',
        '  "candidateProposals": [',
        '    {',
        '      "bucketKey": "n256-apple_silicon_neon",',
        '      "size": 256,',
        '      "family": "split_radix_hybrid",',
        '      "treeSpec": "split-radix with radix-4 leaves",',
        '      "leafSizes": [4, 8],',
        '      "permutationStrategy": "recursive_inplace",',
        '      "twiddleStrategy": "fused_twiddle_blocks",',
        '      "simdStrategy": "neon",',
        '      "notes": "why this should escape the current local minimum"',
        '    }',
        '  ],',
        '  "audits": [],',
        '  "results": []',
        '}',
        '',
        'Explorer comes before builder in this cycle. Focus on giving the builder the best next candidates, not on speculative post-build audits.',
        ...exploitFirstInstructions,
        'Bias new proposals toward unresolved buckets and toward fixes suggested by the recent diagnostics instead of repeating the same broken indexing plan.',
        'If a bucket is in repair mode, propose targeted mutations for that bucket instead of broad new families.',
      ].join('\n'),
    }));
}

export function buildAuditTargets(ctx, state, config) {
  const frontierRows = buildPromptFrontierRows(state).slice(0, 6);
  const frontierText = frontierRows.length > 0
    ? JSON.stringify(frontierRows, null, 2)
    : '[]';
  const promotedText = JSON.stringify(state.activePromotedProposals, null, 2);
  const diagnostics = buildRecentFailureDiagnostics(state);
  const diagnosticsText = diagnostics.length > 0
    ? JSON.stringify(diagnostics, null, 2)
    : '[]';
  const repairDirectives = buildRepairDirectives(state, config);
  const repairText = repairDirectives.length > 0
    ? JSON.stringify(repairDirectives, null, 2)
    : '[]';
  const triedCandidatesText = buildTriedCandidatesSummary(state);
  const activeProposalIds = new Set((state.activePromotedProposals || []).map((proposal) => proposal.proposalId));
  const builtThisCycle = state.candidates
    .filter((candidate) => activeProposalIds.has(candidate.proposalId || candidate.candidateId))
    .map((candidate) => ({
      proposalId: candidate.proposalId || candidate.candidateId,
      bucketKey: candidate.bucketKey,
      family: candidate.family,
      treeSpec: candidate.treeSpec,
      simdStrategy: candidate.simdStrategy,
      medianNs: Number.isFinite(candidate.benchmark?.medianNs) ? Number(candidate.benchmark.medianNs.toFixed(2)) : null,
      speedupPct: Number.isFinite(candidate.benchmark?.speedupVsBaseline)
        ? Number(((candidate.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
        : null,
      maxError: Number.isFinite(candidate.validation?.maxError)
        ? Number(candidate.validation.maxError.toPrecision(6))
        : null,
      cvPct: Number.isFinite(candidate.benchmark?.cvPct)
        ? Number(candidate.benchmark.cvPct.toFixed(2))
        : null,
      notes: safeTrim(candidate.notes, 240),
    }));
  const builtText = builtThisCycle.length > 0
    ? JSON.stringify(builtThisCycle, null, 2)
    : '[]';

  return getLaneParticipantViews(ctx, state)
    .filter(({ lane }) => lane === 'auditor' || lane === 'auditor_explorer' || lane === 'builder_explorer_auditor')
    .map(({ participant, lane, laneIndex }) => ({
      agentId: participant.agentId,
      message: [
        `You are the ${lane} role in post-build audit for cycle ${state.cycleIndex}.`,
        ...buildLanePromptPreamble(participant, lane, laneIndex),
        '',
        'You are auditing the actual built artifacts from this cycle, not only the promoted specs.',
        '',
        'Promoted specs for reference:',
        promotedText,
        '',
        'Just-built candidates from this cycle:',
        builtText,
        '',
        'Current frontier for context:',
        frontierText,
        '',
        'Recent validation and audit diagnostics from this room:',
        diagnosticsText,
        '',
        'Buckets in repair mode due to repeated failure signatures:',
        repairText,
        '',
        'All candidates tried so far in this room:',
        triedCandidatesText,
        '',
        'Reply with JSON only using this shape:',
        '{',
        '  "summary": "top audit risks",',
        '  "audits": [',
        '    {',
        '      "proposalId": "cycle1-n64-1",',
        '      "openHighConfidenceFindings": 1,',
        '      "openMediumConfidenceFindings": 2,',
        '      "retestRequested": true,',
        '      "notes": "what needs to be rechecked"',
        '    }',
        '  ],',
        '  "candidateProposals": [',
        '    {',
        '      "bucketKey": "n64-apple_silicon_neon",',
        '      "size": 64,',
        '      "family": "stockham_autosort",',
        '      "treeSpec": "uniform stockham stages",',
        '      "leafSizes": [4],',
        '      "permutationStrategy": "autosort",',
        '      "twiddleStrategy": "stage_local",',
        '      "simdStrategy": "neon",',
        '      "notes": "mutation or alternative family to try next"',
        '    }',
        '  ],',
        '  "results": []',
        '}',
        '',
        'Use the actual built results above when deciding whether a finding is blocking. Avoid speculative high-confidence findings unless the built evidence really supports them.',
        'Treat a missing NEON implementation by itself as a medium-confidence non-blocking SIMD gap if the candidate is otherwise a real FFT that compiles, validates, and benchmarks cleanly.',
      ].join('\n'),
    }));
}

export function buildReexplorationTargets(ctx, state, config) {
  const missingWinnerBuckets = getMissingWinnerBucketKeys(state, config);
  const missingBucketText = JSON.stringify(missingWinnerBuckets, null, 2);
  const frontierRows = buildPromptFrontierRows(state).slice(0, 6);
  const frontierText = frontierRows.length > 0
    ? JSON.stringify(frontierRows, null, 2)
    : '[]';
  const diagnostics = buildRecentFailureDiagnostics(state);
  const diagnosticsText = diagnostics.length > 0
    ? JSON.stringify(diagnostics, null, 2)
    : '[]';
  const repairDirectives = buildRepairDirectives(state, config);
  const repairText = repairDirectives.length > 0
    ? JSON.stringify(repairDirectives, null, 2)
    : '[]';

  const triedByBucket = {};
  for (const bucketKey of missingWinnerBuckets) {
    const bucketCandidates = state.candidates.filter((c) => c.bucketKey === bucketKey);
    triedByBucket[bucketKey] = bucketCandidates.map((c) => ({
      family: c.family,
      treeSpec: c.treeSpec,
      simdStrategy: c.simdStrategy,
      status: c.status,
      issues: c.audit?.openHighConfidenceFindings || 0,
      notes: c.notes ? c.notes.slice(0, 200) : '',
    }));
  }
  const triedText = JSON.stringify(triedByBucket, null, 2);

  const winnersByBucket = {};
  for (const candidateId of state.frontierIds) {
    const winner = findCandidateById(state, candidateId);
    if (!winner) continue;
    winnersByBucket[winner.bucketKey] = {
      family: winner.family,
      treeSpec: winner.treeSpec,
      leafSizes: winner.leafSizes,
      permutationStrategy: winner.permutationStrategy,
      twiddleStrategy: winner.twiddleStrategy,
      simdStrategy: winner.simdStrategy,
      medianNs: winner.benchmark?.medianNs,
      speedupPct: Number.isFinite(winner.benchmark?.speedupVsBaseline)
        ? Number(((winner.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
        : null,
    };
  }
  const winnersText = Object.keys(winnersByBucket).length > 0
    ? JSON.stringify(winnersByBucket, null, 2)
    : '[]';

  return getLaneParticipantViews(ctx, state).map(({ participant, lane, laneIndex }) => {
    const commonContext = [
      `You are the ${lane} role in a targeted re-exploration phase (cycle ${state.cycleIndex}).`,
      ...buildLanePromptPreamble(participant, lane, laneIndex),
      '',
      `Workspace: ${config.workspacePath}`,
      `Target architecture: ${config.targetArch}`,
      '',
      'The proposal backlog is exhausted but these buckets still lack a winning candidate:',
      missingBucketText,
      '',
      'Previously attempted candidates for these buckets (all failed or were blocked):',
      triedText,
      '',
      'Winning families from solved buckets (consider adapting these for missing buckets):',
      winnersText,
      '',
      'Current frontier for solved buckets:',
      frontierText,
      '',
      'Recent failure diagnostics:',
      diagnosticsText,
      '',
      'Repair directives from repeated failure patterns:',
      repairText,
    ];

    const jsonShape = [
      'Reply with JSON only using this shape:',
      '{',
      '  "summary": "re-exploration strategy for missing buckets",',
      '  "candidateProposals": [',
      '    {',
      '      "bucketKey": "n1024-apple_silicon_neon",',
      '      "size": 1024,',
      '      "family": "stockham_autosort",',
      '      "treeSpec": "uniform stockham stages",',
      '      "leafSizes": [4],',
      '      "permutationStrategy": "autosort",',
      '      "twiddleStrategy": "stage_local",',
      '      "simdStrategy": "neon",',
      '      "notes": "why this approach avoids the previous failure modes"',
      '    }',
      '  ],',
      '  "audits": [],',
      '  "results": []',
      '}',
    ];

    let laneInstructions;
    if (lane === 'auditor' || lane === 'auditor_explorer') {
      laneInstructions = [
        'Analyze the root causes of previous failures for the missing buckets.',
        'Classify each failure as permutation, twiddle, stride, normalization, harness defect, or audit false positive.',
        'Propose structurally different candidates that avoid the identified failure modes.',
      ];
    } else if (lane === 'builder' || lane === 'builder_explorer_auditor') {
      laneInstructions = [
        'Propose candidates you are confident can compile, validate, and benchmark cleanly.',
        'Use the failure diagnostics to avoid repeating the same mistakes.',
        'Prefer simpler decompositions or well-known FFT structures for the failing bucket sizes.',
      ];
    } else {
      laneInstructions = [
        'Propose structurally different FFT families than what was already tried.',
        'Vary the tree decomposition, permutation strategy, twiddle approach, or leaf sizes.',
        'Target candidates that address the specific failure patterns in the diagnostics.',
      ];
    }

    return {
      agentId: participant.agentId,
      message: [
        ...commonContext,
        '',
        ...jsonShape,
        '',
        ...laneInstructions,
        'You MUST propose candidates for the missing buckets only — do not re-propose for solved buckets.',
        'Focus exclusively on approaches that differ from previous attempts listed above.',
      ].join('\n'),
    };
  });
}

function makeProposalId(cycleIndex, proposalIndex, bucketKey) {
  return `cycle${cycleIndex}-${bucketKey}-${proposalIndex}`;
}

const LEAF_SIZE_VARIANTS = [[2], [4], [8], [4, 8], [4, 16]];
const TWIDDLE_VARIANTS = ['precompute_table', 'stage_local', 'fused_twiddle_blocks', 'on_the_fly'];
const PERMUTATION_VARIANTS = ['bit_reverse_postpass', 'autosort', 'recursive_inplace', 'table_lookup'];

export function winnerMutationProposals(state, config, preferredBucketKeys) {
  const proposals = [];
  const allowedBuckets = preferredBucketKeys instanceof Set && preferredBucketKeys.size > 0
    ? preferredBucketKeys
    : null;

  const winners = state.frontierIds
    .map((id) => findCandidateById(state, id))
    .filter(Boolean);

  if (winners.length === 0) return proposals;

  for (const winner of winners) {
    const targetBuckets = allowedBuckets
      ? [...allowedBuckets]
      : config.targetSizes.map((size) => resolveBucketKey(size, config));

    for (const bucketKey of targetBuckets) {
      const size = parseInt(bucketKey.match(/^n(\d+)/)?.[1] || '64', 10);
      if (!isPowerOfTwo(size) || !config.targetSizes.includes(size)) continue;

      const source = bucketKey === winner.bucketKey ? 'same-bucket mutation' : 'cross-bucket transfer';

      for (const leafSizes of LEAF_SIZE_VARIANTS) {
        if (leafSizes.join('-') === (winner.leafSizes || []).join('-')) continue;
        proposals.push({
          bucketKey,
          size,
          family: winner.family,
          treeSpec: winner.treeSpec,
          leafSizes: [...leafSizes],
          permutationStrategy: winner.permutationStrategy,
          twiddleStrategy: winner.twiddleStrategy,
          simdStrategy: winner.simdStrategy,
          notes: `${source} from ${winner.bucketKey} winner: changed leafSizes to [${leafSizes}]`,
          proposedByWorkerId: 'plugin_mutation',
          lane: 'explorer',
        });
      }

      for (const twiddle of TWIDDLE_VARIANTS) {
        if (twiddle === winner.twiddleStrategy) continue;
        proposals.push({
          bucketKey,
          size,
          family: winner.family,
          treeSpec: winner.treeSpec,
          leafSizes: [...(winner.leafSizes || [4, 8])],
          permutationStrategy: winner.permutationStrategy,
          twiddleStrategy: twiddle,
          simdStrategy: winner.simdStrategy,
          notes: `${source} from ${winner.bucketKey} winner: changed twiddle to ${twiddle}`,
          proposedByWorkerId: 'plugin_mutation',
          lane: 'explorer',
        });
      }

      for (const perm of PERMUTATION_VARIANTS) {
        if (perm === winner.permutationStrategy) continue;
        proposals.push({
          bucketKey,
          size,
          family: winner.family,
          treeSpec: winner.treeSpec,
          leafSizes: [...(winner.leafSizes || [4, 8])],
          permutationStrategy: perm,
          twiddleStrategy: winner.twiddleStrategy,
          simdStrategy: winner.simdStrategy,
          notes: `${source} from ${winner.bucketKey} winner: changed permutation to ${perm}`,
          proposedByWorkerId: 'plugin_mutation',
          lane: 'explorer',
        });
      }
    }
  }

  return proposals;
}

export function fallbackSeedProposals(config, preferredBucketKeys) {
  const proposals = [];
  const allowedBuckets = preferredBucketKeys instanceof Set && preferredBucketKeys.size > 0
    ? preferredBucketKeys
    : null;
  for (const size of config.targetSizes) {
    const bucketKey = resolveBucketKey(size, config);
    if (allowedBuckets && !allowedBuckets.has(bucketKey)) continue;
    for (const family of DEFAULT_FAMILIES) {
      proposals.push({
        bucketKey,
        size,
        family: family.family,
        treeSpec: family.treeSpec,
        leafSizes: [...family.leafSizes],
        permutationStrategy: family.permutationStrategy,
        twiddleStrategy: family.twiddleStrategy,
        simdStrategy: family.simdStrategy,
        notes: 'Default seeded family from plugin fallback',
        proposedByWorkerId: 'plugin_seed',
        lane: 'explorer',
      });
    }
  }
  return proposals;
}

function buildProposalKey(proposal) {
  return [
    proposal.bucketKey,
    proposal.family,
    proposal.treeSpec,
    (proposal.leafSizes || []).join('-'),
    proposal.permutationStrategy,
    proposal.twiddleStrategy,
    proposal.simdStrategy,
  ].join('::');
}

export function enqueueProposals(state, proposals, config) {
  const currentKeys = new Set(state.proposalBacklog.map((proposal) => buildProposalKey(proposal)));
  for (const proposal of proposals) {
    if (!config.targetSizes.includes(proposal.size) || !isPowerOfTwo(proposal.size)) continue;
    const proposalKey = buildProposalKey(proposal);
    if (currentKeys.has(proposalKey)) continue;
    currentKeys.add(proposalKey);
    state.proposalBacklog.push(proposal);
  }
}

function canPromoteProposal(familyCounts, proposal, config) {
  const currentFamilyCount = familyCounts.get(proposal.family) || 0;
  return currentFamilyCount < config.maxCandidatesPerFamily;
}

function appendPromotedProposal(state, selected, selectedIndexes, familyCounts, proposal, backlogIndex) {
  selected.push({
    ...proposal,
    proposalId: makeProposalId(state.cycleIndex, selected.length + 1, proposal.bucketKey),
  });
  selectedIndexes.add(backlogIndex);
  familyCounts.set(proposal.family, (familyCounts.get(proposal.family) || 0) + 1);
}

export function selectActivePromotedProposals(state, config) {
  const familyCounts = new Map();
  const selected = [];
  const selectedIndexes = new Set();
  const missingBaselineBuckets = new Set(getMissingBaselineBucketKeys(state, config));
  const missingWinnerBuckets = new Set(getMissingWinnerBucketKeys(state, config));
  const repairBuckets = new Set(buildRepairDirectives(state, config).map((directive) => directive.bucketKey));
  const prioritizedBuckets = [
    ...Array.from(missingBaselineBuckets),
    ...Array.from(repairBuckets),
    ...Array.from(missingWinnerBuckets).filter((bucketKey) => !repairBuckets.has(bucketKey) && !missingBaselineBuckets.has(bucketKey)),
  ];

  if (missingWinnerBuckets.size > 0) {
    for (const bucketKey of prioritizedBuckets) {
      if (selected.length >= config.promoteTopK) break;
      const backlogIndex = state.proposalBacklog.findIndex((proposal, index) =>
        !selectedIndexes.has(index)
        && proposal.bucketKey === bucketKey
        && canPromoteProposal(familyCounts, proposal, config),
      );
      if (backlogIndex >= 0) {
        appendPromotedProposal(
          state,
          selected,
          selectedIndexes,
          familyCounts,
          state.proposalBacklog[backlogIndex],
          backlogIndex,
        );
      }
    }
  }

  for (const restrictToMissingBuckets of [true, false]) {
    if (selected.length >= config.promoteTopK) break;
    for (let index = 0; index < state.proposalBacklog.length; index += 1) {
      if (selected.length >= config.promoteTopK) break;
      if (selectedIndexes.has(index)) continue;
      const proposal = state.proposalBacklog[index];
      if (!canPromoteProposal(familyCounts, proposal, config)) continue;
      if (missingBaselineBuckets.size > 0 && !missingBaselineBuckets.has(proposal.bucketKey)) {
        const hasUnselectedMissingBaselineProposal = state.proposalBacklog.some((candidateProposal, candidateIndex) =>
          !selectedIndexes.has(candidateIndex)
          && missingBaselineBuckets.has(candidateProposal.bucketKey)
          && canPromoteProposal(familyCounts, candidateProposal, config),
        );
        if (hasUnselectedMissingBaselineProposal) {
          continue;
        }
      }
      if (restrictToMissingBuckets && missingWinnerBuckets.size > 0 && !missingWinnerBuckets.has(proposal.bucketKey)) {
        continue;
      }
      if (repairBuckets.size > 0 && restrictToMissingBuckets && !repairBuckets.has(proposal.bucketKey)) {
        const hasUnselectedRepairProposal = state.proposalBacklog.some((candidateProposal, candidateIndex) =>
          !selectedIndexes.has(candidateIndex)
          && repairBuckets.has(candidateProposal.bucketKey)
          && canPromoteProposal(familyCounts, candidateProposal, config),
        );
        if (hasUnselectedRepairProposal) {
          continue;
        }
      }
      appendPromotedProposal(state, selected, selectedIndexes, familyCounts, proposal, index);
    }
  }

  state.proposalBacklog = state.proposalBacklog.filter((_, index) => !selectedIndexes.has(index));
  state.activePromotedProposals = selected;
}

export function buildPendingDecision(ctx, state, config) {
  let targets = null;

  if (state.pendingFanOut === 'baseline') {
    targets = buildBaselineTargets(ctx, state, config);
  } else if (state.pendingFanOut === 'planning') {
    targets = buildPlanningTargets(ctx, state, config);
  } else if (state.pendingFanOut === 'discovery') {
    targets = buildDiscoveryTargets(ctx, state, config);
  } else if (state.pendingFanOut === 'reexplore') {
    targets = buildReexplorationTargets(ctx, state, config);
  } else if (state.pendingFanOut === 'audit') {
    targets = buildAuditTargets(ctx, state, config);
  } else if (state.pendingFanOut === 'cycle' && state.activePromotedProposals.length > 0) {
    targets = buildCycleTargets(ctx, state, config);
  }

  if (!targets) return null;

  // Issue 4: Never return an empty fan_out targets array – the orchestrator
  // contract requires at least one target.  Return a pause instead.
  if (targets.length === 0) {
    return {
      type: 'pause',
      reason: 'no participants available for fan-out',
    };
  }

  return {
    type: 'fan_out',
    targets,
  };
}
