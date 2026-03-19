import { buildCompatibilityReport, getConfig } from './config.js';
import { createRedshiftEngine } from './engine.js';
import { MEASURED_STRATEGY_TYPES } from './constants.js';
import {
  connect, disconnect, getClusterInfo, getTableMetadata,
} from './harness.js';
import {
  PHASES, setPhase, createBasePlugin,
  extractQueryTableRefs, extractJson,
} from '../../sql-optimizer-core/index.js';

// ---------------------------------------------------------------------------
// Redshift-specific helpers
// ---------------------------------------------------------------------------

/**
 * Materialize sort_dist proposals as advisory candidates in state.candidates.
 * They skip the benchmark loop entirely — no builder is asked to measure them.
 * After materialization, they route to audit and appear in the advisory panel.
 */
function materializeAdvisoryProposals(state) {
  const existingIds = new Set(state.candidates.map((c) => c.candidateId));

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

  const ranking = merged.map((entry, i) => ({
    proposalId: entry.proposalId,
    rank: i + 1,
    avgRank: Number(entry.avgRank.toFixed(2)),
    rationale: entry.rationale,
  }));

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
  return createBasePlugin({
    createEngine: createRedshiftEngine,
    getConfig,
    engineInitialState: {
      clusterInfo: null,
      tableMetadata: null,
      connectionClient: null,
    },

    // ---- Engine-specific: connect and gather metadata ----
    async onRoomStart(ctx, { state, config, engine: _engine, emitStateMetrics: emitMetrics, buildDecision }) {
      const _progressStart = Date.now();
      const _progressLines = [];
      function emitProgress(msg) {
        const elapsed = ((Date.now() - _progressStart) / 1000).toFixed(1);
        _progressLines.push(`[${elapsed}s] ${msg}`);
        ctx.emitMetrics({ preflightStatus: { type: 'text', value: _progressLines.join('\n') } });
      }

      // Compatibility check
      emitProgress('Checking compatibility...');
      const report = await buildCompatibilityReport(config);
      if (!report.compatible) {
        emitProgress('Compatibility check failed');
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'stop', reason: 'global_preflight_failed' };
      }

      // Connect and gather metadata
      let client;
      try {
        emitProgress('Connecting to Redshift cluster...');
        client = await connect(config.dbUrl);

        emitProgress('Fetching cluster info...');
        state.clusterInfo = await getClusterInfo(client);
        emitProgress(`Cluster: ${state.clusterInfo.versionString?.slice(0, 80) || 'unknown'}`);

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
        emitMetrics(ctx, state);
        return { type: 'stop', reason: `connection_error: ${err.message}` };
      } finally {
        await disconnect(client);
      }

      // Transition to BASELINE
      setPhase(state, PHASES.BASELINE);
      state.pendingFanOut = 'baseline';
      state.proposalBacklog = [];
      ctx.setCycle(0);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return buildDecision(ctx, state, config);
    },

    beforeFinishSearchCycle(state) {
      materializeAdvisoryProposals(state);
    },

    filterRetestCandidates(candidates) {
      return candidates.filter((c) => MEASURED_STRATEGY_TYPES.includes(c.strategyType));
    },

    // ---- Planning: materialize advisory proposals before base promotes ----
    beforePromoteProposals(state) {
      materializeAdvisoryProposals(state);
    },

    // ---- Planning: only measurable proposals enter the benchmark cycle ----
    filterPromotedProposals(proposals) {
      return proposals.filter((p) => MEASURED_STRATEGY_TYPES.includes(p.strategyType));
    },

    // ---- Post-cycle: materialize advisory proposals ----
    async afterCycleMerge(_ctx, state, _config, { builtNewCandidates: _builtNewCandidates }) {
      materializeAdvisoryProposals(state);
    },

    // ---- Synthesis: merge votes ----
    onSynthesisComplete(_ctx, state, responses) {
      state.synthesisResult = mergeSynthesisVotes(state, _ctx, responses);
    },

    // ---- Shutdown: no-op ----
    async shutdown(_ctx, _state) {
      // No Docker to tear down — connections are short-lived.
    },
  });
}
