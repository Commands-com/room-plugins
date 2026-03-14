import fs from 'node:fs';
import path from 'node:path';

import { CODE_SNIPPET_CHAR_LIMIT, PHASES, SOURCE_FILE_EXTENSIONS } from './constants.js';
import { getConfig } from './config.js';
import { getExpectedBucketKeys, getMissingBaselineBucketKeys, getMissingWinnerBucketKeys } from './buckets.js';
import { buildRepairDirectives } from './planning.js';
import { computeBestImprovementPct, findCandidateById, sortCandidatesForFrontier } from './candidates.js';
import { isSafeSubpath, safeTrim } from './utils.js';

function resolveArtifactPath(config, artifactPath) {
  if (!config.workspacePath || !artifactPath) return null;
  const resolved = path.isAbsolute(artifactPath)
    ? path.resolve(artifactPath)
    : path.resolve(config.workspacePath, artifactPath);
  if (!isSafeSubpath(config.workspacePath, resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  return stat.isFile() ? resolved : null;
}

function chooseSourceArtifact(candidate, config) {
  const ranked = [...candidate.artifactPaths].sort((left, right) => {
    const leftExt = path.extname(left).toLowerCase();
    const rightExt = path.extname(right).toLowerCase();
    const leftRank = SOURCE_FILE_EXTENSIONS.indexOf(leftExt);
    const rightRank = SOURCE_FILE_EXTENSIONS.indexOf(rightExt);
    if (leftRank === -1 && rightRank === -1) return left.localeCompare(right);
    if (leftRank === -1) return 1;
    if (rightRank === -1) return -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });

  for (const artifactPath of ranked) {
    const ext = path.extname(artifactPath).toLowerCase();
    if (!SOURCE_FILE_EXTENSIONS.includes(ext)) continue;
    const resolved = resolveArtifactPath(config, artifactPath);
    if (resolved) return resolved;
  }
  return null;
}

function getHighlightedCandidate(state) {
  const winners = sortCandidatesForFrontier(
    state.frontierIds
      .map((candidateId) => findCandidateById(state, candidateId))
      .filter(Boolean),
  );
  if (winners.length > 0) return winners[0];

  const benchmarked = sortCandidatesForFrontier(state.candidates.filter((candidate) =>
    candidate.compile.ok
    && candidate.validation.ok
    && candidate.benchmark.ok
    && Number.isFinite(candidate.benchmark?.medianNs),
  ));
  if (benchmarked.length > 0) return benchmarked[0];

  const validated = state.candidates.filter((candidate) => candidate.compile.ok && candidate.validation.ok);
  if (validated.length > 0) return validated[0];

  const generated = state.candidates.filter((candidate) => candidate.compile.ok);
  return generated[0] || null;
}

function buildCandidateCodeBlock(candidate, config) {
  const sourcePath = chooseSourceArtifact(candidate, config);
  if (!sourcePath) return null;

  let content;
  try {
    content = fs.readFileSync(sourcePath, 'utf-8');
  } catch {
    return null;
  }

  const truncated = content.length > CODE_SNIPPET_CHAR_LIMIT;
  const snippet = truncated
    ? `${content.slice(0, CODE_SNIPPET_CHAR_LIMIT).trimEnd()}\n/* ... truncated ... */`
    : content;
  const relativePath = isSafeSubpath(config.workspacePath, sourcePath)
    ? path.relative(config.workspacePath, sourcePath) || path.basename(sourcePath)
    : sourcePath;
  const speedupText = Number.isFinite(candidate.benchmark?.speedupVsBaseline)
    ? `${((candidate.benchmark.speedupVsBaseline - 1) * 100).toFixed(1)}% vs baseline`
    : 'no bucket baseline';
  const medianText = Number.isFinite(candidate.benchmark?.medianNs)
    ? `${Math.round(candidate.benchmark.medianNs)} ns median`
    : 'no benchmark';
  const issueCount = candidate.audit?.openHighConfidenceFindings || 0;
  const footerParts = [
    medianText,
    speedupText,
    Number.isFinite(candidate.validation?.maxError) ? `max error ${candidate.validation.maxError}` : '',
    Number.isFinite(candidate.benchmark?.cvPct) ? `cv ${candidate.benchmark.cvPct.toFixed(2)}%` : '',
    `${issueCount} high-confidence issues`,
    truncated ? 'snippet truncated for report display' : '',
  ].filter(Boolean);

  return {
    title: `${candidate.bucketKey} • ${candidate.family}`,
    subtitle: candidate.status === 'winner'
      ? 'winner'
      : `${candidate.status || 'candidate'}`,
    path: relativePath,
    language: 'c',
    content: snippet,
    footer: footerParts.join(' • '),
  };
}

function buildWinnerSourcesMetric(state, config) {
  const winnerCandidates = sortCandidatesForFrontier(
    state.frontierIds
      .map((candidateId) => findCandidateById(state, candidateId))
      .filter(Boolean),
  );

  const candidates = winnerCandidates.length > 0
    ? winnerCandidates
    : [getHighlightedCandidate(state)].filter(Boolean);

  const blocks = candidates
    .map((candidate) => buildCandidateCodeBlock(candidate, config))
    .filter(Boolean);

  if (blocks.length === 0) return null;

  return {
    title: winnerCandidates.length > 0 ? 'Winner Sources' : 'Top Candidate Source',
    blocks,
  };
}

export function buildFrontierRows(state) {
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

function latestReferenceCandidate(state, bucketKey) {
  return state.candidates
    .filter((candidate) =>
      candidate.bucketKey === bucketKey
      && candidate.family === 'ne10_neon_reference',
    )
    .sort((left, right) => {
      const cycleDelta = (right.cycle || 0) - (left.cycle || 0);
      if (cycleDelta !== 0) return cycleDelta;
      const benchmarkDelta = Number(right.benchmark?.ok === true) - Number(left.benchmark?.ok === true);
      if (benchmarkDelta !== 0) return benchmarkDelta;
      return (left.benchmark?.medianNs || Number.POSITIVE_INFINITY) - (right.benchmark?.medianNs || Number.POSITIVE_INFINITY);
    })[0] || null;
}

function summarizeBaselineStatus(record) {
  if (!record) return 'missing';
  if (record.benchmark?.ok) return 'ready';
  if (record.validation?.ok) return 'validated';
  if (record.compile?.ok) return 'compiled';
  return 'attempted';
}

function summarizeReferenceStatus(candidate) {
  if (!candidate) return 'missing';
  if (candidate.benchmark?.ok) return 'ready';
  if (candidate.validation?.ok) return 'validated';
  if (candidate.compile?.ok) return 'compiled';
  return candidate.status || 'attempted';
}

function buildBaselineRows(state, config) {
  const rows = [];

  for (const bucketKey of getExpectedBucketKeys(config)) {
    const canonicalBaseline = state.baselines[bucketKey] || null;
    const baselineArtifact = state.baselineArtifacts[bucketKey] || null;
    const baselineAttempt = state.baselineAttempts[bucketKey] || null;
    const ne10Reference = latestReferenceCandidate(state, bucketKey);

    rows.push({
      bucketKey,
      kind: 'scalar_baseline',
      family: baselineArtifact?.family || baselineAttempt?.family || 'baseline_reference',
      medianNs: Number.isFinite(canonicalBaseline?.medianNs) ? Math.round(canonicalBaseline.medianNs) : '',
      deltaVsScalarPct: '',
      status: canonicalBaseline ? 'ready' : summarizeBaselineStatus(baselineAttempt),
      owner: baselineArtifact?.implementedByWorkerId || baselineAttempt?.implementedByWorkerId || '',
    });

    rows.push({
      bucketKey,
      kind: 'ne10_reference',
      family: ne10Reference?.family || 'ne10_neon_reference',
      medianNs: Number.isFinite(ne10Reference?.benchmark?.medianNs) ? Math.round(ne10Reference.benchmark.medianNs) : '',
      deltaVsScalarPct: Number.isFinite(ne10Reference?.benchmark?.speedupVsBaseline)
        ? Number(((ne10Reference.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
        : '',
      status: summarizeReferenceStatus(ne10Reference),
      owner: ne10Reference?.implementedByWorkerId || '',
    });
  }

  return rows;
}

function latestBucketCandidate(state, bucketKey) {
  return state.candidates
    .filter((candidate) => candidate.bucketKey === bucketKey)
    .sort((left, right) => {
      const cycleDelta = (right.cycle || 0) - (left.cycle || 0);
      if (cycleDelta !== 0) return cycleDelta;
      const statusWeight = (candidate) => {
        if (candidate.benchmark?.ok) return 4;
        if (candidate.validation?.ok) return 3;
        if (candidate.compile?.ok) return 2;
        return 1;
      };
      return statusWeight(right) - statusWeight(left);
    })[0] || null;
}

function describeBlockedBucket(state, config, bucketKey) {
  const repairDirectives = buildRepairDirectives(state, config);
  const repairDirective = repairDirectives.find((directive) => directive.bucketKey === bucketKey);
  const baselineAttempt = state.baselineAttempts?.[bucketKey] || null;
  const latestCandidate = latestBucketCandidate(state, bucketKey);

  if (!state.baselines[bucketKey]) {
    const baselineReason = baselineAttempt?.validation?.failureReason
      || baselineAttempt?.validation?.suspectedIssue
      || baselineAttempt?.notes
      || 'no fresh same-run baseline was produced';
    return {
      family: baselineAttempt?.family || '',
      owner: baselineAttempt?.implementedByWorkerId || '',
      issues: latestCandidate?.audit?.openHighConfidenceFindings || 0,
      baseline: 'no',
      blockedReason: `missing same-run baseline: ${safeTrim(baselineReason, 240)}`,
      attempts: state.candidates.filter((candidate) => candidate.bucketKey === bucketKey).length,
      repairMode: repairDirective ? 'yes' : 'no',
    };
  }

  if (repairDirective) {
    const summary = [repairDirective.suspectedIssue, repairDirective.orderingHint, repairDirective.failureReason]
      .filter(Boolean)
      .join(' | ');
    return {
      family: repairDirective.family || latestCandidate?.family || '',
      owner: latestCandidate?.implementedByWorkerId || '',
      issues: latestCandidate?.audit?.openHighConfidenceFindings || 0,
      baseline: 'yes',
      blockedReason: `repair mode after ${repairDirective.repeatCount} repeated failures: ${safeTrim(summary || repairDirective.signature, 240)}`,
      attempts: state.candidates.filter((candidate) => candidate.bucketKey === bucketKey).length,
      repairMode: 'yes',
    };
  }

  if (latestCandidate) {
    const reason = latestCandidate.validation?.failureReason
      || latestCandidate.validation?.suspectedIssue
      || latestCandidate.validation?.orderingHint
      || latestCandidate.notes
      || 'latest candidate did not produce an eligible winner';
    return {
      family: latestCandidate.family || '',
      owner: latestCandidate.implementedByWorkerId || '',
      issues: latestCandidate.audit?.openHighConfidenceFindings || 0,
      baseline: latestCandidate.hasBucketBaseline ? 'yes' : 'no',
      blockedReason: safeTrim(reason, 240),
      attempts: state.candidates.filter((candidate) => candidate.bucketKey === bucketKey).length,
      repairMode: 'no',
    };
  }

  return {
    family: '',
    owner: '',
    issues: 0,
    baseline: state.baselines[bucketKey] ? 'yes' : 'no',
    blockedReason: 'no successful candidate artifacts were produced for this bucket',
    attempts: 0,
    repairMode: 'no',
  };
}

function buildBlockedBucketRows(state, config) {
  if (state.phase !== PHASES.COMPLETE) {
    return [];
  }
  return getMissingWinnerBucketKeys(state, config).map((bucketKey) => {
    const details = describeBlockedBucket(state, config, bucketKey);
    return {
      bucketKey,
      family: details.family,
      medianNs: '',
      speedupPct: '',
      status: 'blocked',
      issues: details.issues,
      baseline: details.baseline,
      owner: details.owner,
      attempts: details.attempts,
      blockedReason: details.blockedReason,
      repairMode: details.repairMode,
    };
  });
}

function buildCandidateRows(state, config) {
  const candidateRows = sortCandidatesForFrontier(state.candidates.filter((candidate) =>
    candidate.compile.ok
    && candidate.validation.ok
    && candidate.benchmark.ok
    && Number.isFinite(candidate.benchmark?.medianNs),
  )).map((candidate) => ({
    bucketKey: candidate.bucketKey,
    family: candidate.family,
    medianNs: Number.isFinite(candidate.benchmark?.medianNs) ? Math.round(candidate.benchmark.medianNs) : '',
    speedupPct: Number.isFinite(candidate.benchmark?.speedupVsBaseline)
      ? Number(((candidate.benchmark.speedupVsBaseline - 1) * 100).toFixed(1))
      : '',
    status: candidate.status,
    issues: candidate.audit.openHighConfidenceFindings || 0,
    baseline: candidate.hasBucketBaseline ? 'yes' : 'no',
    owner: candidate.implementedByWorkerId || '',
    attempts: '',
    blockedReason: '',
    repairMode: '',
  }));
  return [...candidateRows, ...buildBlockedBucketRows(state, config)];
}

function countCandidateSummary(state, config) {
  return {
    proposed: state.proposalBacklog.length + state.activePromotedProposals.length,
    validated: state.candidates.filter((candidate) => candidate.validation.ok).length,
    benchmarked: state.candidates.filter((candidate) => candidate.benchmark.ok).length,
    frontier: state.frontierIds.length,
    blocked: buildBlockedBucketRows(state, config).length,
  };
}

export function emitStateMetrics(ctx, state) {
  const config = getConfig(ctx);
  ctx.emitMetrics({
    currentPhase: {
      active: state.phase,
      reached: Array.isArray(state.reachedPhases) ? [...state.reachedPhases] : [state.phase],
    },
    candidateSummary: countCandidateSummary(state, config),
    cycleProgress: {
      value: state.cycleIndex,
      max: ctx.limits?.maxCycles || 1,
    },
    bestImprovementPct: {
      value: computeBestImprovementPct(state),
      max: 100,
    },
    degradedDiversity: state.degradedDiversity ? 1 : 0,
    baselines: { rows: buildBaselineRows(state, config) },
    frontier: { rows: buildFrontierRows(state) },
    blockedBuckets: { rows: buildBlockedBucketRows(state, config) },
    candidates: { rows: buildCandidateRows(state, config) },
    winnerSources: buildWinnerSourcesMetric(state, config),
  });
}

export { buildBaselineRows, buildBlockedBucketRows, buildCandidateRows, countCandidateSummary };
