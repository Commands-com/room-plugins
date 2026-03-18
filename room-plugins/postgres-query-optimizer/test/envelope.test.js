import { describe, it, expect } from 'vitest';
import { parseWorkerEnvelope, assignLanes } from '../../sql-optimizer-core/index.js';

const MOCK_CONFIG = {
  plannedCandidatesPerCycle: 4,
  promoteTopK: 2,
  maxRiskScore: 7,
};

const MOCK_WORKER = { agentId: 'agent-1', assignedLane: 'builder' };

describe('extractJson via parseWorkerEnvelope', () => {
  it('extracts JSON from fenced code block', () => {
    const text = 'Here are the results:\n```json\n{"summary":"ok","results":[]}\n```';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.summary).toBe('ok');
  });

  it('extracts JSON from bare braces', () => {
    const text = 'some prose {"summary":"bare","results":[]} more prose';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.summary).toBe('bare');
  });

  it('returns raw text as summary when no JSON found', () => {
    const text = 'No JSON here at all';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.summary).toBe('No JSON here at all');
    expect(result.candidateProposals).toEqual([]);
    expect(result.results).toEqual([]);
    expect(result.audits).toEqual([]);
  });

  it('handles malformed JSON gracefully', () => {
    const text = '```json\n{"summary": "broken",\n```';
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.candidateProposals).toEqual([]);
  });
});

describe('normalizeCandidateProposal', () => {
  it('normalizes an explorer proposal', () => {
    const text = JSON.stringify({
      summary: 'Found optimization',
      candidateProposals: [{
        proposalId: 'idx_test',
        strategyType: 'index',
        applySQL: 'CREATE INDEX idx_test ON orders(user_id);',
        rollbackSQL: 'DROP INDEX IF EXISTS idx_test;',
        notes: 'covers WHERE clause',
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.candidateProposals).toHaveLength(1);
    expect(result.candidateProposals[0].proposalId).toBe('idx_test');
    expect(result.candidateProposals[0].strategyType).toBe('index');
    expect(result.candidateProposals[0].applySQL).toContain('CREATE INDEX');
  });

  it('defaults strategyType to index when invalid', () => {
    const text = JSON.stringify({
      candidateProposals: [{ proposalId: 'x', strategyType: 'bogus' }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.candidateProposals[0].strategyType).toBe('index');
  });

  it('accepts "proposals" as alternate key', () => {
    const text = JSON.stringify({
      proposals: [{ proposalId: 'alt', strategyType: 'rewrite', targetQuery: 'SELECT 1' }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.candidateProposals).toHaveLength(1);
    expect(result.candidateProposals[0].strategyType).toBe('rewrite');
  });
});

describe('normalizeBuilderResult', () => {
  it('normalizes builder baseline result', () => {
    const text = JSON.stringify({
      results: [{
        isBaseline: true,
        baseline: {
          medianMs: 847.3,
          p95Ms: 1200,
          leafAccessNodes: ['Seq Scan'],
          planNodeSet: ['Sort', 'Seq Scan'],
          planStructureHash: 'abc123',
        },
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].isBaseline).toBe(true);
    expect(result.results[0].baseline.medianMs).toBe(847.3);
  });

  it('normalizes candidate benchmark result', () => {
    const text = JSON.stringify({
      results: [{
        proposalId: 'idx_test',
        candidate: { medianMs: 12.4, p95Ms: 18.7, cvPct: 8.2 },
        speedupPct: 98.5,
        indexSizeBytes: 8388608,
        resultParity: true,
      }],
    });
    const result = parseWorkerEnvelope(text, MOCK_WORKER, MOCK_CONFIG);
    expect(result.results[0].candidate.medianMs).toBe(12.4);
    expect(result.results[0].speedupPct).toBe(98.5);
    expect(result.results[0].indexSizeBytes).toBe(8388608);
  });
});

describe('normalizeAuditEntry', () => {
  it('normalizes audit findings', () => {
    const text = JSON.stringify({
      audits: [{
        proposalId: 'idx_test',
        riskScore: 3,
        findings: [{
          severity: 'medium',
          category: 'write_amplification',
          detail: 'Frequent inserts on orders table',
        }],
        approved: true,
        deployNotes: 'Use CONCURRENTLY',
      }],
    });
    const worker = { agentId: 'auditor-1', assignedLane: 'auditor' };
    const result = parseWorkerEnvelope(text, worker, MOCK_CONFIG);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0].riskScore).toBe(3);
    expect(result.audits[0].findings).toHaveLength(1);
    expect(result.audits[0].approved).toBe(true);
  });

  it('defaults riskScore to 5 when missing', () => {
    const text = JSON.stringify({ audits: [{ proposalId: 'x' }] });
    const worker = { agentId: 'auditor-1', assignedLane: 'auditor' };
    const result = parseWorkerEnvelope(text, worker, MOCK_CONFIG);
    expect(result.audits[0].riskScore).toBe(5);
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
    expect(workersByLane.builder).toContain('a2');
    expect(workersByLane.auditor).toContain('a3');
  });
});
