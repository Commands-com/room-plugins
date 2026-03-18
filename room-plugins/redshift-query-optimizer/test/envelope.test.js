import { describe, it, expect } from 'vitest';
import { parseWorkerEnvelope, assignLanes } from '../../sql-optimizer-core/index.js';
import { createRedshiftEngine } from '../lib/engine.js';

const engine = createRedshiftEngine();

const MOCK_CONFIG = {
  plannedCandidatesPerCycle: 4,
  promoteTopK: 2,
  maxRiskScore: 7,
};

const MOCK_WORKER = { agentId: 'agent-1', assignedLane: 'builder' };

describe('extractJson via parseWorkerEnvelope', () => {
  it('extracts JSON from fenced code block', () => {
    const text = 'Here are the results:\n```json\n{"summary":"ok","results":[]}\n```';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.summary).toBe('ok');
  });

  it('extracts JSON from bare braces', () => {
    const text = 'some prose {"summary":"bare","results":[]} more prose';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.summary).toBe('bare');
  });

  it('returns raw text as summary when no JSON found', () => {
    const text = 'No JSON here at all';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.summary).toBe('No JSON here at all');
    expect(result.candidateProposals).toEqual([]);
    expect(result.results).toEqual([]);
    expect(result.audits).toEqual([]);
  });
});

describe('normalizeCandidateProposal (Redshift)', () => {
  it('normalizes a rewrite proposal', () => {
    const text = JSON.stringify({
      summary: 'Found optimization',
      candidateProposals: [{
        proposalId: 'rewrite_join',
        strategyType: 'rewrite',
        targetQuery: 'SELECT 1',
        notes: 'reordered joins',
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.candidateProposals).toHaveLength(1);
    expect(result.candidateProposals[0].strategyType).toBe('rewrite');
  });

  it('normalizes a sort_dist proposal', () => {
    const text = JSON.stringify({
      candidateProposals: [{
        proposalId: 'distkey_orders',
        strategyType: 'sort_dist',
        applySQL: 'ALTER TABLE orders ALTER DISTKEY user_id;',
        notes: 'co-locates with users table',
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.candidateProposals).toHaveLength(1);
    expect(result.candidateProposals[0].strategyType).toBe('sort_dist');
  });

  it('defaults invalid strategyType to rewrite', () => {
    const text = JSON.stringify({
      candidateProposals: [{ proposalId: 'x', strategyType: 'bogus' }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.candidateProposals[0].strategyType).toBe('rewrite');
  });
});

describe('normalizeBuilderResult (Redshift)', () => {
  it('normalizes baseline result with Redshift fields', () => {
    const text = JSON.stringify({
      results: [{
        isBaseline: true,
        baseline: {
          medianMs: 3200,
          p95Ms: 4100,
          cvPct: 12,
          stepTypes: ['XN Seq Scan', 'XN Hash Join'],
          distSteps: ['DS_BCAST_INNER'],
          totalCost: 45000,
          bytesScanned: 1073741824,
          planText: 'XN Hash Join...',
        },
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].isBaseline).toBe(true);
    expect(result.results[0].baseline.medianMs).toBe(3200);
    expect(result.results[0].baseline.stepTypes).toContain('XN Seq Scan');
    expect(result.results[0].baseline.distSteps).toContain('DS_BCAST_INNER');
    expect(result.results[0].baseline.bytesScanned).toBe(1073741824);
  });

  it('normalizes candidate benchmark result', () => {
    const text = JSON.stringify({
      results: [{
        proposalId: 'rewrite_join',
        candidate: {
          medianMs: 800,
          p95Ms: 1100,
          cvPct: 8,
          stepTypes: ['XN Seq Scan', 'XN Merge Join'],
          distSteps: ['DS_DIST_NONE'],
        },
        speedupPct: 75,
        resultParity: true,
        parityChecked: true,
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG, engine);
    expect(result.results[0].candidate.medianMs).toBe(800);
    expect(result.results[0].speedupPct).toBe(75);
    expect(result.results[0].candidate.distSteps).toContain('DS_DIST_NONE');
  });
});

describe('normalizeAuditEntry', () => {
  it('normalizes Redshift audit findings', () => {
    const text = JSON.stringify({
      audits: [{
        proposalId: 'rewrite_join',
        riskScore: 4,
        findings: [{
          severity: 'medium',
          category: 'redistribute_cost',
          detail: 'Adds DS_DIST_INNER step on large table',
        }],
        approved: true,
        deployNotes: 'Safe during off-peak',
      }],
    });
    const worker = { agentId: 'auditor-1', assignedLane: 'auditor' };
    const result = parseWorkerEnvelope(text, worker, MOCK_CONFIG, engine);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0].riskScore).toBe(4);
    expect(result.audits[0].findings[0].category).toBe('redistribute_cost');
  });
});

describe('assignLanes', () => {
  it('assigns lanes by role', () => {
    const participants = [
      { agentId: 'a1', role: 'explorer' },
      { agentId: 'a2', role: 'builder' },
      { agentId: 'a3', role: 'auditor' },
    ];
    const { lanesByAgentId, workersByLane } = assignLanes(participants);
    expect(lanesByAgentId['a1']).toBe('explorer');
    expect(lanesByAgentId['a2']).toBe('builder');
    expect(lanesByAgentId['a3']).toBe('auditor');
    expect(workersByLane.explorer).toContain('a1');
  });
});
