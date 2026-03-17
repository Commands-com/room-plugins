import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(execCb);

import { DEFAULTS, POSTGRES_VERSIONS } from './constants.js';
import {
  clampInt,
  detectVolatileFunctions,
  isReadOnlyQuery,
  isSafeSubpath,
  normalizeStringArray,
  parseConnectionUrl,
  safeTrim,
} from './utils.js';
import { checkDockerAvailability, detectSourceVersion } from './harness.js';

// ---------------------------------------------------------------------------
// Room config normalisation
// ---------------------------------------------------------------------------

export function normalizeRoomConfig(input = {}) {
  const demoMode = Boolean(input.demoMode);
  const schemaSource = ['introspect', 'dump', 'migrations'].includes(input.schemaSource)
    ? input.schemaSource
    : DEFAULTS.schemaSource;
  const dbUrl = safeTrim(input.dbUrl, 4000);
  const slowQuery = safeTrim(input.slowQuery, 50000);
  const schemaPath = safeTrim(input.schemaPath, 4000);
  const seedDataPath = safeTrim(input.seedDataPath, 4000);
  const seedFromSource = Boolean(input.seedFromSource);
  const _postgresVersionExplicit = POSTGRES_VERSIONS.includes(String(input.postgresVersion));
  const postgresVersion = _postgresVersionExplicit
    ? String(input.postgresVersion)
    : DEFAULTS.postgresVersion;
  const schemaFilter = normalizeStringArray(input.schemaFilter || [], 20);
  const outputDir = safeTrim(input.outputDir || DEFAULTS.outputDir, 4000);
  // scaleFactor comes as a string from roomConfigSchema; parse and clamp it
  const rawScaleFactor = typeof input.scaleFactor === 'string'
    ? Number(input.scaleFactor)
    : input.scaleFactor;
  const scaleFactor = clampInt(rawScaleFactor, 1000, 1000000, DEFAULTS.scaleFactor);

  // Parse productionStats — accept JSON string or object
  let productionStats = null;
  if (input.productionStats) {
    if (typeof input.productionStats === 'string') {
      try {
        productionStats = JSON.parse(input.productionStats);
      } catch {
        productionStats = null;
      }
    } else if (typeof input.productionStats === 'object') {
      productionStats = input.productionStats;
    }
  }

  return {
    demoMode,
    schemaSource: demoMode ? 'demo' : schemaSource,
    dbUrl,
    slowQuery,
    schemaPath,
    seedDataPath,
    seedFromSource,
    postgresVersion,
    schemaFilter,
    outputDir,
    scaleFactor,
    productionStats,
    _postgresVersionExplicit,
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
    containerMemory: DEFAULTS.containerMemory,
    containerCpus: DEFAULTS.containerCpus,
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

  // Docker check
  const docker = await checkDockerAvailability();
  if (!docker.ok) {
    hardFailures.push({
      id: 'docker_missing',
      label: 'Docker',
      details: docker.message || 'Docker is not available. Docker is required to spin up an isolated Postgres instance.',
    });
  } else {
    good.push({ id: 'docker', label: 'Docker', details: 'Available' });
  }

  // Demo mode — skip most other checks
  if (config.demoMode) {
    good.push({ id: 'demo_mode', label: 'Demo Mode', details: 'Enabled — using bundled e-commerce scenario' });
    return { compatible: hardFailures.length === 0, good, missing, warnings, hardFailures };
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
    // Volatile function check
    const volatiles = detectVolatileFunctions(config.slowQuery);
    if (volatiles.length > 0) {
      hardFailures.push({
        id: 'volatile_functions',
        label: 'Volatile Functions',
        details: `Query contains volatile functions: ${volatiles.join(', ')}. Replace with literal values.`,
      });
    }
  }

  // Schema source validation
  if (config.schemaSource === 'introspect') {
    if (!config.dbUrl) {
      hardFailures.push({
        id: 'db_url_missing',
        label: 'Database URL',
        details: 'dbUrl is required when schemaSource is "introspect"',
      });
    } else {
      const parsed = parseConnectionUrl(config.dbUrl);
      if (!parsed) {
        hardFailures.push({
          id: 'db_url_invalid',
          label: 'Database URL',
          details: 'dbUrl could not be parsed as a valid connection string',
        });
      } else {
        good.push({ id: 'db_url', label: 'Database URL', details: `${parsed.host}:${parsed.port}/${parsed.database}` });
      }
    }

    // Check for pg_dump availability (host or Docker fallback)
    let hostPgDump = false;
    try {
      await execAsync('which pg_dump', { encoding: 'utf-8', timeout: 5000 });
      hostPgDump = true;
      good.push({ id: 'pg_dump', label: 'pg_dump', details: 'Available on host' });
    } catch {
      // Host pg_dump not available — check Docker fallback
      const dockerOk = await checkDockerAvailability();
      if (dockerOk.ok) {
        good.push({ id: 'pg_dump', label: 'pg_dump', details: 'Not on host — Docker utility container fallback available' });
      } else {
        hardFailures.push({
          id: 'pg_dump_missing',
          label: 'pg_dump',
          details: 'pg_dump is not available on the host and Docker is not available for the utility-container fallback',
        });
      }
    }

    // Detect source database version (host psql or Docker utility container fallback)
    if (config.dbUrl) {
      const versionResult = await detectSourceVersion(config.dbUrl, config.postgresVersion);
      if (versionResult.ok && versionResult.version) {
        const sourceMajor = versionResult.version;
        if (config._postgresVersionExplicit && sourceMajor !== config.postgresVersion) {
          // User explicitly chose a version that differs from source — warn
          warnings.push({
            id: 'version_mismatch',
            label: 'Postgres Version Mismatch',
            details: `Source database is v${sourceMajor} but harness is explicitly configured for v${config.postgresVersion}. Planner behavior may differ.`,
          });
        } else if (sourceMajor !== config.postgresVersion) {
          // Auto-match: user did not explicitly set version, so we'll note the auto-match
          good.push({ id: 'version_auto_match', label: 'Postgres Version', details: `Source v${sourceMajor} detected — harness will auto-match` });
        } else {
          good.push({ id: 'version_match', label: 'Postgres Version', details: `Source v${sourceMajor} matches harness` });
        }
      } else {
        warnings.push({
          id: 'version_detect_failed',
          label: 'Version Detection',
          details: versionResult.message || 'Could not detect source database version — ensure postgresVersion matches your source database',
        });
      }
    }
  }

  if ((config.schemaSource === 'dump' || config.schemaSource === 'migrations') && !config.schemaPath) {
    hardFailures.push({
      id: 'schema_path_missing',
      label: 'Schema Path',
      details: `schemaPath is required when schemaSource is "${config.schemaSource}"`,
    });
  } else if (config.schemaPath) {
    if (!fs.existsSync(config.schemaPath)) {
      hardFailures.push({
        id: 'schema_path_invalid',
        label: 'Schema Path',
        details: `schemaPath "${config.schemaPath}" does not exist`,
      });
    } else {
      good.push({ id: 'schema_path', label: 'Schema Path', details: config.schemaPath });
    }
  }

  // Seed data
  if (config.seedFromSource && !config.dbUrl) {
    hardFailures.push({
      id: 'seed_source_no_url',
      label: 'Seed from Source',
      details: 'dbUrl is required when seedFromSource is true',
    });
  }

  if (config.seedDataPath) {
    if (!fs.existsSync(config.seedDataPath)) {
      hardFailures.push({
        id: 'seed_path_invalid',
        label: 'Seed Data Path',
        details: `seedDataPath "${config.seedDataPath}" does not exist`,
      });
    } else {
      good.push({ id: 'seed_data', label: 'Seed Data Path', details: config.seedDataPath });
    }
  } else if (config.seedFromSource) {
    // Tier 2 sampling requires dbUrl (already validated above) — mark as ready
    if (config.dbUrl) {
      good.push({ id: 'seed_from_source', label: 'Tier 2 Sampling', details: `Will sample up to ${config.scaleFactor} rows per table from source` });
    }
  } else {
    warnings.push({
      id: 'tier3_synthetic',
      label: 'Data Source',
      details: 'No data population method configured — will fall back to Tier 3 synthetic data generation. Benchmark results will be directional only. For reliable results, provide seedDataPath (Tier 1) or enable seedFromSource with dbUrl (Tier 2).',
    });
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
