import { existsSync } from 'node:fs';

import { PHASES } from './constants.js';
import { summarizeReviews } from './analysis-model.js';
import { emitMetrics } from './metrics.js';
import {
  appendFeed,
  ensureRound,
  updateAgentStatuses,
} from './state.js';
import { buildPendingTargetsForPhase, buildTargetsForPhase } from './prompts.js';
import { titleCase } from './utils.js';

export function issuePhaseDecision(ctx, state, phase, options = {}) {
  state.phase = phase;
  ensureRound(state, phase, state.cycleCount);
  const targets = options.pendingOnly ? buildPendingTargetsForPhase(state, phase) : buildTargetsForPhase(state, phase);
  updateAgentStatuses(state, targets.map((target) => target.agentId), 'assigned');
  appendFeed(
    state,
    options.pendingOnly
      ? `Resuming ${phase} pass — ${targets.length} contributor(s) remaining.`
      : phase === PHASES.WRITE
        ? `Starting write pass for ${state.analysisPath}.`
        : phase === PHASES.REVIEW
          ? `Starting review pass for pass ${state.cycleCount}.`
          : `Starting revise pass for pass ${state.cycleCount}.`,
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
      label: options.pendingOnly ? `resume-${phase}-${state.cycleCount}` : `${phase}-${state.cycleCount}`,
    },
  };
}

export function stopForMissingRoles(ctx, state) {
  appendFeed(state, `Cannot start without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `missing_required_roles:${state.missingRoles.join(',')}` };
}

export function stopForMissingPaths(ctx, state) {
  const missing = [];
  if (!state.config.projectDir) missing.push('projectDir');
  if (!state.config.outputDir) missing.push('outputDir');
  appendFeed(state, `Cannot start without required paths: ${missing.join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `missing_required_paths:${missing.join(',')}` };
}

export function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Competitive analysis complete. Review ${state.analysisPath}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

export async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.WRITE || state.phase === PHASES.REVISE) {
    const exists = state.analysisPath && existsSync(state.analysisPath);
    appendFeed(
      state,
      exists
        ? `${titleCase(state.phase)} pass finished. Analysis file is present.`
        : `${titleCase(state.phase)} pass finished, but the analysis file is still missing.`,
    );
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const reviewSummary = summarizeReviews(ensureRound(state, PHASES.REVIEW, state.cycleCount));
    appendFeed(state, `Review pass collected ${reviewSummary.mustChange.length} required change${reviewSummary.mustChange.length === 1 ? '' : 's'}.`);
    if (reviewSummary.mustChange.length === 0) {
      return finalizeRoom(ctx, state, 'convergence');
    }
    if (state.cycleCount >= state.maxCycles) {
      return finalizeRoom(ctx, state, 'cycle_limit');
    }
    state.cycleCount += 1;
    return issuePhaseDecision(ctx, state, PHASES.REVISE);
  }

  appendFeed(state, `Unexpected continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `unexpected_resume_phase:${state.phase}` };
}
