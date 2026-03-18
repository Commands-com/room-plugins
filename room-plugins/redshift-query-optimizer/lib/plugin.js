import { buildCompatibilityReport, getConfig } from './config.js';
import { createRedshiftEngine } from './engine.js';
import { MEASURED_STRATEGY_TYPES } from './constants.js';
import {
  connect, disconnect, getClusterInfo, getTableMetadata,
} from './harness.js';
import {
  PHASES,
  assignLanes,
  chooseStopReason,
  evaluateImprovement,
  mergeCycleArtifacts,
  mergeRetestResults,
  recomputeFrontier,
  selectRetestCandidates,
  createInitialState,
  derivePartialPhase,
  advancePhase,
  setPhase,
  buildPendingDecision,
  enqueueProposals,
  selectActivePromotedProposals,
  emitStateMetrics,
  extractQueryTableRefs,
  extractJson,
} from '../../sql-optimizer-core/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILDER_RESPONSE_LANES = new Set(['builder']);
const SCHEMA_REPAIR_SIGNAL_PATTERNS = [
  /"proposalId"\s*:/,
  /"baseline"\s*:/,
  /"candidate"\s*:/,
  /"medianMs"\s*:/,
  /"speedupPct"\s*:/,
];
const MAX_REPAIR_RESPONSE_LEN = 512 * 1024;

function collectSchemaRepairBuilderResponses(state, ctx, responses) {
  return (Array.isArray(responses) ? responses : [])
    .filter((r) => BUILDER_RESPONSE_LANES.has(state.lanesByAgentId[r.agentId] || 'builder'))
    .map((r) => {
      const participant = (ctx.participants || []).find((p) => p.agentId === r.agentId);
      const raw = typeof r.response === 'string' ? r.response : '';
      return {
        agentId: r.agentId,
        displayName: participant?.displayName || r.agentId,
        response: raw.length > MAX_REPAIR_RESPONSE_LEN ? raw.slice(0, MAX_REPAIR_RESPONSE_LEN) : raw,
      };
    })
    .filter((entry) => {
      const text = entry.response.trim();
      return text.length > 0 && SCHEMA_REPAIR_SIGNAL_PATTERNS.some((p) => p.test(text));
    });
}

/**
 * Materialize sort_dist proposals as advisory candidates in state.candidates.
 * They skip the benchmark loop entirely — no builder is asked to measure them.
 * After materialization, they route to audit and appear in the advisory panel.
 */
function materializeAdvisoryProposals(state) {
  const existingIds = new Set(state.candidates.map((c) => c.candidateId));

  // Check both the backlog and active promoted proposals for sort_dist
  const allProposals = [
    ...state.proposalBacklog,
    ...state.activePromotedProposals,
  ];

  for (const proposal of allProposals) {
    if (proposal.strategyType !== 'sort_dist') continue;
    if (existingIds.has(proposal.proposalId)) continue;

    state.candidates.push({
      candidateId: proposal.proposalId,
      proposalId: proposal.proposalId,
      strategyType: 'sort_dist',
      cycleIndex: state.cycleIndex,
      applySQL: proposal.applySQL || '',
      rollbackSQL: '',
      deploySQL: '',
      targetQuery: null,
      baseline: {},
      result: {},
      resultParity: false,
      parityChecked: false,
      speedupPct: null,
      planShapeChanged: false,
      confidenceLevel: 'advisory',
      indexSizeBytes: null,
      explainJSON: null,
      riskScore: 5,
      auditFindings: [],
      telemetryAvailable: false,
      approved: true,
      deployNotes: '',
      status: 'advisory',
      rejectedReason: null,
      owner: proposal.proposedByWorkerId || 'explorer',
      notes: proposal.notes || '',
      rationale: proposal.rationale || '',
    });
    existingIds.add(proposal.proposalId);
  }

  // Remove materialized sort_dist from backlog so they aren't re-promoted
  state.proposalBacklog = state.proposalBacklog.filter(
    (p) => p.strategyType !== 'sort_dist' || !existingIds.has(p.proposalId),
  );
}

// ---------------------------------------------------------------------------
// Synthesis vote merger
// ---------------------------------------------------------------------------

