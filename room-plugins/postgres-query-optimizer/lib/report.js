import { getConfig } from './config.js';
import { computeBestImprovementPct, findCandidateById, sortCandidatesForFrontier } from './candidates.js';

export function buildFrontierRows(state) {
  return state.frontierIds
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter(Boolean)
    .map((candidate) => ({
      strategyType: candidate.strategyType,
      proposalId: candidate.proposalId,
      medianMs: Number.isFinite(candidate.result?.medianMs)
        ? Number(candidate.result.medianMs.toFixed(1))
        : '',
      speedupPct: Number.isFinite(candidate.speedupPct)
        ? Number(candidate.speedupPct.toFixed(1))
        : '',
      indexSizeMb: Number.isFinite(candidate.indexSizeBytes)
        ? Number((candidate.indexSizeBytes / (1024 * 1024)).toFixed(2))
        : '',
      riskScore: Number.isFinite(candidate.riskScore) ? candidate.riskScore : '',
      status: candidate.status,
      owner: candidate.owner || '',
    }));
}

export function buildCandidateRows(state) {
  return sortCandidatesForFrontier(state.candidates).map((candidate) => ({
    strategyType: candidate.strategyType,
    proposalId: candidate.proposalId,
    medianMs: Number.isFinite(candidate.result?.medianMs)
      ? Number(candidate.result.medianMs.toFixed(1))
      : '',
    speedupPct: Number.isFinite(candidate.speedupPct)
      ? Number(candidate.speedupPct.toFixed(1))
      : '',
    status: candidate.status,
    riskScore: Number.isFinite(candidate.riskScore) ? candidate.riskScore : '',
    owner: candidate.owner || '',
    notes: candidate.rejectedReason || candidate.notes || '',
  }));
}

function countCandidateSummary(state) {
  return {
    proposed: state.proposalBacklog.length + state.activePromotedProposals.length + state.candidates.length,
    promoted: state.activePromotedProposals.length + state.candidates.length,
    benchmarked: state.candidates.filter((c) => Number.isFinite(c.result?.medianMs)).length,
    frontier: state.frontierIds.length,
    rejected: state.candidates.filter((c) => c.status === 'rejected').length,
  };
}

function buildWinnerBlock(candidate, label) {
  if (!candidate) return null;
  const speedup = Number.isFinite(candidate.speedupPct)
    ? `${candidate.speedupPct.toFixed(1)}%`
    : 'N/A';
  const baselineMs = Number.isFinite(candidate.baseline?.medianMs)
    ? `${candidate.baseline.medianMs.toFixed(1)}ms`
    : '?';
  const candidateMs = Number.isFinite(candidate.result?.medianMs)
    ? `${candidate.result.medianMs.toFixed(1)}ms`
    : '?';
  const risk = Number.isFinite(candidate.riskScore) ? `${candidate.riskScore}/10` : '?';

  const lines = [];
  if (candidate.strategyType === 'index') {
    lines.push(`-- ${label}`);
    lines.push(`-- Deploy with:`);
    lines.push(candidate.deploySQL || candidate.applySQL || '-- no SQL available');
    lines.push(`-- Speedup: ${speedup} (${baselineMs} → ${candidateMs}) — benchmarked independently`);
    lines.push(`-- Risk: ${risk}`);
    if (Number.isFinite(candidate.indexSizeBytes)) {
      lines.push(`-- Storage: ~${(candidate.indexSizeBytes / (1024 * 1024)).toFixed(1)}MB`);
    }
  } else {
    lines.push(`-- ${label}`);
    lines.push(`-- Optimized Query:`);
    lines.push(candidate.targetQuery || candidate.applySQL || '-- no SQL available');
    lines.push(`-- Speedup: ${speedup} (${baselineMs} → ${candidateMs})`);
    lines.push(`-- Risk: ${risk}`);
  }
  if (candidate.deployNotes) {
    lines.push(`-- ${candidate.deployNotes}`);
  }
  return lines.join('\n');
}

function buildWinnerQueriesMetric(state) {
  const rewriteWinnerId = state.bestByStrategyType?.rewrite;
  if (!rewriteWinnerId) return null;
  const winner = findCandidateById(state, rewriteWinnerId);
  if (!winner) return null;
  const content = buildWinnerBlock(winner, 'Rewrite Winner');
  if (!content) return null;
  return {
    title: 'Optimized Query',
    blocks: [{
      title: `${winner.proposalId} — ${winner.strategyType}`,
      subtitle: 'winner',
      language: 'sql',
      content,
    }],
  };
}

function buildWinnerIndexesMetric(state) {
  const indexWinnerId = state.bestByStrategyType?.index;
  if (!indexWinnerId) return null;
  const winner = findCandidateById(state, indexWinnerId);
  if (!winner) return null;
  const content = buildWinnerBlock(winner, 'Index Winner');
  if (!content) return null;
  return {
    title: 'Proposed Index',
    blocks: [{
      title: `${winner.proposalId} — ${winner.strategyType}`,
      subtitle: 'winner',
      language: 'sql',
      content,
    }],
  };
}

export function emitStateMetrics(ctx, state) {
  const config = getConfig(ctx);
  const baselineMs = Number.isFinite(state.baselines?.medianMs)
    ? Number(state.baselines.medianMs.toFixed(1))
    : null;

  ctx.emitMetrics({
    currentPhase: {
      active: state.phase,
      reached: Array.isArray(state.reachedPhases) ? [...state.reachedPhases] : [state.phase],
    },
    candidateSummary: countCandidateSummary(state),
    cycleProgress: {
      value: state.cycleIndex,
      max: ctx.limits?.maxCycles || 4,
    },
    bestImprovementPct: {
      value: computeBestImprovementPct(state),
      max: 100,
    },
    baselineMs,
    frontier: { rows: buildFrontierRows(state) },
    candidates: { rows: buildCandidateRows(state) },
    winnerQueries: buildWinnerQueriesMetric(state),
    winnerIndexes: buildWinnerIndexesMetric(state),
  });
}
