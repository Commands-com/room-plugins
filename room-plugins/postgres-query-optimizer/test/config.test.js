import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeRoomConfig, getConfig } from '../lib/config.js';

describe('normalizeRoomConfig', () => {
  it('returns defaults for empty input', () => {
    const config = normalizeRoomConfig({});
    expect(config.demoMode).toBe(false);
    expect(config.schemaSource).toBe('introspect');
    expect(config.postgresVersion).toBe('16');
    expect(config.outputDir).toBe('.commands/postgres-tuner');
  });

  it('normalizes demo mode', () => {
    const config = normalizeRoomConfig({ demoMode: true });
    expect(config.demoMode).toBe(true);
    expect(config.schemaSource).toBe('demo');
  });

  it('validates schemaSource enum', () => {
    expect(normalizeRoomConfig({ schemaSource: 'dump' }).schemaSource).toBe('dump');
    expect(normalizeRoomConfig({ schemaSource: 'migrations' }).schemaSource).toBe('migrations');
    expect(normalizeRoomConfig({ schemaSource: 'bogus' }).schemaSource).toBe('introspect');
  });

  it('validates postgresVersion enum', () => {
    expect(normalizeRoomConfig({ postgresVersion: '14' }).postgresVersion).toBe('14');
    expect(normalizeRoomConfig({ postgresVersion: '99' }).postgresVersion).toBe('16');
  });

  it('trims strings', () => {
    const config = normalizeRoomConfig({ dbUrl: '  postgres://x  ', slowQuery: '  SELECT 1  ' });
    expect(config.dbUrl).toBe('postgres://x');
    expect(config.slowQuery).toBe('SELECT 1');
  });

  it('normalizes schemaFilter array', () => {
    const config = normalizeRoomConfig({ schemaFilter: ['orders', '', 'users', 'orders'] });
    expect(config.schemaFilter).toEqual(['orders', 'users']);
  });
});

describe('getConfig', () => {
  it('merges orchestrator config with room config', () => {
    const ctx = {
      roomConfig: { demoMode: true },
      orchestratorConfig: {
        promoteTopK: 3,
        warmupRuns: 5,
        benchmarkTrials: 20,
      },
    };
    const config = getConfig(ctx);
    expect(config.demoMode).toBe(true);
    expect(config.promoteTopK).toBe(3);
    expect(config.warmupRuns).toBe(5);
    expect(config.benchmarkTrials).toBe(20);
  });

  it('clamps orchestrator values to valid range', () => {
    const ctx = {
      roomConfig: {},
      orchestratorConfig: {
        promoteTopK: 100,
        warmupRuns: -5,
        benchmarkTrials: 999,
        maxRiskScore: 50,
      },
    };
    const config = getConfig(ctx);
    expect(config.promoteTopK).toBe(5);      // clamped to max
    expect(config.warmupRuns).toBe(1);        // clamped to min
    expect(config.benchmarkTrials).toBe(50);  // clamped to max
    expect(config.maxRiskScore).toBe(10);     // clamped to max
  });

  it('returns defaults for null ctx', () => {
    const config = getConfig(null);
    expect(config.plannedCandidatesPerCycle).toBe(4);
    expect(config.warmupRuns).toBe(3);
    expect(config.benchmarkTrials).toBe(10);
    expect(config.plateauCycles).toBe(2);
  });
});
