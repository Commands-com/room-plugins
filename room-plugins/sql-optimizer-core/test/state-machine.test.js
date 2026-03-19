import { describe, it, expect, vi } from 'vitest';
import { createBasePlugin, collectSchemaRepairBuilderResponses } from '../index.js';
import { PHASES } from '../lib/constants.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockCtx(overrides = {}) {
  let state = null;
  return {
    roomId: 'room_test',
    participants: [
      { agentId: 'explorer_1', displayName: 'Explorer', role: 'explorer' },
      { agentId: 'builder_1', displayName: 'Builder', role: 'builder' },
      { agentId: 'auditor_1', displayName: 'Auditor', role: 'auditor' },
    ],
    limits: { maxCycles: 4, maxTurns: 120, ...overrides.limits },
    roomConfig: overrides.roomConfig || {},
    orchestratorConfig: overrides.orchestratorConfig || {},
    getState: () => (state != null ? JSON.parse(JSON.stringify(state)) : null),
    setState: (s) => { state = s != null ? JSON.parse(JSON.stringify(s)) : null; },
    setCycle: overrides.setCycle || vi.fn(),
    emitMetrics: overrides.emitMetrics || vi.fn(),
    ...overrides,
  };
}

function makeMockEngine() {
  return {
    strategyTypes: ['index', 'rewrite'],
    defaultStrategyType: 'index',
    determinePlanShapeChanged: () => false,
    detectStrategyTypeFromSQL: () => 'index',
    extendBuilderResult: (r) => r,
    buildWinnerBlock: () => '',
    buildEngineBaselineRows: () => [],
    buildEngineMetrics: () => ({}),
    targetBuilders: {
      baseline: (ctx) => ctx.participants
        .filter((p) => p.role === 'builder')
        .map((p) => ({ agentId: p.agentId, message: 'baseline' })),
      planning: (ctx) => ctx.participants
        .filter((p) => p.role === 'explorer')
        .map((p) => ({ agentId: p.agentId, message: 'plan' })),
      cycle: (ctx) => ctx.participants
        .filter((p) => p.role === 'builder')
        .map((p) => ({ agentId: p.agentId, message: 'cycle' })),
      audit: (ctx) => ctx.participants
        .filter((p) => p.role === 'auditor')
        .map((p) => ({ agentId: p.agentId, message: 'audit' })),
      retest: (ctx) => ctx.participants
        .filter((p) => p.role === 'builder')
        .map((p) => ({ agentId: p.agentId, message: 'retest' })),
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    demoMode: false,
    slowQuery: 'SELECT 1',
    promoteTopK: 2,
    warmupRuns: 1,
    benchmarkTrials: 3,
    maxRiskScore: 7,
    targetImprovementPct: 20,
    plateauCycles: 2,
    ...overrides,
  };
}

function makePlugin(hookOverrides = {}) {
  const engine = makeMockEngine();
  const config = makeConfig(hookOverrides.config);

  return createBasePlugin({
    createEngine: () => engine,
    getConfig: () => config,
    engineInitialState: hookOverrides.engineInitialState || {},
    onRoomStart: hookOverrides.onRoomStart || vi.fn().mockResolvedValue(null),
    shutdown: hookOverrides.shutdown || vi.fn().mockResolvedValue(undefined),
    ...hookOverrides,
  });
}

function makeBaselineResponse() {
  return JSON.stringify({
    summary: 'Baseline complete',
    results: [{
      isBaseline: true,
      baseline: { medianMs: 500, p95Ms: 550, cvPct: 3.2, leafAccessNodes: ['Seq Scan'], planNodeSet: ['Seq Scan', 'Sort'] },
    }],
  });
}

function makePlanningResponse() {
  return JSON.stringify({
    summary: 'Found optimizations',
    candidateProposals: [
      { proposalId: 'idx_test', strategyType: 'index', applySQL: 'CREATE INDEX idx_test ON t(a)', rollbackSQL: 'DROP INDEX idx_test', notes: 'test' },
      { proposalId: 'rw_test', strategyType: 'rewrite', targetQuery: 'SELECT a FROM t', applySQL: 'SELECT a FROM t', notes: 'test' },
    ],
  });
}

function makeCycleResponse(speedupPct = 40) {
  const baselineMs = 500;
  const candidateMs = baselineMs * (1 - speedupPct / 100);
  return JSON.stringify({
    summary: 'Benchmark results',
    results: [{
      proposalId: 'idx_test',
      candidate: { medianMs: candidateMs, p95Ms: candidateMs + 10, cvPct: 2.0, leafAccessNodes: ['Index Scan'], planNodeSet: ['Index Scan', 'Sort'] },
      speedupPct,
      applySQL: 'CREATE INDEX idx_test ON t(a)',
      rollbackSQL: 'DROP INDEX idx_test',
      indexSizeBytes: 8192,
    }],
  });
}

function makeAuditResponse(approved = true) {
  return JSON.stringify({
    summary: 'Audit complete',
    audits: [{
      proposalId: 'idx_test',
      riskScore: 2,
      findings: [],
      approved,
      deployNotes: 'Safe',
    }],
  });
}

// ---------------------------------------------------------------------------
// collectSchemaRepairBuilderResponses
// ---------------------------------------------------------------------------

describe('collectSchemaRepairBuilderResponses', () => {
  it('collects builder responses matching signal patterns', () => {
    const state = { lanesByAgentId: { b1: 'builder', e1: 'explorer' } };
    const ctx = { participants: [{ agentId: 'b1', displayName: 'Builder' }] };
    const responses = [
      { agentId: 'b1', response: '{"proposalId": "x", "medianMs": 100}' },
      { agentId: 'e1', response: '{"proposalId": "y"}' },
    ];

    const result = collectSchemaRepairBuilderResponses(state, ctx, responses);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('b1');
  });

  it('filters out responses without signal patterns', () => {
    const state = { lanesByAgentId: { b1: 'builder' } };
    const ctx = { participants: [{ agentId: 'b1', displayName: 'Builder' }] };
    const responses = [{ agentId: 'b1', response: 'no useful data here' }];

    const result = collectSchemaRepairBuilderResponses(state, ctx, responses);
    expect(result).toHaveLength(0);
  });

  it('returns empty for null/empty responses', () => {
    const state = { lanesByAgentId: {} };
    const ctx = { participants: [] };
    expect(collectSchemaRepairBuilderResponses(state, ctx, null)).toEqual([]);
    expect(collectSchemaRepairBuilderResponses(state, ctx, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('init', () => {
  it('creates initial state with lanes and engine fields', () => {
    const plugin = makePlugin({ engineInitialState: { myField: 42 } });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    expect(state.phase).toBe(PHASES.PREFLIGHT);
    expect(state.cycleIndex).toBe(0);
    expect(state.lanesByAgentId).toBeDefined();
    expect(Object.keys(state.lanesByAgentId).length).toBe(3);
    expect(state.myField).toBe(42);
    expect(state.candidates).toEqual([]);
    expect(state.proposalBacklog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onTurnResult
// ---------------------------------------------------------------------------

describe('onTurnResult', () => {
  it('always returns null', () => {
    const plugin = makePlugin();
    expect(plugin.onTurnResult()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onRoomStart
// ---------------------------------------------------------------------------

describe('onRoomStart', () => {
  it('delegates to the engine hook', async () => {
    const onRoomStart = vi.fn().mockResolvedValue({ type: 'fan_out', targets: [] });
    const plugin = makePlugin({ onRoomStart });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const decision = await plugin.onRoomStart(ctx);
    expect(onRoomStart).toHaveBeenCalledOnce();
    expect(decision).toEqual({ type: 'fan_out', targets: [] });
  });

  it('passes state, config, engine, and helpers to the hook', async () => {
    let receivedArgs;
    const onRoomStart = vi.fn().mockImplementation((_ctx, args) => {
      receivedArgs = args;
      return { type: 'stop', reason: 'test' };
    });

    const plugin = makePlugin({ onRoomStart });
    const ctx = makeMockCtx();
    plugin.init(ctx);
    await plugin.onRoomStart(ctx);

    expect(receivedArgs.state).toBeDefined();
    expect(receivedArgs.config).toBeDefined();
    expect(receivedArgs.engine).toBeDefined();
    expect(typeof receivedArgs.emitStateMetrics).toBe('function');
    expect(typeof receivedArgs.buildDecision).toBe('function');
    expect(typeof receivedArgs.setPhase).toBe('function');
    expect(receivedArgs.PHASES).toBe(PHASES);
  });
});

// ---------------------------------------------------------------------------
// engineInitialState validation
// ---------------------------------------------------------------------------

describe('engineInitialState validation', () => {
  it('throws on core state key collision', () => {
    expect(() => makePlugin({ engineInitialState: { candidates: [] } }))
      .toThrow(/collides with a core state key/);
  });

  it('throws on phase collision', () => {
    expect(() => makePlugin({ engineInitialState: { phase: 'x' } }))
      .toThrow(/collides with a core state key/);
  });

  it('allows non-colliding keys', () => {
    expect(() => makePlugin({ engineInitialState: { myCustomField: 42 } }))
      .not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — baseline
// ---------------------------------------------------------------------------

describe('onFanOutComplete — baseline', () => {
  it('transitions from baseline to planning', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    // Set state to baseline phase
    const state = ctx.getState();
    state.pendingFanOut = 'baseline';
    state.phase = PHASES.BASELINE;
    ctx.setState(state);

    const responses = [{ agentId: 'builder_1', response: makeBaselineResponse() }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(decision).not.toBeNull();
    expect(decision.type).toBe('fan_out');

    const updated = ctx.getState();
    expect(updated.phase).toBe(PHASES.ANALYSIS);
    expect(updated.pendingFanOut).toBe('planning');
    expect(updated.cycleIndex).toBe(1);
    expect(updated.baselines.medianMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — planning
// ---------------------------------------------------------------------------

describe('onFanOutComplete — planning', () => {
  it('transitions to cycle when proposals are promoted', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'planning';
    state.phase = PHASES.ANALYSIS;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    ctx.setState(state);

    const responses = [{ agentId: 'explorer_1', response: makePlanningResponse() }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(decision.type).toBe('fan_out');
    const updated = ctx.getState();
    expect(updated.phase).toBe(PHASES.CODEGEN);
    expect(updated.pendingFanOut).toBe('cycle');
    expect(updated.activePromotedProposals.length).toBeGreaterThan(0);
  });

  it('increments plateau and loops when no proposals found', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'planning';
    state.phase = PHASES.ANALYSIS;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    ctx.setState(state);

    const responses = [{ agentId: 'explorer_1', response: JSON.stringify({ summary: 'No proposals', candidateProposals: [] }) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    const updated = ctx.getState();
    expect(updated.plateauCount).toBeGreaterThanOrEqual(1);
    // Should loop back to planning or stop (plateau may trigger stop)
    expect(['planning', null].includes(updated.pendingFanOut)).toBe(true);
  });

  it('calls beforePromoteProposals hook before promotion', async () => {
    const beforePromoteProposals = vi.fn();
    const plugin = makePlugin({ beforePromoteProposals });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'planning';
    state.phase = PHASES.ANALYSIS;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    ctx.setState(state);

    const responses = [{ agentId: 'explorer_1', response: makePlanningResponse() }];
    await plugin.onFanOutComplete(ctx, responses);

    expect(beforePromoteProposals).toHaveBeenCalledOnce();
  });

  it('calls filterPromotedProposals hook after promotion', async () => {
    const filterPromotedProposals = vi.fn((proposals) => proposals); // pass-through
    const plugin = makePlugin({ filterPromotedProposals });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'planning';
    state.phase = PHASES.ANALYSIS;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    ctx.setState(state);

    const responses = [{ agentId: 'explorer_1', response: makePlanningResponse() }];
    await plugin.onFanOutComplete(ctx, responses);

    expect(filterPromotedProposals).toHaveBeenCalledOnce();
    expect(filterPromotedProposals.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('routes to audit when filterPromotedProposals returns empty but advisories exist', async () => {
    const filterPromotedProposals = vi.fn(() => []); // filter out everything
    const plugin = makePlugin({ filterPromotedProposals });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'planning';
    state.phase = PHASES.ANALYSIS;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    // Add an advisory candidate to trigger audit routing
    state.candidates = [{
      candidateId: 'advisory_1', strategyType: 'sort_dist', status: 'advisory', cycleIndex: 1,
    }];
    ctx.setState(state);

    const responses = [{ agentId: 'explorer_1', response: makePlanningResponse() }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    const updated = ctx.getState();
    expect(updated.pendingFanOut).toBe('audit');
    expect(updated.phase).toBe(PHASES.STATIC_AUDIT);
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — cycle
// ---------------------------------------------------------------------------

describe('onFanOutComplete — cycle', () => {
  it('transitions to audit when new candidates are built', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.phase = PHASES.CODEGEN;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500, p95Ms: 550, cvPct: 3 };
    state.activePromotedProposals = [
      { proposalId: 'idx_test', strategyType: 'index', applySQL: 'CREATE INDEX idx_test ON t(a)', rollbackSQL: 'DROP INDEX idx_test' },
    ];
    ctx.setState(state);

    const responses = [{ agentId: 'builder_1', response: makeCycleResponse(40) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(decision.type).toBe('fan_out');
    const updated = ctx.getState();
    expect(updated.phase).toBe(PHASES.STATIC_AUDIT);
    expect(updated.pendingFanOut).toBe('audit');
    expect(updated.candidates.length).toBeGreaterThan(0);
  });

  it('calls afterCycleMerge hook', async () => {
    const afterCycleMerge = vi.fn();
    const plugin = makePlugin({ afterCycleMerge });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.phase = PHASES.CODEGEN;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500, p95Ms: 550, cvPct: 3 };
    state.activePromotedProposals = [
      { proposalId: 'idx_test', strategyType: 'index', applySQL: 'CREATE INDEX idx_test ON t(a)', rollbackSQL: 'DROP INDEX idx_test' },
    ];
    ctx.setState(state);

    const responses = [{ agentId: 'builder_1', response: makeCycleResponse(40) }];
    await plugin.onFanOutComplete(ctx, responses);

    expect(afterCycleMerge).toHaveBeenCalledOnce();
    const callArgs = afterCycleMerge.mock.calls[0];
    expect(callArgs[3].builtNewCandidates).toBe(true);
  });

  it('routes to schema_repair when no candidates but builder had repair signals', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'cycle';
    state.phase = PHASES.CODEGEN;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500, p95Ms: 550, cvPct: 3 };
    state.activePromotedProposals = [
      { proposalId: 'idx_test', strategyType: 'index', applySQL: 'CREATE INDEX idx_test ON t(a)' },
    ];
    ctx.setState(state);

    // Response with repair signals but no valid benchmark results
    const responses = [{
      agentId: 'builder_1',
      response: '{"proposalId": "idx_test", "medianMs": "error: relation not found"}',
    }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    const updated = ctx.getState();
    expect(updated.pendingFanOut).toBe('schema_repair');
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — audit
// ---------------------------------------------------------------------------

describe('onFanOutComplete — audit', () => {
  it('processes audit and proceeds to next cycle or stop', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'audit';
    state.phase = PHASES.STATIC_AUDIT;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500, p95Ms: 550, cvPct: 3 };
    state.candidates = [{
      candidateId: 'idx_test', proposalId: 'idx_test', strategyType: 'index',
      cycleIndex: 1, speedupPct: 40, status: 'benchmarked',
      result: { medianMs: 300, p95Ms: 310, cvPct: 2 },
      baseline: { medianMs: 500 },
      applySQL: 'CREATE INDEX idx_test ON t(a)',
      auditFindings: [], approved: true, telemetryAvailable: false, deployNotes: '',
    }];
    ctx.setState(state);

    const responses = [{ agentId: 'auditor_1', response: makeAuditResponse(true) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(decision).not.toBeNull();
    // Should proceed (either to retest, next cycle, or stop)
    const updated = ctx.getState();
    expect(updated.schemaRepairBuilderResponses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — schema_repair
// ---------------------------------------------------------------------------

describe('onFanOutComplete — schema_repair', () => {
  it('processes repair responses and finishes cycle', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'schema_repair';
    state.phase = PHASES.STATIC_AUDIT;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    state.schemaRepairBuilderResponses = [{ agentId: 'builder_1', response: 'repair' }];
    ctx.setState(state);

    const responses = [{ agentId: 'auditor_1', response: JSON.stringify({ summary: 'Repair audit', audits: [] }) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(decision).not.toBeNull();
    const updated = ctx.getState();
    expect(updated.schemaRepairBuilderResponses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — retest
// ---------------------------------------------------------------------------

describe('onFanOutComplete — retest', () => {
  it('merges retest results and proceeds', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'retest';
    state.phase = PHASES.FRONTIER_REFINE;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500, p95Ms: 550, cvPct: 3 };
    state._retestQueue = [{ proposalId: 'idx_test' }];
    state.candidates = [{
      candidateId: 'idx_test', proposalId: 'idx_test', strategyType: 'index',
      cycleIndex: 1, speedupPct: 40, status: 'benchmarked', needsRetest: true,
      result: { medianMs: 300, p95Ms: 310, cvPct: 2 },
      baseline: { medianMs: 500 },
      applySQL: 'CREATE INDEX idx_test ON t(a)',
    }];
    ctx.setState(state);

    const responses = [{
      agentId: 'builder_1',
      response: JSON.stringify({
        summary: 'Retest',
        results: [{
          proposalId: 'idx_test',
          candidate: { medianMs: 305, p95Ms: 315, cvPct: 1.8 },
        }],
      }),
    }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(decision).not.toBeNull();
    const updated = ctx.getState();
    expect(updated._retestQueue).toEqual([]);
  });

  it('calls afterRetestMerge hook and uses its decision', async () => {
    const hookDecision = { type: 'fan_out', targets: [{ agentId: 'a', message: 'audit' }] };
    const afterRetestMerge = vi.fn().mockResolvedValue(hookDecision);
    const plugin = makePlugin({ afterRetestMerge });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'retest';
    state.phase = PHASES.FRONTIER_REFINE;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    state._retestQueue = [];
    state.candidates = [];
    ctx.setState(state);

    const responses = [{ agentId: 'builder_1', response: JSON.stringify({ summary: 'retest', results: [] }) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(afterRetestMerge).toHaveBeenCalledOnce();
    expect(decision).toEqual(hookDecision);
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — synthesis
// ---------------------------------------------------------------------------

describe('onFanOutComplete — synthesis', () => {
  it('calls onSynthesisComplete hook and stops', async () => {
    const onSynthesisComplete = vi.fn();
    const plugin = makePlugin({ onSynthesisComplete });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'synthesis';
    state.phase = PHASES.SYNTHESIS;
    state._stopReason = 'target_met';
    ctx.setState(state);

    const responses = [{ agentId: 'auditor_1', response: JSON.stringify({ ranking: [] }) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    expect(onSynthesisComplete).toHaveBeenCalledOnce();
    expect(decision.type).toBe('stop');
    expect(decision.reason).toBe('target_met');

    const updated = ctx.getState();
    expect(updated.phase).toBe(PHASES.COMPLETE);
    expect(updated.pendingFanOut).toBeNull();
  });

  it('uses synthesis_complete as default stop reason', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'synthesis';
    state.phase = PHASES.SYNTHESIS;
    // no _stopReason set
    ctx.setState(state);

    const decision = await plugin.onFanOutComplete(ctx, []);
    expect(decision.reason).toBe('synthesis_complete');
  });
});

// ---------------------------------------------------------------------------
// onFanOutComplete — unknown phase
// ---------------------------------------------------------------------------

describe('onFanOutComplete — unknown', () => {
  it('returns null for unknown pendingFanOut', async () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'unknown_phase';
    ctx.setState(state);

    const decision = await plugin.onFanOutComplete(ctx, []);
    expect(decision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onEvent
// ---------------------------------------------------------------------------

describe('onEvent', () => {
  it('handles participant_disconnected by pausing', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const decision = plugin.onEvent(ctx, { type: 'participant_disconnected', agentId: 'builder_1' });
    expect(decision.type).toBe('pause');
    expect(decision.reason).toContain('builder_1');

    const updated = ctx.getState();
    expect(updated.phase).toBe(PHASES.FRONTIER_REFINE);
  });

  it('handles user_edit_state for activePromotedProposals', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const newProposals = [{ proposalId: 'custom', strategyType: 'index' }];
    plugin.onEvent(ctx, {
      type: 'user_edit_state',
      edits: { activePromotedProposals: newProposals },
    });

    const updated = ctx.getState();
    expect(updated.activePromotedProposals).toEqual(newProposals);
  });

  it('handles user_edit_state for proposalBacklog', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const newBacklog = [{ proposalId: 'queued', strategyType: 'rewrite' }];
    plugin.onEvent(ctx, {
      type: 'user_edit_state',
      edits: { proposalBacklog: newBacklog },
    });

    const updated = ctx.getState();
    expect(updated.proposalBacklog).toEqual(newBacklog);
  });

  it('returns null for fan_out_partial when not in cycle', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'planning'; // not 'cycle'
    ctx.setState(state);

    const result = plugin.onEvent(ctx, { type: 'fan_out_partial', agentId: 'builder_1' });
    expect(result).toBeNull();
  });

  it('returns null for unknown event types', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    expect(plugin.onEvent(ctx, { type: 'unknown' })).toBeNull();
    expect(plugin.onEvent(ctx, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onResume
// ---------------------------------------------------------------------------

describe('onResume', () => {
  it('builds a pending decision from current state', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'baseline';
    state.phase = PHASES.BASELINE;
    ctx.setState(state);

    const decision = plugin.onResume(ctx);
    expect(decision).not.toBeNull();
    expect(decision.type).toBe('fan_out');
  });

  it('returns null when no pending fan-out', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const decision = plugin.onResume(ctx);
    expect(decision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// refreshPendingDecision
// ---------------------------------------------------------------------------

describe('refreshPendingDecision', () => {
  it('returns fresh decision when pending fan-out exists', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'baseline';
    state.phase = PHASES.BASELINE;
    ctx.setState(state);

    const staleDecision = { type: 'fan_out', targets: [] };
    const fresh = plugin.refreshPendingDecision(ctx, staleDecision);
    expect(fresh.type).toBe('fan_out');
    expect(fresh.targets.length).toBeGreaterThan(0);
  });

  it('returns original decision when no pending fan-out', () => {
    const plugin = makePlugin();
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const original = { type: 'fan_out', targets: [{ agentId: 'x', message: 'y' }] };
    const result = plugin.refreshPendingDecision(ctx, original);
    expect(result).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('delegates to the engine hook', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const plugin = makePlugin({ shutdown });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    await plugin.shutdown(ctx);
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// finishSearchCycle — synthesis routing
// ---------------------------------------------------------------------------

describe('finishSearchCycle — synthesis routing', () => {
  it('routes to synthesis when engine supports it and stop condition met', async () => {
    const engine = makeMockEngine();
    engine.targetBuilders.synthesis = (ctx) => ctx.participants
      .map((p) => ({ agentId: p.agentId, message: 'synthesize' }));

    const config = makeConfig();
    const plugin = createBasePlugin({
      createEngine: () => engine,
      getConfig: () => config,
      engineInitialState: {},
      onRoomStart: vi.fn(),
      shutdown: vi.fn(),
    });

    const ctx = makeMockCtx({ limits: { maxCycles: 1 } });
    plugin.init(ctx);

    // Set up audit phase that will trigger finishSearchCycle
    const state = ctx.getState();
    state.pendingFanOut = 'audit';
    state.phase = PHASES.STATIC_AUDIT;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    state.candidates = [{
      candidateId: 'idx_test', proposalId: 'idx_test', strategyType: 'index',
      cycleIndex: 1, speedupPct: 40, status: 'benchmarked',
      result: { medianMs: 300, p95Ms: 310, cvPct: 2 },
      baseline: { medianMs: 500 },
      planShapeChanged: true,
      applySQL: 'CREATE INDEX idx_test ON t(a)',
      parityChecked: false,
      auditFindings: [], approved: true, telemetryAvailable: false, deployNotes: '',
    }];
    ctx.setState(state);

    const responses = [{ agentId: 'auditor_1', response: makeAuditResponse(true) }];
    const decision = await plugin.onFanOutComplete(ctx, responses);

    const updated = ctx.getState();
    expect(updated.pendingFanOut).toBe('synthesis');
    expect(updated.phase).toBe(PHASES.SYNTHESIS);
    expect(decision.type).toBe('fan_out');
  });
});

// ---------------------------------------------------------------------------
// beforeFinishSearchCycle hook
// ---------------------------------------------------------------------------

describe('beforeFinishSearchCycle hook', () => {
  it('is called before finishing a search cycle', async () => {
    const beforeFinishSearchCycle = vi.fn();
    const plugin = makePlugin({ beforeFinishSearchCycle });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    const state = ctx.getState();
    state.pendingFanOut = 'audit';
    state.phase = PHASES.STATIC_AUDIT;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    ctx.setState(state);

    const responses = [{ agentId: 'auditor_1', response: JSON.stringify({ summary: 'ok', audits: [] }) }];
    await plugin.onFanOutComplete(ctx, responses);

    expect(beforeFinishSearchCycle).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// filterRetestCandidates hook
// ---------------------------------------------------------------------------

describe('filterRetestCandidates hook', () => {
  it('filters retest candidates through the hook', async () => {
    const filterRetestCandidates = vi.fn().mockReturnValue([]); // filter out all
    const plugin = makePlugin({ filterRetestCandidates });
    const ctx = makeMockCtx();
    plugin.init(ctx);

    // Set up a state where retest would normally be triggered
    const state = ctx.getState();
    state.pendingFanOut = 'audit';
    state.phase = PHASES.STATIC_AUDIT;
    state.cycleIndex = 1;
    state.baselines = { medianMs: 500 };
    state.candidates = [{
      candidateId: 'c1', proposalId: 'c1', strategyType: 'index',
      cycleIndex: 1, speedupPct: 15, status: 'benchmarked', needsRetest: true,
      result: { medianMs: 425, cvPct: 5 },
      baseline: { medianMs: 500 },
    }];
    ctx.setState(state);

    const responses = [{ agentId: 'auditor_1', response: JSON.stringify({ summary: 'ok', audits: [] }) }];
    await plugin.onFanOutComplete(ctx, responses);

    expect(filterRetestCandidates).toHaveBeenCalled();
  });
});
