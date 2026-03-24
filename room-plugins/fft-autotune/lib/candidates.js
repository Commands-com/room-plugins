import {
  IMPLEMENTATION_FIDELITY_PATTERNS,
  METHODOLOGY_GAP_PATTERNS,
  NONBLOCKING_FIDELITY_PATTERNS,
  SIMD_GAP_PATTERNS,
} from './constants.js';
import { getMissingBaselineBucketKeys, getMissingWinnerBucketKeys } from './buckets.js';
import { parseWorkerEnvelope } from './envelope.js';
import { resolveAndVerifyPath, safeTrim } from './utils.js';

const REFERENCE_ONLY_FAMILIES = new Set(['ne10_neon_reference']);

/**
 * Determine the set of lanes that are allowed to submit build results.
 */
const BUILDER_CAPABLE_LANES = new Set(['builder', 'builder_explorer_auditor']);

/**
 * Determine the set of lanes that are allowed to submit audit findings.
 */
const AUDITOR_CAPABLE_LANES = new Set(['auditor', 'auditor_explorer', 'builder_explorer_auditor']);

/**
 * Verify that critical artifact paths reported in a builder result actually
 * exist under the allowed workspace/output roots.  Returns true only when all
 * essential evidence files are present.
 */
function verifyResultArtifacts(result, config) {
  const roots = [config.workspacePath, config.outputDir].filter(Boolean);
  if (roots.length === 0) return true; // no roots to verify against

  // Require a non-empty file path for every successful step.
  // Reject results that claim ok without providing evidence paths.
  if (result.compile?.ok) {
    if (!result.compile.binaryPath || !resolveAndVerifyPath(result.compile.binaryPath, roots)) return false;
  }

  if (result.validation?.ok) {
    if (!result.validation.validationPath || !resolveAndVerifyPath(result.validation.validationPath, roots)) return false;
  }

  if (result.benchmark?.ok) {
    if (!result.benchmark.samplePath || !resolveAndVerifyPath(result.benchmark.samplePath, roots)) return false;
  }

  // Verify listed artifact paths
  for (const artifactPath of (result.artifactPaths || [])) {
    if (!resolveAndVerifyPath(artifactPath, roots)) return false;
  }

  return true;
}

function recordCanonicalBaseline(state, result, baseline, sourceKind = 'benchmark_result') {
  if (!baseline?.bucketKey) return;
  state.baselines[baseline.bucketKey] = baseline;
  state.baselineSources[baseline.bucketKey] = {
    bucketKey: baseline.bucketKey,
    family: result?.family || '',
    sourceKind,
    compile: result?.compile || null,
    validation: result?.validation || null,
    benchmark: result?.benchmark || null,
    artifactPaths: result?.artifactPaths || [],
    notes: result?.notes || '',
    implementedByWorkerId: result?.implementedByWorkerId || '',
    proposedByWorkerId: result?.proposedByWorkerId || '',
  };
}

function recordScalarReferenceArtifact(state, result, baseline) {
  if (!baseline?.bucketKey) return;
  state.baselineArtifacts[baseline.bucketKey] = {
    bucketKey: baseline.bucketKey,
    family: result.family,
    compile: result.compile,
    validation: result.validation,
    benchmark: result.benchmark,
    artifactPaths: result.artifactPaths,
    notes: result.notes,
    implementedByWorkerId: result.implementedByWorkerId,
  };
}

function recordBaselineAttempt(state, result, baseline) {
  if (!result.bucketKey) return;
  state.baselineAttempts[result.bucketKey] = {
    bucketKey: result.bucketKey,
    family: result.family,
    compile: result.compile,
    validation: result.validation,
    benchmark: result.benchmark,
    artifactPaths: result.artifactPaths,
    notes: result.notes,
    implementedByWorkerId: result.implementedByWorkerId,
    hasBaseline: Boolean(baseline && Number.isFinite(baseline.medianNs)),
  };
}

