// ---------------------------------------------------------------------------
// Dispatch selection: pick the set of tasks to run in the next window from
// the ready list. One-worker-at-a-time via deduplicateByWorker, write-task
// concurrency capped by maxParallelWrites, and elastic-worker capacity
// requests trimmed to what's actually needed in this dispatch.
// ---------------------------------------------------------------------------

import {
  getMaxParallelWrites,
  useElasticWorkers,
  useIsolatedWriteWorktrees,
} from './config.js';
import { parseReplicaPlaceholder } from '../war-room-prompts.js';

export function deduplicateByWorker(tasks) {
  const seen = new Set();
  const result = [];
  for (const task of tasks) {
    if (!seen.has(task.assignedTo)) {
      seen.add(task.assignedTo);
      result.push(task);
    }
  }
  return result;
}

export function isWriteTask(task) {
  return task?.requiresWrite !== false;
}

export function getReadyTasks(taskBoard) {
  return taskBoard.filter((t) =>
    t.status === 'pending' &&
    typeof t.assignedTo === 'string' &&
    t.assignedTo.trim().length > 0 &&
    t.dependencies.every((dep) => {
      const depTask = taskBoard.find((d) => d.id === dep);
      return depTask && depTask.status === 'done';
    }),
  );
}

export function selectDispatchableTasks(ctx, tasks) {
  const uniqueTasks = deduplicateByWorker(tasks);
  const maxParallelWrites = getMaxParallelWrites(ctx);
  const dispatchable = [];
  let writeCount = 0;

  for (const task of uniqueTasks) {
    if (isWriteTask(task)) {
      if (writeCount >= maxParallelWrites) continue;
      writeCount += 1;
    }
    dispatchable.push(task);
  }

  return dispatchable;
}

export function buildImmediateCapacityRequests(dispatchable, pendingCapacityRequests = []) {
  const directSourceAssignments = new Set();
  const highestPlaceholderIndexBySource = new Map();

  for (const task of Array.isArray(dispatchable) ? dispatchable : []) {
    const assignedTo = typeof task?.assignedTo === 'string' ? task.assignedTo.trim() : '';
    if (!assignedTo) continue;
    const placeholder = parseReplicaPlaceholder(assignedTo);
    if (placeholder) {
      highestPlaceholderIndexBySource.set(
        placeholder.sourceAgentId,
        Math.max(highestPlaceholderIndexBySource.get(placeholder.sourceAgentId) || 0, placeholder.index),
      );
      continue;
    }
    directSourceAssignments.add(assignedTo);
  }

  const filtered = [];
  for (const request of Array.isArray(pendingCapacityRequests) ? pendingCapacityRequests : []) {
    const sourceAgentId = typeof request?.sourceAgentId === 'string' ? request.sourceAgentId.trim() : '';
    if (!sourceAgentId) continue;
    const highestPlaceholderIndex = highestPlaceholderIndexBySource.get(sourceAgentId) || 0;
    if (highestPlaceholderIndex <= 0) continue;
    const baselineCapacity = directSourceAssignments.has(sourceAgentId) ? 0 : 1;
    const immediateReplicaNeed = Math.max(0, highestPlaceholderIndex - baselineCapacity);
    if (immediateReplicaNeed <= 0) continue;
    filtered.push({
      ...request,
      count: Math.min(
        immediateReplicaNeed,
        Number.isInteger(request?.count) && request.count >= 1 ? request.count : immediateReplicaNeed,
      ),
    });
  }

  return filtered;
}

export function buildDispatchMetadata(ctx, state, dispatchable) {
  const metadata = {
    taskIds: dispatchable.map((task) => task.id),
    writeTaskIds: dispatchable.filter((task) => isWriteTask(task)).map((task) => task.id),
    maxParallelWrites: getMaxParallelWrites(ctx),
    isolatedWriteWorktrees: useIsolatedWriteWorktrees(ctx),
  };
  if (useElasticWorkers(ctx)) {
    metadata.elasticWorkers = {
      enabled: true,
      capacityRequests: buildImmediateCapacityRequests(dispatchable, state.pendingCapacityRequests),
    };
  }
  return metadata;
}
