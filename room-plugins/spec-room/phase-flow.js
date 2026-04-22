// ---------------------------------------------------------------------------
// Phase flow — the heart of the lifecycle. issuePhaseDecision fans out to
// targets for the next phase; continueFromCollectedResponses reads the
// canonical spec file between phases and decides whether to move to review,
// revise, or finalize. loadSpecFromFile and friends keep the filesystem
// interactions narrow so tests can reason about state transitions without
// reaching through a larger module.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PHASES, SPEC_TEXT_LIMITS } from './constants.js';
import { safeTrim, titleCase, inferTitle } from './text-utils.js';
import {
  ensureRound,
  appendFeed,
  updateAgentStatuses,
} from './rounds.js';
import {
  buildTargetsForPhase,
  buildPendingTargetsForPhase,
} from './prompts.js';
import {
  parseFinalSpecMarkdown,
  summarizeReviewRound,
} from './spec-model.js';
import { emitMetrics } from './metrics.js';

export function issuePhaseDecision(ctx, state, phase, options = {}) {
  if (!options.pendingOnly && !options.preservePassCount) {
    state.passCount += 1;
  }

  state.phase = phase;
  state.finalRevisionPass = Boolean(options.preservePassCount && phase === PHASES.REVISE);
  ensureRound(state, phase, state.passCount);

  const targets = options.pendingOnly
    ? buildPendingTargetsForPhase(state, phase)
    : buildTargetsForPhase(state, phase);

  updateAgentStatuses(
    state,
    targets.map((target) => target.agentId),
    'assigned',
  );

  const phaseMessage = options.pendingOnly
    ? (phase === PHASES.WRITE
        ? `Resuming write pass — ${targets.length} contributor(s) remaining.`
        : (phase === PHASES.REVIEW
            ? `Resuming review pass — ${targets.length} contributor(s) remaining.`
            : `Resuming revise pass — ${targets.length} contributor(s) remaining.`))
    : (options.preservePassCount && phase === PHASES.REVISE
        ? `Starting final revise pass against ${state.specFilePath}.`
        : (phase === PHASES.WRITE
        ? `Starting write pass. ${state.specFilePath} is the canonical spec file.`
        : (phase === PHASES.REVIEW
            ? `Starting review pass against ${state.specFilePath}.`
            : `Starting revise pass against ${state.specFilePath}.`)));

  appendFeed(state, phaseMessage);
  ctx.setCycle(state.passCount);
  ctx.setState(state);
  emitMetrics(ctx, state);

  return {
    type: 'fan_out',
    targets,
    metadata: {
      phase,
      pass: state.passCount,
      specFilePath: state.specFilePath,
      label: options.pendingOnly ? `resume-${phase}-${state.passCount}` : `${phase}-${state.passCount}`,
    },
  };
}

export function stopForMissingRoles(ctx, state) {
  appendFeed(
    state,
    `Cannot start Spec Room without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`,
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `missing_required_roles:${state.missingRoles.join(',')}`,
  };
}

export function stopForMissingSpecPath(ctx, state) {
  appendFeed(
    state,
    'Cannot start Spec Room without an export directory and export file name from the room setup UI.',
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: 'missing_spec_output_path',
  };
}

export function ensureSpecDirectory(state) {
  if (!state.specFilePath) return;
  try {
    mkdirSync(path.dirname(state.specFilePath), { recursive: true });
  } catch {
    // Let the authoring pass surface any filesystem issue more directly.
  }
}

function loadSpecFromFile(state) {
  try {
    const markdown = readFileSync(state.specFilePath, 'utf-8');
    const cleaned = safeTrim(markdown, SPEC_TEXT_LIMITS.storedResponse * 2);
    if (!cleaned) {
      return { ok: false, reason: 'spec_file_empty' };
    }

    const parsed = parseFinalSpecMarkdown(cleaned, state);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }

    state.currentSpecMarkdown = cleaned;
    state.draftSpec = parsed.spec;
    state.exportedSpecPath = state.specFilePath;
    state.exportError = '';
    return {
      ok: true,
      markdown: cleaned,
      spec: parsed.spec,
      path: state.specFilePath,
    };
  } catch (error) {
    const message = safeTrim(error?.message || String(error), 240) || 'spec_file_missing';
    state.exportedSpecPath = '';
    state.exportError = message;
    return { ok: false, reason: message };
  }
}

function finalizeSpec(ctx, state, reason) {
  state.finalSpec = state.draftSpec;
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Final spec ready: ${state.finalSpec?.title || inferTitle(state.objective)}`);
  if (state.exportedSpecPath) {
    appendFeed(state, `Using canonical spec file at ${state.exportedSpecPath}`);
  }
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

export async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.WRITE) {
    appendFeed(state, `Collected ${ensureRound(state, PHASES.WRITE, state.passCount).responses.length} author response${ensureRound(state, PHASES.WRITE, state.passCount).responses.length === 1 ? '' : 's'}.`);

    const loaded = loadSpecFromFile(state);
    if (!loaded.ok) {
      appendFeed(state, `The canonical spec file could not be loaded after the write pass: ${loaded.reason}`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `spec_file_invalid_after_write:${loaded.reason}`,
      };
    }

    appendFeed(state, `Initial spec loaded from ${loaded.path}.`);
    if (state.passCount >= state.maxPasses) {
      return finalizeSpec(ctx, state, 'cycle_limit');
    }
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const reviewRound = ensureRound(state, PHASES.REVIEW, state.passCount);
    const summary = summarizeReviewRound(reviewRound);

    appendFeed(
      state,
      `Collected ${summary.reviewerCount} review response${summary.reviewerCount === 1 ? '' : 's'} with ${summary.mustChangeCount} required change${summary.mustChangeCount === 1 ? '' : 's'}.`,
    );

    const loaded = loadSpecFromFile(state);
    if (!loaded.ok) {
      appendFeed(state, `The canonical spec file could not be loaded during review: ${loaded.reason}`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `spec_file_invalid_during_review:${loaded.reason}`,
      };
    }

    if (!summary.needsRevision) {
      return finalizeSpec(ctx, state, 'convergence');
    }

    if (state.passCount >= state.maxPasses) {
      appendFeed(state, 'Reached the pass limit during review. Handing the spec back to the implementer for one final revision pass.');
      return issuePhaseDecision(ctx, state, PHASES.REVISE, { preservePassCount: true });
    }

    return issuePhaseDecision(ctx, state, PHASES.REVISE);
  }

  if (state.phase === PHASES.REVISE) {
    appendFeed(state, `Collected ${ensureRound(state, PHASES.REVISE, state.passCount).responses.length} revise response${ensureRound(state, PHASES.REVISE, state.passCount).responses.length === 1 ? '' : 's'}.`);

    const loaded = loadSpecFromFile(state);
    if (!loaded.ok) {
      appendFeed(state, `The canonical spec file could not be loaded after the revise pass: ${loaded.reason}`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `spec_file_invalid_after_revise:${loaded.reason}`,
      };
    }

    appendFeed(state, `Revised spec loaded from ${loaded.path}.`);
    if (state.passCount >= state.maxPasses) {
      appendFeed(state, 'Reached the pass limit after the revise pass. Stopping with the latest spec file.');
      return finalizeSpec(ctx, state, 'cycle_limit');
    }

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
