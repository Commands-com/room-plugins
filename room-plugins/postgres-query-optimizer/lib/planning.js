import { PHASES } from './constants.js';

export function buildDiscoveryTargets(ctx, state, config) {
  return ctx.participants.filter(p => p.role === 'explorer').map(participant => ({
    agentId: participant.agentId,
    message: [
      `You are the Explorer role in a Postgres Query Optimization room.`,
      `Objective: ${ctx.objective}`,
      `Database URL: ${config.dbUrl}`,
      `Slow Query: ${config.slowQuery}`,
      '',
      `1. Explore the schema for tables involved in the query: ${config.schemaFilter.join(', ')}`,
      `2. Identify missing indexes, redundant joins, or expensive subqueries.`,
      `3. Propose 2-4 optimization strategies (indexes or rewrites).`,
      '',
      `Reply with JSON only: { "summary": "...", "candidateProposals": [{ "strategyType": "index", "sql": "CREATE INDEX...", "notes": "..." }] }`
    ].join('\n')
  }));
}

export function buildBaselineTargets(ctx, state, config) {
  return ctx.participants.filter(p => p.role === 'builder').map(participant => ({
    agentId: participant.agentId,
    message: [
      `Establish the performance baseline for the target query.`,
      `Query: ${config.slowQuery}`,
      `Run: EXPLAIN (ANALYZE, FORMAT JSON) ${config.slowQuery}`,
      '',
      `Reply with the execution time and plan JSON.`
    ].join('\n')
  }));
}

export function buildPlanningTargets(ctx, state, config) {
  // Similar to FFT planning, but for SQL strategies.
  return ctx.participants.filter(p => p.role === 'explorer').map(participant => ({
    agentId: participant.agentId,
    message: `Plan the next cycle of SQL optimizations based on previous results...`
  }));
}

export function buildCycleTargets(ctx, state, config) {
  const promoted = state.activePromotedProposals || [];
  return ctx.participants.filter(p => p.role === 'builder').map(participant => ({
    agentId: participant.agentId,
    message: [
      `Implement and benchmark the following optimization strategies:`,
      JSON.stringify(promoted, null, 2),
      '',
      `For each strategy:`,
      `1. Apply the change (CREATE INDEX or use the rewritten SQL).`,
      `2. Run EXPLAIN (ANALYZE, FORMAT JSON) to get the new execution time.`,
      `3. Verify result set parity with the baseline query.`,
      `4. Roll back changes (DROP INDEX) before the next candidate.`
    ].join('\n')
  }));
}

export function buildAuditTargets(ctx, state, config) {
  return ctx.participants.filter(p => p.role === 'auditor').map(participant => ({
    agentId: participant.agentId,
    message: `Audit the proposed SQL optimizations for risk (storage, lock contention, write overhead)...`
  }));
}

export function buildPendingDecision(ctx, state, config) {
  if (state.phase === PHASES.BASELINE) {
    return { type: 'fan_out', targets: buildBaselineTargets(ctx, state, config) };
  }
  if (state.phase === PHASES.ANALYSIS) {
    return { type: 'fan_out', targets: buildDiscoveryTargets(ctx, state, config) };
  }
  if (state.phase === PHASES.CODEGEN) {
    return { type: 'fan_out', targets: buildCycleTargets(ctx, state, config) };
  }
  if (state.phase === PHASES.STATIC_AUDIT) {
    return { type: 'fan_out', targets: buildAuditTargets(ctx, state, config) };
  }
  return null;
}
