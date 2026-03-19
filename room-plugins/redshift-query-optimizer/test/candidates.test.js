import { describe, it, expect } from 'vitest';
import { recomputeFrontier } from '../../sql-optimizer-core/index.js';
import { createRedshiftEngine } from '../lib/engine.js';

const { determinePlanShapeChanged } = createRedshiftEngine();

// Shared core tests (isConfidentMeasurement, sortCandidatesForFrontier,
// recomputeFrontier, evaluateImprovement, chooseStopReason, findCandidateById)
// live in sql-optimizer-core/test/candidates.test.js.

describe('determinePlanShapeChanged (Redshift)', () => {
  it('detects step type changes', () => {
    const changed = determinePlanShapeChanged({
      baseline: { stepTypes: ['XN Seq Scan', 'XN Sort'] },
      result: { stepTypes: ['XN Seq Scan', 'XN Hash Join'] },
    });
    expect(changed).toBe(true);
  });

  it('no change when same step types', () => {
    const changed = determinePlanShapeChanged({
      baseline: { stepTypes: ['XN Seq Scan', 'XN Sort'] },
      result: { stepTypes: ['XN Sort', 'XN Seq Scan'] },
    });
    expect(changed).toBe(false);
  });

  it('detects redistribution step changes', () => {
    const changed = determinePlanShapeChanged({
      baseline: { stepTypes: ['XN Hash Join'], distSteps: ['DS_BCAST_INNER'] },
      result: { stepTypes: ['XN Hash Join'], distSteps: ['DS_DIST_NONE'] },
    });
    expect(changed).toBe(true);
  });

  it('no change when same dist steps', () => {
    const changed = determinePlanShapeChanged({
      baseline: { stepTypes: ['XN Hash Join'], distSteps: ['DS_DIST_INNER'] },
      result: { stepTypes: ['XN Hash Join'], distSteps: ['DS_DIST_INNER'] },
    });
    expect(changed).toBe(false);
  });

  it('returns false when both sides are empty', () => {
    expect(determinePlanShapeChanged({ baseline: {}, result: {} })).toBe(false);
  });

  it('returns false when candidate is missing', () => {
    expect(determinePlanShapeChanged(null)).toBe(false);
    expect(determinePlanShapeChanged({ baseline: {} })).toBe(false);
  });
});

describe('recomputeFrontier (Redshift-specific)', () => {
  it('excludes sort_dist from frontier', () => {
    const state = {
      candidates: [
        { candidateId: 'c1', strategyType: 'sort_dist', speedupPct: null, result: {}, riskScore: 3, status: 'advisory', approved: true },
        { candidateId: 'c2', strategyType: 'rewrite', speedupPct: 50, result: { medianMs: 50, cvPct: 5 }, riskScore: 3, resultParity: true, parityChecked: true, planShapeChanged: true, retested: true, status: 'benchmarked', approved: true },
      ],
      frontierIds: [],
      bestByStrategyType: {},
    };
    recomputeFrontier(state, { maxRiskScore: 7 });
    expect(state.frontierIds).toHaveLength(1);
    expect(state.bestByStrategyType.rewrite).toBe('c2');
    expect(state.bestByStrategyType.sort_dist).toBeUndefined();
  });
});
