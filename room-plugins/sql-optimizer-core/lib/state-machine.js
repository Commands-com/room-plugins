import { PHASES } from './constants.js';
import { setPhase, advancePhase, derivePartialPhase, createInitialState } from './phases.js';
import { assignLanes } from './envelope.js';
import {
  mergeCycleArtifacts, mergeRetestResults,
  recomputeFrontier, evaluateImprovement,
  chooseStopReason, selectRetestCandidates,
} from './candidates.js';
import {
  enqueueProposals, selectActivePromotedProposals, buildPendingDecision,
} from './planning.js';
import { emitStateMetrics } from './report.js';

// ---------------------------------------------------------------------------
// Core state keys — used for engineInitialState collision detection
// ---------------------------------------------------------------------------

const CORE_STATE_KEYS = new Set([
  'phase', 'reachedPhases', 'cycleIndex', 'lanesByAgentId', 'workersByLane',
  'workerCount', 'proposalBacklog', 'activePromotedProposals', 'discoveryNotes',
  'candidates', 'baselines', 'frontierIds', 'bestByStrategyType',
  'safeBestByStrategyType', 'pendingFanOut', 'schemaRepairBuilderResponses',
  'plateauCount', 'bestImprovementPct',
]);

// ---------------------------------------------------------------------------
// Schema repair helpers (shared by all engines)
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

