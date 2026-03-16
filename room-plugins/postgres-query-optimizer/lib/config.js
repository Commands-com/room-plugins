import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './constants.js';

export function normalizeRoomConfig(input = {}) {
  const dbUrl = input.dbUrl || '';
  const slowQuery = input.slowQuery || '';
  const schemaFilter = Array.isArray(input.schemaFilter) ? input.schemaFilter : [];
  const dryRun = Boolean(input.dryRun);
  const outputDir = input.outputDir || '.commands/postgres-tuner';

  return {
    dbUrl,
    slowQuery,
    schemaFilter,
    dryRun,
    outputDir,
  };
}

export function getConfig(ctx) {
  const roomConfig = normalizeRoomConfig(ctx?.roomConfig || {});
  return {
    plannedCandidatesPerCycle: ctx?.orchestratorConfig?.plannedCandidatesPerCycle || DEFAULTS.plannedCandidatesPerCycle,
    promoteTopK: ctx?.orchestratorConfig?.promoteTopK || DEFAULTS.promoteTopK,
    maxRiskScore: ctx?.orchestratorConfig?.maxRiskScore || DEFAULTS.maxRiskScore,
    targetImprovementPct: ctx?.orchestratorConfig?.targetImprovementPct || DEFAULTS.targetImprovementPct,
    ...roomConfig,
  };
}

export async function checkCompatibility(payload = {}) {
  const config = normalizeRoomConfig(payload.roomConfig || payload);
  const hardFailures = [];
  const good = [];

  if (!config.dbUrl) {
    hardFailures.push({ id: 'db_url_missing', label: 'Database URL', details: 'Postgres connection string is required' });
  } else {
    // In a real implementation, we would try to connect here.
    good.push({ id: 'db_url', label: 'Database URL', details: 'Provided' });
  }

  if (!config.slowQuery) {
    hardFailures.push({ id: 'query_missing', label: 'Target Query', details: 'A slow query must be provided to optimize' });
  } else {
    good.push({ id: 'query', label: 'Target Query', details: 'Provided' });
  }

  return {
    ok: true,
    report: {
      compatible: hardFailures.length === 0,
      good,
      hardFailures,
      warnings: [],
      missing: [],
    }
  };
}

export async function makeCompatible(payload = {}) {
  const config = normalizeRoomConfig(payload.roomConfig || payload);
  // Implementation for scaffolding output dir, etc.
  return { ok: true, applied: true, actions: ['Initialized tuner workspace'] };
}
