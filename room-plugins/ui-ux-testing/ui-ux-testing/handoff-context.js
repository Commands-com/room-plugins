// ---------------------------------------------------------------------------
// Handoff context. Reads inbound spec_bundle / implementation_bundle /
// review_findings payloads from ctx.handoffContext and builds the compact
// prompt-friendly summary string the discovery + planning + evaluation
// prompts splice in. collectPassThroughPayloads keeps each accepted
// inbound contract forwarded to downstream rooms on final report.
// ---------------------------------------------------------------------------

const HANDOFF_LIST_LIMIT = 4;
const HANDOFF_TEXT_LIMIT = 220;

function trimPromptText(value, max = HANDOFF_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function takePromptItems(values, limit = HANDOFF_LIST_LIMIT, max = HANDOFF_TEXT_LIMIT) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => trimPromptText(value, max))
    .filter(Boolean)
    .slice(0, limit);
}

function findInboundPayload(handoffContext, contract) {
  const payloads = Array.isArray(handoffContext?.payloads) ? handoffContext.payloads : [];
  return payloads.find((payload) => payload?.contract === contract && payload?.data && typeof payload.data === 'object') || null;
}

export function collectPassThroughPayloads(handoffContext) {
  const payloads = Array.isArray(handoffContext?.payloads) ? handoffContext.payloads : [];
  const allowedContracts = new Set(['spec_bundle.v1', 'implementation_bundle.v1', 'review_findings.v1']);
  const seen = new Set();
  const outputs = [];

  for (const payload of payloads) {
    const contract = payload?.contract;
    if (!allowedContracts.has(contract) || seen.has(contract)) continue;
    seen.add(contract);
    outputs.push(payload);
  }

  return outputs;
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

  const goals = takePromptItems(spec.goals);
  if (goals.length > 0) lines.push(`Goals: ${goals.join(' | ')}`);

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

  const taskCounts = [
    `tasks=${Number(summary.totalTasks) || tasks.length || 0}`,
    `completed=${Number(summary.completedTasks) || 0}`,
    `blocked=${Number(summary.blockedTasks) || 0}`,
  ];
  lines.push(`Task Summary: ${taskCounts.join(', ')}`);

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

  const files = changedFiles.map((value) => trimPromptText(value, 160)).filter(Boolean).slice(0, HANDOFF_LIST_LIMIT);
  if (files.length > 0) lines.push(`Changed Files: ${files.join(' | ')}`);

  return lines.join('\n');
}

function buildReviewFindingsPromptContext(handoffContext) {
  const payload = findInboundPayload(handoffContext, 'review_findings.v1');
  if (!payload) return '';

  const data = payload.data || {};
  const summary = data.summary || {};
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const lines = ['## Upstream Review Findings'];

  const counts = [
    `total=${Number(summary.totalFindings) || findings.length || 0}`,
    `open=${Number(summary.openFindings) || 0}`,
    `resolved=${Number(summary.resolvedFindings) || 0}`,
  ];
  lines.push(`Finding Counts: ${counts.join(', ')}`);

  const priorities = findings
    .filter((finding) => finding?.status !== 'resolved')
    .slice(0, 3)
    .map((finding) => {
      const title = trimPromptText(finding?.title, 120);
      const severity = trimPromptText(finding?.severity, 32);
      const description = trimPromptText(finding?.suggestion || finding?.description, 160);
      return [title && `${severity ? `[${severity}] ` : ''}${title}`, description].filter(Boolean).join(' — ');
    })
    .filter(Boolean);
  if (priorities.length > 0) lines.push(`Priority Findings: ${priorities.join(' | ')}`);

  return lines.join('\n');
}

export function buildInboundPromptContext(handoffContext) {
  const sections = [
    buildSpecBundlePromptContext(handoffContext),
    buildImplementationBundlePromptContext(handoffContext),
    buildReviewFindingsPromptContext(handoffContext),
  ].filter(Boolean);

  return sections.join('\n\n');
}
