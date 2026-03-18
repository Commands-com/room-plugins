import { describe, it, expect } from 'vitest';
import { normalizeRoomConfig, getConfig } from '../lib/config.js';

describe('normalizeRoomConfig', () => {
  it('returns defaults for empty input', () => {
    const config = normalizeRoomConfig({});
    expect(config.dbUrl).toBe('');
    expect(config.slowQuery).toBe('');
    expect(config.schemaFilter).toEqual([]);
    expect(config.outputDir).toBe('.commands/redshift-tuner');
  });

  it('normalizes provided values', () => {
    const config = normalizeRoomConfig({
      dbUrl: '  postgres://user:pass@cluster:5439/db  ',
      slowQuery: 'SELECT * FROM orders WHERE created_at > NOW() - INTERVAL \'7 days\'',
      schemaFilter: ['orders', 'users', 'orders'],
      outputDir: '/tmp/tuner',
    });
    expect(config.dbUrl).toBe('postgres://user:pass@cluster:5439/db');
    expect(config.slowQuery).toContain('SELECT');
    expect(config.schemaFilter).toEqual(['orders', 'users']);
    expect(config.outputDir).toBe('/tmp/tuner');
  });
});

describe('getConfig', () => {
  it('merges room and orchestrator config', () => {
    const config = getConfig({
      roomConfig: {
        dbUrl: 'postgres://x:y@cluster:5439/db',
        slowQuery: 'SELECT 1',
      },
      orchestratorConfig: {
        plannedCandidatesPerCycle: 6,
        warmupRuns: 3,
        benchmarkTrials: 10,
      },
    });
    expect(config.dbUrl).toBe('postgres://x:y@cluster:5439/db');
    expect(config.plannedCandidatesPerCycle).toBe(6);
    expect(config.warmupRuns).toBe(3);
    expect(config.benchmarkTrials).toBe(10);
  });

  it('clamps out-of-range orchestrator values', () => {
    const config = getConfig({
      roomConfig: {},
      orchestratorConfig: {
        plannedCandidatesPerCycle: 999,
        benchmarkTrials: 1,
      },
    });
    expect(config.plannedCandidatesPerCycle).toBe(10);
    expect(config.benchmarkTrials).toBe(3);
  });

  it('uses defaults when orchestratorConfig is missing', () => {
    const config = getConfig({ roomConfig: {} });
    expect(config.plannedCandidatesPerCycle).toBe(4);
    expect(config.promoteTopK).toBe(2);
    expect(config.warmupRuns).toBe(2);
    expect(config.benchmarkTrials).toBe(5);
    expect(config.maxRetestCandidates).toBe(2);
  });
});
