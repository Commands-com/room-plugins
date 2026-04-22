// ---------------------------------------------------------------------------
// Phase flow — the lifecycle transitions. issuePhaseDecision fans out the
// next phase's targets; continueFromCollectedResponses is the gate between
// phases, wiring up synthesis after review, convergence/cycle-limit checks
// before moving to the next cycle, and the final-room stop.
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
import { refreshSnapshots } from './prototype-fs.js';
import {
  getSynthesisForCycle,
  summarizeReviewRound,
  synthesizeReviewCycle,
} from './review-model.js';
import { emitMetrics } from './metrics.js';

export function issuePhaseDecision(ctx, state, phase, options = {}) {
  state.phase = phase;
  ensureRound(state, phase, state.cycleCount);

  const targets = options.pendingOnly
    ? buildPendingTargetsForPhase(state, phase)
    : buildTargetsForPhase(state, phase);

  updateAgentStatuses(state, targets.map((target) => target.agentId), 'assigned');

  const phaseMessage = options.pendingOnly
    ? `Resuming ${phase} cycle work — ${targets.length} contributor(s) remaining.`
    : (phase === PHASES.BUILD
        ? `Starting build pass for cycle ${state.cycleCount} in ${state.config.outputDir}.`
        : (phase === PHASES.REVIEW
            ? `Starting review cycle ${state.cycleCount} across all prototype folders.`
            : `Starting improve cycle ${state.cycleCount} so each participant can upgrade its own prototype.`));

  appendFeed(state, phaseMessage);
  ctx.setCycle(state.cycleCount);
  ctx.setState(state);
  emitMetrics(ctx, state);

  return {
    type: 'fan_out',
    targets,
    metadata: {
      phase,
      cycle: state.cycleCount,
      outputDir: state.config.outputDir,
      label: options.pendingOnly ? `resume-${phase}-${state.cycleCount}` : `${phase}-${state.cycleCount}`,
    },
  };
}

export function stopForMissingRoles(ctx, state) {
  appendFeed(
    state,
    `Cannot start Prototype Room without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`,
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `missing_required_roles:${state.missingRoles.join(',')}`,
  };
}

export function stopForMissingOutputDir(ctx, state) {
  appendFeed(
    state,
    'Cannot start Prototype Room without an output directory from the room setup UI.',
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: 'missing_output_directory',
  };
}

function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Prototype room complete. Review the folders under ${state.config.outputDir}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

function shouldStopForConvergence(state) {
  const synthesis = getSynthesisForCycle(state, state.cycleCount);
  return Boolean(
    synthesis
      && state.cycleCount >= 2
      && synthesis.reviewBlockCount > 0
      && synthesis.mustChangeCount === 0
  );
}

export async function continueFromCollectedResponses(ctx, state) {
  refreshSnapshots(state);

  if (state.phase === PHASES.BUILD) {
    const snapshots = state.participants.map((participant) => state.snapshots[participant.agentId]);
    const incomplete = snapshots.filter((snapshot) => snapshot && snapshot.status !== 'ready');
    appendFeed(
      state,
      incomplete.length > 0
        ? `Build pass finished with ${incomplete.length} incomplete prototype folder${incomplete.length === 1 ? '' : 's'}. Review will continue with the current snapshots.`
        : 'Build pass finished. All prototype folders have a summary file.',
    );
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const summary = summarizeReviewRound(ensureRound(state, PHASES.REVIEW, state.cycleCount), state);
    appendFeed(
      state,
      `Collected ${summary.reviewBlockCount} peer review block${summary.reviewBlockCount === 1 ? '' : 's'} with ${summary.mustChangeCount} required change${summary.mustChangeCount === 1 ? '' : 's'}.`,
    );
    state.phase = PHASES.SYNTHESIZE;
    const synthesis = synthesizeReviewCycle(state, state.cycleCount);
    const leader = synthesis.ranked[0];
    appendFeed(
      state,
      leader
        ? `Cycle ${state.cycleCount} synthesis complete. ${leader.prototypeLabel} is currently leading at ${leader.averageScore.toFixed(1)} / 10.`
        : `Cycle ${state.cycleCount} synthesis complete.`,
    );
    ctx.setState(state);
    emitMetrics(ctx, state);
    return issuePhaseDecision(ctx, state, PHASES.IMPROVE);
  }

  if (state.phase === PHASES.IMPROVE) {
    appendFeed(state, `Improve cycle ${state.cycleCount} finished.`);
    if (shouldStopForConvergence(state)) {
      appendFeed(state, 'Reviewers are no longer asking for material changes. Stopping after this improve pass.');
      return finalizeRoom(ctx, state, 'convergence');
    }
    if (state.cycleCount >= state.maxCycles) {
      appendFeed(state, 'Reached the configured cycle limit. Final prototype snapshots are ready.');
      return finalizeRoom(ctx, state, 'cycle_limit');
    }

    state.cycleCount += 1;
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  appendFeed(state, `Unexpected collected-response continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `unexpected_resume_phase:${state.phase}`,
  };
}
