import { clampInt, optionalFiniteNumber, normalizeStringArray, safeTrim } from './utils.js';

// ---------------------------------------------------------------------------
// JSON extraction (engine-agnostic)
// ---------------------------------------------------------------------------

const MAX_EXTRACT_LEN = 512 * 1024;

export function extractJson(text) {
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

  // Truncated JSON repair: LLM output may have been cut off mid-response.
  // Try to salvage by closing open strings, arrays, and objects.
  if (firstBrace >= 0) {
    const truncated = raw.slice(firstBrace);
    const repaired = repairTruncatedJson(truncated);
    if (repaired) {
      try { return JSON.parse(repaired); } catch {}
    }
  }

  return null;
}

/**
 * Attempt to close a truncated JSON string so it becomes parseable.
 * Walks the string tracking nesting depth and open string state,
 * then appends the necessary closing tokens.
 */
function repairTruncatedJson(text) {
  if (!text || text.length < 2) return null;

  let inString = false;
  let escaped = false;
  const stack = []; // tracks '{' and '['

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  // Nothing to close — either already valid or not JSON
  if (stack.length === 0) return null;

  // Trim trailing partial tokens: incomplete key/value after last comma or colon
  let trimmed = text;

  // If we're inside a string, close it
  if (inString) {
    trimmed += '"';
  }

  // Remove trailing partial key-value (e.g. `"key": "truncated value"` after last complete pair)
  // Find the last complete value boundary before the truncation
  const lastCompleteComma = trimmed.lastIndexOf(',');
  const lastCompleteBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  const lastColon = trimmed.lastIndexOf(':');

  // If the last colon is after the last comma/brace, we have an incomplete key-value pair
  // Trim back to the last comma and remove it, or to the last opening brace
  if (lastColon > Math.max(lastCompleteComma, lastCompleteBrace)) {
    // We're in an incomplete "key": value — try to keep what we have
    // The string close above should help, but we may have a partial number/bool
    // Just try closing as-is first
  }

  // Close all open brackets/braces in reverse order
  const suffix = stack.reverse().join('');
  return trimmed + suffix;
}

// ---------------------------------------------------------------------------
// Candidate proposal normalisation
// ---------------------------------------------------------------------------

function normalizeCandidateProposal(proposal, config, workerId, engine) {
  const strategyTypes = engine?.strategyTypes || ['index', 'rewrite'];
  const defaultStrategy = engine?.defaultStrategyType || strategyTypes[0] || 'index';

  return {
    proposalId:
      safeTrim(proposal?.proposalId || proposal?.id, 120) ||
      `proposal-${Date.now()}`,
    strategyType: strategyTypes.includes(safeTrim(proposal?.strategyType, 20))
      ? safeTrim(proposal?.strategyType, 20)
      : defaultStrategy,
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
// Builder result normalisation — common timing fields
// Engine can extend via engine.extendBuilderResult(normalized, raw)
// ---------------------------------------------------------------------------

function normalizeBuilderResult(result, config, workerId, engine) {
  const normalized = {
    proposalId: safeTrim(result?.proposalId || result?.id, 120),
    isBaseline: Boolean(result?.isBaseline),

    baseline: {
      medianMs: optionalFiniteNumber(result?.baseline?.medianMs),
      p95Ms: optionalFiniteNumber(result?.baseline?.p95Ms),
      cvPct: optionalFiniteNumber(result?.baseline?.cvPct),
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
    },

    resultParity: result?.parityChecked ? result?.resultParity === true : undefined,
    parityChecked: Boolean(result?.parityChecked),
    speedupPct: optionalFiniteNumber(result?.speedupPct),
    indexSizeBytes: optionalFiniteNumber(result?.indexSizeBytes),
    applySQL: safeTrim(result?.applySQL || result?.applySql, 8000),
    rollbackSQL: safeTrim(result?.rollbackSQL || result?.rollbackSql, 8000),
    deploySQL: safeTrim(result?.deploySQL || result?.deploySql, 8000),
    explainJSON: result?.explainJSON || result?.explainJson || null,
    notes: safeTrim(result?.notes, 2000),
    implementedByWorkerId: workerId,
  };

  // Let engine add engine-specific fields (e.g., leafAccessNodes, planNodeSet)
  if (engine?.extendBuilderResult) {
    return engine.extendBuilderResult(normalized, result);
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Audit entry normalisation (engine-agnostic)
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

/**
 * @param {string} responseText
 * @param {object} worker — { agentId, assignedLane }
 * @param {object} config
 * @param {object} [engine] — { strategyTypes, defaultStrategyType, extendBuilderResult }
 */
export function parseWorkerEnvelope(responseText, worker, config, engine) {
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
      normalizeCandidateProposal(p, config, worker.agentId, engine),
    ),
    results: resultsSource.map((r) =>
      normalizeBuilderResult(r, config, worker.agentId, engine),
    ),
    audits: auditsSource.map((a) => normalizeAuditEntry(a)),
  };
}

// ---------------------------------------------------------------------------
// Lane assignment (engine-agnostic)
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
