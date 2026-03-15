import {
  clampInt,
  isPowerOfTwo,
  normalizeNumberArray,
  normalizeStringArray,
  optionalFiniteNumber,
  optionalInteger,
  resolveBucketKey,
  safeTrim,
} from './utils.js';

const EXPLICIT_LANE_ROLES = ['explorer', 'builder', 'auditor'];

const MAX_EXTRACT_LEN = 512 * 1024; // 512 KB ceiling for regex + JSON.parse

function extractJson(text) {
  const raw = typeof text === 'string' ? text.trim().slice(0, MAX_EXTRACT_LEN) : '';
  if (!raw) return null;

  const candidates = [];
  const fencedMatches = raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/ig);
  for (const match of fencedMatches) {
    if (match?.[1]) candidates.push(match[1].trim());
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = raw.indexOf('[');
  const lastBracket = raw.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(raw.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function resolveBucketSize(bucketKey, fallbackSize) {
  const match = String(bucketKey || '').match(/^n(\d+)-/);
  if (!match) return fallbackSize;
  const parsed = Number(match[1]);
  return isPowerOfTwo(parsed) ? parsed : fallbackSize;
}

function normalizeCandidateProposal(proposal, fallbackBucketKey, config, proposedByWorkerId, lane) {
  const bucketKey = safeTrim(proposal?.bucketKey, 120) || safeTrim(fallbackBucketKey, 120);
  const sizeFromBucket = resolveBucketSize(bucketKey, NaN);
  const explicitSize = Number(proposal?.size);
  const normalizedSize = isPowerOfTwo(sizeFromBucket)
    ? sizeFromBucket
    : (isPowerOfTwo(explicitSize) ? explicitSize : (config.targetSizes[0] || 64));
  const normalizedBucketKey = bucketKey || resolveBucketKey(normalizedSize, config);
  const family = safeTrim(proposal?.family, 120) || 'cooley_tukey_shallow';
  const treeSpec = safeTrim(proposal?.treeSpec, 200) || 'balanced radix-4 decomposition';
  const permutationStrategy = safeTrim(proposal?.permutationStrategy, 120) || 'bit_reverse_postpass';
  const twiddleStrategy = safeTrim(proposal?.twiddleStrategy, 120) || 'precompute_table';
  const simdStrategy = safeTrim(proposal?.simdStrategy, 40) === 'scalar' ? 'scalar' : 'neon';
  const leafSizes = normalizeNumberArray(proposal?.leafSizes || [], 8)
    .map((value) => Math.max(2, Math.floor(value)));

  return {
    bucketKey: normalizedBucketKey,
    size: normalizedSize,
    family,
    treeSpec,
    leafSizes: leafSizes.length > 0 ? leafSizes : [4, 8],
    permutationStrategy,
    twiddleStrategy,
    simdStrategy,
    notes: safeTrim(proposal?.notes || proposal?.reason, 600),
    proposedByWorkerId,
    lane,
  };
}

function normalizeAuditEntry(audit = {}) {
  return {
    proposalId: safeTrim(audit.proposalId, 120),
    openHighConfidenceFindings: clampInt(audit.openHighConfidenceFindings, 0, 100, 0),
    openMediumConfidenceFindings: clampInt(audit.openMediumConfidenceFindings, 0, 100, 0),
    retestRequested: Boolean(audit.retestRequested),
    notes: safeTrim(audit.notes, 1000),
  };
}

function normalizeBucketKey(rawKey, rawSize, config) {
  const key = safeTrim(rawKey, 120);
  // Already fully qualified: "n64-apple_silicon_neon"
  if (key && key.includes('-')) return key;
  // Bare bucket like "n64" or "n256" — extract size and resolve
  const bareMatch = String(key || '').match(/^n?(\d+)$/);
  const sizeFromKey = bareMatch ? Number(bareMatch[1]) : NaN;
  const size = isPowerOfTwo(sizeFromKey) ? sizeFromKey : (Number(rawSize) || config.targetSizes[0] || 64);
  return resolveBucketKey(isPowerOfTwo(size) ? size : (config.targetSizes[0] || 64), config);
}

function resolveNestedObject(result, primary, ...alternates) {
  if (result?.[primary] && typeof result[primary] === 'object') return result[primary];
  for (const key of alternates) {
    const val = result?.[key];
    if (val && typeof val === 'object') {
      // Handle nested wrappers like compileEvidence: { ... } or benchmarkEvidence: { benchmarkJson: { ... } }
      const innerKeys = Object.keys(val);
      const jsonKey = innerKeys.find((k) => k.endsWith('Json'));
      return jsonKey && typeof val[jsonKey] === 'object' ? { ...val, ...val[jsonKey] } : val;
    }
  }
  return {};
}

function normalizeBuilderResult(result = {}, config, workerId) {
  const compile = resolveNestedObject(result, 'compile', 'compileEvidence');
  const validation = resolveNestedObject(result, 'validation', 'validationEvidence');
  const benchmark = resolveNestedObject(result, 'benchmark', 'benchmarkEvidence');
  const artifactPaths = normalizeStringArray(result?.artifactPaths || [], 12);

  return {
    proposalId: safeTrim(result.proposalId || result.specId, 120),
    bucketKey: normalizeBucketKey(result.bucketKey || result.bucket, result.size || result.dftSize, config),
    family: safeTrim(result.family || result.familyName, 120) || 'cooley_tukey_shallow',
    isBaseline: Boolean(result.isBaseline),
    treeSpec: safeTrim(result.treeSpec || result.treeDescription, 200) || 'balanced radix-4 decomposition',
    leafSizes: normalizeNumberArray(result.leafSizes || [], 8).map((value) => Math.floor(value)),
    permutationStrategy: safeTrim(result.permutationStrategy, 120) || 'bit_reverse_postpass',
    twiddleStrategy: safeTrim(result.twiddleStrategy, 120) || 'precompute_table',
    simdStrategy: safeTrim(result.simdStrategy, 40) === 'scalar' ? 'scalar' : 'neon',
    compile: {
      ok: Boolean(compile.ok
        ?? result.compiled
        ?? result.compileOk
        ?? (optionalFiniteNumber(compile.compileReturnCode ?? compile.exitCode ?? result.compileReturnCode ?? result.exitCode) === 0
          && safeTrim(compile.compiledBinaryPath || compile.binaryPath || result.compiledBinaryPath || result.binaryPath, 1000))),
      command: safeTrim(compile.command || compile.compileCommand || result.compileCommand, 600),
      exitCode: optionalFiniteNumber(compile.exitCode ?? compile.compileReturnCode ?? result.exitCode ?? result.compileReturnCode),
      stderrPath: safeTrim(compile.stderrPath || compile.compileStderr || result.stderrPath || result.compileStderr, 1000),
      binaryPath: safeTrim(compile.binaryPath || compile.compiledBinaryPath || result.binaryPath || result.compiledBinaryPath, 1000),
    },
    validation: {
      ok: Boolean(validation.ok
        ?? result.validated
        ?? result.validationOk
        ?? (optionalFiniteNumber(validation.validationReturnCode ?? result.validationReturnCode) === 0
          && clampInt(validation.sampleCount ?? result.sampleCount, 0, 100000, 0) > 0)),
      sampleCount: clampInt(validation.sampleCount ?? result.sampleCount, 0, 100000, 0),
      maxError: optionalFiniteNumber(validation.maxError ?? result.maxError),
      tolerance: optionalFiniteNumber(validation.tolerance ?? result.tolerance) ?? 1e-3,
      failureReason: safeTrim(validation.failureReason || result.failureReason, 800),
      validationPath: safeTrim(validation.validationPath || validation.samplePath || result.validationPath || result.samplePath, 1000),
      firstFailIndex: optionalInteger(validation.firstFailIndex ?? result.firstFailIndex),
      firstFailInputLabel: safeTrim(validation.firstFailInputLabel || validation.failingInputLabel || result.firstFailInputLabel || result.failingInputLabel, 160),
      firstFailExpected: safeTrim(validation.firstFailExpected || result.firstFailExpected, 240),
      firstFailActual: safeTrim(validation.firstFailActual || result.firstFailActual, 240),
      firstFailError: optionalFiniteNumber(validation.firstFailError ?? result.firstFailError),
      orderingHint: safeTrim(validation.orderingHint || result.orderingHint, 240),
      suspectedIssue: safeTrim(validation.suspectedIssue || result.suspectedIssue, 240),
      diagnosticSummary: safeTrim(validation.diagnosticSummary || result.diagnosticSummary, 600),
    },
    benchmark: {
      ok: Boolean(benchmark.ok ?? result.benchmarked ?? result.benchmarkOk),
      warmups: clampInt(benchmark.warmups ?? result.warmups, 0, 100000, config.benchmarkWarmups),
      trials: clampInt(benchmark.trials ?? result.trials, 0, 100000, config.benchmarkTrials),
      medianNs: optionalFiniteNumber(benchmark.medianNs ?? result.medianNs),
      p95Ns: optionalFiniteNumber(benchmark.p95Ns ?? result.p95Ns),
      cvPct: optionalFiniteNumber(benchmark.cvPct ?? result.cvPct),
      speedupVsBaseline: optionalFiniteNumber(benchmark.speedupVsBaseline ?? result.speedupVsBaseline),
      samplePath: safeTrim(benchmark.samplePath || result.samplePath, 1000),
    },
    baselineBenchmarks: Array.isArray(result?.baselineBenchmarks)
      ? result.baselineBenchmarks
          .map((entry) => ({
            bucketKey: safeTrim(entry?.bucketKey, 120) || resolveBucketKey(Number(entry?.size) || config.targetSizes[0] || 64, config),
            medianNs: optionalFiniteNumber(entry?.medianNs),
            p95Ns: optionalFiniteNumber(entry?.p95Ns),
            cvPct: optionalFiniteNumber(entry?.cvPct),
          }))
          .filter((entry) => Number.isFinite(entry.medianNs))
      : [],
    artifactPaths,
    notes: safeTrim(result.notes, 1200),
    implementedByWorkerId: workerId,
  };
}

export function parseWorkerEnvelope(responseText, worker, config, fallbackBucketKey = null) {
  const parsed = extractJson(responseText);
  const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
  const candidateSource = Array.isArray(envelope.candidateProposals)
    ? envelope.candidateProposals
    : (Array.isArray(envelope.proposals) ? envelope.proposals : []);
  const resultsSource = Array.isArray(envelope.results)
    ? envelope.results
    : (Array.isArray(envelope.candidates) ? envelope.candidates : []);
  const auditsSource = Array.isArray(envelope.audits)
    ? envelope.audits
    : (Array.isArray(envelope.findings) ? envelope.findings : []);

  return {
    summary: safeTrim(envelope.summary || responseText, 2000),
    candidateProposals: candidateSource.map((proposal) =>
      normalizeCandidateProposal(proposal, fallbackBucketKey, config, worker.agentId, worker.assignedLane),
    ),
    results: resultsSource.map((result) => normalizeBuilderResult(result, config, worker.agentId)),
    audits: auditsSource.map((audit) => normalizeAuditEntry(audit)),
  };
}

export function assignLanes(participants) {
  const lanesByAgentId = {};
  const workersByLane = {};
  const explicitRoleParticipants = EXPLICIT_LANE_ROLES.flatMap((lane) =>
    participants
      .filter((participant) => participant?.role === lane)
      .map((participant) => ({ participant, lane })),
  );

  if (explicitRoleParticipants.length > 0) {
    for (const { participant, lane } of explicitRoleParticipants) {
      lanesByAgentId[participant.agentId] = lane;
      if (!workersByLane[lane]) workersByLane[lane] = [];
      workersByLane[lane].push(participant.agentId);
    }

    const legacyWorkers = participants.filter((participant) => participant?.role === 'worker');
    for (let index = 0; index < legacyWorkers.length; index += 1) {
      const lane = index % 2 === 0 ? 'explorer' : 'builder';
      lanesByAgentId[legacyWorkers[index].agentId] = lane;
      if (!workersByLane[lane]) workersByLane[lane] = [];
      workersByLane[lane].push(legacyWorkers[index].agentId);
    }

    return { lanesByAgentId, workersByLane };
  }

  const workers = participants.filter((participant) => participant?.role === 'worker');

  if (workers.length === 1) {
    lanesByAgentId[workers[0].agentId] = 'builder_explorer_auditor';
  } else if (workers.length === 2) {
    lanesByAgentId[workers[0].agentId] = 'builder';
    lanesByAgentId[workers[1].agentId] = 'auditor_explorer';
  } else {
    lanesByAgentId[workers[0].agentId] = 'explorer';
    lanesByAgentId[workers[1].agentId] = 'builder';
    lanesByAgentId[workers[2].agentId] = 'auditor';
    for (let index = 3; index < workers.length; index += 1) {
      lanesByAgentId[workers[index].agentId] = index % 2 === 1 ? 'explorer' : 'builder';
    }
  }

  for (const worker of workers) {
    const lane = lanesByAgentId[worker.agentId];
    if (!workersByLane[lane]) workersByLane[lane] = [];
    workersByLane[lane].push(worker.agentId);
  }

  return { lanesByAgentId, workersByLane };
}
