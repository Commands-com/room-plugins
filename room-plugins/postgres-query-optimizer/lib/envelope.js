import { STRATEGY_TYPES } from './constants.js';
import { clampInt, optionalFiniteNumber, normalizeStringArray, safeTrim } from './utils.js';

// ---------------------------------------------------------------------------
// JSON extraction (same approach as FFT autotune)
// ---------------------------------------------------------------------------

const MAX_EXTRACT_LEN = 512 * 1024;

function extractJson(text) {
  const raw = typeof text === 'string' ? text.trim().slice(0, MAX_EXTRACT_LEN) : '';
  if (!raw) return null;

  const candidates = [];

  const fencedMatches = raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/ig);
  for (const match of fencedMatches) {
    if (match?.[1]) candidates.push(match[1].trim());
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = raw.indexOf('[');
  const lastBracket = raw.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(raw.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Candidate proposal normalisation (explorer output)
// ---------------------------------------------------------------------------

function normalizeCandidateProposal(proposal, config, workerId) {
  return {
    proposalId:
      safeTrim(proposal?.proposalId || proposal?.id, 120) ||
      `proposal-${Date.now()}`,
    strategyType: STRATEGY_TYPES.includes(safeTrim(proposal?.strategyType, 20))
      ? safeTrim(proposal?.strategyType, 20)
      : 'index',
    applySQL:
      safeTrim(proposal?.applySQL || proposal?.sql || proposal?.applySql, 8000),
    rollbackSQL:
      safeTrim(proposal?.rollbackSQL || proposal?.rollbackSql, 8000),
    deploySQL:
      safeTrim(proposal?.deploySQL || proposal?.deploySql, 8000),
    targetQuery:
      safeTrim(proposal?.targetQuery || proposal?.rewrittenQuery, 50000) || null,
    notes:
      safeTrim(proposal?.notes || proposal?.reason, 2000),
    expectedImpact:
      safeTrim(proposal?.expectedImpact, 40) || 'unknown',
    proposedByWorkerId: workerId,
  };
}

// ---------------------------------------------------------------------------
// Builder result normalisation (benchmark measurements)
// ---------------------------------------------------------------------------

function normalizeBuilderResult(result, config, workerId) {
  return {
    proposalId: safeTrim(result?.proposalId || result?.id, 120),
    isBaseline: Boolean(result?.isBaseline),

    baseline: {
      medianMs: optionalFiniteNumber(result?.baseline?.medianMs),
      p95Ms: optionalFiniteNumber(result?.baseline?.p95Ms),
      cvPct: optionalFiniteNumber(result?.baseline?.cvPct),
      leafAccessNodes: normalizeStringArray(
        result?.baseline?.leafAccessNodes,
        20,
      ),
      planNodeSet: normalizeStringArray(result?.baseline?.planNodeSet, 40),
      planStructureHash: safeTrim(
        result?.baseline?.planStructureHash,
        120,
      ),
      sharedHitBlocks: optionalFiniteNumber(
        result?.baseline?.sharedHitBlocks,
      ),
      sharedReadBlocks: optionalFiniteNumber(
        result?.baseline?.sharedReadBlocks,
      ),
    },

    candidate: {
      medianMs: optionalFiniteNumber(
        result?.candidate?.medianMs ?? result?.medianMs,
      ),
      p95Ms: optionalFiniteNumber(
        result?.candidate?.p95Ms ?? result?.p95Ms,
      ),
      cvPct: optionalFiniteNumber(
        result?.candidate?.cvPct ?? result?.cvPct,
      ),
      leafAccessNodes: normalizeStringArray(
        result?.candidate?.leafAccessNodes ?? result?.leafAccessNodes,
        20,
      ),
      planNodeSet: normalizeStringArray(
        result?.candidate?.planNodeSet ?? result?.planNodeSet,
        40,
      ),
      planStructureHash: safeTrim(
        result?.candidate?.planStructureHash ?? result?.planStructureHash,
        120,
      ),
      sharedHitBlocks: optionalFiniteNumber(
        result?.candidate?.sharedHitBlocks,
      ),
      sharedReadBlocks: optionalFiniteNumber(
        result?.candidate?.sharedReadBlocks,
      ),
    },

    resultParity: result?.parityChecked ? result?.resultParity === true : undefined,
    parityChecked: Boolean(result?.parityChecked),
    speedupPct: optionalFiniteNumber(result?.speedupPct),
    indexSizeBytes: optionalFiniteNumber(result?.indexSizeBytes),
    applySQL: safeTrim(result?.applySQL || result?.applySql, 8000),
    rollbackSQL: safeTrim(result?.rollbackSQL || result?.rollbackSql, 8000),
    explainJSON: result?.explainJSON || result?.explainJson || null,
    notes: safeTrim(result?.notes, 2000),
    implementedByWorkerId: workerId,
  };
}

// ---------------------------------------------------------------------------
// Audit entry normalisation (auditor output)
// ---------------------------------------------------------------------------

function normalizeAuditEntry(audit) {
  return {
    proposalId: safeTrim(audit?.proposalId || audit?.id, 120),
    riskScore: clampInt(audit?.riskScore, 0, 10, 5),
    findings: Array.isArray(audit?.findings)
      ? audit.findings.slice(0, 10).map((f) => ({
          severity: safeTrim(f?.severity, 20) || 'medium',
          category: safeTrim(f?.category, 40),
          confidence: safeTrim(f?.confidence, 20) || 'heuristic',
          detail: safeTrim(f?.detail, 1000),
          recommendation: safeTrim(f?.recommendation, 1000),
        }))
      : [],
    telemetryAvailable: Boolean(audit?.telemetryAvailable),
    approved: audit?.approved !== false,
    deployNotes: safeTrim(audit?.deployNotes, 2000),
  };
}

// ---------------------------------------------------------------------------
// Main envelope parser
// ---------------------------------------------------------------------------

export function parseWorkerEnvelope(responseText, worker, config) {
  const parsed = extractJson(responseText);
  const envelope =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};

  const candidateSource = Array.isArray(envelope.candidateProposals)
    ? envelope.candidateProposals
    : Array.isArray(envelope.proposals)
      ? envelope.proposals
      : [];

  const resultsSource = Array.isArray(envelope.results)
    ? envelope.results
    : Array.isArray(envelope.candidates)
      ? envelope.candidates
      : [];

  const auditsSource = Array.isArray(envelope.audits)
    ? envelope.audits
    : Array.isArray(envelope.findings)
      ? envelope.findings
      : [];

  return {
    summary: safeTrim(envelope.summary || responseText, 2000),
    candidateProposals: candidateSource.map((p) =>
      normalizeCandidateProposal(p, config, worker.agentId),
    ),
    results: resultsSource.map((r) =>
      normalizeBuilderResult(r, config, worker.agentId),
    ),
    audits: auditsSource.map((a) => normalizeAuditEntry(a)),
  };
}

// ---------------------------------------------------------------------------
// Lane assignment
// ---------------------------------------------------------------------------

export function assignLanes(participants) {
  const lanesByAgentId = {};
  const workersByLane = {};

  for (const participant of participants) {
    const lane = participant?.role;
    if (!lane) continue;
    lanesByAgentId[participant.agentId] = lane;
    if (!workersByLane[lane]) workersByLane[lane] = [];
    workersByLane[lane].push(participant.agentId);
  }

  return { lanesByAgentId, workersByLane };
}
