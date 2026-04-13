/**
 * War Room state validation — pure validation for task board edits.
 *
 * No Electron deps, no I/O, no mutation.
 */

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate war room state edits against the current task board.
 * Pure validation — does NOT mutate taskBoard or perform cascading cleanup.
 * Mutation logic (dep cascading, clientId resolution) lives in the plugin.
 *
 * @param {object} edits - The edit payload { taskEdits?, taskAdds?, taskRemovals? }
 * @param {Array} taskBoard - Current task board state
 * @param {string[]} availableWorkerIds - Agent IDs of available workers
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWarRoomStateEdit(edits, taskBoard, availableWorkerIds) {
  const errors = [];
  if (!edits || typeof edits !== 'object') {
    return { valid: false, errors: ['edits must be an object'] };
  }

  const taskIds = new Set(taskBoard.map(t => t.id));

  // Normalize taskRemovals early so dependency checks never throw on non-iterable values.
  // The explicit non-array validation error is still produced below.
  const safeTaskRemovals = Array.isArray(edits.taskRemovals) ? edits.taskRemovals : [];

  // Validate taskEdits
  if (edits.taskEdits) {
    if (!Array.isArray(edits.taskEdits)) {
      errors.push('taskEdits must be an array');
    } else {
      for (const edit of edits.taskEdits) {
        if (!edit || !edit.id) {
          errors.push('taskEdit must have an id');
          continue;
        }
        if (!taskIds.has(edit.id)) {
          errors.push(`taskEdit references unknown task ID: ${edit.id}`);
          continue;
        }
        if (edit.assignedTo !== undefined && edit.assignedTo !== null && !availableWorkerIds.includes(edit.assignedTo)) {
          errors.push(`taskEdit[${edit.id}].assignedTo: unknown or unavailable worker "${edit.assignedTo}"`);
        }
        if (edit.status !== undefined && !['pending', 'blocked', 'integration_failed'].includes(edit.status)) {
          errors.push(`taskEdit[${edit.id}].status: only "pending", "blocked", or "integration_failed" allowed, got "${edit.status}"`);
        }
        if (edit.dependencies !== undefined) {
          if (!Array.isArray(edit.dependencies)) {
            errors.push(`taskEdit[${edit.id}].dependencies must be an array`);
          } else {
            const removedIds = new Set(safeTaskRemovals);
            for (const dep of edit.dependencies) {
              if (dep === edit.id) {
                errors.push(`taskEdit[${edit.id}].dependencies: self-dependency is not allowed`);
              } else if (!taskIds.has(dep)) {
                errors.push(`taskEdit[${edit.id}].dependencies: unknown task ID "${dep}"`);
              } else if (removedIds.has(dep)) {
                errors.push(`taskEdit[${edit.id}].dependencies: dependency "${dep}" is being removed in the same edit`);
              }
            }
          }
        }
      }
    }
  }

  // Validate taskAdds
  if (edits.taskAdds) {
    if (!Array.isArray(edits.taskAdds)) {
      errors.push('taskAdds must be an array');
    } else {
      const clientIds = new Set();
      for (const add of edits.taskAdds) {
        if (!add || typeof add !== 'object') {
          errors.push('each taskAdd must be an object');
          continue;
        }
        if (!isNonEmptyString(add.title)) {
          errors.push('taskAdd must have a title');
        }
        if (!isNonEmptyString(add.description)) {
          errors.push('taskAdd must have a description');
        }
        if (!isNonEmptyString(add.assignedTo)) {
          errors.push('taskAdd must have an assignedTo');
        } else if (!availableWorkerIds.includes(add.assignedTo)) {
          errors.push(`taskAdd.assignedTo: unknown or unavailable worker "${add.assignedTo}"`);
        }
        if (add.clientId !== undefined) {
          if (clientIds.has(add.clientId)) {
            errors.push(`duplicate clientId in taskAdds: "${add.clientId}"`);
          }
          if (taskIds.has(add.clientId)) {
            errors.push(`taskAdd clientId "${add.clientId}" collides with an existing task ID`);
          }
          clientIds.add(add.clientId);
        }
      }

      // Validate dependency references for taskAdds (second pass, after collecting all clientIds).
      // Dependencies may reference existing task IDs or clientIds of other taskAdds in the same batch.
      const removedIds = new Set(safeTaskRemovals);
      for (const add of edits.taskAdds) {
        if (!add || typeof add !== 'object' || !Array.isArray(add.dependencies)) continue;
        for (const dep of add.dependencies) {
          if (add.clientId !== undefined && dep === add.clientId) {
            errors.push(`taskAdd "${add.title}": self-dependency is not allowed`);
          } else if (!taskIds.has(dep) && !clientIds.has(dep)) {
            errors.push(`taskAdd "${add.title}": dependency references unknown task/clientId "${dep}"`);
          } else if (removedIds.has(dep)) {
            errors.push(`taskAdd "${add.title}": dependency "${dep}" is being removed in the same edit`);
          }
        }
      }
    }
  }

  // Validate taskRemovals
  if (edits.taskRemovals) {
    if (!Array.isArray(edits.taskRemovals)) {
      errors.push('taskRemovals must be an array');
    } else {
      for (const id of edits.taskRemovals) {
        if (!taskIds.has(id)) {
          errors.push(`taskRemoval references unknown task ID: ${id}`);
        } else {
          const task = taskBoard.find(t => t.id === id);
          if (task && task.status === 'in_progress') {
            errors.push(`cannot remove in_progress task: ${id}`);
          }
        }
      }
    }
  }

  // Check for circular dependencies if taskEdits modify dependencies
  if (Array.isArray(edits.taskEdits)) {
    const editsWithDeps = edits.taskEdits.filter(e => e != null && typeof e === 'object' && Array.isArray(e.dependencies));
    if (editsWithDeps.length > 0) {
      // Build adjacency from current board with edits applied
      const depMap = new Map();
      for (const task of taskBoard) {
        depMap.set(task.id, [...(task.dependencies || [])]);
      }
      for (const edit of editsWithDeps) {
        if (depMap.has(edit.id)) {
          depMap.set(edit.id, [...(edit.dependencies || [])]);
        }
      }
      if (hasCyclicDeps(depMap)) {
        errors.push('dependency edits would create a circular dependency');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Detect cycles in a dependency graph (Map<id, depIds[]>). */
export function hasCyclicDeps(depMap) {
  const visited = new Set();
  const stack = new Set();

  function visit(id) {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    for (const dep of (depMap.get(id) || [])) {
      if (visit(dep)) return true;
    }
    stack.delete(id);
    return false;
  }

  for (const id of depMap.keys()) {
    if (visit(id)) return true;
  }
  return false;
}
