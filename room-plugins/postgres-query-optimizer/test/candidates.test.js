import { describe, it, expect } from 'vitest';
import { createPostgresEngine } from '../lib/engine.js';

const { determinePlanShapeChanged } = createPostgresEngine();

// Shared core tests (isConfidentMeasurement, sortCandidatesForFrontier,
// recomputeFrontier, evaluateImprovement, chooseStopReason, findCandidateById)
// live in sql-optimizer-core/test/candidates.test.js.

describe('determinePlanShapeChanged (Postgres)', () => {
  it('detects index plan shape change (Seq Scan → Index Scan)', () => {
    const changed = determinePlanShapeChanged({
      strategyType: 'index',
      baseline: { leafAccessNodes: ['Seq Scan'] },
      result: { leafAccessNodes: ['Index Scan'] },
    });
    expect(changed).toBe(true);
  });

  it('no change when same leaf nodes', () => {
    const changed = determinePlanShapeChanged({
      strategyType: 'index',
      baseline: { leafAccessNodes: ['Index Scan'] },
      result: { leafAccessNodes: ['Index Scan'] },
    });
    expect(changed).toBe(false);
  });

  it('detects rewrite plan change via hash', () => {
    const changed = determinePlanShapeChanged({
      strategyType: 'rewrite',
      baseline: { planStructureHash: 'abc', planNodeSet: ['Sort', 'Seq Scan'] },
      result: { planStructureHash: 'def', planNodeSet: ['Hash Join', 'Index Scan'] },
    });
    expect(changed).toBe(true);
  });

  it('falls back to planNodeSet for rewrite when no hash', () => {
    const changed = determinePlanShapeChanged({
      strategyType: 'rewrite',
      baseline: { planNodeSet: ['Sort', 'Seq Scan'] },
      result: { planNodeSet: ['Sort', 'Seq Scan'] },
    });
    expect(changed).toBe(false);
  });

  it('returns false when both baseline and result are empty', () => {
    expect(determinePlanShapeChanged({ strategyType: 'index', baseline: {}, result: {} })).toBe(false);
    expect(determinePlanShapeChanged({ strategyType: 'rewrite', baseline: {}, result: {} })).toBe(false);
  });

  it('returns false for missing baseline or result', () => {
    expect(determinePlanShapeChanged({ strategyType: 'index', baseline: null, result: {} })).toBe(false);
    expect(determinePlanShapeChanged({ strategyType: 'index', baseline: {}, result: null })).toBe(false);
  });
});
