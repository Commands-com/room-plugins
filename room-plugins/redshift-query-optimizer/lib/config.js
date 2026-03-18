import { DEFAULTS } from './constants.js';
import {
  clampInt,
  isReadOnlyQuery,
  safeTrim,
  normalizeStringArray,
} from '../../sql-optimizer-core/index.js';
import { testConnection } from './harness.js';

// ---------------------------------------------------------------------------
// Room config normalisation
// ---------------------------------------------------------------------------

export function normalizeRoomConfig(input = {}) {
  const dbUrl = safeTrim(input.dbUrl, 4000);
  const slowQuery = safeTrim(input.slowQuery, 50000);
  const schemaFilter = normalizeStringArray(input.schemaFilter || [], 20);
  const outputDir = safeTrim(input.outputDir || '.commands/redshift-tuner', 4000);

  return {
    dbUrl,
    slowQuery,
    schemaFilter,
    outputDir,
  };
}

// ---------------------------------------------------------------------------
// Full merged config (room + orchestrator)
// ---------------------------------------------------------------------------

export function getConfig(ctx) {
  const roomConfig = normalizeRoomConfig(ctx?.roomConfig || {});
  return {
    plannedCandidatesPerCycle: clampInt(ctx?.orchestratorConfig?.plannedCandidatesPerCycle, 1, 10, DEFAULTS.plannedCandidatesPerCycle),
    promoteTopK: clampInt(ctx?.orchestratorConfig?.promoteTopK, 1, 5, DEFAULTS.promoteTopK),
    maxRetestCandidates: clampInt(ctx?.orchestratorConfig?.maxRetestCandidates, 1, 3, DEFAULTS.maxRetestCandidates),
    maxRiskScore: clampInt(ctx?.orchestratorConfig?.maxRiskScore, 0, 10, DEFAULTS.maxRiskScore),
    targetImprovementPct: Number.isFinite(Number(ctx?.orchestratorConfig?.targetImprovementPct))
      ? Math.max(0, Math.min(1000, Number(ctx.orchestratorConfig.targetImprovementPct)))
      : DEFAULTS.targetImprovementPct,
    warmupRuns: clampInt(ctx?.orchestratorConfig?.warmupRuns, 1, 20, DEFAULTS.warmupRuns),
    benchmarkTrials: clampInt(ctx?.orchestratorConfig?.benchmarkTrials, 3, 50, DEFAULTS.benchmarkTrials),
    plateauCycles: clampInt(ctx?.orchestratorConfig?.plateauCycles, 1, 5, DEFAULTS.plateauCycles),
    parityFullThreshold: DEFAULTS.parityFullThreshold,
    queryTimeoutMs: DEFAULTS.queryTimeoutMs,
    ...roomConfig,
  };
}

// ---------------------------------------------------------------------------
// Compatibility checking
// ---------------------------------------------------------------------------

export async function buildCompatibilityReport(config) {
  const good = [];
  const missing = [];
  const warnings = [];
  const hardFailures = [];

  // Connection check
  if (!config.dbUrl) {
    hardFailures.push({
      id: 'db_url_missing',
      label: 'Redshift URL',
      details: 'A Redshift connection URL is required.',
    });
  } else {
    const connResult = await testConnection(config.dbUrl);
    if (!connResult.ok) {
      hardFailures.push({
        id: 'connection_failed',
        label: 'Redshift Connection',
        details: `Could not connect: ${connResult.message}`,
      });
    } else {
      good.push({ id: 'connection', label: 'Redshift Connection', details: 'Connected successfully' });
    }
  }

  // Slow query
  if (!config.slowQuery) {
    hardFailures.push({
      id: 'query_missing',
      label: 'Target Query',
      details: 'A slow query must be provided to optimise',
    });
  } else if (!isReadOnlyQuery(config.slowQuery)) {
    hardFailures.push({
      id: 'query_not_readonly',
      label: 'Target Query',
      details: 'Query must be a read-only SELECT or WITH...SELECT',
    });
  } else {
    good.push({ id: 'query', label: 'Target Query', details: 'Provided (read-only)' });
  }

  return { compatible: hardFailures.length === 0, good, missing, warnings, hardFailures };
}

export async function checkCompatibility(payload = {}) {
  const config = normalizeRoomConfig(payload.roomConfig || payload);
  const report = await buildCompatibilityReport(config);
  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// Make compatible (scaffold output directory)
// ---------------------------------------------------------------------------

export async function makeCompatible(payload = {}) {
  const config = normalizeRoomConfig(payload.roomConfig || payload);
  const actions = [];
  const errors = [];

  try {
    const fs = await import('node:fs');
    if (config.outputDir && !fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
      actions.push(`Created output directory ${config.outputDir}`);
    }
  } catch (err) {
    errors.push(err?.message || String(err));
  }

  const report = await buildCompatibilityReport(config);
  return {
    ok: true,
    applied: actions.length > 0,
    actions,
    errors,
    report,
  };
}
