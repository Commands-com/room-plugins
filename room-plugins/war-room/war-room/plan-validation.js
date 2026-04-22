// ---------------------------------------------------------------------------
// Plan validation. After the planner LLM emits a task list, validatePlan
// enforces: unique task IDs, assignable workers (direct + replica
// placeholders), boolean requiresWrite, dependency IDs exist, no cycles,
// and at least one root task.
// ---------------------------------------------------------------------------

import { buildCapacityBudget, isAssignableWorkerId } from './workers.js';

function hasCyclicDeps(depMap) {
  const visited = new Set();
  const inStack = new Set();

  function dfs(id) {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    for (const dep of (depMap.get(id) || [])) {
      if (dfs(dep)) return true;
    }
    inStack.delete(id);
    return false;
  }

  for (const id of depMap.keys()) {
    if (dfs(id)) return true;
  }
  return false;
}

export function validatePlan(tasks, availableWorkerIds, options = {}) {
  const errors = [];
  const taskIds = new Set();
  const capacityBudget = buildCapacityBudget(options.capacityRequests);

  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      errors.push(`Duplicate task ID: "${task.id}"`);
    }
    taskIds.add(task.id);
  }

  for (const task of tasks) {
    if (task.assignedTo === null) {
      errors.push(`Task "${task.id}" must have an assigned worker`);
    } else if (typeof task.assignedTo !== 'string' || task.assignedTo.trim().length === 0) {
      errors.push(`Task "${task.id}" must have an assigned worker`);
    } else if (!isAssignableWorkerId(task.assignedTo, availableWorkerIds, {
      capacityBudget,
      workerCapabilities: options.workerCapabilities || {},
    })) {
      errors.push(`Task "${task.id}" assigned to unknown worker "${task.assignedTo}"`);
    }
    if (typeof task.requiresWrite !== 'boolean') {
      errors.push(`Task "${task.id}" must declare requiresWrite as true or false`);
    }
    for (const dep of task.dependencies) {
      if (!taskIds.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  const depMap = new Map(tasks.map((t) => [t.id, t.dependencies]));
  if (hasCyclicDeps(depMap)) {
    errors.push('Task plan contains circular dependencies');
  }

  const rootTasks = tasks.filter((t) => t.dependencies.length === 0);
  if (rootTasks.length === 0 && tasks.length > 0) {
    errors.push('Task plan has no root tasks (every task has dependencies)');
  }

  return { valid: errors.length === 0, errors };
}