function findReportedBucketBaseline(result) {
  const baselines = Array.isArray(result?.baselineBenchmarks)
    ? result.baselineBenchmarks
    : [];
  return baselines.find((baseline) =>
    baseline?.bucketKey === result?.bucketKey
    && Number.isFinite(baseline?.medianNs),
  ) || null;
}

function applyAuditSeverityPolicy(candidate, promotedProposal) {
  if (!candidate || !candidate.audit) return;
  if (
    !candidate.compile?.ok
    || !candidate.validation?.ok
    || !candidate.benchmark?.ok
    || candidate.audit.openHighConfidenceFindings <= 0
  ) {
    return;
  }

  const promotedSimdStrategy = promotedProposal?.simdStrategy || '';
  const candidateSimdStrategy = candidate.simdStrategy || '';
  const combinedNotes = [candidate.notes, candidate.validation?.diagnosticSummary]
    .filter(Boolean)
    .join(' | ');
  const simdGapOnly = promotedSimdStrategy === 'neon'
    && candidateSimdStrategy === 'scalar'
    && SIMD_GAP_PATTERNS.some((pattern) => pattern.test(combinedNotes));
  const nonBlockingFidelityOnly = NONBLOCKING_FIDELITY_PATTERNS.some((pattern) => pattern.test(combinedNotes));
  const methodologyGapOnly = METHODOLOGY_GAP_PATTERNS.some((pattern) => pattern.test(combinedNotes));

  if (!simdGapOnly && !nonBlockingFidelityOnly && !methodologyGapOnly) {
    return;
  }

  candidate.audit.openMediumConfidenceFindings = Math.max(
    candidate.audit.openMediumConfidenceFindings || 0,
    candidate.audit.openHighConfidenceFindings,
    1,
  );
  candidate.audit.openHighConfidenceFindings = 0;
  if (simdGapOnly) {
    candidate.notes = [
      candidate.notes,
      'SIMD gap treated as non-blocking optimization debt because the candidate is still a correct benchmarked FFT.',
    ].filter(Boolean).join(' | ');
  }
  if (nonBlockingFidelityOnly) {
    candidate.notes = [
      candidate.notes,
      'Metadata/permutation fidelity mismatch treated as non-blocking because the built artifact validated and benchmarked cleanly; builder should report actual built metadata next cycle.',
    ].filter(Boolean).join(' | ');
  }
  if (methodologyGapOnly) {
    candidate.notes = [
      candidate.notes,
      'Benchmark methodology or small-N stability concern treated as non-blocking for frontier eligibility; keep as follow-up retest guidance.',
    ].filter(Boolean).join(' | ');
  }
}

function appendUniqueNote(existingNotes, note) {
  const trimmed = safeTrim(note, 1200);
  if (!trimmed) return existingNotes || '';
  if (!existingNotes) return trimmed;
  if (existingNotes.includes(trimmed)) return existingNotes;
  return `${existingNotes} | ${trimmed}`;
}

function syncFidelityMismatch(candidate) {
  const fidelityMismatch = IMPLEMENTATION_FIDELITY_PATTERNS.some((pattern) => pattern.test(candidate.notes || ''));
  if (!fidelityMismatch) return;
  candidate.audit.openHighConfidenceFindings = Math.max(candidate.audit.openHighConfidenceFindings || 0, 1);
  candidate.status = 'rejected';
  candidate.notes = appendUniqueNote(
    candidate.notes,
    'Implementation fidelity mismatch: result does not match claimed FFT family',
  );
}

