import { describe, it, expect } from 'vitest';
import { createRedshiftEngine } from '../lib/engine.js';

const engine = createRedshiftEngine();

describe('createRedshiftEngine', () => {
  it('returns correct strategy types', () => {
    expect(engine.strategyTypes).toEqual(['rewrite', 'sort_dist']);
    expect(engine.measuredStrategyTypes).toEqual(['rewrite']);
    expect(engine.defaultStrategyType).toBe('rewrite');
  });

  it('has all required hooks', () => {
    expect(typeof engine.determinePlanShapeChanged).toBe('function');
    expect(typeof engine.detectStrategyTypeFromSQL).toBe('function');
    expect(typeof engine.extendBuilderResult).toBe('function');
    expect(typeof engine.buildWinnerBlock).toBe('function');
    expect(typeof engine.buildEngineBaselineRows).toBe('function');
    expect(typeof engine.buildEngineMetrics).toBe('function');
  });

  it('has target builders', () => {
    expect(typeof engine.targetBuilders.baseline).toBe('function');
    expect(typeof engine.targetBuilders.planning).toBe('function');
    expect(typeof engine.targetBuilders.cycle).toBe('function');
    expect(typeof engine.targetBuilders.audit).toBe('function');
    expect(typeof engine.targetBuilders.retest).toBe('function');
    expect(typeof engine.targetBuilders.synthesis).toBe('function');
  });

  it('has computeRobustCV hook', () => {
    expect(typeof engine.computeRobustCV).toBe('function');
  });
});

describe('detectStrategyTypeFromSQL', () => {
  it('detects rewrite as default', () => {
    expect(engine.detectStrategyTypeFromSQL('SELECT 1')).toBe('rewrite');
    expect(engine.detectStrategyTypeFromSQL(null)).toBe('rewrite');
    expect(engine.detectStrategyTypeFromSQL('')).toBe('rewrite');
  });

  it('detects sort key changes', () => {
    expect(engine.detectStrategyTypeFromSQL(
      'ALTER TABLE orders ALTER COMPOUND SORTKEY (created_at, user_id)',
    )).toBe('sort_dist');
  });

  it('detects dist key changes', () => {
    expect(engine.detectStrategyTypeFromSQL(
      'ALTER TABLE orders ALTER DISTKEY user_id',
    )).toBe('sort_dist');
    expect(engine.detectStrategyTypeFromSQL(
      'ALTER TABLE orders ALTER DISTSTYLE ALL',
    )).toBe('sort_dist');
  });
});

describe('buildWinnerBlock', () => {
  it('renders rewrite winner', () => {
    const block = engine.buildWinnerBlock({
      strategyType: 'rewrite',
      targetQuery: 'SELECT optimized FROM t',
      speedupPct: 65.3,
      riskScore: 3,
      baseline: { medianMs: 3000, distSteps: ['DS_BCAST_INNER'] },
      result: { medianMs: 1040, distSteps: ['DS_DIST_NONE'] },
    }, 'Test Winner');

    expect(block).toContain('Test Winner');
    expect(block).toContain('65.3%');
    expect(block).toContain('SELECT optimized FROM t');
    expect(block).toContain('Eliminated redistribution');
    expect(block).toContain('measured on cluster');
  });

  it('renders sort_dist advisory', () => {
    const block = engine.buildWinnerBlock({
      strategyType: 'sort_dist',
      applySQL: 'ALTER TABLE orders ALTER DISTKEY user_id',
      riskScore: 5,
      rationale: 'Co-locates orders with users',
    }, 'Dist Key Rec');

    expect(block).toContain('ADVISORY');
    expect(block).toContain('ALTER TABLE');
    expect(block).toContain('table rebuild');
    expect(block).toContain('Co-locates');
  });
});

describe('buildEngineBaselineRows', () => {
  it('builds rows from baseline data', () => {
    const rows = engine.buildEngineBaselineRows({
      baselines: {
        medianMs: 3200,
        p95Ms: 4100,
        cvPct: 12,
        stepTypes: ['XN Seq Scan', 'XN Hash Join'],
        distSteps: ['DS_BCAST_INNER'],
        totalCost: 45000,
        bytesScanned: 1073741824,
      },
    });

    expect(rows.find((r) => r.metric === 'Median').value).toContain('3200');
    expect(rows.find((r) => r.metric === 'P95').value).toContain('4100');
    expect(rows.find((r) => r.metric === 'Plan Steps').value).toContain('XN Seq Scan');
    expect(rows.find((r) => r.metric === 'Redistribution').value).toContain('DS_BCAST_INNER');
    expect(rows.find((r) => r.metric === 'Bytes Scanned').value).toContain('GB');
  });

  it('returns empty array when no baselines', () => {
    expect(engine.buildEngineBaselineRows({})).toEqual([]);
  });
});

describe('computeRobustCV', () => {
  it('returns MAD-based CV from raw timings', () => {
    // Timings from user's real Redshift baseline with WLM outliers
    const baselines = {
      cvPct: 28.11,
      trials: [76, 159, 88, 79, 81, 104, 159, 106, 101, 87],
    };
    const robustCV = engine.computeRobustCV(baselines);
    // MAD-based CV should be ~13%, well below the 25% threshold
    expect(robustCV).toBeLessThan(20);
    expect(robustCV).toBeGreaterThan(5);
  });

  it('returns undefined when no trials available', () => {
    expect(engine.computeRobustCV({ cvPct: 30 })).toBeUndefined();
    expect(engine.computeRobustCV({})).toBeUndefined();
    expect(engine.computeRobustCV(null)).toBeUndefined();
  });

  it('returns undefined for too few trials', () => {
    expect(engine.computeRobustCV({ trials: [100, 105, 110] })).toBeUndefined();
  });

  it('handles stable timings', () => {
    const baselines = { trials: [100, 102, 98, 101, 99, 103, 97, 100] };
    const robustCV = engine.computeRobustCV(baselines);
    expect(robustCV).toBeLessThan(5);
  });

  it('reads from timings key as fallback', () => {
    const baselines = { timings: [76, 159, 88, 79, 81, 104, 159, 106, 101, 87] };
    const robustCV = engine.computeRobustCV(baselines);
    expect(robustCV).toBeLessThan(20);
  });
});

describe('buildEngineMetrics', () => {
  it('includes advisory recommendations', () => {
    const state = {
      candidates: [
        {
          candidateId: 'sd1',
          proposalId: 'distkey_orders',
          strategyType: 'sort_dist',
          status: 'advisory',
          applySQL: 'ALTER TABLE orders ALTER DISTKEY user_id',
          riskScore: 5,
          cycleIndex: 1,
        },
      ],
      frontierIds: [],
      bestByStrategyType: {},
    };

    const metrics = engine.buildEngineMetrics(state, {});
    expect(metrics.advisoryRecommendations).toBeDefined();
    expect(metrics.advisoryRecommendations.blocks).toHaveLength(1);
    expect(metrics.advisoryRecommendations.blocks[0].title).toContain('sort_dist');
  });

  it('excludes rejected advisory candidates', () => {
    const state = {
      candidates: [
        {
          candidateId: 'sd1',
          proposalId: 'distkey_bad',
          strategyType: 'sort_dist',
          status: 'rejected',
          applySQL: 'ALTER TABLE x ALTER DISTKEY y',
          riskScore: 9,
        },
      ],
      frontierIds: [],
      bestByStrategyType: {},
    };

    const metrics = engine.buildEngineMetrics(state, {});
    expect(metrics.advisoryRecommendations).toBeUndefined();
  });
});
