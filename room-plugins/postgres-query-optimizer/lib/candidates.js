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
  const retestCount = candidate?.retestCount ?? 0;

  // CV too high → reject regardless of other factors
  if (Number.isFinite(cvPct) && cvPct > CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD) {
    return {
      confident: false,
      confidence: 'low',
      needsRetest: retestCount < 1,
      reason: `CV ${cvPct.toFixed(1)}% exceeds discard threshold of ${CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD}%`,
    };
  }

  const highSpeedupThreshold = (CONFIDENCE_THRESHOLDS.HIGH_SPEEDUP_WITH_PLAN_CHANGE - 1) * 100;
  const acceptWithoutPlanChangeThreshold = (CONFIDENCE_THRESHOLDS.ACCEPT_WITHOUT_PLAN_CHANGE - 1) * 100;
  const retestConfirmationThreshold = CONFIDENCE_THRESHOLDS.RETEST_CONFIRMATION_TOLERANCE;

  if (planShapeChanged) {
    if (speedupPct > highSpeedupThreshold) {
      return {
        confident: true,
        confidence: 'high',
        needsRetest: false,
        reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup (>${highSpeedupThreshold}% threshold)`,
      };
    }
    // Plan changed but speedup is modest — require retest for confirmation
    if (retested) {
      return {
        confident: true,
        confidence: 'medium',
        needsRetest: false,
        reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup, confirmed by retest`,
      };
    }
    return {
      confident: false,
      confidence: 'medium',
      needsRetest: true,
      reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup but below ${highSpeedupThreshold}% — retest required for confirmation`,
    };
  }

  // No plan shape change
  if (speedupPct > acceptWithoutPlanChangeThreshold) {
    if (retested) {
      return {
        confident: true,
        confidence: 'medium',
        needsRetest: false,
        reason: `No plan change but ${speedupPct.toFixed(1)}% speedup exceeds ${acceptWithoutPlanChangeThreshold}% threshold, confirmed by retest`,
      };
    }
    return {
      confident: false,
      confidence: 'medium',
      needsRetest: true,
      reason: `No plan change but ${speedupPct.toFixed(1)}% speedup exceeds threshold — retest required for confirmation`,
    };
  }

  // Low confidence — accept only if retested
  if (retested) {
    return {
      confident: true,
      confidence: 'low',
      needsRetest: false,
      reason: `No plan change and modest ${speedupPct.toFixed(1)}% speedup, but accepted after retest confirmation`,
    };
  }

  return {
    confident: false,
    confidence: 'low',
    needsRetest: speedupPct > 0,
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
          telemetryAvailable: false,
          auditedByWorkerIds: [],
        };
        current.riskScore = Math.max(current.riskScore, audit.riskScore || 0);
        current.findings = current.findings.concat(audit.findings || []);
        current.approved = current.approved && audit.approved !== false;
        current.telemetryAvailable = current.telemetryAvailable || Boolean(audit.telemetryAvailable);
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
        cvPct: optionalFiniteNumber(baselineData.cvPct),
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
      resultParity: result.parityChecked ? result.resultParity === true : false,
      parityChecked: Boolean(result.parityChecked),
      speedupPct: Number.isFinite(speedupPct) ? Number(speedupPct.toFixed(1)) : null,
      planShapeChanged: false,
      confidenceLevel: 'low',
      indexSizeBytes: optionalFiniteNumber(result.indexSizeBytes),
      explainJSON: result.explainJSON || null,
      riskScore: audit.riskScore,
      auditFindings: audit.findings,
      telemetryAvailable: Boolean(audit.telemetryAvailable),
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
    candidate.needsRetest = Boolean(confidence.needsRetest);
    if (!confidence.confident && !confidence.needsRetest && candidate.status === 'benchmarked') {
      candidate.status = 'rejected';
      candidate.rejectedReason = confidence.reason;
    }

    // Apply audit findings
    if (audit.findings.length > 0) {
      candidate.status = candidate.status === 'rejected' ? 'rejected' : 'audited';
    }

    // Reject if rewrite parity not verified (must be both checked AND passing)
    if (
      strategyType === 'rewrite'
      && candidate.status !== 'rejected'
    ) {
      if (!candidate.parityChecked) {
        candidate.status = 'rejected';
        candidate.rejectedReason = 'Rewrite result parity was not verified — parityChecked must be true';
      } else if (!candidate.resultParity) {
        candidate.status = 'rejected';
        candidate.rejectedReason = 'Rewrite result parity check failed — results differ from original query';
      }
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
    candidate.telemetryAvailable = candidate.telemetryAvailable || Boolean(audit.telemetryAvailable);
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

  // Filter eligible candidates for frontier — risk score does NOT exclude
  // candidates from the frontier. High-risk candidates are shown with their
  // risk score so the user can make an informed decision. Risk only gates
  // auto-deployment recommendations, not visibility.
  const eligible = state.candidates.filter((candidate) => {
    if (candidate.status === 'rejected') return false;
    if (!Number.isFinite(candidate.speedupPct) || candidate.speedupPct <= 0) return false;

    // Rewrites must have verified parity (both checked and passing)
    if (candidate.strategyType === 'rewrite' && (!candidate.parityChecked || !candidate.resultParity)) return false;

    // Confidence check
    const confidence = isConfidentMeasurement(candidate);
    if (!confidence.confident) return false;

    return true;
  });

  const maxRiskScore = config?.maxRiskScore ?? 7;
  const ranked = sortCandidatesForFrontier(eligible);

  const bestByStrategyType = {};
  const safeBestByStrategyType = {};
  const frontierIds = [];

  for (const candidate of ranked) {
    const bucket = candidate.strategyType || 'index';
    if (!bestByStrategyType[bucket]) {
      bestByStrategyType[bucket] = candidate.candidateId;
      frontierIds.push(candidate.candidateId);
    }
    // Track best candidate that's under the risk threshold
    if (!safeBestByStrategyType[bucket]
      && (!Number.isFinite(candidate.riskScore) || candidate.riskScore <= maxRiskScore)) {
      safeBestByStrategyType[bucket] = candidate.candidateId;
    }
  }

  state.bestByStrategyType = bestByStrategyType;
  state.safeBestByStrategyType = safeBestByStrategyType;
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
  // 1. benchmark_unstable: baseline CV is too high even after retesting
  //    The spec defines this based on baseline measurement stability, not candidate CVs
  const baselineCvPct = optionalFiniteNumber(state.baselines?.cvPct);
  const baselineRetested = Boolean(state.baselines?.retested);
  if (Number.isFinite(baselineCvPct) && baselineCvPct > CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD) {
    // If baseline is unstable and has already been retested with doubled trials, stop
    if (baselineRetested) {
      return 'benchmark_unstable';
    }
    // Mark that baseline needs retesting with doubled trials
    state._baselineNeedsRetest = true;
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
// Retest result merging — updates existing candidates instead of creating new ones
// ---------------------------------------------------------------------------

export function mergeRetestResults(state, responses, config) {
  const tolerance = CONFIDENCE_THRESHOLDS.RETEST_CONFIRMATION_TOLERANCE;

  // Parse all retest responses
  for (const response of responses) {
    const worker = {
      agentId: response.agentId,
      assignedLane: state.lanesByAgentId[response.agentId] || 'builder',
    };
    const envelope = parseWorkerEnvelope(response.response || '', worker, config);

    // Process baseline retest
    for (const result of envelope.results) {
      if (result.isBaseline) {
        const retestMedian = optionalFiniteNumber(result.baseline?.medianMs);
        const retestCvPct = optionalFiniteNumber(result.baseline?.cvPct);
        if (Number.isFinite(retestMedian) && retestMedian > 0 && state.baselines) {
          state.baselines.retestMedianMs = retestMedian;
          state.baselines.retestCvPct = retestCvPct;
          state.baselines.retested = true;

          // Compare retest to original within tolerance
          const origMedian = optionalFiniteNumber(state.baselines.medianMs);
          if (Number.isFinite(origMedian) && origMedian > 0) {
            const driftPct = Math.abs(retestMedian - origMedian) / origMedian * 100;
            state.baselines.retestDriftPct = Number(driftPct.toFixed(1));
            // Accept retest as the authoritative measurement
            state.baselines.medianMs = retestMedian;
            state.baselines.p95Ms = optionalFiniteNumber(result.baseline?.p95Ms) ?? state.baselines.p95Ms;
            state.baselines.cvPct = retestCvPct ?? state.baselines.cvPct;
          }
          state._baselineNeedsRetest = false;
        }
        continue;
      }

      // Process candidate retests — match to existing candidates
      const existing = state.candidates.find(
        (c) => c.proposalId === result.proposalId && c.status !== 'rejected',
      );

      // New candidate proposed during retest (builder refined/combined strategies)
      if (!existing) {
        const candidateMedianMs = optionalFiniteNumber(result.candidate?.medianMs ?? result.medianMs);
        if (!Number.isFinite(candidateMedianMs)) continue;

        const baselineMedianMs = optionalFiniteNumber(state.baselines?.medianMs);
        let speedupPct = optionalFiniteNumber(result.speedupPct);
        if (!Number.isFinite(speedupPct) && Number.isFinite(candidateMedianMs) && Number.isFinite(baselineMedianMs) && baselineMedianMs > 0) {
          speedupPct = ((baselineMedianMs - candidateMedianMs) / baselineMedianMs) * 100;
        }

        const newCandidate = {
          candidateId: result.proposalId || `retest-candidate-${state.candidates.length + 1}`,
          proposalId: result.proposalId || '',
          strategyType: result.applySQL?.match(/CREATE\s+INDEX/i) ? 'index' : 'rewrite',
          cycleIndex: state.cycleIndex,
          applySQL: result.applySQL || '',
          rollbackSQL: result.rollbackSQL || '',
          deploySQL: result.deploySQL || '',
          targetQuery: null,
          baseline: {
            medianMs: baselineMedianMs,
            p95Ms: optionalFiniteNumber(state.baselines?.p95Ms),
            leafAccessNodes: state.baselines?.leafAccessNodes || [],
            planNodeSet: state.baselines?.planNodeSet || [],
            planStructureHash: state.baselines?.planStructureHash || '',
          },
          result: {
            medianMs: candidateMedianMs,
            p95Ms: optionalFiniteNumber(result.candidate?.p95Ms ?? result.p95Ms),
            cvPct: optionalFiniteNumber(result.candidate?.cvPct ?? result.cvPct),
            leafAccessNodes: result.candidate?.leafAccessNodes || [],
            planNodeSet: result.candidate?.planNodeSet || [],
            planStructureHash: result.candidate?.planStructureHash || '',
          },
          resultParity: result.parityChecked ? result.resultParity === true : false,
          parityChecked: Boolean(result.parityChecked),
          speedupPct: Number.isFinite(speedupPct) ? Number(speedupPct.toFixed(1)) : null,
          indexSizeBytes: optionalFiniteNumber(result.indexSizeBytes),
          explainJSON: result.explainJSON || null,
          riskScore: 5,
          auditFindings: [],
          approved: true,
          status: 'benchmarked',
          rejectedReason: null,
          owner: result.implementedByWorkerId || 'builder',
          notes: result.notes || 'Proposed during frontier refinement',
        };

        // Determine confidence
        newCandidate.planShapeChanged = determinePlanShapeChanged(newCandidate);
        const confidence = isConfidentMeasurement(newCandidate);
        newCandidate.confidenceLevel = confidence.confidence;
        newCandidate.needsRetest = Boolean(confidence.needsRetest);

        state.candidates.push(newCandidate);
        continue;
      }

      const retestMedian = optionalFiniteNumber(result.candidate?.medianMs ?? result.medianMs);
      const retestCvPct = optionalFiniteNumber(result.candidate?.cvPct ?? result.cvPct);
      if (!Number.isFinite(retestMedian)) continue;

      // Store both original and retest measurements on the same record
      existing.retestResult = {
        medianMs: retestMedian,
        p95Ms: optionalFiniteNumber(result.candidate?.p95Ms ?? result.p95Ms),
        cvPct: retestCvPct,
      };

      // Compare retest to original within confirmation tolerance
      const origMedian = optionalFiniteNumber(existing.result?.medianMs);
      if (Number.isFinite(origMedian) && origMedian > 0) {
        const driftPct = Math.abs(retestMedian - origMedian) / origMedian * 100;
        existing.retestDriftPct = Number(driftPct.toFixed(1));

        if (driftPct <= tolerance) {
          // Retest corroborates original — mark as confirmed
          existing.retested = true;
          existing.retestCount = (existing.retestCount || 0) + 1;
          existing.needsRetest = false;

          // Use the better (lower CV) measurement as authoritative
          if (Number.isFinite(retestCvPct) && retestCvPct < (existing.result.cvPct ?? Infinity)) {
            existing.result.medianMs = retestMedian;
            existing.result.p95Ms = existing.retestResult.p95Ms ?? existing.result.p95Ms;
            existing.result.cvPct = retestCvPct;
          }

          // Recompute speedup against current baseline
          const baselineMedian = optionalFiniteNumber(state.baselines?.medianMs);
          if (Number.isFinite(baselineMedian) && baselineMedian > 0) {
            existing.speedupPct = Number(
              (((baselineMedian - existing.result.medianMs) / baselineMedian) * 100).toFixed(1),
            );
          }

          // Recompute confidence now that retested=true
          const confidence = isConfidentMeasurement(existing);
          existing.confidenceLevel = confidence.confidence;
          existing.needsRetest = Boolean(confidence.needsRetest);
        } else {
          // Retest does NOT corroborate — measurement is unstable
          existing.retested = false;
          existing.retestCount = (existing.retestCount || 0) + 1;
          existing.needsRetest = false; // Don't retest again
          existing.status = 'rejected';
          existing.rejectedReason = `Retest measurement drifted ${driftPct.toFixed(1)}% (tolerance ${tolerance}%) — result not reproducible`;
        }
      } else {
        // No original measurement to compare — accept retest as-is
        existing.retested = true;
        existing.retestCount = (existing.retestCount || 0) + 1;
        existing.needsRetest = false;
        existing.result.medianMs = retestMedian;
        existing.result.cvPct = retestCvPct;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Retest selection
// ---------------------------------------------------------------------------

export function selectRetestCandidates(state, config) {
  const maxRetest = config?.maxRetestCandidates ?? 1;
  const candidates = state.candidates.filter(
    (c) => c.needsRetest && !c.retested && c.status !== 'rejected',
  );
  // Sort by speedup desc — retest the most promising first
  candidates.sort((a, b) => (b.speedupPct || 0) - (a.speedupPct || 0));
  return candidates.slice(0, maxRetest);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findCandidateById(state, candidateId) {
  return state.candidates.find((c) => c.candidateId === candidateId) || null;
}
