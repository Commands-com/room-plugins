import { DEFAULTS, MEASURED_STRATEGY_TYPES } from './constants.js';
import {
  findCandidateById,
  buildDataWarningsSection,
  buildRecentFailureDiagnostics,
  buildFrontierSummary,
} from '../../sql-optimizer-core/index.js';

// ---------------------------------------------------------------------------
// Mutation hint generation (Redshift-specific, for cycle 2+)
// ---------------------------------------------------------------------------

function buildMutationHints(state, _config) {
  const hints = [];

  // Winner refinement hints
  for (const candidateId of state.frontierIds) {
    const winner = findCandidateById(state, candidateId);
    if (!winner) continue;
    if (winner.strategyType === 'rewrite') {
      hints.push(
        `WINNER REFINEMENT: "${winner.proposalId}" gave ${winner.speedupPct?.toFixed(1)}% speedup. ` +
        `Try further optimizations: eliminate remaining subqueries, adjust join order, ` +
        `push predicates closer to base tables, convert correlated subqueries to joins, ` +
        `or use APPROXIMATE COUNT DISTINCT.`,
      );

      // Redistribution hints based on plan
      const distSteps = winner.result?.distSteps || [];
      if (distSteps.some((d) => d.includes('BCAST'))) {
        hints.push(
          `REDISTRIBUTION: "${winner.proposalId}" still has broadcast joins (${distSteps.join(', ')}). ` +
          `Try restructuring the query to avoid broadcasting large tables.`,
        );
      }
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
        `Check NULL handling, verify COALESCE usage, ensure aggregate boundaries match.`,
      );
    }
  }

  // Coverage hints — push hard for the missing strategy type
  const hasRewrite = state.candidates.some((c) => c.strategyType === 'rewrite' && c.status !== 'rejected');
  const hasSortDist = state.candidates.some((c) => c.strategyType === 'sort_dist');

  if (!hasRewrite) {
    hints.unshift(
      `CRITICAL — NO QUERY REWRITES PROPOSED YET. Sort/dist key changes are advisory only ` +
      `and cannot be benchmarked. The optimization loop CANNOT make measurable progress without ` +
      `at least one "rewrite" proposal. You MUST propose a rewrite strategy this cycle. ` +
      `Ideas: flatten CTEs into subqueries or vice versa, reorder JOINs to reduce redistribution, ` +
      `push WHERE predicates into inner queries, replace correlated subqueries with JOINs, ` +
      `use APPROXIMATE COUNT(DISTINCT ...), eliminate unnecessary columns from intermediate results, ` +
      `pre-aggregate before joining. Even a minor restructuring is valuable — it establishes ` +
      `a measured candidate so the frontier can track real improvements.`,
    );
  }

  if (!hasSortDist && hasRewrite) {
    hints.push(
      `UNEXPLORED: No sort/dist key recommendations yet. Analyze redistribution steps ` +
      `and recommend SORTKEY/DISTKEY changes if they could improve the query.`,
    );
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Redshift-specific prompt builders
// ---------------------------------------------------------------------------

export function buildBaselineTargets(ctx, state, config) {
  const dbUrl = config.dbUrl;
  const slowQuery = config.slowQuery;
  const warmupRuns = config.warmupRuns || DEFAULTS.warmupRuns;
  const benchmarkTrials = config.benchmarkTrials || DEFAULTS.benchmarkTrials;

  return ctx.participants.filter((p) => p.role === 'builder').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Builder (Query Architect) in a Redshift Query Optimization room.`,
      `Your task is to establish the performance baseline for the target query.`,
      '',
      `## Connection`,
      `\`\`\``,
      dbUrl,
      `\`\`\``,
      `Use the \`pg\` module (Redshift is wire-compatible with Postgres).`,
      '',
      `## Target Query`,
      `\`\`\`sql`,
      slowQuery,
      `\`\`\``,
      '',
      `## Protocol`,
      `1. Connect to the Redshift cluster using the connection string above.`,
      `2. Run the target query ${warmupRuns} time(s) as warmup (discard results).`,
      `3. Run the target query ${benchmarkTrials} time(s), measuring wall-clock elapsed time for each.`,
      `4. Compute median, p95, and CV% from the timings.`,
      `5. Run EXPLAIN on the target query. From the text plan, extract:`,
      `   - stepTypes: list of plan step types (XN Seq Scan, XN Hash Join, etc.)`,
      `   - distSteps: distribution steps (DS_DIST_INNER, DS_BCAST_INNER, etc.)`,
      `   - totalCost: the highest estimated cost from the plan`,
      `6. Query SVL_QUERY_SUMMARY for the most recent execution:`,
      `   - bytesScanned: total bytes processed`,
      `   - rowsReturned: total rows in result`,
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
      `      "trials": [<ms>, <ms>, ...],`,
      `      "stepTypes": ["XN Seq Scan", ...],`,
      `      "distSteps": ["DS_BCAST_INNER", ...],`,
      `      "totalCost": <number>,`,
      `      "bytesScanned": <number>,`,
      `      "rowsReturned": <number>,`,
      `      "planText": "<first 2000 chars of EXPLAIN output — truncate to avoid response overflow>"`,
      `    }`,
      `  }]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

export function buildDiscoveryTargets(ctx, state, config) {
  const slowQuery = config.slowQuery;
  const dbUrl = config.dbUrl;
  const schemaFilter = config.schemaFilter.length > 0
    ? `Focus on tables: ${config.schemaFilter.join(', ')}`
    : 'Analyze all tables referenced by the query.';

  const baselineInfo = state.baselines?.medianMs
    ? `Current baseline: ${state.baselines.medianMs.toFixed(1)}ms median, steps: ${(state.baselines.stepTypes || []).join(', ') || 'unknown'}, redistribution: ${(state.baselines.distSteps || []).join(', ') || 'none'}`
    : 'No baseline established yet.';

  // Table metadata context (populated during preflight)
  const metadataSection = [];
  if (state.tableMetadata?.tableInfo?.length > 0) {
    metadataSection.push('## Table Metadata (from SVV_TABLE_INFO)');
    for (const t of state.tableMetadata.tableInfo) {
      metadataSection.push(
        `- **${t.table_name}**: ${Number(t.row_count || 0).toLocaleString()} rows, ${t.size_mb}MB, ` +
        `diststyle=${t.diststyle || '?'}, sortkey1=${t.sortkey1 || 'none'}, ` +
        `unsorted=${t.unsorted_pct || '?'}%, skew_rows=${t.skew_rows || '?'}`,
      );
    }
    metadataSection.push('');
  }

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

    const frontierSummary = buildFrontierSummary(state);
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
      `You are the Explorer (Schema Analyst) in a Redshift Query Optimization room.`,
      `Cycle ${state.cycleIndex} of ${ctx.limits?.maxCycles || 4}.`,
      '',
      `## Connection (for schema inspection)`,
      `\`\`\``,
      dbUrl,
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
      ...metadataSection,
      ...dataWarningsSection,
      `## Instructions`,
      `${schemaFilter}`,
      `1. Connect and examine the schema:`,
      `   - SVV_TABLE_INFO for table sizes, dist/sort keys, unsorted %, row skew`,
      `   - information_schema.columns for column types`,
      `   - Run EXPLAIN on the target query to understand the plan`,
      `2. Identify bottlenecks:`,
      `   - Seq Scans on large tables`,
      `   - DS_BCAST_INNER / DS_DIST_BOTH (expensive redistributions)`,
      `   - High unsorted % on sort key tables`,
      `   - Row skew indicating poor dist key choice`,
      `3. Propose 2-4 optimization strategies. Two types are supported:`,
      '',
      `**IMPORTANT: You MUST include at least one "rewrite" proposal.** Rewrites are the only strategy ` +
      `type that can be benchmarked and measured. Sort/dist key changes are advisory-only and cannot ` +
      `drive the optimization loop forward. Even a modest SQL restructuring is valuable.`,
      '',
      `### rewrite (measured — will be benchmarked)`,
      `   - CTE restructuring, JOIN reordering, subquery elimination`,
      `   - Predicate pushdown, APPROXIMATE COUNT DISTINCT`,
      `   - Window function optimization`,
      `   For each rewrite, provide:`,
      `   - proposalId, strategyType: "rewrite"`,
      `   - targetQuery: the rewritten SQL`,
      `   - notes: rationale`,
      '',
      `### sort_dist (advisory — audited but NOT benchmarked)`,
      `   - SORTKEY changes (compound vs interleaved)`,
      `   - DISTKEY / DISTSTYLE changes (KEY, ALL, EVEN, AUTO)`,
      `   These require table rebuilds and can't be tested in-place.`,
      `   For each recommendation, provide:`,
      `   - proposalId, strategyType: "sort_dist"`,
      `   - applySQL: the ALTER TABLE statement`,
      `   - rationale: detailed explanation of why this change helps`,
      `   - notes: operational guidance (rebuild time, maintenance window)`,
      '',
      ...(cycleContext.length > 0 ? cycleContext : []),
      '',
      `## Output Format`,
      `Reply with JSON only. Do NOT copy this template — fill in real values from your analysis:`,
      `\`\`\`json`,
      `{`,
      `  "summary": "<your analysis of the bottleneck>",`,
      `  "candidateProposals": [`,
      `    {`,
      `      "proposalId": "<short_snake_case_id>",`,
      `      "strategyType": "rewrite",`,
      `      "targetQuery": "<the full rewritten SQL>",`,
      `      "notes": "<rationale for this rewrite>"`,
      `    },`,
      `    {`,
      `      "proposalId": "<short_snake_case_id>",`,
      `      "strategyType": "sort_dist",`,
      `      "applySQL": "<the ALTER TABLE statement>",`,
      `      "rationale": "<why this key change helps the target query>",`,
      `      "notes": "<operational guidance: rebuild time, maintenance window>"`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

export function buildCycleTargets(ctx, state, config) {
  const dbUrl = config.dbUrl;
  const slowQuery = config.slowQuery;
  const warmupRuns = config.warmupRuns || DEFAULTS.warmupRuns;
  const benchmarkTrials = config.benchmarkTrials || DEFAULTS.benchmarkTrials;

  // Only benchmark rewrite proposals — sort_dist is advisory.
  const promoted = (state.activePromotedProposals || []).filter(
    (p) => p.strategyType === 'rewrite',
  );

  const baselineInfo = state.baselines?.medianMs
    ? `Baseline: ${state.baselines.medianMs.toFixed(1)}ms median`
    : 'No baseline available.';

  const proposalBlock = promoted.map((p, i) => [
    `### Proposal ${i + 1}: ${p.proposalId} (rewrite)`,
    `Rewritten Query: ${p.targetQuery || 'N/A'}`,
    `Notes: ${p.notes || 'none'}`,
  ].filter(Boolean).join('\n')).join('\n\n');

  const dataWarningsSection = buildDataWarningsSection(state);

  return ctx.participants.filter((p) => p.role === 'builder').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Builder (Query Architect) in a Redshift Query Optimization room.`,
      `Your task is to benchmark the following rewrite proposals on the cluster.`,
      '',
      `## Connection`,
      `\`\`\``,
      dbUrl,
      `\`\`\``,
      '',
      `## Original Target Query`,
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
      `## Protocol (for EACH rewrite proposal)`,
      `1. Run the rewritten query ${warmupRuns} time(s) as warmup.`,
      `2. Run the rewritten query ${benchmarkTrials} time(s), measuring wall-clock time.`,
      `3. Compute median, p95, CV%.`,
      `4. Run EXPLAIN on the rewritten query. Extract stepTypes, distSteps, totalCost.`,
      `5. Verify result parity:`,
      `   SELECT COUNT(*) FROM (`,
      `     (original_query EXCEPT ALL rewritten_query)`,
      `     UNION ALL`,
      `     (rewritten_query EXCEPT ALL original_query)`,
      `   ) AS parity_check;`,
      `   Both queries MUST be run in the SAME TRANSACTION.`,
      `   Result must be 0. If not, the rewrite is invalid.`,
      `   For large result sets (>100K rows): compare row counts first, then run`,
      `   EXCEPT ALL only if counts match. Note which method you used.`,
      `6. Query SVL_QUERY_SUMMARY for bytesScanned, rowsReturned.`,
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
      `        "stepTypes": [...],`,
      `        "distSteps": [...],`,
      `        "totalCost": <number>,`,
      `        "bytesScanned": <number>,`,
      `        "planText": "..."`,
      `      },`,
      `      "resultParity": true,`,
      `      "parityChecked": true,`,
      `      "parityMethod": "full_except_all",`,
      `      "speedupPct": <number>`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

export function buildAuditTargets(ctx, state, config) {
  // Separate measured (rewrite) and advisory (sort_dist) candidates
  const rewriteCandidates = state.candidates
    .filter((c) => c.cycleIndex === state.cycleIndex && c.strategyType === 'rewrite' && c.status !== 'rejected')
    .slice(-10);

  const advisoryCandidates = state.candidates
    .filter((c) => c.cycleIndex === state.cycleIndex && c.strategyType === 'sort_dist')
    .slice(-5);

  const rewriteSummary = rewriteCandidates.map((c) => [
    `- ${c.proposalId} (rewrite):`,
    `  speedup ${c.speedupPct?.toFixed(1) || '?'}%,`,
    `  dist steps: ${(c.result?.distSteps || []).join(', ') || 'unknown'}`,
  ].join(' ')).join('\n');

  const advisorySummary = advisoryCandidates.map((c) => [
    `- ${c.proposalId} (sort_dist):`,
    `  ${c.applySQL?.slice(0, 200) || 'no SQL'}`,
    `  rationale: ${c.rationale || c.notes || 'none'}`,
  ].join(' ')).join('\n');

  const dataWarningsSection = buildDataWarningsSection(state);

  // Table metadata for context
  const metadataSection = [];
  if (state.tableMetadata?.tableInfo?.length > 0) {
    metadataSection.push('## Current Table Metadata');
    for (const t of state.tableMetadata.tableInfo) {
      metadataSection.push(
        `- **${t.table_name}**: ${Number(t.row_count || 0).toLocaleString()} rows, ` +
        `diststyle=${t.diststyle || '?'}, sortkey1=${t.sortkey1 || 'none'}`,
      );
    }
    metadataSection.push('');
  }

  return ctx.participants.filter((p) => p.role === 'auditor').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Auditor (DBA Auditor) in a Redshift Query Optimization room.`,
      `Your task is to review the following optimization candidates for operational risk.`,
      `You answer: "if you deploy this, what could go wrong?"`,
      '',
      ...dataWarningsSection,
      ...metadataSection,
      `## Risk Score Guidelines`,
      `Score OPERATIONAL risk — things that could degrade cluster performance or break workflows:`,
      `- 1-3: Low — straightforward rewrite, no schema changes needed`,
      `- 4-6: Moderate — may increase bytes scanned, adds redistribution, or changes result ordering`,
      `- 7-8: High — table rebuild required, WLM queue impact, concurrency scaling concern`,
      `- 9-10: Critical — affects production ETL windows, potential data access issues`,
      '',
      `## Redshift-Specific Risk Dimensions`,
      `1. **Redistribute cost** — does the rewrite add or remove DS_DIST/DS_BCAST steps?`,
      `2. **Result set size** — does the rewrite change the amount of data scanned?`,
      `3. **WLM queue impact** — longer/shorter queries affect slot allocation`,
      `4. **Concurrency scaling** — will this rewrite trigger concurrency scaling?`,
      `5. **Maintenance window** — sort/dist key changes require table rebuild (sort_dist only)`,
      '',
      ...(rewriteCandidates.length > 0 ? [
        `## Measured Candidates (rewrite)`,
        rewriteSummary,
        '',
      ] : []),
      ...(advisoryCandidates.length > 0 ? [
        `## Advisory Candidates (sort_dist — NOT benchmarked)`,
        `These are table design recommendations. They require table rebuilds and cannot be tested in-place.`,
        `Audit for operational risk: rebuild time, maintenance window, downstream dependencies.`,
        advisorySummary,
        '',
      ] : []),
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
      `          "category": "redistribute_cost|result_set_size|wlm_queue_impact|concurrency_scaling|maintenance_window",`,
      `          "detail": "...",`,
      `          "recommendation": "..."`,
      `        }`,
      `      ],`,
      `      "approved": true,`,
      `      "deployNotes": "Safe to deploy during low-traffic window."`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
    ].join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Retest prompt builder
// ---------------------------------------------------------------------------

export function buildRetestTargets(ctx, state, config) {
  const dbUrl = config.dbUrl;
  const slowQuery = config.slowQuery;
  const warmupRuns = config.warmupRuns || DEFAULTS.warmupRuns;
  // Double trials for retest
  const benchmarkTrials = (config.benchmarkTrials || DEFAULTS.benchmarkTrials) * 2;

  const retestCandidates = (state._retestQueue || []).filter((c) => c.strategyType === 'rewrite');
  const isBaselineRetest = state._baselineNeedsRetest && !state.baselines?.retested;

  const retestBlock = retestCandidates.map((c, i) => [
    `### Retest ${i + 1}: ${c.proposalId} (rewrite)`,
    `Rewritten Query: ${c.targetQuery || 'N/A'}`,
    `Previous speedup: ${c.speedupPct?.toFixed(1) || '?'}%`,
  ].filter(Boolean).join('\n')).join('\n\n');

  return ctx.participants.filter((p) => p.role === 'builder').map((participant) => ({
    agentId: participant.agentId,
    message: [
      `You are the Builder (Query Architect) in a Redshift Query Optimization room.`,
      `This is a RETEST round with DOUBLED trials (${benchmarkTrials}) for improved statistical confidence.`,
      `On a shared cluster, variance is expected — more trials help confirm real improvements.`,
      '',
      `## Connection`,
      `\`\`\``,
      dbUrl,
      `\`\`\``,
      '',
      `## Target Query`,
      `\`\`\`sql`,
      slowQuery,
      `\`\`\``,
      '',
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
      `2. Run the query ${benchmarkTrials} times, measuring wall-clock time.`,
      `3. Compute median, p95, and CV%.`,
      `4. For candidates, run the rewritten query, not the original.`,
      `5. Report all metrics in the same JSON format as previous rounds.`,
      `6. IMPORTANT: Include the "trials" array with each individual timing (ms) — needed for robust statistics.`,
      '',
      `## Output Format`,
      `Reply with JSON only, same format as previous rounds.`,
      `Include "isBaseline": true for baseline results and "proposalId" for candidate results.`,
    ].join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Synthesis prompt builder — all 3 roles vote on best deployment plan
// ---------------------------------------------------------------------------

export function buildSynthesisTargets(ctx, state, _config) {
  // Gather all non-rejected candidates
  const rewrites = state.candidates.filter(
    (c) => MEASURED_STRATEGY_TYPES.includes(c.strategyType) && c.status !== 'rejected',
  );
  const advisories = state.candidates.filter(
    (c) => c.strategyType === 'sort_dist' && c.status !== 'rejected',
  );
  const frontierSet = new Set(state.frontierIds || []);

  const baselineMs = state.baselines?.medianMs;
  const baselineInfo = Number.isFinite(baselineMs)
    ? `Baseline: ${baselineMs.toFixed(1)}ms median`
    : 'No baseline established.';

  // Build candidate summaries
  const rewriteLines = rewrites.map((c) => {
    const frontier = frontierSet.has(c.candidateId) ? ' [FRONTIER WINNER]' : '';
    const speedup = Number.isFinite(c.speedupPct) ? `${c.speedupPct.toFixed(1)}%` : '?';
    const median = Number.isFinite(c.result?.medianMs) ? `${c.result.medianMs.toFixed(1)}ms` : '?';
    const risk = Number.isFinite(c.riskScore) ? `risk ${c.riskScore}/10` : '';
    const auditCount = (c.auditFindings || []).length;
    const audit = auditCount > 0 ? `${auditCount} findings` : 'no findings';
    const parity = c.resultParity ? 'parity verified' : 'parity unverified';
    return `  - ${c.proposalId}: ${speedup} speedup → ${median}, ${risk}, ${audit}, ${parity}${frontier}`;
  });

  const advisoryLines = advisories.map((c) => {
    const risk = Number.isFinite(c.riskScore) ? `risk ${c.riskScore}/10` : '';
    const auditCount = (c.auditFindings || []).length;
    const audit = auditCount > 0 ? `${auditCount} findings` : 'no findings';
    const sql = (c.applySQL || '').split('\n')[0].slice(0, 120);
    return `  - ${c.proposalId}: ${sql}... ${risk}, ${audit}, status: ${c.status}`;
  });

  // Table metadata context
  const metadataLines = [];
  if (state.tableMetadata?.tableInfo?.length > 0) {
    metadataLines.push('## Table Metadata');
    for (const t of state.tableMetadata.tableInfo) {
      metadataLines.push(
        `- ${t.table_name}: ${Number(t.row_count || 0).toLocaleString()} rows, ` +
        `diststyle=${t.diststyle || '?'}, sortkey1=${t.sortkey1 || 'none'}`,
      );
    }
  }

  const roleInstructions = {
    explorer: `You are the Explorer (Schema Analyst). You understand the schema, table sizes, and join patterns best. ` +
      `Rank solutions by which will have the greatest real-world impact given the data distribution and access patterns you observed.`,
    builder: `You are the Builder (Query Architect). You benchmarked these rewrites and know which measurements were solid vs noisy. ` +
      `Rank solutions by confidence in the measured improvement and implementation quality.`,
    auditor: `You are the Auditor (DBA Auditor). You reviewed these for operational risk. ` +
      `Rank solutions by deployment safety — what should be done first with lowest risk, and what needs more validation.`,
  };

  const stopReason = state._stopReason || 'optimization complete';

  const sharedPrompt = [
    `## Optimization Summary`,
    baselineInfo,
    `Stop reason: ${stopReason}`,
    `Cycles completed: ${state.cycleIndex}`,
    '',
    ...(rewriteLines.length > 0 ? [
      `## Measured Rewrites (benchmarked on cluster)`,
      ...rewriteLines,
      '',
    ] : ['## No measured rewrites survived.\n']),
    ...(advisoryLines.length > 0 ? [
      `## Advisory Recommendations (sort/dist key changes — NOT benchmarked)`,
      ...advisoryLines,
      '',
    ] : []),
    ...metadataLines,
    '',
    `## Your Task`,
    `Rank ALL surviving candidates (both rewrites and advisories) into a recommended deployment order.`,
    `Consider: measured speedup, confidence in the measurement, operational risk, dependencies between changes,`,
    `and whether a rewrite should be deployed before or after a table rebuild.`,
    '',
    `For each candidate, assign a rank (1 = deploy first) and explain why.`,
    `If a candidate should NOT be deployed, rank it last and say why.`,
    '',
    `## Output Format`,
    `Reply with JSON only:`,
    '```json',
    `{`,
    `  "ranking": [`,
    `    { "proposalId": "...", "rank": 1, "rationale": "..." },`,
    `    { "proposalId": "...", "rank": 2, "rationale": "..." }`,
    `  ],`,
    `  "overallAssessment": "One paragraph: what was achieved, what remains, and the recommended deployment sequence."`,
    `}`,
    '```',
  ].join('\n');

  return ctx.participants
    .filter((p) => ['explorer', 'builder', 'auditor'].includes(p.role))
    .map((participant) => ({
      agentId: participant.agentId,
      message: [
        roleInstructions[participant.role] || '',
        `This is the SYNTHESIS phase — optimization is complete and you are voting on the best deployment plan.`,
        '',
        sharedPrompt,
      ].join('\n'),
    }));
}
