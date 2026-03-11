import { DEFAULT_FAMILIES } from './constants.js';
import { getExpectedBucketKeys, getMissingBaselineBucketKeys, getMissingWinnerBucketKeys } from './buckets.js';
import { findCandidateById } from './candidates.js';
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

  return getLaneParticipantViews(ctx, state).map(({ participant, lane, laneIndex }) => {

      if (lane === 'builder' || lane === 'builder_explorer_auditor') {
        return {
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
            'Establish a fresh same-run baseline for every missing bucket below before candidate ranking begins:',
            baselineText,
            '',
            'A baseline must come from compile + validate + benchmark evidence produced in this run.',
            'You may reuse existing workspace source only if you compile, validate, and benchmark it again now.',
            'If no suitable baseline exists, generate a straightforward correct reference-quality implementation and harness for that bucket.',
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
            'Before random validation, make the harness run deterministic vectors first: impulse, all-ones, single-tone, alternating-sign, then fixed-seed random.',
            'If a baseline bucket fails, report the real failure diagnostics instead of omitting the bucket.',
          ].join('\n'),
        };
      }

      const sourceContextHint = config.sourceContextPaths.length > 0
        ? `Focus first on these paths under the workspace: ${config.sourceContextPaths.join(', ')}`
        : 'Search the workspace for FFT code, benchmark harnesses, validation helpers, and compile scripts.';

      return {
        agentId: participant.agentId,
        message: [
          `You are the ${lane} role for FFT baseline bootstrap.`,
          ...buildLanePromptPreamble(participant, lane, laneIndex),
          '',
          `Objective: ${ctx.objective}`,
          `Workspace: ${config.workspacePath}`,
          `Target sizes: ${config.targetSizes.join(', ')}`,
          `Target architecture: ${config.targetArch}`,
          sourceContextHint,
          '',
          'Fresh same-run baselines are required for these buckets before ranking:',
          baselineText,
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
          'Prefer proposals for buckets that are still missing baselines.',
        ].join('\n'),
      };
    });
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

  return getLaneParticipantViews(ctx, state).map(({ participant, lane, laneIndex }) => {

      if (lane === 'builder' || lane === 'builder_explorer_auditor') {
        return {
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
            '      "compile": { "ok": true, "command": "clang ...", "exitCode": 0, "binaryPath": "...", "stderrPath": "" },',
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
            'Before random validation, update or regenerate the harness to run deterministic vectors first: impulse, all-ones, single-tone, alternating-sign, then one fixed-seed random input.',
            'If any requested bucket is still missing a same-run baseline, establish that baseline before expecting frontier eligibility for any bucket.',
            'If validation fails, emit the diagnostic fields above using real workspace evidence instead of only "max error exceeded tolerance".',
            'Use the recent diagnostics to target the likely bug class: permutation/order, twiddle sign, stride/indexing, normalization, or accumulation precision.',
            'If a promoted bucket is in repair mode, treat the task as fixing the recorded bug signature in that bucket. Prefer mutating the most recent failing artifact or harness over inventing a fresh unrelated family.',
            'If the implementation does not actually use NEON intrinsics yet, report "simdStrategy": "scalar" honestly. A scalar-but-correct FFT is acceptable as an intermediate candidate and should not be hidden.',
            'Do not silently swap to a different algorithm family or fallback direct DFT while keeping the original FFT metadata.',
            '',
            'Use real compile, validation, and benchmark evidence from the workspace. Keep the JSON valid.',
          ].join('\n'),
        };
      }

      if (lane === 'auditor' || lane === 'auditor_explorer') {
        return {
          agentId: participant.agentId,
          message: [
            `You are the ${lane} role in cycle ${state.cycleIndex}.`,
            ...buildLanePromptPreamble(participant, lane, laneIndex),
            '',
            'Audit these promoted FFT specs for correctness, permutation, twiddle, stride, aliasing, benchmark methodology, and cache risks:',
            promotedText,
            '',
            'Current frontier for context:',
            frontierText,
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
            'Use the recent diagnostics to call out likely root causes and specific retest requests, not just generic FFT risks.',
            'For repair-mode buckets, explicitly classify whether the repeated signature suggests permutation, twiddle, stride, normalization, or harness defects.',
            'Treat a missing NEON implementation by itself as a medium-confidence non-blocking SIMD gap if the candidate is otherwise a real FFT that compiles, validates, and benchmarks cleanly.',
          ].join('\n'),
        };
      }

      return {
        agentId: participant.agentId,
        message: [
          `You are the ${lane} role in cycle ${state.cycleIndex}.`,
          ...buildLanePromptPreamble(participant, lane, laneIndex),
          '',
          'Propose the next diverse FFT candidates to try based on the active frontier and promoted specs.',
          '',
          'Promoted specs:',
          promotedText,
          '',
          'Current frontier:',
          frontierText,
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
          'Bias new proposals toward unresolved buckets and toward fixes suggested by the recent diagnostics instead of repeating the same broken indexing plan.',
          'If a bucket is in repair mode, propose targeted mutations for that bucket instead of broad new families.',
        ].join('\n'),
      };
    });
}

function makeProposalId(cycleIndex, proposalIndex, bucketKey) {
  return `cycle${cycleIndex}-${bucketKey}-${proposalIndex}`;
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
  if (state.pendingFanOut === 'baseline') {
    return {
      type: 'fan_out',
      targets: buildBaselineTargets(ctx, state, config),
    };
  }
  if (state.pendingFanOut === 'discovery') {
    return {
      type: 'fan_out',
      targets: buildDiscoveryTargets(ctx, state, config),
    };
  }
  if (state.pendingFanOut === 'cycle' && state.activePromotedProposals.length > 0) {
    return {
      type: 'fan_out',
      targets: buildCycleTargets(ctx, state, config),
    };
  }
  return null;
}
