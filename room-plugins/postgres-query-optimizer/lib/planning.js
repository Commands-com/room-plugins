import { PHASES, STRATEGY_TYPES, DEFAULTS } from './constants.js';
import { findCandidateById, sortCandidatesForFrontier } from './candidates.js';
import { safeTrim } from './utils.js';

// ---------------------------------------------------------------------------
// Proposal management
// ---------------------------------------------------------------------------

export function enqueueProposals(state, proposals, config) {
  if (!Array.isArray(proposals) || proposals.length === 0) return;

  const existingIds = new Set([
    ...state.proposalBacklog.map((p) => p.proposalId),
    ...state.activePromotedProposals.map((p) => p.proposalId),
    ...state.candidates.map((c) => c.proposalId),
  ]);

  for (const proposal of proposals) {
    if (!proposal.proposalId || existingIds.has(proposal.proposalId)) continue;
    if (!proposal.applySQL && proposal.strategyType !== 'rewrite') continue;
    if (proposal.strategyType === 'rewrite' && !proposal.targetQuery && !proposal.applySQL) continue;
    existingIds.add(proposal.proposalId);
    state.proposalBacklog.push(proposal);
  }
}

export function selectActivePromotedProposals(state, config) {
  const topK = config.promoteTopK || DEFAULTS.promoteTopK;
  state.activePromotedProposals = state.proposalBacklog.splice(0, topK);
}

// ---------------------------------------------------------------------------
// Data warning section builder
// ---------------------------------------------------------------------------

