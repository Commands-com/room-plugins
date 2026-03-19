import { describe, it, expect } from 'vitest';
import {
  isConfidentMeasurement,
  sortCandidatesForFrontier,
  recomputeFrontier,
  evaluateImprovement,
  chooseStopReason,
  findCandidateById,
} from '../index.js';

describe('isConfidentMeasurement', () => {
  it('rejects when CV is too high', () => {
    const result = isConfidentMeasurement({
      result: { cvPct: 25 },
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

  it('accepts without plan change when speedup is very high (needs retest)', () => {
    const noRetest = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 500,
      planShapeChanged: false,
    });
    expect(noRetest.confident).toBe(false);
    expect(noRetest.needsRetest).toBe(true);

    const retested = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 500,
      planShapeChanged: false,
      retested: true,
    });
    expect(retested.confident).toBe(true);
  });

  it('rejects low speedup without plan change unless retested', () => {
    const result = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 10,
      planShapeChanged: false,
      retested: false,
    });
    expect(result.confident).toBe(false);

    const retested = isConfidentMeasurement({
      result: { cvPct: 5 },
      speedupPct: 10,
      planShapeChanged: false,
      retested: true,
    });
    expect(retested.confident).toBe(true);
    expect(retested.confidence).toBe('low');
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

  it('breaks ties by cvPct ascending', () => {
    const candidates = [
      { speedupPct: 90, result: { cvPct: 15 }, riskScore: 3 },
      { speedupPct: 90, result: { cvPct: 5 }, riskScore: 3 },
    ];
    const sorted = sortCandidatesForFrontier(candidates);
    expect(sorted[0].result.cvPct).toBe(5);
  });

  it('breaks ties by riskScore ascending', () => {
    const candidates = [
      { speedupPct: 90, result: { cvPct: 5 }, riskScore: 7 },
      { speedupPct: 90, result: { cvPct: 5 }, riskScore: 2 },
    ];
    const sorted = sortCandidatesForFrontier(candidates);
    expect(sorted[0].riskScore).toBe(2);
  });
});

describe('recomputeFrontier', () => {
  it('selects one best per strategy type', () => {
    const state = {
      candidates: [
        { candidateId: 'c1', strategyType: 'index', speedupPct: 90, result: { medianMs: 10, cvPct: 5 }, riskScore: 3, resultParity: true, parityChecked: true, planShapeChanged: true, retested: true, status: 'benchmarked', approved: true },
        { candidateId: 'c2', strategyType: 'index', speedupPct: 50, result: { medianMs: 50, cvPct: 5 }, riskScore: 3, resultParity: true, parityChecked: true, planShapeChanged: true, retested: true, status: 'benchmarked', approved: true },
        { candidateId: 'c3', strategyType: 'rewrite', speedupPct: 70, result: { medianMs: 30, cvPct: 5 }, riskScore: 2, resultParity: true, parityChecked: true, planShapeChanged: true, retested: true, status: 'benchmarked', approved: true },
      ],
      frontierIds: [],
      bestByStrategyType: {},
    };
    recomputeFrontier(state, { maxRiskScore: 7 });
    expect(state.frontierIds).toHaveLength(2);
    expect(state.bestByStrategyType.index).toBe('c1');
    expect(state.bestByStrategyType.rewrite).toBe('c3');
  });

  it('excludes rejected candidates', () => {
    const state = {
      candidates: [
        { candidateId: 'c1', strategyType: 'index', speedupPct: 90, result: { medianMs: 10, cvPct: 5 }, riskScore: 3, resultParity: true, planShapeChanged: true, status: 'rejected', approved: true },
      ],
      frontierIds: [],
      bestByStrategyType: {},
    };
    recomputeFrontier(state, { maxRiskScore: 7 });
    expect(state.frontierIds).toHaveLength(0);
  });
});

describe('evaluateImprovement', () => {
  it('resets plateau on improvement', () => {
    const state = { frontierIds: ['c1'], candidates: [{ candidateId: 'c1', speedupPct: 50 }], bestImprovementPct: 30, plateauCount: 2 };
    evaluateImprovement(state);
    expect(state.plateauCount).toBe(0);
    expect(state.bestImprovementPct).toBe(50);
  });

  it('increments plateau when no improvement', () => {
    const state = { frontierIds: ['c1'], candidates: [{ candidateId: 'c1', speedupPct: 30 }], bestImprovementPct: 50, plateauCount: 0 };
    evaluateImprovement(state);
    expect(state.plateauCount).toBe(1);
  });
});

describe('chooseStopReason', () => {
  it('returns benchmark_unstable when baseline CV is high after retest', () => {
    const state = { baselines: { medianMs: 100, cvPct: 25, retested: true }, candidates: [], cycleIndex: 1, plateauCount: 0, bestImprovementPct: 0, frontierIds: [] };
    expect(chooseStopReason(state, {}, {})).toBe('benchmark_unstable');
  });

  it('returns cycle_limit when cycle exceeds max', () => {
    const state = { candidates: [], cycleIndex: 5, plateauCount: 0, bestImprovementPct: 50, frontierIds: ['c1'] };
    expect(chooseStopReason(state, {}, { maxCycles: 4 })).toBe('cycle_limit');
  });

  it('returns target_met when plateau + target exceeded + approved', () => {
    const state = { candidates: [{ candidateId: 'c1', status: 'frontier', speedupPct: 50, approved: true }], cycleIndex: 2, plateauCount: 2, bestImprovementPct: 50, frontierIds: ['c1'] };
    expect(chooseStopReason(state, { plateauCycles: 2, targetImprovementPct: 20 }, { maxCycles: 10 })).toBe('target_met');
  });

  it('returns plateau as catch-all', () => {
    const state = { candidates: [{ candidateId: 'c1', status: 'frontier', speedupPct: 10, approved: true }], cycleIndex: 2, plateauCount: 2, bestImprovementPct: 10, frontierIds: ['c1'] };
    expect(chooseStopReason(state, { plateauCycles: 2, targetImprovementPct: 20 }, { maxCycles: 10 })).toBe('plateau');
  });

  it('returns null when no stop condition met', () => {
    const state = { candidates: [], cycleIndex: 1, plateauCount: 0, bestImprovementPct: 0, frontierIds: [] };
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