function applyAuditRecordToCandidate(candidate, audit, promotedProposal) {
  if (!candidate || !audit) return;
  candidate.auditedByWorkerIds = Array.from(new Set([
    ...(candidate.auditedByWorkerIds || []),
    ...(audit.auditedByWorkerIds || []),
  ]));
  candidate.audit.openHighConfidenceFindings = Math.max(
    candidate.audit.openHighConfidenceFindings || 0,
    audit.openHighConfidenceFindings || 0,
  );
  candidate.audit.openMediumConfidenceFindings = Math.max(
    candidate.audit.openMediumConfidenceFindings || 0,
    audit.openMediumConfidenceFindings || 0,
  );
  const joinedNotes = Array.isArray(audit.notes) ? audit.notes.join(' | ') : safeTrim(audit.notes, 1000);
  candidate.notes = appendUniqueNote(candidate.notes, joinedNotes);
  syncFidelityMismatch(candidate);
  applyAuditSeverityPolicy(candidate, promotedProposal || {
    simdStrategy: candidate.requestedSimdStrategy || candidate.simdStrategy,
  });
}

export function mergeCycleArtifacts(state, responses, config, options = {}) {
  const auditsByProposalId = new Map();
  const results = [];
  const proposals = [];
  const discoveryNotes = [];
  const acceptedResultLanes = options.acceptResultLanes instanceof Set
    ? options.acceptResultLanes
    : BUILDER_CAPABLE_LANES;

  for (const response of responses) {
    const worker = {
      agentId: response.agentId,
      assignedLane: state.lanesByAgentId[response.agentId] || 'worker',
    };
    const envelope = parseWorkerEnvelope(response.response || '', worker, config);
    discoveryNotes.push({
      agentId: response.agentId,
      lane: worker.assignedLane,
      summary: envelope.summary,
    });
    proposals.push(...envelope.candidateProposals);

    // Issue 1: Only accept results from builder-capable lanes
    if (acceptedResultLanes.has(worker.assignedLane)) {
      // Issue 0: Verify artifact paths exist before accepting results
      for (const result of envelope.results) {
        if (verifyResultArtifacts(result, config)) {
          results.push(result);
        }
      }
    }

    // Issue 1: Only accept audits from auditor-capable lanes
    if (AUDITOR_CAPABLE_LANES.has(worker.assignedLane)) {
      for (const audit of envelope.audits) {
        if (!audit.proposalId) continue;
        const current = auditsByProposalId.get(audit.proposalId) || {
          proposalId: audit.proposalId,
          openHighConfidenceFindings: 0,
          openMediumConfidenceFindings: 0,
          retestRequested: false,
          notes: [],
          auditedByWorkerIds: [],
        };
        current.openHighConfidenceFindings = Math.max(current.openHighConfidenceFindings, audit.openHighConfidenceFindings);
        current.openMediumConfidenceFindings = Math.max(current.openMediumConfidenceFindings, audit.openMediumConfidenceFindings);
        current.retestRequested = current.retestRequested || audit.retestRequested;
        if (audit.notes) current.notes.push(audit.notes);
        current.auditedByWorkerIds.push(response.agentId);
        auditsByProposalId.set(audit.proposalId, current);
      }
    }
  }

  for (const result of results) {
    const promoted = state.activePromotedProposals.find((proposal) => proposal.proposalId === result.proposalId);
    const isBaselineResult = Boolean(result.isBaseline || promoted?.isBaselineCandidate);
    const isNe10ReferenceResult = result.family === 'ne10_neon_reference';
    // Only accept baselines from results that have verified successful
    // compile + validation + benchmark evidence.  Without all three, the
    // result cannot serve as trustworthy same-run baseline data.
    const hasVerifiedEvidence = Boolean(
      result.compile?.ok && result.validation?.ok && result.benchmark?.ok,
    );
    const directBaseline = hasVerifiedEvidence && Number.isFinite(result.benchmark.medianNs)
      ? {
        bucketKey: result.bucketKey,
        medianNs: result.benchmark.medianNs,
        p95Ns: result.benchmark.p95Ns,
        cvPct: result.benchmark.cvPct,
      }
      : null;
    if (isBaselineResult && hasVerifiedEvidence) {
      if (directBaseline) {
        recordScalarReferenceArtifact(state, result, directBaseline);
      }
      for (const baseline of result.baselineBenchmarks) {
        if (baseline.bucketKey && Number.isFinite(baseline.medianNs)) {
          recordScalarReferenceArtifact(state, result, baseline);
        }
      }
    }
    if (isNe10ReferenceResult && directBaseline) {
      recordCanonicalBaseline(state, result, directBaseline, 'ne10_reference');
    } else if (hasVerifiedEvidence) {
      for (const baseline of result.baselineBenchmarks) {
        if (
          baseline.bucketKey
          && Number.isFinite(baseline.medianNs)
          && !state.baselines[baseline.bucketKey]
        ) {
          recordCanonicalBaseline(state, result, baseline, 'reported_comparison');
        }
      }
    }
    if (isBaselineResult || isNe10ReferenceResult) {
      recordBaselineAttempt(state, result, directBaseline || result.baselineBenchmarks[0] || null);
    }
  }

  for (const result of results) {
    const promoted = state.activePromotedProposals.find((proposal) => proposal.proposalId === result.proposalId);
    const isBaselineResult = Boolean(result.isBaseline || promoted?.isBaselineCandidate);
    if (isBaselineResult) {
      continue;
    }
    const benchmark = { ...result.benchmark };
    const baseline = state.baselines[result.bucketKey];
    const reportedBucketBaseline = findReportedBucketBaseline(result);
    if (benchmark.ok && Number.isFinite(benchmark.medianNs) && Number.isFinite(baseline?.medianNs) && baseline.medianNs > 0) {
      benchmark.speedupVsBaseline = baseline.medianNs / benchmark.medianNs;
    } else {
      benchmark.speedupVsBaseline = null;
    }

    const audit = auditsByProposalId.get(result.proposalId) || {
      openHighConfidenceFindings: 0,
      openMediumConfidenceFindings: 0,
      notes: [],
      auditedByWorkerIds: [],
    };

    const candidate = {
      candidateId: `${result.proposalId || `candidate-${state.candidates.length + 1}`}`,
      proposalId: result.proposalId || '',
      cycle: state.cycleIndex,
      bucketKey: result.bucketKey,
      family: result.family,
      status: benchmark.ok ? 'benchmarked' : (result.validation.ok ? 'validated' : (result.compile.ok ? 'generated' : 'rejected')),
      proposedByWorkerId: promoted?.proposedByWorkerId || 'unknown',
      implementedByWorkerId: result.implementedByWorkerId,
      auditedByWorkerIds: audit.auditedByWorkerIds,
      lane: promoted?.lane || 'builder',
      treeSpec: result.treeSpec,
      leafSizes: result.leafSizes.length > 0 ? result.leafSizes : (promoted?.leafSizes || [4, 8]),
      permutationStrategy: result.permutationStrategy,
      twiddleStrategy: result.twiddleStrategy,
      simdStrategy: result.simdStrategy,
      requestedSimdStrategy: promoted?.simdStrategy || result.simdStrategy,
      compile: result.compile,
      validation: result.validation,
      benchmark,
      reportedBucketBaseline,
      audit: {
        openHighConfidenceFindings: audit.openHighConfidenceFindings,
        openMediumConfidenceFindings: audit.openMediumConfidenceFindings,
        findingsPath: '',
      },
      artifactPaths: result.artifactPaths,
      notes: [promoted?.notes, result.notes, ...(audit.notes || [])].filter(Boolean).join(' | '),
    };
    if (
      reportedBucketBaseline
      && Number.isFinite(baseline?.medianNs)
      && baseline.medianNs > 0
      && Math.abs(reportedBucketBaseline.medianNs - baseline.medianNs) > 0.001
    ) {
      candidate.notes = [
        candidate.notes,
        `Reported comparison baseline ${reportedBucketBaseline.medianNs.toFixed(3)} ns differs from canonical same-run baseline ${baseline.medianNs.toFixed(3)} ns; final speedup uses canonical baseline.`,
      ].filter(Boolean).join(' | ');
    }
    syncFidelityMismatch(candidate);
    applyAuditSeverityPolicy(candidate, promoted);
    state.candidates.push(candidate);
  }

  for (const [proposalId, audit] of auditsByProposalId.entries()) {
    const candidate = state.candidates.find((entry) =>
      entry.candidateId === proposalId || entry.proposalId === proposalId,
    );
    if (!candidate) continue;
    const promoted = state.activePromotedProposals.find((proposal) => proposal.proposalId === proposalId);
    applyAuditRecordToCandidate(candidate, audit, promoted);
  }

  refreshBaselineCoverage(state);
  state.discoveryNotes = discoveryNotes.slice(-24);
  return { proposals };
}

