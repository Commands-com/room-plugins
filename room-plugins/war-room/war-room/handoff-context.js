// ---------------------------------------------------------------------------
// Handoff context builders. Reads inbound spec_bundle.v1 + review_findings.v1
// payloads from ctx.handoffContext and produces a compact prompt-friendly
// summary string that gets spliced into discovery/planning prompts.
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

function buildSpecBundlePromptContext(handoffContext) {
  const payload = findInboundPayload(handoffContext, 'spec_bundle.v1');
  if (!payload) return '';

  const data = payload.data || {};
  const summary = data.summary || {};
  const spec = data.spec || {};
  const provenance = data.provenance || {};
  const primaryArtifact = Array.isArray(data.artifacts) ? data.artifacts.find((artifact) => artifact?.primary) : null;
  const lines = ['## Upstream Spec'];

  const title = trimPromptText(summary.title || spec.title, 120);
  if (title) lines.push(`Title: ${title}`);

  const oneLiner = trimPromptText(summary.oneLiner || spec.problem);
  if (oneLiner) lines.push(`Summary: ${oneLiner}`);

  const recommendation = trimPromptText(summary.recommendedDirection, 180);
  if (recommendation) lines.push(`Recommended Direction: ${recommendation}`);

  const meta = [
    trimPromptText(data.deliverableType, 40),
    trimPromptText(data.audience, 40),
    trimPromptText(data.detailLevel, 40),
  ].filter(Boolean);
  if (meta.length > 0) lines.push(`Spec Meta: ${meta.join(' | ')}`);

  const problem = trimPromptText(spec.problem);
  if (problem) lines.push(`Problem: ${problem}`);

  const goals = takePromptItems(spec.goals);
  if (goals.length > 0) lines.push(`Goals: ${goals.join(' | ')}`);

  const proposal = takePromptItems(spec.proposal);
  if (proposal.length > 0) lines.push(`Proposal: ${proposal.join(' | ')}`);

  const acceptance = takePromptItems(spec.acceptanceCriteria);
  if (acceptance.length > 0) lines.push(`Acceptance Criteria: ${acceptance.join(' | ')}`);

  const implementationPlan = takePromptItems(spec.implementationPlan);
  if (implementationPlan.length > 0) lines.push(`Implementation Plan: ${implementationPlan.join(' | ')}`);

  const risks = takePromptItems(spec.risks, 3, 160);
  if (risks.length > 0) lines.push(`Risks: ${risks.join(' | ')}`);

  const openQuestions = takePromptItems(spec.openQuestions, 3, 160);
  if (openQuestions.length > 0) lines.push(`Open Questions: ${openQuestions.join(' | ')}`);

  if (primaryArtifact?.path) lines.push(`Spec File: ${trimPromptText(primaryArtifact.path, 180)}`);
  if (provenance.sourcePrototypeTitle) lines.push(`Source Prototype: ${trimPromptText(provenance.sourcePrototypeTitle, 120)}`);
  if (provenance.sourcePrototypeEntryHtmlPath) lines.push(`Prototype Entry: ${trimPromptText(provenance.sourcePrototypeEntryHtmlPath, 180)}`);

  return lines.join('\n');
}

function buildReviewFindingsPromptContext(handoffContext) {
  const payload = findInboundPayload(handoffContext, 'review_findings.v1');
  if (!payload) return '';

  const data = payload.data || {};
  const summary = data.summary || {};
  const severitySummary = summary.severitySummary || {};
  const openFindings = Array.isArray(data.findings)
    ? data.findings.filter((finding) => finding?.status !== 'resolved')
    : [];
  const lines = ['## Upstream Review Findings'];

  const counts = [
    `total=${Number(summary.totalFindings) || 0}`,
    `open=${Number(summary.openFindings) || 0}`,
    `resolved=${Number(summary.resolvedFindings) || 0}`,
  ];
  lines.push(`Finding Counts: ${counts.join(', ')}`);

  const severities = [
    `critical=${Number(severitySummary.critical) || 0}`,
    `major=${Number(severitySummary.major) || 0}`,
    `minor=${Number(severitySummary.minor) || 0}`,
    `nit=${Number(severitySummary.nit) || 0}`,
  ];
  lines.push(`Open Severity: ${severities.join(', ')}`);

  const topFindings = openFindings
    .slice(0, 3)
    .map((finding) => {
      const title = trimPromptText(finding?.title, 120);
      const severity = trimPromptText(finding?.severity, 24);
      const suggestion = trimPromptText(finding?.suggestion || finding?.description, 160);
      return [title && `${severity ? `[${severity}] ` : ''}${title}`, suggestion].filter(Boolean).join(' — ');
    })
    .filter(Boolean);
  if (topFindings.length > 0) lines.push(`Priority Findings: ${topFindings.join(' | ')}`);

  return lines.join('\n');
}

export function buildInboundPromptContext(handoffContext) {
  const sections = [
    buildSpecBundlePromptContext(handoffContext),
    buildReviewFindingsPromptContext(handoffContext),
  ].filter(Boolean);

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

export function mergePromptContexts(...sections) {
  return sections
    .map((section) => (typeof section === 'string' ? section.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}
