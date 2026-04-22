// ---------------------------------------------------------------------------
// Phase flow. issuePhaseDecision builds the next fan-out (explore/refine/
// review); continueFromCollectedResponses is the gate between phases,
// running synthesis after review, stopping on convergence or cycle limit,
// and otherwise advancing to the next refine cycle.
// ---------------------------------------------------------------------------

import { PHASES } from './constants.js';
import { titleCase } from './text-utils.js';
import {
  appendFeed,
  ensureRound,
  updateAgentStatuses,
} from './rounds.js';
import {
  buildPendingTargetsForPhase,
  buildTargetsForPhase,
} from './prompts.js';
import { summarizeReviewRound } from './review-model.js';
import { synthesizeConcepts } from './synthesis.js';
import { emitMetrics } from './metrics.js';

export function issuePhaseDecision(ctx, state, phase, options = {}) {
  state.phase = phase;
  ensureRound(state, phase, state.cycleCount);

  const targets = options.pendingOnly
    ? buildPendingTargetsForPhase(state, phase)
    : buildTargetsForPhase(state, phase);

  updateAgentStatuses(state, targets.map((target) => target.agentId), 'assigned');
  appendFeed(
    state,
    options.pendingOnly
      ? `Resuming ${phase} pass — ${targets.length} contributor(s) remaining.`
      : (phase === PHASES.EXPLORE
          ? `Starting explore pass for seed mode ${state.config.seedModeLabel}.`
          : phase === PHASES.REFINE
            ? `Starting refine pass for cycle ${state.cycleCount}.`
            : `Starting peer review for cycle ${state.cycleCount}.`),
  );
  ctx.setCycle(state.cycleCount);
  ctx.setState(state);
  emitMetrics(ctx, state);

  return {
    type: 'fan_out',
    targets,
    metadata: {
      phase,
      cycle: state.cycleCount,
      label: options.pendingOnly ? `resume-${phase}` : `${phase}-${state.cycleCount}`,
    },
  };
}

export function stopForMissingRoles(ctx, state) {
  appendFeed(state, `Cannot start Explore Room without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `missing_required_roles:${state.missingRoles.join(',')}`,
  };
}

function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, 'Explore room complete. The selected concept bundle is ready for downstream rooms.');
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

export async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.EXPLORE || state.phase === PHASES.REFINE) {
    const conceptCount = ensureRound(state, state.phase, state.cycleCount).responses.length;
    appendFeed(state, `Collected ${conceptCount} concept brief${conceptCount === 1 ? '' : 's'}.`);
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const summary = summarizeReviewRound(ensureRound(state, PHASES.REVIEW, state.cycleCount), state);
    appendFeed(state, `Collected ${summary.reviewBlockCount} peer review block${summary.reviewBlockCount === 1 ? '' : 's'}.`);
    state.phase = PHASES.SYNTHESIZE;
    const synthesis = synthesizeConcepts(state);
    if (synthesis.selected) {
      appendFeed(state, `${synthesis.selected.title} is the selected concept at ${synthesis.selected.averageScore.toFixed(1)} / 10.`);
    }
    if (summary.mustChangeCount === 0) {
      appendFeed(state, 'No material refinements were requested in review. Ending exploration.');
      return finalizeRoom(ctx, state, 'convergence');
    }
    if (state.cycleCount >= state.maxCycles) {
      appendFeed(state, `Reached the cycle limit at cycle ${state.cycleCount} with remaining refinement requests.`);
      return finalizeRoom(ctx, state, 'cycle_limit');
    }
    state.cycleCount += 1;
    return issuePhaseDecision(ctx, state, PHASES.REFINE);
  }

  appendFeed(state, `Unexpected collected-response continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `unexpected_resume_phase:${state.phase}`,
  };
}
