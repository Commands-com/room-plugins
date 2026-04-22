// ---------------------------------------------------------------------------
// Task-result application. Takes the parsed worker response + optional
// integration result and mutates the task record: result/filesChanged/
// integrationNotes/integration, plus status (done vs. blocked) and the
// cycle it completed in.
// ---------------------------------------------------------------------------

function mergeIntegrationNotes(baseNotes, integration) {
  const notes = [];
  if (typeof baseNotes === 'string' && baseNotes.trim()) {
    notes.push(baseNotes.trim());
  }
  if (integration?.status === 'merged') {
    const mergeLine = integration.mergeCommitHash
      ? `Merged isolated worktree branch ${integration.branch} back into ${integration.baseBranch} via ${integration.mergeCommitHash}.`
      : `Merged isolated worktree branch ${integration.branch} back into ${integration.baseBranch}.`;
    notes.push(mergeLine);
  }
  return notes.length > 0 ? notes.join('\n\n') : null;
}

export function applyParsedTaskResult(task, parsed, integration, currentCycle) {
  task.result = parsed.summary;
  task.filesChanged = parsed.filesChanged;
  task.integrationNotes = mergeIntegrationNotes(parsed.integrationNotes, integration);
  task.integration = integration || null;

  if (parsed.status === 'blocked') {
    task.status = 'blocked';
    task.blockedReason = parsed.blockedReason;
    task.completedInCycle = currentCycle;
    return;
  }

  task.status = 'done';
  task.blockedReason = null;
  task.completedInCycle = currentCycle;
}
