import fs from 'node:fs';
import path from 'node:path';

import { getExpectedBucketKeys } from './buckets.js';
import { findCandidateById } from './candidates.js';

const SNAPSHOT_FILENAME = 'frontier-baseline.json';
const SNAPSHOT_VERSION = 1;

function buildSnapshotPath(config) {
  if (!config?.outputDir) return null;
  return path.join(config.outputDir, SNAPSHOT_FILENAME);
}

function pickBenchmarkFields(benchmark = {}) {
  if (!Number.isFinite(benchmark?.medianNs)) return null;
  return {
    medianNs: benchmark.medianNs,
    p95Ns: Number.isFinite(benchmark?.p95Ns) ? benchmark.p95Ns : null,
    cvPct: Number.isFinite(benchmark?.cvPct) ? benchmark.cvPct : null,
  };
}

export function persistFrontierSnapshot(state, config) {
  const snapshotPath = buildSnapshotPath(config);
  if (!snapshotPath) return { ok: false, skipped: true, reason: 'missing_output_dir' };

  const winners = (state?.frontierIds || [])
    .map((candidateId) => findCandidateById(state, candidateId))
    .filter((candidate) => candidate && Number.isFinite(candidate?.benchmark?.medianNs))
    .map((candidate) => ({
      bucketKey: candidate.bucketKey,
      family: candidate.family,
      treeSpec: candidate.treeSpec,
      leafSizes: Array.isArray(candidate.leafSizes) ? [...candidate.leafSizes] : [],
      permutationStrategy: candidate.permutationStrategy,
      twiddleStrategy: candidate.twiddleStrategy,
      simdStrategy: candidate.simdStrategy,
      proposedByWorkerId: candidate.proposedByWorkerId || '',
      implementedByWorkerId: candidate.implementedByWorkerId || '',
      auditedByWorkerIds: Array.isArray(candidate.auditedByWorkerIds) ? [...candidate.auditedByWorkerIds] : [],
      benchmark: pickBenchmarkFields(candidate.benchmark),
      notes: candidate.notes || '',
    }))
    .filter((winner) => winner.benchmark);

  if (winners.length === 0) {
    return { ok: false, skipped: true, reason: 'no_frontier' };
  }

  const payload = {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
    targetArch: config.targetArch,
    targetSizes: Array.isArray(config.targetSizes) ? [...config.targetSizes] : [],
    winners,
  };

  fs.writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  return { ok: true, path: snapshotPath, winnerCount: winners.length };
}

function seedCandidateFromWinner(winner) {
  const benchmark = {
    ok: true,
    warmups: 0,
    trials: 0,
    medianNs: winner.benchmark.medianNs,
    p95Ns: Number.isFinite(winner.benchmark.p95Ns) ? winner.benchmark.p95Ns : winner.benchmark.medianNs,
    cvPct: Number.isFinite(winner.benchmark.cvPct) ? winner.benchmark.cvPct : 0,
    speedupVsBaseline: 1,
    samplePath: '',
  };

  return {
    candidateId: `seed-${winner.bucketKey}`,
    proposalId: '',
    cycle: 0,
    bucketKey: winner.bucketKey,
    family: winner.family,
    status: 'winner',
    proposedByWorkerId: winner.proposedByWorkerId || 'prior_frontier',
    implementedByWorkerId: winner.implementedByWorkerId || 'prior_frontier',
    auditedByWorkerIds: Array.isArray(winner.auditedByWorkerIds) ? [...winner.auditedByWorkerIds] : [],
    lane: 'seed',
    treeSpec: winner.treeSpec,
    leafSizes: Array.isArray(winner.leafSizes) ? [...winner.leafSizes] : [],
    permutationStrategy: winner.permutationStrategy,
    twiddleStrategy: winner.twiddleStrategy,
    simdStrategy: winner.simdStrategy,
    requestedSimdStrategy: winner.simdStrategy,
    compile: { ok: true, command: '', exitCode: 0, stderrPath: '', binaryPath: '' },
    validation: { ok: true, sampleCount: 0, maxError: 0, tolerance: 0, failureReason: '', validationPath: '' },
    benchmark,
    reportedBucketBaseline: {
      bucketKey: winner.bucketKey,
      medianNs: winner.benchmark.medianNs,
      p95Ns: Number.isFinite(winner.benchmark.p95Ns) ? winner.benchmark.p95Ns : null,
      cvPct: Number.isFinite(winner.benchmark.cvPct) ? winner.benchmark.cvPct : null,
    },
    audit: {
      openHighConfidenceFindings: 0,
      openMediumConfidenceFindings: 0,
      findingsPath: '',
    },
    artifactPaths: [],
    notes: winner.notes
      ? `Seeded from prior run frontier snapshot | ${winner.notes}`
      : 'Seeded from prior run frontier snapshot',
    hasBucketBaseline: true,
  };
}

export function loadFrontierSnapshot(config) {
  const snapshotPath = buildSnapshotPath(config);
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { ok: true, found: false, seededCount: 0 };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return { ok: false, found: true, seededCount: 0, reason: 'invalid_json' };
  }

  if (
    !parsed
    || parsed.version !== SNAPSHOT_VERSION
    || parsed.targetArch !== config.targetArch
    || !Array.isArray(parsed.winners)
  ) {
    return { ok: false, found: true, seededCount: 0, reason: 'invalid_snapshot' };
  }

  const expectedBuckets = new Set(getExpectedBucketKeys(config));
  const winners = parsed.winners
    .filter((winner) =>
      winner
      && expectedBuckets.has(winner.bucketKey)
      && Number.isFinite(winner?.benchmark?.medianNs),
    );

  const seededCandidates = winners.map(seedCandidateFromWinner);
  const baselines = {};
  const baselineSources = {};
  const bestByBucket = {};
  const frontierIds = [];

  for (const winner of winners) {
    baselines[winner.bucketKey] = {
      bucketKey: winner.bucketKey,
      medianNs: winner.benchmark.medianNs,
      p95Ns: Number.isFinite(winner.benchmark.p95Ns) ? winner.benchmark.p95Ns : null,
      cvPct: Number.isFinite(winner.benchmark.cvPct) ? winner.benchmark.cvPct : null,
    };
    baselineSources[winner.bucketKey] = {
      bucketKey: winner.bucketKey,
      family: winner.family,
      sourceKind: 'previous_frontier',
      benchmark: {
        medianNs: winner.benchmark.medianNs,
        p95Ns: Number.isFinite(winner.benchmark.p95Ns) ? winner.benchmark.p95Ns : null,
        cvPct: Number.isFinite(winner.benchmark.cvPct) ? winner.benchmark.cvPct : null,
      },
      implementedByWorkerId: winner.implementedByWorkerId || '',
      proposedByWorkerId: winner.proposedByWorkerId || '',
      notes: winner.notes || '',
    };
    const candidateId = `seed-${winner.bucketKey}`;
    bestByBucket[winner.bucketKey] = candidateId;
    frontierIds.push(candidateId);
  }

  return {
    ok: true,
    found: winners.length > 0,
    seededCount: winners.length,
    baselines,
    baselineSources,
    seededCandidates,
    bestByBucket,
    frontierIds,
    path: snapshotPath,
  };
}