export function sortCandidatesForFrontier(candidates) {
  return [...candidates].sort((left, right) => {
    const leftBucket = left.bucketKey || '';
    const rightBucket = right.bucketKey || '';
    if (leftBucket !== rightBucket) return leftBucket.localeCompare(rightBucket);
    const leftMedian = Number.isFinite(left.benchmark?.medianNs) ? left.benchmark.medianNs : Number.POSITIVE_INFINITY;
    const rightMedian = Number.isFinite(right.benchmark?.medianNs) ? right.benchmark.medianNs : Number.POSITIVE_INFINITY;
    if (leftMedian !== rightMedian) return leftMedian - rightMedian;
    const leftP95 = Number.isFinite(left.benchmark?.p95Ns) ? left.benchmark.p95Ns : Number.POSITIVE_INFINITY;
    const rightP95 = Number.isFinite(right.benchmark?.p95Ns) ? right.benchmark.p95Ns : Number.POSITIVE_INFINITY;
    if (leftP95 !== rightP95) return leftP95 - rightP95;
    const leftCv = Number.isFinite(left.benchmark?.cvPct) ? left.benchmark.cvPct : Number.POSITIVE_INFINITY;
    const rightCv = Number.isFinite(right.benchmark?.cvPct) ? right.benchmark.cvPct : Number.POSITIVE_INFINITY;
    if (leftCv !== rightCv) return leftCv - rightCv;
    const leftSpeedup = Number.isFinite(left.benchmark?.speedupVsBaseline) ? left.benchmark.speedupVsBaseline : Number.NEGATIVE_INFINITY;
    const rightSpeedup = Number.isFinite(right.benchmark?.speedupVsBaseline) ? right.benchmark.speedupVsBaseline : Number.NEGATIVE_INFINITY;
    if (rightSpeedup !== leftSpeedup) return rightSpeedup - leftSpeedup;
    return (left.family || '').localeCompare(right.family || '');
  });
}