function buildDataWarningsSection(state) {
  const warnings = state.dataWarnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  const lines = ['## ⚠ Data Quality Warnings'];
  lines.push('The harness data was populated via Tier 3 synthetic generation. Keep these caveats in mind:');
  for (const w of warnings) {
    lines.push(`- ${w}`);
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------------------
// Mutation hint generation (for cycle 2+)
// ---------------------------------------------------------------------------

function buildMutationHints(state, config) {
  const hints = [];

  // Winner refinement hints
  for (const candidateId of state.frontierIds) {
    const winner = findCandidateById(state, candidateId);
    if (!winner) continue;
    if (winner.strategyType === 'index') {
      hints.push(
        `WINNER REFINEMENT: "${winner.proposalId}" gave ${winner.speedupPct?.toFixed(1)}% speedup. ` +
        `Try variations: add INCLUDE columns for covering index, try partial index with WHERE clause, ` +
        `or try different column ordering.`,
      );
    }
    if (winner.strategyType === 'rewrite') {
      hints.push(
        `WINNER REFINEMENT: "${winner.proposalId}" gave ${winner.speedupPct?.toFixed(1)}% speedup. ` +
        `Try further optimizations: eliminate remaining subqueries, adjust join order, ` +
        `or try lateral join pattern.`,
      );
    }
  }

  // Failure recovery hints
  const rejected = state.candidates.filter((c) => c.status === 'rejected');
  for (const candidate of rejected.slice(-3)) {
    if (candidate.rejectedReason) {
      hints.push(
        `FAILURE RECOVERY: "${candidate.proposalId}" was rejected: ${candidate.rejectedReason}. ` +
        `Try a different approach to solve the same problem.`,
      );
    }
    if (candidate.strategyType === 'rewrite' && !candidate.resultParity) {
      hints.push(
        `PARITY FAILURE: "${candidate.proposalId}" failed result parity check. ` +
        `Check NULL handling in LEFT JOINs, verify COALESCE usage, or try a different rewrite strategy.`,
      );
    }
  }

  // Bucket coverage hints
  const hasIndex = state.candidates.some((c) => c.strategyType === 'index' && c.status !== 'rejected');
  const hasRewrite = state.candidates.some((c) => c.strategyType === 'rewrite' && c.status !== 'rejected');
  if (!hasRewrite && hasIndex) {
    hints.push(
      `UNEXPLORED: No rewrite candidates tested yet. Try JOIN restructuring, subquery elimination, ` +
      `CTE refactoring, or window function optimization.`,
    );
  }
  if (!hasIndex && hasRewrite) {
    hints.push(
      `UNEXPLORED: No index candidates tested yet. Analyze the query plan for Seq Scans and ` +
      `propose targeted indexes.`,
    );
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Recent failure diagnostics
// ---------------------------------------------------------------------------

function buildRecentFailureDiagnostics(state) {
  return state.candidates
    .filter((c) => c.status === 'rejected')
    .sort((a, b) => (b.cycleIndex || 0) - (a.cycleIndex || 0))
    .slice(0, 5)
    .map((c) => ({
      proposalId: c.proposalId,
      strategyType: c.strategyType,
      rejectedReason: c.rejectedReason || 'unknown',
      speedupPct: c.speedupPct,
      notes: c.notes,
    }));
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildBaselineTargets(ctx, state, config) {
  const connectionString = state.harnessState?.connectionString || 'postgres://harness:harness@localhost:5432/harness';
  const slowQuery = config.demoMode
    ? state.demoQuery || config.slowQuery
    : config.slowQuery;
  const warmupRuns = config.warmupRuns || DEFAULTS.warmupRuns;
  const benchmarkTrials = config.benchmarkTrials || DEFAULTS.benchmarkTrials;

  const dataWarningsSection = buildDataWarningsSection(state);

  return ctx.participants.filter((p) => p.role === 'builder').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Builder (Query Architect) in a Postgres Query Optimization room.`,
      `Your task is to establish the performance baseline for the target query.`,
      '',
      `## Connection`,
      `\`\`\``,
      connectionString,
      `\`\`\``,
      '',
      `## Target Query`,
      `\`\`\`sql`,
      slowQuery,
      `\`\`\``,
      '',
      ...dataWarningsSection,
      `## Protocol`,
      `1. Connect to the database using the connection string above.`,
      `2. Run the target query ${warmupRuns} time(s) as warmup (discard results).`,
      `3. Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the target query ${benchmarkTrials} time(s).`,
      `4. Extract execution time from each trial. Compute median, p95, and CV%.`,
      `5. From the EXPLAIN JSON output, extract:`,
      `   - leafAccessNodes: leaf-level access nodes (Seq Scan, Index Scan, etc.)`,
      `   - planNodeSet: set of all node types in the plan tree`,
      `   - planStructureHash: a hash of the plan tree structure`,
      `   - Shared Hit Blocks and Shared Read Blocks`,
      '',
      `## Output Format`,
      `Reply with JSON only:`,
      `\`\`\`json`,
      `{`,
      `  "summary": "Baseline measurement results",`,
      `  "results": [{`,
      `    "isBaseline": true,`,
      `    "baseline": {`,
      `      "medianMs": <number>,`,
      `      "p95Ms": <number>,`,
      `      "cvPct": <number>,`,
      `      "leafAccessNodes": ["Seq Scan", ...],`,
      `      "planNodeSet": ["Sort", "Seq Scan", ...],`,
      `      "planStructureHash": "<string>",`,
      `      "sharedHitBlocks": <number>,`,
      `      "sharedReadBlocks": <number>`,
      `    }`,
      `  }]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

export function buildDiscoveryTargets(ctx, state, config) {
  const slowQuery = config.demoMode
    ? state.demoQuery || config.slowQuery
    : config.slowQuery;
  const schemaFilter = config.schemaFilter.length > 0
    ? `Focus on tables: ${config.schemaFilter.join(', ')}`
    : 'Analyze all tables referenced by the query.';

  const baselineInfo = state.baselines?.medianMs
    ? `Current baseline: ${state.baselines.medianMs.toFixed(1)}ms median, plan: ${(state.baselines.leafAccessNodes || []).join(', ') || 'unknown'}`
    : 'No baseline established yet.';

  const connectionString = state.harnessState?.connectionString || '';

  // Cycle feedback for cycle 2+
  const cycleContext = [];
  if (state.cycleIndex > 1) {
    const mutationHints = buildMutationHints(state, config);
    if (mutationHints.length > 0) {
      cycleContext.push('## Mutation Hints (from prior cycles)');
      for (const hint of mutationHints) {
        cycleContext.push(`- ${hint}`);
      }
    }

    const recentFailures = buildRecentFailureDiagnostics(state);
    if (recentFailures.length > 0) {
      cycleContext.push('');
      cycleContext.push('## Recent Failures');
      for (const failure of recentFailures) {
        cycleContext.push(`- ${failure.proposalId} (${failure.strategyType}): ${failure.rejectedReason}`);
      }
    }

    const frontierSummary = state.frontierIds
      .map((id) => findCandidateById(state, id))
      .filter(Boolean)
      .map((c) => `  - ${c.proposalId} (${c.strategyType}): ${c.speedupPct?.toFixed(1)}% speedup`);
    if (frontierSummary.length > 0) {
      cycleContext.push('');
      cycleContext.push('## Current Frontier Winners');
      cycleContext.push(...frontierSummary);
    }
  }

  const dataWarningsSection = buildDataWarningsSection(state);

  return ctx.participants.filter((p) => p.role === 'explorer').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Explorer (Schema Analyst) in a Postgres Query Optimization room.`,
      `Cycle ${state.cycleIndex} of ${ctx.limits?.maxCycles || 4}.`,
      '',
      `## Connection (for schema inspection)`,
      `\`\`\``,
      connectionString,
      `\`\`\``,
      '',
      `## Target Query`,
      `\`\`\`sql`,
      slowQuery,
      `\`\`\``,
      '',
      `## Baseline`,
      baselineInfo,
      '',
      ...dataWarningsSection,
      `## Instructions`,
      `${schemaFilter}`,
      `1. Connect and examine the schema: \\d, \\di, pg_stat_user_tables, etc.`,
      `2. Run EXPLAIN (FORMAT JSON) on the target query to understand the plan.`,
      `3. Identify bottlenecks: Seq Scans, Hash Joins on large tables, Sort on unindexed columns.`,
      `4. Propose 2-4 optimization strategies. For each, provide:`,
      `   - proposalId: a short identifier (e.g., "idx_orders_user_created")`,
      `   - strategyType: "index" or "rewrite"`,
      `   - applySQL: the SQL to apply in the harness (e.g., CREATE INDEX ...)`,
      `   - rollbackSQL: the SQL to undo the change (e.g., DROP INDEX IF EXISTS ...)`,
      `   - deploySQL: the production-safe version (e.g., CREATE INDEX CONCURRENTLY ...)`,
      `   - targetQuery: for rewrites only, the rewritten SQL`,
      `   - notes: rationale`,
      '',
      ...(cycleContext.length > 0 ? cycleContext : []),
      '',
      `## Output Format`,
      `Reply with JSON only:`,
      `\`\`\`json`,
      `{`,
      `  "summary": "Analysis of query bottleneck...",`,
      `  "candidateProposals": [`,
      `    {`,
      `      "proposalId": "idx_orders_user_created",`,
      `      "strategyType": "index",`,
      `      "applySQL": "CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);",`,
      `      "rollbackSQL": "DROP INDEX IF EXISTS idx_orders_user_created;",`,
      `      "deploySQL": "CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders(user_id, created_at);",`,
      `      "targetQuery": null,`,
      `      "notes": "Covers the WHERE + ORDER BY pattern",`,
      `      "expectedImpact": "high"`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

export function buildCycleTargets(ctx, state, config) {
  const connectionString = state.harnessState?.connectionString || 'postgres://harness:harness@localhost:5432/harness';
  const slowQuery = config.demoMode
    ? state.demoQuery || config.slowQuery
    : config.slowQuery;
  const promoted = state.activePromotedProposals || [];
  const warmupRuns = config.warmupRuns || DEFAULTS.warmupRuns;
  const benchmarkTrials = config.benchmarkTrials || DEFAULTS.benchmarkTrials;

  const baselineInfo = state.baselines?.medianMs
    ? `Baseline: ${state.baselines.medianMs.toFixed(1)}ms median`
    : 'No baseline available.';

  const proposalBlock = promoted.map((p, i) => [
    `### Proposal ${i + 1}: ${p.proposalId} (${p.strategyType})`,
    `Apply SQL: ${p.applySQL}`,
    `Rollback SQL: ${p.rollbackSQL || 'N/A'}`,
    p.strategyType === 'rewrite' ? `Rewritten Query: ${p.targetQuery || p.applySQL}` : '',
    `Notes: ${p.notes || 'none'}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  const dataWarningsSection = buildDataWarningsSection(state);

  return ctx.participants.filter((p) => p.role === 'builder').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Builder (Query Architect) in a Postgres Query Optimization room.`,
      `Your task is to implement and benchmark the following optimization proposals.`,
      '',
      `## Connection`,
      `\`\`\``,
      connectionString,
      `\`\`\``,
      '',
      `## Target Query`,
      `\`\`\`sql`,
      slowQuery,
      `\`\`\``,
      '',
      `## ${baselineInfo}`,
      '',
      ...dataWarningsSection,
      `## Proposals to Benchmark`,
      proposalBlock,
      '',
      `## Protocol (for EACH proposal)`,
      `1. Apply the change (applySQL).`,
      `2. Run ANALYZE on affected tables.`,
      `3. Run ${warmupRuns} warmup queries (discard results).`,
      `4. Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${benchmarkTrials} times on the target query`,
      `   (or on the rewritten query for rewrite strategies).`,
      `5. For REWRITE strategies ONLY: verify result parity:`,
      `   SELECT COUNT(*) FROM (`,
      `     (original_query EXCEPT ALL rewritten_query)`,
      `     UNION ALL`,
      `     (rewritten_query EXCEPT ALL original_query)`,
      `   ) AS parity_check;`,
      `   Both queries MUST be run in the SAME TRANSACTION to freeze transaction-stable functions like NOW().`,
      `   Result must be 0. If not, the rewrite is invalid.`,
      `6. Record: medianMs, p95Ms, cvPct, leafAccessNodes, planNodeSet, planStructureHash, buffer stats.`,
      `7. Execute rollbackSQL before the next proposal.`,
      `8. If the index strategy, also query: SELECT pg_relation_size('index_name') for indexSizeBytes.`,
      '',
      `## Output Format`,
      `Reply with JSON only:`,
      `\`\`\`json`,
      `{`,
      `  "summary": "Benchmark results for N proposals",`,
      `  "results": [`,
      `    {`,
      `      "proposalId": "...",`,
      `      "candidate": {`,
      `        "medianMs": <number>,`,
      `        "p95Ms": <number>,`,
      `        "cvPct": <number>,`,
      `        "leafAccessNodes": [...],`,
      `        "planNodeSet": [...],`,
      `        "planStructureHash": "..."`,
      `      },`,
      `      "resultParity": true,`,
      `      "parityChecked": true,`,
      `      "speedupPct": <number>,`,
      `      "indexSizeBytes": <number or null>,`,
      `      "applySQL": "...",`,
      `      "rollbackSQL": "...",`,
      `      "explainJSON": { ... }`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

export function buildAuditTargets(ctx, state, config) {
  const recentCandidates = state.candidates
    .filter((c) => c.cycleIndex === state.cycleIndex && c.status !== 'rejected')
    .slice(-10);

  const candidateSummary = recentCandidates.map((c) => [
    `- ${c.proposalId} (${c.strategyType}):`,
    `  speedup ${c.speedupPct?.toFixed(1) || '?'}%,`,
    `  ${c.applySQL?.slice(0, 200) || 'no SQL'}`,
    c.indexSizeBytes ? `  index size: ${(c.indexSizeBytes / (1024 * 1024)).toFixed(2)}MB` : '',
  ].filter(Boolean).join(' ')).join('\n');

  // Thread production telemetry data to auditor when available
  const telemetrySection = [];
  if (config.productionStats) {
    telemetrySection.push('## Production Telemetry (AVAILABLE)');
    telemetrySection.push('Production statistics are available for this database. Use this data to produce');
    telemetrySection.push('"verified" confidence findings rather than "heuristic" findings.');
    telemetrySection.push('Set `telemetryAvailable: true` and `confidence: "verified"` for findings backed by this data.');
    telemetrySection.push('');
    telemetrySection.push('```json');
    telemetrySection.push(typeof config.productionStats === 'string'
      ? config.productionStats
      : JSON.stringify(config.productionStats, null, 2));
    telemetrySection.push('```');
    telemetrySection.push('');
  }

  const dataWarningsSection = buildDataWarningsSection(state);

  return ctx.participants.filter((p) => p.role === 'auditor').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Auditor (DBA Auditor) in a Postgres Query Optimization room.`,
      `Your task is to review the following optimization candidates for operational risk.`,
      `You CANNOT reject candidates based on performance — that's the frontier ranking's job.`,
      `You answer: "if you deploy this, what could go wrong?"`,
      '',
      ...dataWarningsSection,
      `## Risk Score Guidelines`,
      `Score FUNCTIONAL risk — things that could break production or silently degrade over time:`,
      `- 1-3: Low — standard index, no unusual concerns`,
      `- 4-6: Moderate — expression index on a high-churn column, large storage, partial index with tricky predicate`,
      `- 7-8: High — rewrite changes semantics edge cases, index on a very hot write path, > 500MB storage`,
      `- 9-10: Critical — risk of data corruption, locking a high-QPS table for minutes, unrecoverable change`,
      '',
      `IMPORTANT: Standard deployment steps (use CONCURRENTLY, deploy outside a transaction, run ANALYZE after)`,
      `are NOT risk — they are procedure. Every index requires these steps. Do NOT inflate the risk score`,
      `for standard deployment procedure. Only score risk for things specific to THIS candidate that go`,
      `beyond normal index deployment practice.`,
      '',
      `## Risk Dimensions to Evaluate`,
      `1. Lock contention: only if the table has high write QPS AND the index build would be unusually slow`,
      `2. Storage overhead: index size vs table size ratio — flag if > 50% of table size`,
      `3. Write amplification: index on frequently-updated column (not just inserted)`,
      `4. Query plan instability: plan depends on statistics that shift with data growth`,
      `5. Migration complexity: only if the deploy requires non-standard steps beyond normal CONCURRENTLY`,
      '',
      ...telemetrySection,
      `## Candidates to Audit`,
      candidateSummary,
      '',
      `## Output Format`,
      `Reply with JSON only:`,
      `\`\`\`json`,
      `{`,
      `  "summary": "Audit of N candidates",`,
      `  "audits": [`,
      `    {`,
      `      "proposalId": "...",`,
      `      "riskScore": <0-10>,`,
      `      "findings": [`,
      `        {`,
      `          "severity": "high|medium|low",`,
      `          "category": "lock_contention|storage_overhead|write_amplification|plan_instability|migration_complexity",`,
      `          "confidence": "verified|heuristic",`,
      `          "detail": "...",`,
      `          "recommendation": "..."`,
      `        }`,
      `      ],`,
      `      "telemetryAvailable": ${config.productionStats ? 'true' : 'false'},`,
      `      "approved": true,`,
      `      "deployNotes": "Safe to apply with CREATE INDEX CONCURRENTLY during low-traffic window."`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

function buildSchemaRepairTargets(ctx, state, config) {
  const repairResponses = state.schemaRepairBuilderResponses || [];
  const summaries = repairResponses.map((r) =>
    `Builder ${r.displayName}: ${safeTrim(r.response, 2000)}`,
  ).join('\n\n---\n\n');

  return ctx.participants.filter((p) => p.role === 'auditor').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Auditor in a Postgres Query Optimization room.`,
      `The builder's cycle did not produce any new candidate artifacts.`,
      `Below are the builder responses. Review them for schema issues, connection problems,`,
      `or other errors that prevented successful benchmarking.`,
      '',
      `## Builder Responses`,
      summaries,
      '',
      `If you can extract valid results from the builder responses, format them as JSON.`,
      `Otherwise, explain what went wrong so the next cycle can adapt.`,
      '',
      `Reply with JSON matching the builder result format if possible, or an audit with findings.`,
    ].join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Retest prompt builder
// ---------------------------------------------------------------------------

export function buildRetestTargets(ctx, state, config) {
  const connectionString = state.harnessState?.connectionString || 'postgres://harness:harness@localhost:5432/harness';
  const slowQuery = config.demoMode
    ? state.demoQuery || config.slowQuery
    : config.slowQuery;
  const warmupRuns = config.warmupRuns || DEFAULTS.warmupRuns;
  // Double the trials for retest to improve statistical confidence
  const benchmarkTrials = (config.benchmarkTrials || DEFAULTS.benchmarkTrials) * 2;

  const retestCandidates = state._retestQueue || [];
  const isBaselineRetest = state._baselineNeedsRetest && !state.baselines?.retested;

  const retestBlock = retestCandidates.map((c, i) => [
    `### Retest ${i + 1}: ${c.proposalId} (${c.strategyType})`,
    `Apply SQL: ${c.applySQL}`,
    `Rollback SQL: ${c.rollbackSQL || 'N/A'}`,
    c.strategyType === 'rewrite' ? `Rewritten Query: ${c.targetQuery || c.applySQL}` : '',
    `Previous speedup: ${c.speedupPct?.toFixed(1) || '?'}%`,
  ].filter(Boolean).join('\n')).join('\n\n');

  const dataWarningsSection = buildDataWarningsSection(state);

  return ctx.participants.filter((p) => p.role === 'builder').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Builder (Query Architect) in a Postgres Query Optimization room.`,
      `This is a RETEST round with DOUBLED trials (${benchmarkTrials}) for improved statistical confidence.`,
      '',
      `## Connection`,
      `\`\`\``,
      connectionString,
      `\`\`\``,
      '',
      `## Target Query`,
      `\`\`\`sql`,
      slowQuery,
      `\`\`\``,
      '',
      ...dataWarningsSection,
      ...(isBaselineRetest ? [
        `## BASELINE RETEST`,
        `The baseline measurement had high CV (${state.baselines?.cvPct?.toFixed(1) || '?'}%).`,
        `Re-run the baseline with ${benchmarkTrials} trials and report the updated cvPct.`,
        '',
      ] : []),
      ...(retestCandidates.length > 0 ? [
        `## Candidates to Retest`,
        retestBlock,
        '',
      ] : []),
      `## Protocol`,
      `1. ${isBaselineRetest ? 'Re-run baseline: ' : ''}Run ${warmupRuns} warmup queries.`,
      `2. Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${benchmarkTrials} times.`,
      `3. Compute median, p95, and CV%. Report all metrics.`,
      `4. For candidates, apply the change first, then benchmark, then rollback.`,
      '',
      `## Output Format`,
      `Reply with JSON only, same format as previous rounds.`,
      `Include "isBaseline": true for baseline results and "proposalId" for candidate results.`,
      `Include "cvPct" in the baseline object.`,
    ].join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Decision router
// ---------------------------------------------------------------------------

export function buildPendingDecision(ctx, state, config) {
  if (state.pendingFanOut === 'baseline' || state.phase === PHASES.BASELINE) {
    return { type: 'fan_out', targets: buildBaselineTargets(ctx, state, config) };
  }
  if (state.pendingFanOut === 'planning' || state.phase === PHASES.ANALYSIS) {
    return { type: 'fan_out', targets: buildDiscoveryTargets(ctx, state, config) };
  }
  if (state.pendingFanOut === 'cycle' || state.phase === PHASES.CODEGEN) {
    return { type: 'fan_out', targets: buildCycleTargets(ctx, state, config) };
  }
  if (state.pendingFanOut === 'audit' || state.phase === PHASES.STATIC_AUDIT) {
    return { type: 'fan_out', targets: buildAuditTargets(ctx, state, config) };
  }
  if (state.pendingFanOut === 'schema_repair') {
    return { type: 'fan_out', targets: buildSchemaRepairTargets(ctx, state, config) };
  }
  if (state.pendingFanOut === 'retest') {
    return { type: 'fan_out', targets: buildRetestTargets(ctx, state, config) };
  }
  return null;
}
