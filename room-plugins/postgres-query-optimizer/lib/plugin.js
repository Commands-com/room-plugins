import { PHASES } from './constants.js';
import { getConfig } from './config.js';
import { buildPendingDecision } from './planning.js';

function createInitialState(ctx) {
  return {
    phase: PHASES.PREFLIGHT,
    cycleIndex: 0,
    candidates: [],
    frontierIds: [],
    baselines: {},
    bestImprovementPct: 0,
    proposalBacklog: [],
    activePromotedProposals: [],
  };
}

export function createPlugin() {
  function init(ctx) {
    const state = createInitialState(ctx);
    ctx.setState(state);
  }

  function onRoomStart(ctx) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);
    
    state.phase = PHASES.BASELINE;
    ctx.setCycle(0);
    ctx.setState(state);
    return buildPendingDecision(ctx, state, config);
  }

  function onFanOutComplete(ctx, responses) {
    const state = ctx.getState();
    const config = getConfig(ctx);

    if (state.phase === PHASES.BASELINE) {
      // Process baseline response...
      state.phase = PHASES.ANALYSIS;
      ctx.setState(state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.phase === PHASES.ANALYSIS) {
      // Process proposed strategies...
      // Promotion logic would go here.
      state.phase = PHASES.CODEGEN;
      ctx.setState(state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.phase === PHASES.CODEGEN) {
      // Process benchmark results...
      state.phase = PHASES.STATIC_AUDIT;
      ctx.setState(state);
      return buildPendingDecision(ctx, state, config);
    }

    if (state.phase === PHASES.STATIC_AUDIT) {
      // Process audit findings...
      state.cycleIndex += 1;
      if (state.cycleIndex >= ctx.limits.maxCycles) {
        state.phase = PHASES.COMPLETE;
        ctx.setState(state);
        return { type: 'stop', reason: 'cycle_limit' };
      }
      state.phase = PHASES.ANALYSIS;
      ctx.setCycle(state.cycleIndex);
      ctx.setState(state);
      return buildPendingDecision(ctx, state, config);
    }

    return null;
  }

  return {
    init,
    onRoomStart,
    onFanOutComplete,
    onResume: (ctx) => buildPendingDecision(ctx, ctx.getState(), getConfig(ctx)),
  };
}
