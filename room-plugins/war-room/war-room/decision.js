// ---------------------------------------------------------------------------
// Decision building. buildDecision inspects the task board and emits the
// next runtime directive: FAN_OUT/SPEAK for ready tasks, PAUSE for
// unassignable/blocked/deadlocked states, STOP on convergence or cycle
// limit. wrapForSemiAuto swaps a FAN_OUT for a PAUSE in semi_auto mode so
// the user can review before dispatch. regenerateDispatch is used to
// refresh a queued pendingFanOut after user edits to the task board.
// ---------------------------------------------------------------------------

import { DECISION_TYPES, STOP_REASON } from '../../core-room-support/room-contracts.js';
import { buildTaskAssignmentPrompt } from '../war-room-prompts.js';
import {
  buildDispatchMetadata,
  getReadyTasks,
  selectDispatchableTasks,
} from './dispatch.js';
import { getWorkerCapabilityForAssignment } from './workers.js';

export function buildDecision(ctx, state) {
  const readyTasks = getReadyTasks(state.taskBoard);
  const readyButUnassigned = state.taskBoard.filter((t) =>
    t.status === 'pending' &&
    (!t.assignedTo || typeof t.assignedTo !== 'string' || t.assignedTo.trim().length === 0) &&
    t.dependencies.every((dep) => {
      const depTask = state.taskBoard.find((d) => d.id === dep);
      return depTask && depTask.status === 'done';
    }),
  );

  if (readyTasks.length === 0) {
    const allDone = state.taskBoard.every((t) => t.status === 'done');
    if (allDone) {
      return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE };
    }

    const inProgressTasks = state.taskBoard.filter((t) => t.status === 'in_progress');
    const blockedTasks = state.taskBoard.filter((t) => t.status === 'blocked');
    const integrationFailedTasks = state.taskBoard.filter((t) => t.status === 'integration_failed');
    const isDeadlocked = inProgressTasks.length === 0 && blockedTasks.length > 0;

    if (readyButUnassigned.length > 0 || integrationFailedTasks.length > 0) {
      return { type: DECISION_TYPES.PAUSE, reason: 'tasks_unassigned' };
    }

    if (isDeadlocked) {
      if (state.blockedPauseIssued) {
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES };
      }
      state.blockedPauseIssued = true;
      return { type: DECISION_TYPES.PAUSE, reason: 'tasks_blocked' };
    }

    if (inProgressTasks.length > 0) {
      return null; // wait for responses
    }

    return { type: DECISION_TYPES.PAUSE, reason: 'waiting_for_dependencies' };
  }

  const availableReady = readyTasks.filter((t) => {
    const cap = getWorkerCapabilityForAssignment(state, t.assignedTo);
    return cap && cap.available !== false;
  });

  if (availableReady.length === 0) {
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
  }

  const dispatchable = selectDispatchableTasks(ctx, availableReady);

  state.currentCycle += 1;
  ctx.setCycle(state.currentCycle);

  if (state.currentCycle > ctx.limits.maxCycles) {
    return {
      type: DECISION_TYPES.STOP,
      reason: STOP_REASON.CYCLE_LIMIT,
    };
  }

  for (const task of dispatchable) {
    task.status = 'in_progress';
    task.assignedInCycle = state.currentCycle;
  }

  if (dispatchable.length === 1) {
    return {
      type: DECISION_TYPES.SPEAK,
      agentId: dispatchable[0].assignedTo,
      message: buildTaskAssignmentPrompt(
        dispatchable[0],
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: dispatchable[0].id,
      taskTitle: dispatchable[0].title,
      dependencies: Array.isArray(dispatchable[0].dependencies) ? [...dispatchable[0].dependencies] : [],
      requiresWrite: dispatchable[0].requiresWrite,
      metadata: buildDispatchMetadata(ctx, state, dispatchable),
    };
  }

  return {
    type: DECISION_TYPES.FAN_OUT,
    targets: dispatchable.map((t) => ({
      agentId: t.assignedTo,
      message: buildTaskAssignmentPrompt(
        t,
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: t.id,
      taskTitle: t.title,
      dependencies: Array.isArray(t.dependencies) ? [...t.dependencies] : [],
      requiresWrite: t.requiresWrite,
    })),
    metadata: buildDispatchMetadata(ctx, state, dispatchable),
  };
}

export function wrapForSemiAuto(ctx, state, decision) {
  if (!decision) return decision;
  if (ctx.mode !== 'semi_auto') return decision;
  if (decision.type === DECISION_TYPES.STOP || decision.type === DECISION_TYPES.PAUSE) return decision;

  if (decision.type === DECISION_TYPES.FAN_OUT) {
    state.pendingFanOut = decision;
    return { type: DECISION_TYPES.PAUSE, reason: 'semi_auto_review' };
  }

  return decision;
}

export function regenerateDispatch(ctx, state) {
  const readyTasks = getReadyTasks(state.taskBoard);
  if (readyTasks.length === 0) return null;

  const availableReady = readyTasks.filter((t) => {
    const cap = getWorkerCapabilityForAssignment(state, t.assignedTo);
    return cap && cap.available !== false;
  });
  if (availableReady.length === 0) return null;

  const dispatchable = selectDispatchableTasks(ctx, availableReady);

  for (const task of dispatchable) {
    task.status = 'in_progress';
  }

  if (dispatchable.length === 1) {
    return {
      type: DECISION_TYPES.SPEAK,
      agentId: dispatchable[0].assignedTo,
      message: buildTaskAssignmentPrompt(
        dispatchable[0],
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: dispatchable[0].id,
      taskTitle: dispatchable[0].title,
      dependencies: Array.isArray(dispatchable[0].dependencies) ? [...dispatchable[0].dependencies] : [],
      requiresWrite: dispatchable[0].requiresWrite,
      metadata: buildDispatchMetadata(ctx, state, dispatchable),
    };
  }

  return {
    type: DECISION_TYPES.FAN_OUT,
    targets: dispatchable.map((t) => ({
      agentId: t.assignedTo,
      message: buildTaskAssignmentPrompt(
        t,
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: t.id,
      taskTitle: t.title,
      dependencies: Array.isArray(t.dependencies) ? [...t.dependencies] : [],
      requiresWrite: t.requiresWrite,
    })),
    metadata: buildDispatchMetadata(ctx, state, dispatchable),
  };
}
