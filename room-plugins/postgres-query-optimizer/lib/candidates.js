import { CONFIDENCE_THRESHOLDS, STRATEGY_TYPES } from './constants.js';
import { parseWorkerEnvelope } from './envelope.js';
import { safeTrim, optionalFiniteNumber } from './utils.js';

// ---------------------------------------------------------------------------
// Confidence gating (spec section 1.6)
// ---------------------------------------------------------------------------

export function isConfidentMeasurement(candidate) {
  const cvPct = optionalFiniteNumber(candidate?.result?.cvPct);
  const speedupPct = optionalFiniteNumber(candidate?.speedupPct) ?? 0;
  const planShapeChanged = Boolean(candidate?.planShapeChanged);
  const retested = Boolean(candidate?.retested);

  // CV too high → reject regardless of other factors
  if (Number.isFinite(cvPct) && cvPct > CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD) {
    return {
      confident: false,
      confidence: 'low',
      reason: `CV ${cvPct.toFixed(1)}% exceeds discard threshold of ${CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD}%`,
    };
  }

  const highSpeedupThreshold = (CONFIDENCE_THRESHOLDS.HIGH_SPEEDUP_WITH_PLAN_CHANGE - 1) * 100;
  const acceptWithoutPlanChangeThreshold = (CONFIDENCE_THRESHOLDS.ACCEPT_WITHOUT_PLAN_CHANGE - 1) * 100;

  if (planShapeChanged) {
    if (speedupPct > highSpeedupThreshold) {
      return {
        confident: true,
        confidence: 'high',
        reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup (>${highSpeedupThreshold}% threshold)`,
      };
    }
    return {
      confident: true,
      confidence: 'medium',
      reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup; retest recommended for confirmation`,
    };
  }

  // No plan shape change
  if (speedupPct > acceptWithoutPlanChangeThreshold) {
    return {
      confident: true,
      confidence: 'medium',
      reason: `No plan change but ${speedupPct.toFixed(1)}% speedup exceeds ${acceptWithoutPlanChangeThreshold}% threshold`,
    };
  }

  // Low confidence — accept only if retested
  if (retested) {
    return {
      confident: true,
      confidence: 'low',
      reason: `No plan change and modest ${speedupPct.toFixed(1)}% speedup, but accepted after retest confirmation`,
    };
  }

  return {
    confident: false,
    confidence: 'low',
    reason: `No plan change and only ${speedupPct.toFixed(1)}% speedup without retest confirmation`,
  };
}

// ---------------------------------------------------------------------------
// Plan shape comparison
// ---------------------------------------------------------------------------

export function determinePlanShapeChanged(candidate) {
  const baseline = candidate?.baseline;
  const result = candidate?.result;
  if (!baseline || !result) return false;

  const strategyType = candidate?.strategyType || 'index';

  if (strategyType === 'index') {
    // Compare leafAccessNodes arrays (set difference)
    const baselineNodes = new Set(Array.isArray(baseline.leafAccessNodes) ? baseline.leafAccessNodes : []);
    const candidateNodes = new Set(Array.isArray(result.leafAccessNodes) ? result.leafAccessNodes : []);
    if (baselineNodes.size === 0 && candidateNodes.size === 0) return false;
    if (baselineNodes.size !== candidateNodes.size) return true;
    for (const node of baselineNodes) {
      if (!candidateNodes.has(node)) return true;
    }
    return false;
  }

  if (strategyType === 'rewrite') {
    // Compare planStructureHash first (fast path)
    if (
      baseline.planStructureHash
      && result.planStructureHash
      && baseline.planStructureHash !== result.planStructureHash
    ) {
      return true;
    }
    // Fall back to planNodeSet comparison
    const baselineSet = new Set(Array.isArray(baseline.planNodeSet) ? baseline.planNodeSet : []);
    const candidateSet = new Set(Array.isArray(result.planNodeSet) ? result.planNodeSet : []);
    if (baselineSet.size === 0 && candidateSet.size === 0) return false;
    if (baselineSet.size !== candidateSet.size) return true;
    for (const node of baselineSet) {
      if (!candidateSet.has(node)) return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Lane capability sets
// ---------------------------------------------------------------------------

const BUILDER_CAPABLE_LANES = new Set(['builder']);
const AUDITOR_CAPABLE_LANES = new Set(['auditor']);

// ---------------------------------------------------------------------------
// Merge cycle artifacts
// ---------------------------------------------------------------------------

export function mergeCycleArtifacts(state, responses, config) {
  const auditsByProposalId = new Map();
  const allResults = [];
  const proposals = [];
  const discoveryNotes = [];

  // ---- Parse all responses ----
  for (const response of responses) {
    const worker = {
      agentId: response.agentId,
      assignedLane: state.lanesByAgentId[response.agentId] || 'builder',
    };
    const envelope = parseWorkerEnvelope(response.response || '', worker, config);

    discoveryNotes.push({
      agentId: response.agentId,
      lane: worker.assignedLane,
      summary: envelope.summary,
    });

    proposals.push(...envelope.candidateProposals);

    // Accept results from builder-capable lanes
    if (BUILDER_CAPABLE_LANES.has(worker.assignedLane)) {
      for (const result of envelope.results) {
        allResults.push(result);
      }
    }

    // Accept audits from auditor-capable lanes
    if (AUDITOR_CAPABLE_LANES.has(worker.assignedLane)) {
      for (const audit of envelope.audits) {
        if (!audit.proposalId) continue;
        const current = auditsByProposalId.get(audit.proposalId) || {
          proposalId: audit.proposalId,
          riskScore: 5,
          findings: [],
          approved: true,
          deployNotes: '',
          auditedByWorkerIds: [],
        };
        current.riskScore = Math.max(current.riskScore, audit.riskScore || 0);
        current.findings = current.findings.concat(audit.findings || []);
        current.approved = current.approved && audit.approved !== false;
        if (audit.deployNotes) {
          current.deployNotes = [current.deployNotes, audit.deployNotes].filter(Boolean).join(' | ');
        }
        current.auditedByWorkerIds.push(response.agentId);
        auditsByProposalId.set(audit.proposalId, current);
      }
    }
  }

  // ---- Process baseline results ----
  for (const result of allResults) {
    if (!result.isBaseline) continue;
    const baselineData = result.baseline || {};
    if (Number.isFinite(baselineData.medianMs) && baselineData.medianMs > 0) {
      state.baselines = {
        ...state.baselines,
        medianMs: baselineData.medianMs,
        p95Ms: baselineData.p95Ms,
        leafAccessNodes: baselineData.leafAccessNodes || [],
        planNodeSet: baselineData.planNodeSet || [],
        planStructureHash: baselineData.planStructureHash || '',
        sharedHitBlocks: baselineData.sharedHitBlocks,
        sharedReadBlocks: baselineData.sharedReadBlocks,
      };
    }
  }

  // ---- Process candidate results ----
  for (const result of allResults) {
    if (result.isBaseline) continue;

    const promoted = state.activePromotedProposals.find(
      (p) => p.proposalId === result.proposalId,
    );
    const audit = auditsByProposalId.get(result.proposalId) || {
      riskScore: 5,
      findings: [],
      approved: true,
      deployNotes: '',
      auditedByWorkerIds: [],
    };

    const candidateMedianMs = optionalFiniteNumber(result.candidate?.medianMs);
    const baselineMedianMs = optionalFiniteNumber(state.baselines?.medianMs);

    // Calculate speedup
    let speedupPct = optionalFiniteNumber(result.speedupPct);
    if (
      !Number.isFinite(speedupPct)
      && Number.isFinite(candidateMedianMs)
      && Number.isFinite(baselineMedianMs)
      && baselineMedianMs > 0
    ) {
      speedupPct = ((baselineMedianMs - candidateMedianMs) / baselineMedianMs) * 100;
    }

    const strategyType = STRATEGY_TYPES.includes(promoted?.strategyType)
      ? promoted.strategyType
      : 'index';

    // Build candidate baseline snapshot
    const candidateBaseline = {
      medianMs: baselineMedianMs,
      p95Ms: optionalFiniteNumber(state.baselines?.p95Ms),
      leafAccessNodes: state.baselines?.leafAccessNodes || [],
      planNodeSet: state.baselines?.planNodeSet || [],
      planStructureHash: state.baselines?.planStructureHash || '',
      sharedHitBlocks: state.baselines?.sharedHitBlocks,
      sharedReadBlocks: state.baselines?.sharedReadBlocks,
    };

    // Build candidate result snapshot
    const candidateResult = {
      medianMs: candidateMedianMs,
      p95Ms: optionalFiniteNumber(result.candidate?.p95Ms),
      cvPct: optionalFiniteNumber(result.candidate?.cvPct),
      leafAccessNodes: result.candidate?.leafAccessNodes || [],
      planNodeSet: result.candidate?.planNodeSet || [],
      planStructureHash: result.candidate?.planStructureHash || '',
      sharedHitBlocks: optionalFiniteNumber(result.candidate?.sharedHitBlocks),
      sharedReadBlocks: optionalFiniteNumber(result.candidate?.sharedReadBlocks),
    };

    const candidate = {
      candidateId: `${result.proposalId || `candidate-${state.candidates.length + 1}`}`,
      proposalId: result.proposalId || '',
      strategyType,
      cycleIndex: state.cycleIndex,
      applySQL: result.applySQL || promoted?.applySQL || '',
      rollbackSQL: result.rollbackSQL || promoted?.rollbackSQL || '',
      deploySQL: promoted?.deploySQL || '',
      targetQuery: strategyType === 'rewrite'
        ? (promoted?.targetQuery || null)
        : null,
      baseline: candidateBaseline,
      result: candidateResult,
      resultParity: result.resultParity !== false,
      parityChecked: Boolean(result.parityChecked),
      speedupPct: Number.isFinite(speedupPct) ? Number(speedupPct.toFixed(1)) : null,
      planShapeChanged: false,
      confidenceLevel: 'low',
      indexSizeBytes: optionalFiniteNumber(result.indexSizeBytes),
      explainJSON: result.explainJSON || null,
      riskScore: audit.riskScore,
      auditFindings: audit.findings,
      approved: audit.approved,
      deployNotes: audit.deployNotes,
      status: Number.isFinite(candidateMedianMs) ? 'benchmarked' : 'proposed',
      rejectedReason: null,
      owner: result.implementedByWorkerId || promoted?.proposedByWorkerId || 'unknown',
      notes: [promoted?.notes, result.notes].filter(Boolean).join(' | '),
    };

    // Determine plan shape change
    candidate.planShapeChanged = determinePlanShapeChanged(candidate);

    // Determine confidence
    const confidence = isConfidentMeasurement(candidate);
    candidate.confidenceLevel = confidence.confidence;
    if (!confidence.confident && candidate.status === 'benchmarked') {
      candidate.status = 'rejected';
      candidate.rejectedReason = confidence.reason;
    }

    // Apply audit findings
    if (audit.findings.length > 0) {
      candidate.status = candidate.status === 'rejected' ? 'rejected' : 'audited';
    }

    // Reject if rewrite parity not checked
    if (
      strategyType === 'rewrite'
      && !candidate.resultParity
      && candidate.status !== 'rejected'
    ) {
      candidate.status = 'rejected';
      candidate.rejectedReason = 'Rewrite result parity check failed';
    }

    state.candidates.push(candidate);
  }

  // ---- Apply remaining audits to existing candidates ----
  for (const [proposalId, audit] of auditsByProposalId.entries()) {
    const candidate = state.candidates.find(
      (c) => c.candidateId === proposalId || c.proposalId === proposalId,
    );
    if (!candidate) continue;
    candidate.riskScore = Math.max(candidate.riskScore, audit.riskScore);
    candidate.auditFindings = candidate.auditFindings.concat(audit.findings);
    candidate.approved = candidate.approved && audit.approved;
    if (audit.deployNotes) {
      candidate.deployNotes = [candidate.deployNotes, audit.deployNotes].filter(Boolean).join(' | ');
    }
  }

  state.discoveryNotes = discoveryNotes.slice(-24);
  return { proposals };
}

// ---------------------------------------------------------------------------
// Frontier computation
// ---------------------------------------------------------------------------

export function sortCandidatesForFrontier(candidates) {
  return [...candidates].sort((left, right) => {
    // speedupPct desc (higher is better)
    const leftSpeedup = Number.isFinite(left.speedupPct) ? left.speedupPct : Number.NEGATIVE_INFINITY;
    const rightSpeedup = Number.isFinite(right.speedupPct) ? right.speedupPct : Number.NEGATIVE_INFINITY;
    if (rightSpeedup !== leftSpeedup) return rightSpeedup - leftSpeedup;

    // cvPct asc (lower is better)
    const leftCv = Number.isFinite(left.result?.cvPct) ? left.result.cvPct : Number.POSITIVE_INFINITY;
    const rightCv = Number.isFinite(right.result?.cvPct) ? right.result.cvPct : Number.POSITIVE_INFINITY;
    if (leftCv !== rightCv) return leftCv - rightCv;

    // riskScore asc (lower is better)
    const leftRisk = Number.isFinite(left.riskScore) ? left.riskScore : Number.POSITIVE_INFINITY;
    const rightRisk = Number.isFinite(right.riskScore) ? right.riskScore : Number.POSITIVE_INFINITY;
    if (leftRisk !== rightRisk) return leftRisk - rightRisk;

    // indexSizeBytes asc (lower is better, null-safe)
    const leftSize = Number.isFinite(left.indexSizeBytes) ? left.indexSizeBytes : Number.POSITIVE_INFINITY;
    const rightSize = Number.isFinite(right.indexSizeBytes) ? right.indexSizeBytes : Number.POSITIVE_INFINITY;
    if (leftSize !== rightSize) return leftSize - rightSize;

    return 0;
  });
}

export function recomputeFrontier(state, config) {
  // Demote previous frontier candidates
  for (const candidate of state.candidates) {
    if (candidate.status === 'frontier') {
      candidate.status = Number.isFinite(candidate.result?.medianMs) ? 'benchmarked' : candidate.status;
    }
  }

  const maxRiskScore = config?.maxRiskScore ?? 7;

  // Filter eligible candidates
  const eligible = state.candidates.filter((candidate) => {
    if (candidate.status === 'rejected') return false;
    if (!Number.isFinite(candidate.speedupPct) || candidate.speedupPct <= 0) return false;
    if (Number.isFinite(candidate.riskScore) && candidate.riskScore > maxRiskScore) return false;

    // Rewrites must pass parity
    if (candidate.strategyType === 'rewrite' && !candidate.resultParity) return false;

    // Confidence check
    const confidence = isConfidentMeasurement(candidate);
    if (!confidence.confident) return false;

    return true;
  });

  const ranked = sortCandidatesForFrontier(eligible);

  const bestByStrategyType = {};
  const frontierIds = [];

  for (const candidate of ranked) {
    const bucket = candidate.strategyType || 'index';
    if (!bestByStrategyType[bucket]) {
      bestByStrategyType[bucket] = candidate.candidateId;
      frontierIds.push(candidate.candidateId);
    }
  }

  state.bestByStrategyType = bestByStrategyType;
  state.frontierIds = frontierIds;

  // Update statuses
  for (const candidate of state.candidates) {
    if (frontierIds.includes(candidate.candidateId)) {
      candidate.status = 'frontier';
    }
  }
}

// ---------------------------------------------------------------------------
// Improvement tracking
// ---------------------------------------------------------------------------

export function computeBestImprovementPct(state) {
  const winners = state.frontierIds
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter(Boolean);
  let best = 0;
  for (const winner of winners) {
    if (Number.isFinite(winner.speedupPct)) {
      best = Math.max(best, winner.speedupPct);
    }
  }
  return Number(best.toFixed(1));
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

// ---------------------------------------------------------------------------
// Stop condition evaluation
// ---------------------------------------------------------------------------

export function chooseStopReason(state, config, limits) {
  // 1. benchmark_unstable: all benchmarked candidates have high CV
  const benchmarked = state.candidates.filter(
    (c) => Number.isFinite(c.result?.medianMs) && c.status !== 'rejected',
  );
  if (benchmarked.length > 0) {
    const allUnstable = benchmarked.every(
      (c) => Number.isFinite(c.result?.cvPct) && c.result.cvPct > 25,
    );
    if (allUnstable) return 'benchmark_unstable';
  }

  // 2. cycle_limit
  const maxCycles = limits?.maxCycles ?? config?.maxCycles ?? 8;
  if (state.cycleIndex >= maxCycles) return 'cycle_limit';

  const plateauCycles = config?.plateauCycles ?? 2;
  const targetImprovementPct = config?.targetImprovementPct ?? 20;

  // 3. target_met: plateau reached AND target improvement met AND at least one approved frontier
  if (state.plateauCount >= plateauCycles && state.bestImprovementPct >= targetImprovementPct) {
    const hasApprovedFrontier = state.frontierIds.some((id) => {
      const candidate = findCandidateById(state, id);
      return candidate && candidate.approved;
    });
    if (hasApprovedFrontier) return 'target_met';
  }

  // 4. plateau: catch-all plateau
  if (state.plateauCount >= plateauCycles) return 'plateau';

  return null;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findCandidateById(state, candidateId) {
  return state.candidates.find((c) => c.candidateId === candidateId) || null;
}
