// ---------------------------------------------------------------------------
// User-edit application. applyTaskBoardEdits mutates the task board based
// on a validated delta (taskRemovals, taskEdits, taskAdds). Cascades
// removals through dependency lists, remaps clientId references for newly
// added tasks, and runs a final integrity pass to drop dangling/self deps.
// ---------------------------------------------------------------------------

export function applyTaskBoardEdits(state, edits) {
  if (edits.taskRemovals?.length) {
    const removeSet = new Set(edits.taskRemovals);
    state.taskBoard = state.taskBoard.filter((t) => !removeSet.has(t.id));
    for (const task of state.taskBoard) {
      task.dependencies = task.dependencies.filter((d) => !removeSet.has(d));
    }
  }

  if (edits.taskEdits?.length) {
    for (const edit of edits.taskEdits) {
      const task = state.taskBoard.find((t) => t.id === edit.id);
      if (!task) continue;
      if (edit.assignedTo !== undefined) {
        if (task.status === 'in_progress') task.status = 'pending';
        task.assignedTo = edit.assignedTo;
      }
      if (edit.status !== undefined) task.status = edit.status;
      if (edit.dependencies !== undefined) task.dependencies = edit.dependencies;
      if (edit.requiresIntegration !== undefined) task.requiresIntegration = Boolean(edit.requiresIntegration);
      if (edit.requiresWrite !== undefined) task.requiresWrite = Boolean(edit.requiresWrite);
      if (edit.title !== undefined) task.title = edit.title;
      if (edit.description !== undefined) task.description = edit.description;
    }
  }

  if (edits.taskAdds?.length) {
    const clientIdMap = new Map();
    const newTaskIds = new Set();
    for (const add of edits.taskAdds) {
      const newId = `task_${state.nextTaskId++}`;
      newTaskIds.add(newId);
      if (add.clientId) clientIdMap.set(add.clientId, newId);

      state.taskBoard.push({
        id: newId,
        title: add.title,
        description: add.description,
        assignedTo: add.assignedTo,
        dependencies: Array.isArray(add.dependencies) ? [...add.dependencies] : [],
        requiresIntegration: Boolean(add.requiresIntegration),
        requiresWrite: Boolean(add.requiresWrite),
        status: 'pending',
      });
    }

    // Resolve clientId references in dependencies — only for newly added tasks.
    // Remapping globally would corrupt existing dependencies if a clientId
    // happened to match a pre-existing task ID.
    if (clientIdMap.size > 0) {
      for (const task of state.taskBoard) {
        if (!newTaskIds.has(task.id)) continue;
        task.dependencies = task.dependencies.map((dep) => clientIdMap.get(dep) || dep);
      }
    }
  }

  // Drop dangling/self deps so later dispatch logic can't deadlock on them.
  const allTaskIds = new Set(state.taskBoard.map((t) => t.id));
  for (const task of state.taskBoard) {
    task.dependencies = task.dependencies.filter(
      (dep) => dep !== task.id && allTaskIds.has(dep),
    );
  }
}