export function refreshBaselineCoverage(state) {
  for (const candidate of state.candidates) {
    const baseline = state.baselines[candidate.bucketKey];
    if (
      baseline
      && Number.isFinite(candidate.benchmark?.medianNs)
      && candidate.benchmark.medianNs > 0
      && Number.isFinite(baseline?.medianNs)
      && baseline.medianNs > 0
    ) {
      candidate.benchmark.speedupVsBaseline = baseline.medianNs / candidate.benchmark.medianNs;
    }
    candidate.hasBucketBaseline = Boolean(baseline && Number.isFinite(baseline.medianNs));
  }
}

export function findCandidateById(state, candidateId) {
  return state.candidates.find((candidate) => candidate.candidateId === candidateId) || null;
}

export function computeBestImprovementPct(state) {
  const winners = state.frontierIds
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter(Boolean);
  let best = 0;
  for (const winner of winners) {
    if (Number.isFinite(winner.benchmark?.speedupVsBaseline)) {
      best = Math.max(best, (winner.benchmark.speedupVsBaseline - 1) * 100);
    }
  }
  return Number(best.toFixed(1));
}

export function recomputeFrontier(state, config) {
  // Demote previous frontier/winner candidates whose bucket lost its baseline.
  // Buckets with valid baselines keep their frontier status.
  for (const candidate of state.candidates) {
    if (
      (candidate.status === 'winner' || candidate.status === 'frontier')
      && !candidate.hasBucketBaseline
    ) {
      candidate.status = candidate.benchmark.ok ? 'benchmarked' : candidate.status;
    }
  }
  const eligible = state.candidates.filter((candidate) =>
    !REFERENCE_ONLY_FAMILIES.has(candidate.family)
    &&
    candidate.hasBucketBaseline
    && candidate.compile.ok
    && candidate.validation.ok
    && candidate.benchmark.ok
    && candidate.audit.openHighConfidenceFindings === 0
    && Number.isFinite(candidate.benchmark?.medianNs)
    && (candidate.benchmark.speedupVsBaseline || 0) >= 1.0,
  );
  const ranked = sortCandidatesForFrontier(eligible);
  const bestByBucket = {};
  const frontierIds = [];

  for (const candidate of ranked) {
    if (!bestByBucket[candidate.bucketKey]) {
      bestByBucket[candidate.bucketKey] = candidate.candidateId;
      frontierIds.push(candidate.candidateId);
    }
  }

  state.bestByBucket = bestByBucket;
  state.frontierIds = frontierIds;

  for (const candidate of state.candidates) {
    if (state.frontierIds.includes(candidate.candidateId)) {
      candidate.status = 'frontier';
    }
  }
  for (const bucketKey of Object.keys(state.bestByBucket)) {
    const bestId = state.bestByBucket[bucketKey];
    const winner = state.candidates.find((candidate) => candidate.candidateId === bestId);
    if (winner) winner.status = 'winner';
  }
}

