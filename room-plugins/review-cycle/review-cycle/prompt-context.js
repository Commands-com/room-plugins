// ---------------------------------------------------------------------------
// Prompt context builders — pure helpers that turn runtime ctx (workspace
// config, worktree path, inbound handoff payloads) into string fragments
// that the prompt templates (prompts.js) splice into reviewer/implementer
// prompts. No I/O, no state.
//
// findInboundPayload is also consumed by findings-metadata.js.
// ---------------------------------------------------------------------------

const HANDOFF_TEXT_LIMIT = 220;
const HANDOFF_LIST_LIMIT = 4;

/**
 * Build workspace context string to append to tool-using participant prompts.
 * Returns empty string when no multi-root workspace or worktree is configured.
 */
export function buildWorkspaceContext(ctx) {
  const workspace = ctx.workspace;
  const worktree = ctx.worktree;
  if (!workspace && !worktree) return '';

  const lines = [];
  if (workspace && workspace.roots && workspace.roots.length > 1) {
    lines.push('');
    lines.push('You have access to the following project directories:');
    for (const root of workspace.roots) {
      if (root === workspace.primaryCwd) {
        lines.push(`  [primary] ${root}`);
      } else {
        lines.push(`  ${root}`);
      }
    }
    lines.push(`Your default working directory is ${workspace.primaryCwd}.`);
  }
  if (worktree) {
    lines.push('');
    lines.push(`Note: Your primary directory is an isolated git worktree at ${worktree.path}.`);
    lines.push('Your changes are isolated from the main working tree. Do not push changes.');
  }
  return lines.join('\n');
}

export function trimPromptText(value, max = HANDOFF_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
}

export function takePromptItems(values, limit = HANDOFF_LIST_LIMIT, max = HANDOFF_TEXT_LIMIT) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => trimPromptText(value, max))
    .filter(Boolean)
    .slice(0, limit);
}

export function findInboundPayload(handoffContext, contract) {
  const payloads = Array.isArray(handoffContext?.payloads) ? handoffContext.payloads : [];
  return payloads.find((payload) => payload?.contract === contract && payload?.data && typeof payload.data === 'object') || null;
}

function buildSpecBundlePromptContext(handoffContext) {
  const payload = findInboundPayload(handoffContext, 'spec_bundle.v1');
  if (!payload) return '';

  const data = payload.data || {};
  const summary = data.summary || {};
  const spec = data.spec || {};
  const lines = ['## Upstream Spec'];

  const title = trimPromptText(summary.title || spec.title, 120);
  if (title) lines.push(`Title: ${title}`);

  const oneLiner = trimPromptText(summary.oneLiner || spec.problem);
  if (oneLiner) lines.push(`Summary: ${oneLiner}`);

  const recommendation = trimPromptText(summary.recommendedDirection, 180);
  if (recommendation) lines.push(`Recommended Direction: ${recommendation}`);

  const acceptance = takePromptItems(spec.acceptanceCriteria);
  if (acceptance.length > 0) lines.push(`Acceptance Criteria: ${acceptance.join(' | ')}`);

  return lines.join('\n');
}

function buildImplementationBundlePromptContext(handoffContext) {
  const payload = findInboundPayload(handoffContext, 'implementation_bundle.v1');
  if (!payload) return '';

  const data = payload.data || {};
  const summary = data.summary || {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const changedFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
  const lines = ['## Upstream Implementation'];

  const objective = trimPromptText(data.objective);
  if (objective) lines.push(`Objective: ${objective}`);

  lines.push(
    `Task Summary: tasks=${Number(summary.totalTasks) || tasks.length || 0}, completed=${Number(summary.completedTasks) || 0}, blocked=${Number(summary.blockedTasks) || 0}`,
  );

  const keyTasks = tasks
    .filter((task) => task?.status === 'done' || task?.status === 'blocked')
    .slice(0, HANDOFF_LIST_LIMIT)
    .map((task) => {
      const title = trimPromptText(task?.title, 120);
      const status = trimPromptText(task?.status, 32);
      const result = trimPromptText(task?.result || task?.description, 160);
      return [title && `${status ? `[${status}] ` : ''}${title}`, result].filter(Boolean).join(' — ');
    })
    .filter(Boolean);
  if (keyTasks.length > 0) lines.push(`Key Tasks: ${keyTasks.join(' | ')}`);

  const files = changedFiles
    .map((value) => trimPromptText(value, 160))
    .filter(Boolean)
    .slice(0, HANDOFF_LIST_LIMIT);
  if (files.length > 0) lines.push(`Changed Files: ${files.join(' | ')}`);

  return lines.join('\n');
}

function buildTestResultsPromptContext(handoffContext) {
  const payload = findInboundPayload(handoffContext, 'test_results.v1');
  if (!payload) return '';

  const data = payload.data || {};
  const summary = data.summary || {};
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  const lines = ['## Upstream Validation'];

  const targetPath = trimPromptText(data?.target?.path, 160);
  const targetRuntime = trimPromptText(data?.target?.runtime, 80);
  if (targetPath || targetRuntime) {
    lines.push(`Target: ${[targetPath, targetRuntime].filter(Boolean).join(' | ')}`);
  }

  lines.push(
    `Scenario Summary: total=${Number(summary.totalScenarios) || scenarios.length || 0}, passed=${Number(summary.passed) || 0}, failed=${Number(summary.failed) || 0}, skipped=${Number(summary.skipped) || 0}, passRate=${Number(summary.passRate) || 0}%`,
  );

  const failing = scenarios
    .filter((scenario) => scenario?.status === 'failed')
    .slice(0, HANDOFF_LIST_LIMIT)
    .map((scenario) => {
      const title = trimPromptText(scenario?.title, 120);
      const detail = trimPromptText(
        scenario?.lastResult?.summary
          || (Array.isArray(scenario?.lastResult?.errors) ? scenario.lastResult.errors[0] : '')
          || scenario?.description,
        160,
      );
      return [title, detail].filter(Boolean).join(' — ');
    })
    .filter(Boolean);
  if (failing.length > 0) lines.push(`Failing Scenarios: ${failing.join(' | ')}`);

  return lines.join('\n');
}

function buildSummaryFallbackPromptContext(handoffContext) {
  const summaryFallback = trimPromptText(handoffContext?.summaryFallback, 1200);
  if (!summaryFallback) return '';
  return ['## Upstream Summary', summaryFallback].join('\n');
}

export function buildHandoffPromptContext(handoffContext) {
  const sections = [
    buildSpecBundlePromptContext(handoffContext),
    buildImplementationBundlePromptContext(handoffContext),
    buildTestResultsPromptContext(handoffContext),
    buildSummaryFallbackPromptContext(handoffContext),
  ].filter(Boolean);

  return sections.join('\n\n');
}
