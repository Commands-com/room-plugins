// ---------------------------------------------------------------------------
// Metrics emission. emitBoardMetrics derives per-worker status (discovering/
// idle/working/done/unavailable), task-summary counters, the rendered task
// board rows (with display-friendly numeric IDs + dependency references),
// and the turn log, then fans them through ctx.emitMetrics.
// ---------------------------------------------------------------------------

export function emitBoardMetrics(ctx, state) {
  const board = state.taskBoard;
  const pending = board.filter((t) => t.status === 'pending').length;
  const inProgress = board.filter((t) => t.status === 'in_progress').length;
  const done = board.filter((t) => t.status === 'done').length;
  const blocked = board.filter((t) => t.status === 'blocked').length;

  const workerStatusMap = {};
  for (const [agentId, cap] of Object.entries(state.workerCapabilities)) {
    const participant = ctx.participants.find((p) => p.agentId === agentId);
    const displayName = participant?.displayName || agentId;
    if (!cap.available) {
      workerStatusMap[displayName] = 'unavailable';
    } else {
      const workerTasks = board.filter((t) => t.assignedTo === agentId);
      const hasInProgress = workerTasks.some((t) => t.status === 'in_progress');
      const allDone = workerTasks.length > 0 && workerTasks.every((t) => t.status === 'done');
      if (hasInProgress) workerStatusMap[displayName] = 'working';
      else if (allDone) workerStatusMap[displayName] = 'done';
      else workerStatusMap[displayName] = 'idle';
    }
  }

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    taskSummary: { pending, inProgress, done, blocked },
    taskProgress: { value: done, max: board.length },
    workerStatus: workerStatusMap,
    taskBoard: {
      rows: board.map((t, idx) => {
        const participant = ctx.participants.find((p) => p.agentId === t.assignedTo);
        const taskNum = String(idx + 1);
        const depNums = t.dependencies.map((depId) => {
          const depIdx = board.findIndex((bt) => bt.id === depId);
          return depIdx >= 0 ? String(depIdx + 1) : depId.replace('task_', '#');
        });
        const assignedLabel = t.assignedTo
          ? (participant?.displayName || t.assignedTo)
          : 'Unassigned';
        return {
          id: t.id,
          taskNum,
          title: t.title,
          agentId: t.assignedTo,
          assignedTo: assignedLabel,
          status: t.status,
          dependencies: depNums.join(', '),
          completedInCycle: t.completedInCycle != null ? `C${t.completedInCycle}` : null,
        };
      }),
    },
    turnLog: { entries: state.turnLog },
  });
}