export function collectSchemaRepairBuilderResponses(state, ctx, responses) {
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

// ---------------------------------------------------------------------------
// Base plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates a plugin with the shared state machine skeleton.
 * Engine-specific behaviour is injected via hooks.
 *
 * Required hooks:
 * @param {object}   hooks
 * @param {Function} hooks.createEngine          - () => engine object (see BUILDING_AN_ENGINE.md)
 * @param {Function} hooks.getConfig             - (ctx) => config object
 * @param {object}   hooks.engineInitialState    - Engine-specific state fields. Must NOT collide
 *                                                  with core keys (candidates, baselines, phase, etc.)
 * @param {Function} hooks.onRoomStart           - async (ctx, helpers) => decision
 *                                                  helpers: { state, config, engine, emitStateMetrics, buildDecision, setPhase, PHASES }
 *                                                  Must set up engine infrastructure and return a decision
 *                                                  (typically { type: 'fan_out' } for baseline) or { type: 'stop' }.
 * @param {Function} hooks.shutdown              - async (ctx, state) => void
 *
 * Optional hooks:
 * @param {Function} [hooks.beforeFinishSearchCycle]  - (state) => void
 *   Called at the start of finishSearchCycle. Use for advisory proposal materialization.
 * @param {Function} [hooks.filterRetestCandidates]   - (candidates) => candidates
 *   Filter retest candidates before they enter the retest queue.
 * @param {Function} [hooks.beforePromoteProposals]   - (state, config) => void
 *   Called before selectActivePromotedProposals in the planning phase. Use to materialize
 *   advisory proposals or filter the backlog. The base handles promotion after this returns.
 * @param {Function} [hooks.filterPromotedProposals]  - (proposals) => proposals
 *   Filter promoted proposals after selection. Return only the measurable ones;
 *   the base uses the filtered list to decide whether to enter CODEGEN or handle plateau.
 * @param {Function} [hooks.afterCycleMerge]          - async (ctx, state, config, { builtNewCandidates, responses }) => void
 *   Called after cycle artifacts are merged. Use for harness verification and parity checks.
 * @param {Function} [hooks.afterRetestMerge]         - async (ctx, state, config, { responses, newCandidatesFromRetest, emitStateMetrics, buildDecision }) => decision | null
 *   Called after retest results are merged. Return a decision to override default routing
 *   (e.g., to route new candidates to audit), or null for default behavior.
 * @param {Function} [hooks.onSynthesisComplete]      - (ctx, state, responses) => void
 *   Called when synthesis fan-out completes, before the plugin stops.
 */
export function createBasePlugin(hooks) {
  // Validate engineInitialState for key collisions
  if (hooks.engineInitialState) {
    for (const key of Object.keys(hooks.engineInitialState)) {
      if (CORE_STATE_KEYS.has(key)) {
        throw new Error(
          `engineInitialState key "${key}" collides with a core state key. ` +
          `Use a different name to avoid silently overwriting orchestrator state.`,
        );
      }
    }
  }

  const engine = hooks.createEngine();

  // Wrap core functions to auto-pass engine hooks
  const _createInitialState = (ctx) => createInitialState(ctx, hooks.engineInitialState);
  const _emitStateMetrics = (ctx, state) => {
    const config = hooks.getConfig(ctx);
    emitStateMetrics(ctx, state, config, engine);
  };
  const _buildPendingDecision = (ctx, state, config) => buildPendingDecision(ctx, state, config, engine);
  const _mergeCycleArtifacts = (state, responses, config) => mergeCycleArtifacts(state, responses, config, engine);
  const _mergeRetestResults = (state, responses, config) => mergeRetestResults(state, responses, config, engine);
  const _derivePartialPhase = (state, event, config) => derivePartialPhase(state, event, config, engine);

  // ---- Shared: evaluate stop condition and route to synthesis/complete/next cycle ----
  function evaluateAndRoute(ctx, state, config) {
    recomputeFrontier(state, config, engine);
    evaluateImprovement(state);

    const stopReason = chooseStopReason(state, config, ctx.limits, engine);
    if (stopReason) {
      const hasCandidates = state.candidates.some((c) => c.status !== 'rejected');
      if (hasCandidates && engine.targetBuilders?.synthesis) {
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

    // No stop — advance to next cycle
    state.cycleIndex += 1;
    ctx.setCycle(state.cycleIndex);
    setPhase(state, PHASES.ANALYSIS);
    state.pendingFanOut = 'planning';
    ctx.setState(state);
    _emitStateMetrics(ctx, state);
    return _buildPendingDecision(ctx, state, config);
  }

  // ---- Shared: finish a search cycle ----
  function finishSearchCycle(ctx, state, config) {
    hooks.beforeFinishSearchCycle?.(state);

    const needsBaselineRetest = state._baselineNeedsRetest && !state.baselines?.retested;
    let retestCandidates = selectRetestCandidates(state, config);
    if (hooks.filterRetestCandidates) {
      retestCandidates = hooks.filterRetestCandidates(retestCandidates);
    }

    if (needsBaselineRetest || retestCandidates.length > 0) {
      state._retestQueue = retestCandidates;
      state.pendingFanOut = 'retest';
      setPhase(state, PHASES.FRONTIER_REFINE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return _buildPendingDecision(ctx, state, config);
    }

    return evaluateAndRoute(ctx, state, config);
  }

  // ---- init ----
  function init(ctx) {
    const state = _createInitialState(ctx);
    const { lanesByAgentId, workersByLane } = assignLanes(ctx.participants || []);
    state.lanesByAgentId = lanesByAgentId;
    state.workersByLane = workersByLane;
    state.workerCount = Object.keys(lanesByAgentId).length;
    ctx.setState(state);
    _emitStateMetrics(ctx, state);
  }

  // ---- onRoomStart: delegates to engine hook ----
  async function onRoomStart(ctx) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = hooks.getConfig(ctx);
    return hooks.onRoomStart(ctx, {
      state, config, engine,
      emitStateMetrics: _emitStateMetrics,
      buildDecision: _buildPendingDecision,
      setPhase,
      PHASES,
    });
  }

  function onTurnResult() {
    return null;
  }

  // ---- onFanOutComplete: shared state machine ----
  async function onFanOutComplete(ctx, responses) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = hooks.getConfig(ctx);

    // ---- BASELINE ----
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

    // ---- PLANNING ----
    if (state.pendingFanOut === 'planning') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      // Engine hook: pre-promotion (e.g., materialize advisory proposals)
      hooks.beforePromoteProposals?.(state, config);

      selectActivePromotedProposals(state, config);

      // Engine hook: filter promoted proposals (e.g., keep only measurable ones)
      let promotedProposals = state.activePromotedProposals;
      if (hooks.filterPromotedProposals) {
        promotedProposals = hooks.filterPromotedProposals(promotedProposals);
      }

      // If we have advisory-only candidates (filtered out of promotedProposals) but no
      // measurable ones, route to audit so advisory recommendations still get reviewed.
      const hasNewAdvisory = promotedProposals.length < state.activePromotedProposals.length
        || state.candidates.some((c) => c.status === 'advisory' && c.cycleIndex === state.cycleIndex);

      // Write filtered set back so cycle target builders see only measurable proposals
      state.activePromotedProposals = promotedProposals;

      if (promotedProposals.length === 0) {
        if (hasNewAdvisory) {
          state.schemaRepairBuilderResponses = [];
          setPhase(state, PHASES.STATIC_AUDIT);
          state.pendingFanOut = 'audit';
          ctx.setState(state);
          _emitStateMetrics(ctx, state);
          return _buildPendingDecision(ctx, state, config);
        }

        state.plateauCount += 1;
        return evaluateAndRoute(ctx, state, config);
      }

      setPhase(state, PHASES.CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return _buildPendingDecision(ctx, state, config);
    }

    // ---- CYCLE ----
    if (state.pendingFanOut === 'cycle') {
      const candidateCountBefore = state.candidates.length;
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      const builtNewCandidates = state.candidates.length > candidateCountBefore;

      // Engine hook for post-cycle verification (Postgres: harness verify + parity)
      await hooks.afterCycleMerge?.(ctx, state, config, { builtNewCandidates, responses });

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

    // ---- AUDIT ----
    if (state.pendingFanOut === 'audit') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- SCHEMA REPAIR ----
    if (state.pendingFanOut === 'schema_repair') {
      const { proposals } = _mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- RETEST ----
    if (state.pendingFanOut === 'retest') {
      const candidateCountBefore = state.candidates.length;
      _mergeRetestResults(state, responses, config);
      const newCandidatesFromRetest = state.candidates.length - candidateCountBefore;

      // Engine hook for post-retest verification (Postgres: harness verify + parity)
      const hookDecision = await hooks.afterRetestMerge?.(ctx, state, config, {
        responses, newCandidatesFromRetest,
        emitStateMetrics: _emitStateMetrics,
        buildDecision: _buildPendingDecision,
      });
      if (hookDecision) return hookDecision;

      state._retestQueue = [];
      return evaluateAndRoute(ctx, state, config);
    }

    // ---- SYNTHESIS ----
    if (state.pendingFanOut === 'synthesis') {
      hooks.onSynthesisComplete?.(ctx, state, responses);
      state.pendingFanOut = null;
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      _emitStateMetrics(ctx, state);
      return { type: 'stop', reason: state._stopReason || 'synthesis_complete' };
    }

    return null;
  }

  // ---- onEvent ----
  function onEvent(ctx, event) {
    if (event?.type === 'fan_out_partial') {
      const state = ctx.getState() || _createInitialState(ctx);
      if (state.pendingFanOut !== 'cycle') return null;
      const config = hooks.getConfig(ctx);
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

  // ---- onResume ----
  function onResume(ctx) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = hooks.getConfig(ctx);
    return _buildPendingDecision(ctx, state, config);
  }

  // ---- refreshPendingDecision ----
  function refreshPendingDecision(ctx, pendingDecision) {
    const state = ctx.getState() || _createInitialState(ctx);
    const config = hooks.getConfig(ctx);
    return _buildPendingDecision(ctx, state, config) || pendingDecision;
  }

  // ---- shutdown: delegates to engine hook ----
  async function shutdown(ctx) {
    const state = ctx.getState();
    await hooks.shutdown(ctx, state);
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