function mergeSynthesisVotes(state, ctx, responses) {
  const votes = [];
  const allProposalIds = new Set(
    state.candidates.filter((c) => c.status !== 'rejected').map((c) => c.proposalId),
  );
  const penaltyRank = allProposalIds.size + 1;

  for (const r of (responses || [])) {
    const role = state.lanesByAgentId[r.agentId] || 'unknown';
    const text = typeof r.response === 'string' ? r.response : '';
    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.ranking)) continue;

    votes.push({
      agentId: r.agentId,
      role,
      ranking: parsed.ranking.filter((e) => e.proposalId && typeof e.rank === 'number'),
      overallAssessment: parsed.overallAssessment || '',
    });
  }

  // Merge rankings: average rank per proposalId across voters
  const rankSums = new Map();
  const rankCounts = new Map();
  const rationales = new Map();

  for (const vote of votes) {
    for (const entry of vote.ranking) {
      const id = entry.proposalId;
      if (!allProposalIds.has(id)) continue;
      rankSums.set(id, (rankSums.get(id) || 0) + entry.rank);
      rankCounts.set(id, (rankCounts.get(id) || 0) + 1);
      if (entry.rationale) {
        if (!rationales.has(id)) rationales.set(id, []);
        rationales.get(id).push(`${vote.role}: ${entry.rationale}`);
      }
    }
  }

  // Proposals not ranked by a voter get penalty rank
  for (const id of allProposalIds) {
    const missing = votes.length - (rankCounts.get(id) || 0);
    if (missing > 0) {
      rankSums.set(id, (rankSums.get(id) || 0) + penaltyRank * missing);
      rankCounts.set(id, votes.length);
    }
  }

  // Sort by average rank
  const merged = [...allProposalIds].map((id) => ({
    proposalId: id,
    avgRank: (rankSums.get(id) || penaltyRank) / (rankCounts.get(id) || 1),
    rationale: (rationales.get(id) || []).join(' | '),
  }));
  merged.sort((a, b) => a.avgRank - b.avgRank);

  // Assign final ranks
  const ranking = merged.map((entry, i) => ({
    proposalId: entry.proposalId,
    rank: i + 1,
    avgRank: Number(entry.avgRank.toFixed(2)),
    rationale: entry.rationale,
  }));

  // Pick the best overall assessment (prefer auditor, then explorer, then builder)
  const assessmentPriority = ['auditor', 'explorer', 'builder'];
  let overallAssessment = '';
  for (const role of assessmentPriority) {
    const vote = votes.find((v) => v.role === role && v.overallAssessment);
    if (vote) {
      overallAssessment = vote.overallAssessment;
      break;
    }
  }
  if (!overallAssessment && votes.length > 0) {
    overallAssessment = votes[0].overallAssessment || '';
  }

  return { ranking, votes, overallAssessment };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createPlugin() {
  const engine = createRedshiftEngine();

  // Engine-specific initial state fields
  const rsInitialState = {
    clusterInfo: null,
    tableMetadata: null,
    connectionClient: null, // not serialized — live pg client
  };

  // Wrap core functions to auto-pass engine hooks
  const _createInitialState = (ctx) => createInitialState(ctx, rsInitialState);
  const _emitStateMetrics = (ctx, state) => {
    const config = getConfig(ctx);
    emitStateMetrics(ctx, state, config, engine);
  };
  const _buildPendingDecision = (ctx, state, config) => buildPendingDecision(ctx, state, config, engine);
  const _mergeCycleArtifacts = (state, responses, config) => mergeCycleArtifacts(state, responses, config, engine);
  const _mergeRetestResults = (state, responses, config) => mergeRetestResults(state, responses, config, engine);
  const _derivePartialPhase = (state, event, config) => derivePartialPhase(state, event, config, engine);

  function finishSearchCycle(ctx, state, config) {
    materializeAdvisoryProposals(state);

    const needsBaselineRetest = state._baselineNeedsRetest && !state.baselines?.retested;
    const retestCandidates = selectRetestCandidates(state, config)
      .filter((c) => MEASURED_STRATEGY_TYPES.includes(c.strategyType));

    if (needsBaselineRetest || retestCandidates.length > 0) {
      state._retestQueue = retestCandidates;
      state.pendingFanOut = 'retest';
      setPhase(state, PHASES.FRONTIER_REFINE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return _buildPendingDecision(ctx, state, config);
    }

    recomputeFrontier(state, config, engine);
    evaluateImprovement(state);

    const stopReason = chooseStopReason(state, config, ctx.limits, engine);
    if (stopReason) {
      // Route to synthesis phase for final vote before completing
      const hasCandidates = state.candidates.some((c) => c.status !== 'rejected');
      if (hasCandidates && engine.targetBuilders.synthesis) {
        state._stopReason = stopReason;
        state.pendingFanOut = 'synthesis';
        setPhase(state, PHASES.SYNTHESIS);
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
        return _buildPendingDecision(ctx, state, config);
      }

      setPhase(state, PHASES.COMPLETE);
      state.pendingFanOut = null;
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return { type: 'stop', reason: stopReason };
    }

    state.cycleIndex += 1;
    ctx.setCycle(state.cycleIndex);
    setPhase(state, PHASES.ANALYSIS);
    state.pendingFanOut = 'planning';
    ctx.setState(state);
    _emitStateMetrics(ctx, state);
    return _buildPendingDecision(ctx, state, config);
  }

  function init(ctx) {
    const state = _createInitialState(ctx);
    const { lanesByAgentId, workersByLane } = assignLanes(ctx.participants || []);
    state.lanesByAgentId = lanesByAgentId;
    state.workersByLane = workersByLane;
    state.workerCount = Object.keys(lanesByAgentId).length;
    ctx.setState(state);
    _emitStateMetrics(ctx, state);
  }

  async function onRoomStart(ctx) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = getConfig(ctx);

    const _progressStart = Date.now();
    const _progressLines = [];
    function emitProgress(msg) {
      const elapsed = ((Date.now() - _progressStart) / 1000).toFixed(1);
      _progressLines.push(`[${elapsed}s] ${msg}`);
      ctx.emitMetrics({ preflightStatus: { type: 'text', value: _progressLines.join('\n') } });
    }

    // ---- Preflight: compatibility check ----
    emitProgress('Checking compatibility...');
    const report = await buildCompatibilityReport(config);
    if (!report.compatible) {
      emitProgress('Compatibility check failed');
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return { type: 'stop', reason: 'global_preflight_failed' };
    }

    // ---- Preflight: Connect and gather metadata ----
    let client;
    try {
      emitProgress('Connecting to Redshift cluster...');
      client = await connect(config.dbUrl);

      emitProgress('Fetching cluster info...');
      state.clusterInfo = await getClusterInfo(client);
      emitProgress(`Cluster: ${state.clusterInfo.versionString?.slice(0, 80) || 'unknown'}`);

      // Pull table metadata for tables referenced in the query
      emitProgress('Analyzing query tables...');
      const tableRefs = extractQueryTableRefs(config.slowQuery);
      if (tableRefs.length > 0) {
        state.tableMetadata = await getTableMetadata(client, tableRefs);
        emitProgress(`Found metadata for ${state.tableMetadata.tableInfo?.length || 0} table(s)`);
      }

      emitProgress('Preflight complete');
    } catch (err) {
      emitProgress(`Connection error: ${err.message}`);
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return { type: 'stop', reason: `connection_error: ${err.message}` };
    } finally {
      await disconnect(client);
    }

    // ---- Transition to BASELINE ----
    setPhase(state, PHASES.BASELINE);
    state.pendingFanOut = 'baseline';
    state.proposalBacklog = [];
    ctx.setCycle(0);
    ctx.setState(state);
    _emitStateMetrics(ctx, state);
    return _buildPendingDecision(ctx, state, config);
  }

  function onTurnResult() {
    return null;
  }

  async function onFanOutComplete(ctx, responses) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = getConfig(ctx);

    // ---- BASELINE fan-out complete ----
    if (state.pendingFanOut === 'baseline') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      state.cycleIndex = 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.ANALYSIS);
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return _buildPendingDecision(ctx, state, config);
    }

    // ---- ANALYSIS/PLANNING fan-out complete ----
    if (state.pendingFanOut === 'planning') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      // Route sort_dist proposals to advisory status immediately
      materializeAdvisoryProposals(state);

      selectActivePromotedProposals(state, config);

      // Check if there are any measurable proposals to benchmark
      const measurableProposals = state.activePromotedProposals.filter(
        (p) => MEASURED_STRATEGY_TYPES.includes(p.strategyType),
      );

      // If we have new advisory candidates but no measurable ones,
      // route to audit so sort_dist recommendations still get reviewed.
      const hasNewAdvisory = state.candidates.some(
        (c) => c.strategyType === 'sort_dist' && c.cycleIndex === state.cycleIndex && c.status === 'advisory',
      );

      if (measurableProposals.length === 0 && hasNewAdvisory) {
        state.schemaRepairBuilderResponses = [];
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'audit';
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
        return _buildPendingDecision(ctx, state, config);
      }

      if (measurableProposals.length === 0) {
        state.plateauCount += 1;
        recomputeFrontier(state, config, engine);

        const stopReason = chooseStopReason(state, config, ctx.limits, engine);
        if (stopReason) {
          setPhase(state, PHASES.COMPLETE);
          state.pendingFanOut = null;
          ctx.setState(state);
          _emitStateMetrics(ctx, state);
          return { type: 'stop', reason: stopReason };
        }

        state.cycleIndex += 1;
        ctx.setCycle(state.cycleIndex);
        setPhase(state, PHASES.ANALYSIS);
        state.pendingFanOut = 'planning';
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
        return _buildPendingDecision(ctx, state, config);
      }

      setPhase(state, PHASES.CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return _buildPendingDecision(ctx, state, config);
    }

    // ---- CODEGEN/CYCLE fan-out complete ----
    if (state.pendingFanOut === 'cycle') {
      const candidateCountBefore = state.candidates.length;
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      const builtNewCandidates = state.candidates.length > candidateCountBefore;

      materializeAdvisoryProposals(state);

      if (builtNewCandidates) {
        state.schemaRepairBuilderResponses = [];
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'audit';
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
        return _buildPendingDecision(ctx, state, config);
      }

      const schemaRepairResponses = collectSchemaRepairBuilderResponses(state, ctx, responses);
      if (schemaRepairResponses.length > 0) {
        state.schemaRepairBuilderResponses = schemaRepairResponses;
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'schema_repair';
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
        return _buildPendingDecision(ctx, state, config);
      }

      return finishSearchCycle(ctx, state, config);
    }

    // ---- AUDIT fan-out complete ----
    if (state.pendingFanOut === 'audit') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- SCHEMA REPAIR fan-out complete ----
    if (state.pendingFanOut === 'schema_repair') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- RETEST fan-out complete ----
    if (state.pendingFanOut === 'retest') {
      _mergeRetestResults(state, responses, config);
      state._retestQueue = [];

      recomputeFrontier(state, config, engine);
      evaluateImprovement(state);

      const stopReason = chooseStopReason(state, config, ctx.limits, engine);
      if (stopReason) {
        // Route to synthesis for final vote
        const hasCandidates = state.candidates.some((c) => c.status !== 'rejected');
        if (hasCandidates && engine.targetBuilders.synthesis) {
          state._stopReason = stopReason;
          state.pendingFanOut = 'synthesis';
          setPhase(state, PHASES.SYNTHESIS);
          ctx.setState(state);
          _emitStateMetrics(ctx, state);
          return _buildPendingDecision(ctx, state, config);
        }

        setPhase(state, PHASES.COMPLETE);
        state.pendingFanOut = null;
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
        return { type: 'stop', reason: stopReason };
      }

      state.cycleIndex += 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.ANALYSIS);
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return _buildPendingDecision(ctx, state, config);
    }

    // ---- SYNTHESIS fan-out complete ----
    if (state.pendingFanOut === 'synthesis') {
      state.synthesisResult = mergeSynthesisVotes(state, ctx, responses);
      state.pendingFanOut = null;
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return { type: 'stop', reason: state._stopReason || 'synthesis_complete' };
    }

    return null;
  }

  function onEvent(ctx, event) {
    if (event?.type === 'fan_out_partial') {
      const state = ctx.getState() || _createInitialState(ctx);
      if (state.pendingFanOut !== 'cycle') return null;
      const config = getConfig(ctx);
      const nextPhase = _derivePartialPhase(state, event, config);
      if (!nextPhase) return null;
      const previousPhase = state.phase;
      advancePhase(state, nextPhase);
      if (state.phase !== previousPhase) {
        ctx.setState(state);
        _emitStateMetrics(ctx, state);
      }
      return null;
    }

    if (event?.type === 'participant_disconnected') {
      const state = ctx.getState() || _createInitialState(ctx);
      setPhase(state, PHASES.FRONTIER_REFINE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return {
        type: 'pause',
        reason: `participant disconnected: ${event.agentId}`,
      };
    }

    if (event?.type === 'user_edit_state') {
      const state = ctx.getState() || _createInitialState(ctx);
      if (event.edits && typeof event.edits === 'object') {
        if (Array.isArray(event.edits.activePromotedProposals)) {
          state.activePromotedProposals = event.edits.activePromotedProposals;
        }
        if (Array.isArray(event.edits.proposalBacklog)) {
          state.proposalBacklog = event.edits.proposalBacklog;
        }
      }
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
    }

    return null;
  }

  function onResume(ctx) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = getConfig(ctx);
    return _buildPendingDecision(ctx, state, config);
  }

  function refreshPendingDecision(ctx, pendingDecision) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = getConfig(ctx);
    return _buildPendingDecision(ctx, state, config) || pendingDecision;
  }

  async function shutdown(_ctx) {
    // No Docker to tear down — nothing to clean up.
    // Connections are short-lived (opened and closed per operation).
  }

  return {
    init,
    onRoomStart,
    onTurnResult,
    onFanOutComplete,
    onEvent,
    onResume,
    refreshPendingDecision,
    shutdown,
  };
}