export function updateDiversity(state) {
  const contributorSet = new Set();
  for (const candidateId of state.frontierIds) {
    const candidate = findCandidateById(state, candidateId);
    if (!candidate) continue;
    if (candidate.proposedByWorkerId) contributorSet.add(candidate.proposedByWorkerId);
    if (candidate.implementedByWorkerId) contributorSet.add(candidate.implementedByWorkerId);
    for (const auditorId of candidate.auditedByWorkerIds || []) {
      contributorSet.add(auditorId);
    }
  }
  state.degradedDiversity = contributorSet.size < Math.min(2, Math.max(1, state.workerCount || 0));
}

function maybeStopForInstability(state) {
  const benchmarked = state.candidates.filter((candidate) => candidate.benchmark.ok);
  if (benchmarked.length === 0) return null;
  const unstable = benchmarked.every((candidate) =>
    Number.isFinite(candidate.benchmark?.cvPct) && candidate.benchmark.cvPct > 20,
  );
  return unstable ? 'benchmark_unstable' : null;
}

export function evaluateImprovement(state) {
  const currentBest = computeBestImprovementPct(state);
  if (currentBest > state.bestImprovementPct) {
    state.bestImprovementPct = currentBest;
    state.plateauCount = 0;
  } else {
    state.plateauCount += 1;
  }
}

export function chooseStopReason(state, config, limits) {
  const unstableReason = maybeStopForInstability(state);
  if (unstableReason) return unstableReason;
  const missingWinnerBuckets = getMissingWinnerBucketKeys(state, config);

  if (state.frontierIds.length > 0 && state.plateauCount >= config.plateauCycles) {
    const hasOpenIssues = state.frontierIds.some((candidateId) => {
      const candidate = state.candidates.find((entry) => entry.candidateId === candidateId);
      return candidate && candidate.audit.openHighConfidenceFindings > 0;
    });
    if (missingWinnerBuckets.length > 0) {
      return 'convergence_with_open_issues';
    }
    return hasOpenIssues ? 'convergence_with_open_issues' : 'convergence';
  }

  if (state.cycleIndex >= (limits?.maxCycles || 1)) {
    if (missingWinnerBuckets.length > 0) {
      return 'convergence_with_open_issues';
    }
    return state.frontierIds.length > 0 ? 'cycle_limit' : 'convergence_with_open_issues';
  }

  return null;
}

export { applyAuditSeverityPolicy };
