import { CONFIDENCE_THRESHOLDS } from './constants.js';
import { parseWorkerEnvelope } from './envelope.js';
import { safeTrim, optionalFiniteNumber } from './utils.js';

// ---------------------------------------------------------------------------
// Confidence gating (engine-agnostic)
// ---------------------------------------------------------------------------

export function isConfidentMeasurement(candidate, thresholds) {
  const T = thresholds || CONFIDENCE_THRESHOLDS;
  const speedupPct = optionalFiniteNumber(candidate?.speedupPct) ?? 0;
  const planShapeChanged = Boolean(candidate?.planShapeChanged);
  const retested = Boolean(candidate?.retested);
  const retestCount = candidate?.retestCount ?? 0;

  // Use engine's robust CV (e.g. MAD-based) when raw trials are available.
  // This resists WLM queue outliers on shared clusters.
  let cvPct = optionalFiniteNumber(candidate?.result?.cvPct);
  if (typeof T.computeRobustCV === 'function' && candidate?.result) {
    const robust = T.computeRobustCV(candidate.result);
    if (Number.isFinite(robust)) cvPct = robust;
  }

  const cvDiscard = T.CV_DISCARD_THRESHOLD ?? CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD;

  if (Number.isFinite(cvPct) && cvPct > cvDiscard) {
    return {
      confident: false,
      confidence: 'low',
      needsRetest: retestCount < 1,
      reason: `CV ${cvPct.toFixed(1)}% exceeds discard threshold of ${cvDiscard}%`,
    };
  }

  const highSpeedupThreshold = ((T.HIGH_SPEEDUP_WITH_PLAN_CHANGE ?? CONFIDENCE_THRESHOLDS.HIGH_SPEEDUP_WITH_PLAN_CHANGE) - 1) * 100;
  const acceptWithoutPlanChangeThreshold = ((T.ACCEPT_WITHOUT_PLAN_CHANGE ?? CONFIDENCE_THRESHOLDS.ACCEPT_WITHOUT_PLAN_CHANGE) - 1) * 100;

  if (planShapeChanged) {
    if (speedupPct > highSpeedupThreshold) {
      return { confident: true, confidence: 'high', needsRetest: false,
        reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup (>${highSpeedupThreshold}% threshold)` };
    }
    if (retested) {
      return { confident: true, confidence: 'medium', needsRetest: false,
        reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup, confirmed by retest` };
    }
    return { confident: false, confidence: 'medium', needsRetest: true,
      reason: `Plan shape changed with ${speedupPct.toFixed(1)}% speedup but below ${highSpeedupThreshold}% — retest required` };
  }

  if (speedupPct > acceptWithoutPlanChangeThreshold) {
    if (retested) {
      return { confident: true, confidence: 'medium', needsRetest: false,
        reason: `No plan change but ${speedupPct.toFixed(1)}% speedup exceeds threshold, confirmed by retest` };
    }
    return { confident: false, confidence: 'medium', needsRetest: true,
      reason: `No plan change but ${speedupPct.toFixed(1)}% speedup exceeds threshold — retest required` };
  }

  if (retested) {
    return { confident: true, confidence: 'low', needsRetest: false,
      reason: `No plan change and modest ${speedupPct.toFixed(1)}% speedup, but accepted after retest` };
  }

  return { confident: false, confidence: 'low', needsRetest: speedupPct > 0,
    reason: `No plan change and only ${speedupPct.toFixed(1)}% speedup without retest confirmation` };
}

// ---------------------------------------------------------------------------
// Lane capability sets
// ---------------------------------------------------------------------------

const BUILDER_CAPABLE_LANES = new Set(['builder']);
const AUDITOR_CAPABLE_LANES = new Set(['auditor']);

// ---------------------------------------------------------------------------
// Merge cycle artifacts
// ---------------------------------------------------------------------------

/**
 * @param {object} state
 * @param {Array} responses
 * @param {object} config
 * @param {object} engine — { strategyTypes, defaultStrategyType, determinePlanShapeChanged, extendBuilderResult }
 */
