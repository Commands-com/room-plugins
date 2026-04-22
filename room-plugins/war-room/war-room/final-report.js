// ---------------------------------------------------------------------------
// implementation_bundle.v1 assembly. Aggregates the final task board into a
// downstream payload: per-worker assignments, summary counts, changed-file
// artifacts, and each task's result/status/integration notes. Called from
// the factory's getFinalReport hook.
// ---------------------------------------------------------------------------

function collectFileArtifacts(paths) {
  const artifacts = [];
  const seen = new Set();

  for (const value of paths || []) {
    const path = typeof value === 'string' ? value.trim() : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    artifacts.push({ type: 'file', path });
  }

  return artifacts;
}

export function buildImplementationBundleReport(ctx, state) {
  const tasks = Array.isArray(state?.taskBoard) ? state.taskBoard : [];
  const artifacts = collectFileArtifacts(tasks.flatMap((task) => (
    Array.isArray(task.filesChanged) ? task.filesChanged : []
  )));
  const baseReport = typeof ctx.getFinalReport === 'function' ? ctx.getFinalReport() : null;
  const completedTasks = tasks.filter((task) => task.status === 'done');
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const pendingTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'blocked');

  return {
    artifacts,
    payload: {
      contract: 'implementation_bundle.v1',
      data: {
        objective: ctx.objective || '',
        roomId: ctx.roomId || null,
        stopReason: baseReport?.stopReason || null,
        cyclesCompleted: state?.currentCycle ?? ctx.cycle ?? 0,
        workerAssignments: Object.values(state?.workerCapabilities || {}).map((worker) => ({
          agentId: worker.agentId,
          displayName: worker.displayName,
          available: worker.available !== false,
          responsibilities: worker.responsibilities || '',
        })),
        summary: {
          totalTasks: tasks.length,
          completedTasks: completedTasks.length,
          blockedTasks: blockedTasks.length,
          pendingTasks: pendingTasks.length,
          changedFileCount: artifacts.length,
        },
        changedFiles: artifacts.map((artifact) => artifact.path),
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          assignedTo: task.assignedTo,
          dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
          status: task.status,
          result: task.result || '',
          blockedReason: task.blockedReason || null,
          filesChanged: Array.isArray(task.filesChanged) ? task.filesChanged : [],
          integrationNotes: task.integrationNotes || null,
          completedInCycle: task.completedInCycle ?? null,
        })),
      },
    },
  };
}
