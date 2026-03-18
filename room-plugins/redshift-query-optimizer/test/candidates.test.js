import { describe, it, expect } from 'vitest';
import {
  isConfidentMeasurement,
  sortCandidatesForFrontier,
  recomputeFrontier,
  evaluateImprovement,
  computeBestImprovementPct,
  chooseStopReason,
  findCandidateById,
} from '../../sql-optimizer-core/index.js';
import { createRedshiftEngine } from '../lib/engine.js';

const { determinePlanShapeChanged } = createRedshiftEngine();

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

describe('isConfidentMeasurement', () => {
  it('rejects when CV is too high', () => {
    const result = isConfidentMeasurement({
      result: { cvPct: 30 },
      speedupPct: 50,
      planShapeChanged: true,
    });
    expect(result.confident).toBe(false);
    expect(result.reason).toContain('CV');
  });

  it('high confidence: plan change + high speedup', () => {
    const result = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 150,
      planShapeChanged: true,
    });
    expect(result.confident).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('medium confidence: plan change + modest speedup (needs retest)', () => {
    const noRetest = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 50,
      planShapeChanged: true,
    });
    expect(noRetest.confident).toBe(false);
    expect(noRetest.needsRetest).toBe(true);

    const retested = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 50,
      planShapeChanged: true,
      retested: true,
    });
    expect(retested.confident).toBe(true);
    expect(retested.confidence).toBe('medium');
  });
});

describe('sortCandidatesForFrontier', () => {
  it('sorts by speedupPct descending', () => {
    const candidates = [
      { speedupPct: 50, result: { cvPct: 5 }, riskScore: 3 },
      { speedupPct: 90, result: { cvPct: 5 }, riskScore: 3 },
      { speedupPct: 70, result: { cvPct: 5 }, riskScore: 3 },
    ];
    const sorted = sortCandidatesForFrontier(candidates);
    expect(sorted[0].speedupPct).toBe(90);
    expect(sorted[1].speedupPct).toBe(70);
    expect(sorted[2].speedupPct).toBe(50);
  });
});

describe('recomputeFrontier', () => {
  it('selects best rewrite candidate', () => {
    const state = {
      candidates: [
        {
          candidateId: 'c1',
          strategyType: 'rewrite',
          speedupPct: 90,
          result: { medianMs: 10, cvPct: 5 },
          riskScore: 3,
          resultParity: true,
          parityChecked: true,
          planShapeChanged: true,
          retested: true,
          status: 'benchmarked',
          approved: true,
        },
        {
          candidateId: 'c2',
          strategyType: 'rewrite',
          speedupPct: 50,
          result: { medianMs: 50, cvPct: 5 },
          riskScore: 3,
          resultParity: true,
          parityChecked: true,
          planShapeChanged: true,
          retested: true,
          status: 'benchmarked',
          approved: true,
        },
      ],
      frontierIds: [],
      bestByStrategyType: {},
    };

    recomputeFrontier(state, { maxRiskScore: 7 });

    expect(state.frontierIds).toHaveLength(1);
    expect(state.bestByStrategyType.rewrite).toBe('c1');
  });

  it('excludes sort_dist from frontier', () => {
    const state = {
      candidates: [
        {
          candidateId: 'c1',
          strategyType: 'sort_dist',
          speedupPct: null,
          result: {},
          riskScore: 3,
          status: 'advisory',
          approved: true,
        },
        {
          candidateId: 'c2',
          strategyType: 'rewrite',
          speedupPct: 50,
          result: { medianMs: 50, cvPct: 5 },
          riskScore: 3,
          resultParity: true,
          parityChecked: true,
          planShapeChanged: true,
          retested: true,
          status: 'benchmarked',
          approved: true,
        },
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

describe('evaluateImprovement', () => {
  it('resets plateau on improvement', () => {
    const state = {
      frontierIds: ['c1'],
      candidates: [{ candidateId: 'c1', speedupPct: 50 }],
      bestImprovementPct: 30,
      plateauCount: 2,
    };
    evaluateImprovement(state);
    expect(state.plateauCount).toBe(0);
    expect(state.bestImprovementPct).toBe(50);
  });

  it('increments plateau when no improvement', () => {
    const state = {
      frontierIds: ['c1'],
      candidates: [{ candidateId: 'c1', speedupPct: 30 }],
      bestImprovementPct: 50,
      plateauCount: 0,
    };
    evaluateImprovement(state);
    expect(state.plateauCount).toBe(1);
    expect(state.bestImprovementPct).toBe(50);
  });
});

describe('chooseStopReason', () => {
  it('returns cycle_limit when cycle exceeds max', () => {
    const state = {
      candidates: [{ result: { medianMs: 10, cvPct: 5 }, status: 'benchmarked' }],
      cycleIndex: 5,
      plateauCount: 0,
      bestImprovementPct: 50,
      frontierIds: ['c1'],
    };
    expect(chooseStopReason(state, {}, { maxCycles: 4 })).toBe('cycle_limit');
  });

  it('returns null when no stop condition met', () => {
    const state = {
      candidates: [{ result: { medianMs: 10, cvPct: 5 }, status: 'benchmarked' }],
      cycleIndex: 1,
      plateauCount: 0,
      bestImprovementPct: 0,
      frontierIds: [],
    };
    expect(chooseStopReason(state, {}, { maxCycles: 10 })).toBeNull();
  });
});

describe('findCandidateById', () => {
  it('finds by candidateId', () => {
    const state = { candidates: [{ candidateId: 'c1' }, { candidateId: 'c2' }] };
    expect(findCandidateById(state, 'c2')?.candidateId).toBe('c2');
  });

  it('returns null for unknown id', () => {
    const state = { candidates: [{ candidateId: 'c1' }] };
    expect(findCandidateById(state, 'c99')).toBeNull();
  });
});