export function mergeCycleArtifacts(state, responses, config, engine) {
  const strategyTypes = engine?.strategyTypes || ['index', 'rewrite'];
  const defaultStrategyType = engine?.defaultStrategyType || strategyTypes[0] || 'index';
  const determinePlanShapeChanged = engine?.determinePlanShapeChanged || (() => false);

  const auditsByProposalId = new Map();
  const allResults = [];
  const proposals = [];
  const discoveryNotes = [];

  for (const response of responses) {
    const worker = {
      agentId: response.agentId,
      assignedLane: state.lanesByAgentId[response.agentId] || 'builder',
    };
    const envelope = parseWorkerEnvelope(response.response || '', worker, config, engine);

    discoveryNotes.push({
      agentId: response.agentId,
      lane: worker.assignedLane,
      summary: envelope.summary,
    });

    proposals.push(...envelope.candidateProposals);

    if (BUILDER_CAPABLE_LANES.has(worker.assignedLane)) {
      for (const result of envelope.results) {
        allResults.push(result);
      }
    }

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

  // Process baseline results
  for (const result of allResults) {
    if (!result.isBaseline) continue;
    const baselineData = result.baseline || {};
    if (Number.isFinite(baselineData.medianMs) && baselineData.medianMs > 0) {
      state.baselines = {
        ...state.baselines,
        ...baselineData,
      };
    }
  }

  // Process candidate results
  for (const result of allResults) {
    if (result.isBaseline) continue;

    const promoted = state.activePromotedProposals.find(
      (p) => p.proposalId === result.proposalId,
    );
    const audit = auditsByProposalId.get(result.proposalId) || {
      riskScore: 5, findings: [], approved: true, deployNotes: '', auditedByWorkerIds: [],
    };

    const candidateMedianMs = optionalFiniteNumber(result.candidate?.medianMs);
    const baselineMedianMs = optionalFiniteNumber(state.baselines?.medianMs);

    let speedupPct = optionalFiniteNumber(result.speedupPct);
    if (!Number.isFinite(speedupPct) && Number.isFinite(candidateMedianMs)
      && Number.isFinite(baselineMedianMs) && baselineMedianMs > 0) {
      speedupPct = ((baselineMedianMs - candidateMedianMs) / baselineMedianMs) * 100;
    }

    const strategyType = strategyTypes.includes(promoted?.strategyType)
      ? promoted.strategyType
      : defaultStrategyType;

    const candidateBaseline = { ...state.baselines };
    const candidateResult = { ...result.candidate };

    const candidate = {
      candidateId: `${result.proposalId || `candidate-${state.candidates.length + 1}`}`,
      proposalId: result.proposalId || '',
      strategyType,
      cycleIndex: state.cycleIndex,
      applySQL: result.applySQL || promoted?.applySQL || '',
      rollbackSQL: result.rollbackSQL || promoted?.rollbackSQL || '',
      deploySQL: result.deploySQL || promoted?.deploySQL || '',
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

    candidate.planShapeChanged = determinePlanShapeChanged(candidate);

    const engineThresholds = engine?.confidenceThresholds || undefined;
    const confidence = isConfidentMeasurement(candidate, engineThresholds);
    candidate.confidenceLevel = confidence.confidence;
    candidate.needsRetest = Boolean(confidence.needsRetest);
    if (!confidence.confident && !confidence.needsRetest && candidate.status === 'benchmarked') {
      candidate.status = 'rejected';
      candidate.rejectedReason = confidence.reason;
    }

    if (audit.findings.length > 0) {
      candidate.status = candidate.status === 'rejected' ? 'rejected' : 'audited';
    }

    if (strategyType === 'rewrite' && candidate.status !== 'rejected') {
      if (!candidate.parityChecked) {
        candidate.status = 'rejected';
        candidate.rejectedReason = 'Rewrite result parity was not verified';
      } else if (!candidate.resultParity) {
        candidate.status = 'rejected';
        candidate.rejectedReason = 'Rewrite result parity check failed — results differ from original query';
      }
    }

    state.candidates.push(candidate);
  }

  // Apply remaining audits to existing candidates
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

    // Transition status based on audit outcome
    if (!candidate.approved) {
      candidate.status = 'rejected';
      candidate.rejectedReason = candidate.rejectedReason
        || 'Rejected by auditor';
    } else if (audit.findings.length > 0 && candidate.status !== 'rejected') {
      candidate.status = 'audited';
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
    const leftSpeedup = Number.isFinite(left.speedupPct) ? left.speedupPct : Number.NEGATIVE_INFINITY;
    const rightSpeedup = Number.isFinite(right.speedupPct) ? right.speedupPct : Number.NEGATIVE_INFINITY;
    if (rightSpeedup !== leftSpeedup) return rightSpeedup - leftSpeedup;

    const leftCv = Number.isFinite(left.result?.cvPct) ? left.result.cvPct : Number.POSITIVE_INFINITY;
    const rightCv = Number.isFinite(right.result?.cvPct) ? right.result.cvPct : Number.POSITIVE_INFINITY;
    if (leftCv !== rightCv) return leftCv - rightCv;

    const leftRisk = Number.isFinite(left.riskScore) ? left.riskScore : Number.POSITIVE_INFINITY;
    const rightRisk = Number.isFinite(right.riskScore) ? right.riskScore : Number.POSITIVE_INFINITY;
    if (leftRisk !== rightRisk) return leftRisk - rightRisk;

    const leftSize = Number.isFinite(left.indexSizeBytes) ? left.indexSizeBytes : Number.POSITIVE_INFINITY;
    const rightSize = Number.isFinite(right.indexSizeBytes) ? right.indexSizeBytes : Number.POSITIVE_INFINITY;
    if (leftSize !== rightSize) return leftSize - rightSize;

    return 0;
  });
}

export function recomputeFrontier(state, config, engine) {
  for (const candidate of state.candidates) {
    if (candidate.status === 'frontier') {
      candidate.status = Number.isFinite(candidate.result?.medianMs) ? 'benchmarked' : candidate.status;
    }
  }

  const eligible = state.candidates.filter((candidate) => {
    if (candidate.status === 'rejected') return false;
    if (!Number.isFinite(candidate.speedupPct) || candidate.speedupPct <= 0) return false;
    if (candidate.strategyType === 'rewrite' && (!candidate.parityChecked || !candidate.resultParity)) return false;
    const engineThresholds = engine?.confidenceThresholds || undefined;
    const confidence = isConfidentMeasurement(candidate, engineThresholds);
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
    if (!safeBestByStrategyType[bucket]
      && (!Number.isFinite(candidate.riskScore) || candidate.riskScore <= maxRiskScore)) {
      safeBestByStrategyType[bucket] = candidate.candidateId;
    }
  }

  state.bestByStrategyType = bestByStrategyType;
  state.safeBestByStrategyType = safeBestByStrategyType;
  state.frontierIds = frontierIds;

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

export function chooseStopReason(state, config, limits, engine) {
  const cvDiscard = engine?.confidenceThresholds?.CV_DISCARD_THRESHOLD
    ?? CONFIDENCE_THRESHOLDS.CV_DISCARD_THRESHOLD;
  // Use engine's robust CV (e.g. MAD-based) if available; fall back to reported cvPct.
  const baselineCvPct = engine?.computeRobustCV?.(state.baselines)
    ?? optionalFiniteNumber(state.baselines?.cvPct);
  const baselineRetested = Boolean(state.baselines?.retested);
  if (Number.isFinite(baselineCvPct) && baselineCvPct > cvDiscard) {
    if (baselineRetested) return 'benchmark_unstable';
    state._baselineNeedsRetest = true;
  }

  const maxCycles = limits?.maxCycles ?? config?.maxCycles ?? 8;
  if (state.cycleIndex >= maxCycles) return 'cycle_limit';

  const plateauCycles = config?.plateauCycles ?? 2;
  const targetImprovementPct = config?.targetImprovementPct ?? 20;

  if (state.plateauCount >= plateauCycles && state.bestImprovementPct >= targetImprovementPct) {
    const hasApprovedFrontier = state.frontierIds.some((id) => {
      const candidate = findCandidateById(state, id);
      return candidate && candidate.approved;
    });
    if (hasApprovedFrontier) return 'target_met';
  }

  if (state.plateauCount >= plateauCycles) return 'plateau';
  return null;
}

// ---------------------------------------------------------------------------
// Retest result merging
// ---------------------------------------------------------------------------

/**
 * @param {object} state
 * @param {Array} responses
 * @param {object} config
 * @param {object} engine — { determinePlanShapeChanged, detectStrategyTypeFromSQL, extendBuilderResult }
 */
export function mergeRetestResults(state, responses, config, engine) {
  const tolerance = engine?.confidenceThresholds?.RETEST_CONFIRMATION_TOLERANCE
    ?? CONFIDENCE_THRESHOLDS.RETEST_CONFIRMATION_TOLERANCE;
  const determinePlanShapeChanged = engine?.determinePlanShapeChanged || (() => false);
  const detectStrategyTypeFromSQL = engine?.detectStrategyTypeFromSQL || (() => 'rewrite');

  for (const response of responses) {
    const worker = {
      agentId: response.agentId,
      assignedLane: state.lanesByAgentId[response.agentId] || 'builder',
    };
    const envelope = parseWorkerEnvelope(response.response || '', worker, config, engine);

    for (const result of envelope.results) {
      if (result.isBaseline) {
        const retestMedian = optionalFiniteNumber(result.baseline?.medianMs);
        const retestCvPct = optionalFiniteNumber(result.baseline?.cvPct);
        if (Number.isFinite(retestMedian) && retestMedian > 0 && state.baselines) {
          state.baselines.retestMedianMs = retestMedian;
          state.baselines.retestCvPct = retestCvPct;
          state.baselines.retested = true;

          const origMedian = optionalFiniteNumber(state.baselines.medianMs);
          if (Number.isFinite(origMedian) && origMedian > 0) {
            const driftPct = Math.abs(retestMedian - origMedian) / origMedian * 100;
            state.baselines.retestDriftPct = Number(driftPct.toFixed(1));
            state.baselines.medianMs = retestMedian;
            state.baselines.p95Ms = optionalFiniteNumber(result.baseline?.p95Ms) ?? state.baselines.p95Ms;
            state.baselines.cvPct = retestCvPct ?? state.baselines.cvPct;
            // Preserve raw timings for robust CV computation
            const retestTrials = result.baseline?.trials || result.baseline?.timings;
            if (Array.isArray(retestTrials) && retestTrials.length > 0) {
              state.baselines.trials = retestTrials;
            }
          }
          state._baselineNeedsRetest = false;
        }
        continue;
      }

      const existing = state.candidates.find(
        (c) => c.proposalId === result.proposalId && c.status !== 'rejected',
      );

      // New candidate proposed during retest
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
          strategyType: detectStrategyTypeFromSQL(result.applySQL),
          cycleIndex: state.cycleIndex,
          applySQL: result.applySQL || '',
          rollbackSQL: result.rollbackSQL || '',
          deploySQL: result.deploySQL || '',
          targetQuery: null,
          baseline: { ...state.baselines },
          result: { ...result.candidate },
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

        newCandidate.planShapeChanged = determinePlanShapeChanged(newCandidate);
        const engineThresholds = engine?.confidenceThresholds || undefined;
        const confidence = isConfidentMeasurement(newCandidate, engineThresholds);
        newCandidate.confidenceLevel = confidence.confidence;
        newCandidate.needsRetest = Boolean(confidence.needsRetest);

        state.candidates.push(newCandidate);
        continue;
      }

      const retestMedian = optionalFiniteNumber(result.candidate?.medianMs ?? result.medianMs);
      const retestCvPct = optionalFiniteNumber(result.candidate?.cvPct ?? result.cvPct);
      if (!Number.isFinite(retestMedian)) continue;

      existing.retestResult = {
        medianMs: retestMedian,
        p95Ms: optionalFiniteNumber(result.candidate?.p95Ms ?? result.p95Ms),
        cvPct: retestCvPct,
      };

      const origMedian = optionalFiniteNumber(existing.result?.medianMs);
      if (Number.isFinite(origMedian) && origMedian > 0) {
        const driftPct = Math.abs(retestMedian - origMedian) / origMedian * 100;
        existing.retestDriftPct = Number(driftPct.toFixed(1));

        if (driftPct <= tolerance) {
          existing.retested = true;
          existing.retestCount = (existing.retestCount || 0) + 1;
          existing.needsRetest = false;

          if (Number.isFinite(retestCvPct) && retestCvPct < (existing.result.cvPct ?? Infinity)) {
            existing.result.medianMs = retestMedian;
            existing.result.p95Ms = existing.retestResult.p95Ms ?? existing.result.p95Ms;
            existing.result.cvPct = retestCvPct;
          }

          const baselineMedian = optionalFiniteNumber(state.baselines?.medianMs);
          if (Number.isFinite(baselineMedian) && baselineMedian > 0) {
            existing.speedupPct = Number(
              (((baselineMedian - existing.result.medianMs) / baselineMedian) * 100).toFixed(1),
            );
          }

          const confidence = isConfidentMeasurement(existing, engine?.confidenceThresholds);
          existing.confidenceLevel = confidence.confidence;
          existing.needsRetest = Boolean(confidence.needsRetest);
        } else {
          existing.retested = false;
          existing.retestCount = (existing.retestCount || 0) + 1;
          existing.needsRetest = false;
          existing.status = 'rejected';
          existing.rejectedReason = `Retest measurement drifted ${driftPct.toFixed(1)}% (tolerance ${tolerance}%) — result not reproducible`;
        }
      } else {
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
  candidates.sort((a, b) => (b.speedupPct || 0) - (a.speedupPct || 0));
  return candidates.slice(0, maxRetest);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findCandidateById(state, candidateId) {
  return state.candidates.find((c) => c.candidateId === candidateId) || null;
}
