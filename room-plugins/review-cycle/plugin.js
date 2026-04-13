/**
 * review-cycle-plugin.js — Review Cycle Orchestrator plugin.
 *
 * Decision logic for the review-cycle orchestration pattern:
 *   1 implementer + N reviewers in a convergence loop.
 *   Reviewers find issues, orchestrator LLM consolidates them,
 *   implementer fixes, repeat until convergence or limits.
 *
 * This is pure decision logic — no Electron deps, no I/O, no timeouts.
 * The room runtime owns all enforcement (limits, retries, fan-out, quorum).
 */

import {
  DECISION_TYPES,
  AGENT_ROLES,
  REVIEWER_PHASES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'review_cycle';

/** Max characters stored per turnLog entry content to prevent unbounded growth. */
const TURN_LOG_MAX_CONTENT_LENGTH = 20_000;
const HANDOFF_TEXT_LIMIT = 220;
const HANDOFF_LIST_LIMIT = 4;

const MANIFEST = Object.freeze({
  id: PLUGIN_ID,
  name: 'Review Cycle',
  version: '1.0.0',
  orchestratorType: 'review_cycle',
  description: 'Convergence-based code review with 1 implementer + N reviewers',
  supportsQuorum: false,
  dashboard: Object.freeze({
    panels: Object.freeze([
      Object.freeze({
        type: 'counter-group',
        key: 'issueSummary',
        label: 'Issues',
        layout: 'row',
        counters: Object.freeze([
          Object.freeze({ key: 'p1Open', label: 'P1 Open', color: 'red' }),
          Object.freeze({ key: 'p2Open', label: 'P2 Open', color: 'orange' }),
          Object.freeze({ key: 'p3Open', label: 'P3 Open', color: 'yellow' }),
          Object.freeze({ key: 'totalResolved', label: 'Resolved', color: 'green' }),
        ]),
      }),
      Object.freeze({
        type: 'progress',
        key: 'cycleProgress',
        label: 'Cycle Progress',
        format: '{value} / {max}',
      }),
      Object.freeze({
        type: 'phase',
        key: 'currentPhase',
        label: 'Phase',
        phases: Object.freeze(['reviewing', 'synthesizing', 'implementing', 'converging']),
      }),
      Object.freeze({
        type: 'bar-chart',
        key: 'convergenceTrend',
        label: 'Issues by Cycle',
        series: Object.freeze([
          Object.freeze({ key: 'p1', label: 'P1', color: 'red' }),
          Object.freeze({ key: 'p2', label: 'P2', color: 'orange' }),
          Object.freeze({ key: 'p3', label: 'P3', color: 'yellow' }),
          Object.freeze({ key: 'p4', label: 'Nit', color: 'blue' }),
        ]),
      }),
      Object.freeze({
        type: 'agent-status',
        key: 'reviewerStatus',
        label: 'Reviewers',
        states: Object.freeze([
          'initial_review', 'has_open_issues', 'clean_review',
          'done', 'withdrawn', 'responding', 'timeout',
        ]),
      }),
      Object.freeze({
        type: 'table',
        key: 'issueLog',
        label: 'Issue Log',
        columns: Object.freeze([
          Object.freeze({ key: 'severity', label: 'Sev', width: 40 }),
          Object.freeze({ key: 'title', label: 'Issue' }),
          Object.freeze({ key: 'reportedBy', label: 'Reported By' }),
          Object.freeze({ key: 'status', label: 'Status', width: 80 }),
          Object.freeze({ key: 'resolvedInCycle', label: 'Resolved', width: 70 }),
        ]),
        sortable: true,
        filterable: Object.freeze(['severity', 'status']),
      }),
    ]),
  }),
  limits: Object.freeze({
    maxCycles: Object.freeze({ default: 5 }),
    maxTurns: Object.freeze({ default: 40, min: 1, max: 1000 }),
    llmTimeoutMs: Object.freeze({ default: 60_000, max: 300_000 }),
    turnFloorRole: 'reviewer',
    turnFloorFormula: '1 + N',
  }),
  roles: Object.freeze({
    required: Object.freeze(['implementer', 'reviewer']),
    optional: Object.freeze([]),
    forbidden: Object.freeze(['worker']),
    minCount: Object.freeze({
      implementer: 1,
      reviewer: 1,
    }),
    maxCount: Object.freeze({
      implementer: 1,
    }),
  }),
  endpointConstraints: Object.freeze({
    requiresLocalParticipant: true,
    perRole: Object.freeze({}),
  }),
  handoff: Object.freeze({
    inputs: Object.freeze([
      Object.freeze({ contract: 'spec_bundle.v1', required: false, multiple: false }),
      Object.freeze({ contract: 'implementation_bundle.v1', required: false, multiple: false }),
      Object.freeze({ contract: 'test_results.v1', required: false, multiple: false }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ contract: 'review_findings.v1', default: true }),
      Object.freeze({ contract: 'spec_bundle.v1' }),
      Object.freeze({ contract: 'implementation_bundle.v1' }),
      Object.freeze({ contract: 'test_results.v1' }),
    ]),
    defaultApprovalMode: 'auto',
  }),
  display: Object.freeze({
    typeLabel: 'Review Cycle',
    typeTag: 'RC',
    cycleNoun: 'Cycle',
    reportTitle: 'Review Cycle Report',
    activityMessages: Object.freeze({
      idle: 'Waiting...',
      fanOut: 'Review in progress',
      singleTurn: 'Implementation in progress',
      synthesis: 'Synthesis in progress',
      planning: 'Planning...',
    }),
    phaseActivityMessages: Object.freeze({
      reviewing: 'Reviewers reviewing changes',
      implementing: 'Implementer addressing findings',
      synthesizing: 'Consolidating review findings',
    }),
    defaultRoster: Object.freeze([
      Object.freeze({ role: 'implementer', displayName: 'Implementer' }),
      Object.freeze({ role: 'reviewer', displayName: 'Reviewer 1' }),
    ]),
    defaultAddRole: 'reviewer',
  }),
  report: Object.freeze({
    summaryMetrics: Object.freeze(['issueSummary']),
    table: Object.freeze({
      metricKey: 'issueLog',
      columns: Object.freeze([
        Object.freeze({ key: 'severity', label: 'Sev', width: 60 }),
        Object.freeze({ key: 'title', label: 'Issue' }),
        Object.freeze({ key: 'reportedBy', label: 'Reported By' }),
        Object.freeze({ key: 'status', label: 'Status', width: 80 }),
        Object.freeze({ key: 'resolvedInCycle', label: 'Resolved', width: 70 }),
      ]),
    }),
  }),
  cli: Object.freeze({
    command: 'review-cycle',
    description: 'Review code changes with multi-agent convergence',
    startParams: Object.freeze([]),
    clientFlags: Object.freeze([
      Object.freeze({
        name: 'worktree',
        type: 'boolean',
        behavior: 'git-worktree',
        required: false,
        default: false,
        description: 'Create isolated git worktree for review',
      }),
      Object.freeze({
        name: 'ref',
        type: 'string',
        behavior: 'git-ref',
        required: false,
        description: 'Base commit for worktree (requires --worktree)',
        requiresFlag: 'worktree',
      }),
    ]),
    statusFields: Object.freeze([
      Object.freeze({ key: 'issueSummary', label: 'Issues', format: 'counter-group' }),
      Object.freeze({ key: 'currentPhase', label: 'Phase', format: 'text', extract: 'active' }),
    ]),
    computedStatusFields: Object.freeze([
      Object.freeze({
        name: 'openIssues',
        label: 'Open Issues',
        format: 'number',
        derive: '(metrics.issueSummary.p1Open || 0) + (metrics.issueSummary.p2Open || 0) + (metrics.issueSummary.p3Open || 0)',
      }),
    ]),
    exitCodes: Object.freeze({
      'cycle_limit': 2,
      'turn_limit': 2,
      'convergence_with_open_issues': 2,
    }),
    statusTemplate: '[{{command}}] {{roomId}}: {{state}} (cycle {{cycle}}/{{maxCycles}}, {{openIssues}} open issues){{#stopReason}}  [stopReason: {{stopReason}}]{{/stopReason}}',
    listTemplate: '{{roomId}}  {{state}}  cycle {{cycle}}/{{maxCycles}}  {{openIssues}} open issues{{#stopReason}}  [stopReason: {{stopReason}}]{{/stopReason}}{{#age}}  [{{age}}]{{/age}}',
    startTemplate: '[{{command}}] started: {{roomId}}',
    stopTemplate: '[{{command}}] stopping: {{roomId}}',
    skill: Object.freeze({
      name: 'review-cycle',
      description: 'Run a multi-agent code review',
      defaultObjective: 'Review the current working directory for correctness, regressions, and missing tests.',
    }),
  }),
});

// ---------------------------------------------------------------------------
// Workspace context
// ---------------------------------------------------------------------------

/**
 * Build workspace context string to append to tool-using participant prompts.
 * Returns empty string when no multi-root workspace or worktree is configured.
 */
function buildWorkspaceContext(ctx) {
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

function trimPromptText(value, max = HANDOFF_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
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

function buildHandoffPromptContext(handoffContext) {
  const sections = [
    buildSpecBundlePromptContext(handoffContext),
    buildImplementationBundlePromptContext(handoffContext),
    buildTestResultsPromptContext(handoffContext),
    buildSummaryFallbackPromptContext(handoffContext),
  ].filter(Boolean);

  return sections.join('\n\n');
}

function deriveReviewDisposition(openIssues) {
  const criticalOrMajor = openIssues.filter((issue) => ['critical', 'major'].includes(issue?.severity)).length;
  if (criticalOrMajor > 0) return 'changes_requested';
  if (openIssues.length > 0) return 'approved_with_followups';
  return 'approved';
}

function collectReferencedArtifacts(ctx) {
  const payloads = Array.isArray(ctx.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const artifacts = [];
  const seen = new Set();

  function addArtifact(contract, path, label = null, kind = 'file') {
    const cleanPath = trimPromptText(path, 260);
    if (!cleanPath) return;
    const key = `${contract}:${cleanPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push({ contract, kind, path: cleanPath, label: label ? trimPromptText(label, 120) : null });
  }

  for (const payload of payloads) {
    const contract = payload?.contract;
    const data = payload?.data || {};

    if (contract === 'spec_bundle.v1') {
      for (const artifact of Array.isArray(data.artifacts) ? data.artifacts : []) {
        addArtifact(contract, artifact?.path, artifact?.label, artifact?.kind || 'file');
      }
      continue;
    }

    if (contract === 'implementation_bundle.v1') {
      for (const changedFile of Array.isArray(data.changedFiles) ? data.changedFiles : []) {
        addArtifact(contract, changedFile, 'Changed file');
      }
      continue;
    }

    if (contract === 'test_results.v1') {
      for (const scenario of Array.isArray(data.scenarios) ? data.scenarios : []) {
        addArtifact(contract, scenario?.testFilePath, scenario?.title || 'Test scenario');
      }
    }
  }

  return artifacts;
}

function buildDocumentationIntegrity(ctx, openIssues) {
  const payloads = Array.isArray(ctx.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const checkedAgainst = payloads
    .map((payload) => payload?.contract)
    .filter((value, index, array) => typeof value === 'string' && array.indexOf(value) === index);
  const testResults = findInboundPayload(ctx.handoffContext, 'test_results.v1');
  const failedScenarios = Number(testResults?.data?.summary?.failed) || 0;

  if (!testResults && checkedAgainst.length === 0) {
    return {
      status: 'not_evaluated',
      summary: 'No upstream artifacts were available to verify documentation or artifact claims.',
      checkedAgainst,
    };
  }

  if (failedScenarios > 0) {
    return {
      status: 'issues_found',
      summary: `Upstream validation reported ${failedScenarios} failing scenario${failedScenarios === 1 ? '' : 's'}; public documentation should avoid stronger correctness claims until they are resolved.`,
      checkedAgainst,
    };
  }

  if (openIssues.length > 0) {
    return {
      status: 'follow_up_required',
      summary: `Review identified ${openIssues.length} unresolved finding${openIssues.length === 1 ? '' : 's'}; documentation should reflect outstanding risk until follow-up is complete.`,
      checkedAgainst,
    };
  }

  return {
    status: 'no_mismatches_found',
    summary: 'Reviewed the available spec, implementation, and validation artifacts without identifying documentation-integrity mismatches.',
    checkedAgainst,
  };
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

function buildInitialReviewPrompt(objective, reviewerDisplayName, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a code reviewer.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `Review the implementation against the objective.`,
    `For each issue found, provide:`,
    `- A short title`,
    `- Severity: critical | major | minor | nit`,
    `- Description of the problem`,
    `- Suggested fix (if applicable)`,
    '',
    `Respond with a JSON object: { "issues": [{ "title", "severity", "description", "suggestion" }] }`,
    `If no issues found, respond with: { "issues": [] }`,
  );
  return lines.join('\n');
}

function buildReReviewPrompt(objective, reviewerDisplayName, openIssues, latestImplementation, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a code reviewer.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  lines.push(
    `## Previously Identified Issues`,
    JSON.stringify(openIssues, null, 2),
    '',
  );

  if (latestImplementation) {
    lines.push(
      `## Implementer's Latest Changes`,
      latestImplementation,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `The implementer has made changes. Re-review the implementation against the issues above.`,
    `For each previously identified issue, check if it has been resolved.`,
    `Also check for any new issues introduced by the changes.`,
    '',
    `**Important:** Only include issues that are **still open**. If a previously identified issue has been fixed by the implementer's changes, omit it from your response entirely — do NOT re-report resolved issues.`,
    '',
    `Respond with a JSON object: { "issues": [{ "title", "severity", "description", "suggestion" }] }`,
    `If all issues are resolved and no new issues, respond with: { "issues": [] }`,
  );
  return lines.join('\n');
}

function buildCleanReviewPrompt(objective, reviewerDisplayName, latestImplementation, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a code reviewer.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  if (latestImplementation) {
    lines.push(
      `## Implementer's Latest Changes`,
      latestImplementation,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `Perform a clean review of the latest changes. Check for any remaining or newly introduced issues.`,
    '',
    `Respond with a JSON object: { "issues": [{ "title", "severity", "description", "suggestion" }] }`,
    `If no issues found, respond with: { "issues": [] }`,
  );
  return lines.join('\n');
}

function buildImplementerPrompt(objective, consolidatedIssues, reviewerFeedback, handoffPromptContext = '') {
  const lines = [
    `You are the implementer. Your job is to fix the code by editing the actual files using your tools.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  lines.push(
    `## Issues to Fix`,
    JSON.stringify(consolidatedIssues, null, 2),
    '',
  );

  if (reviewerFeedback) {
    lines.push(
      `## Reviewer Feedback`,
      `The reviewers provided the following detailed feedback:`,
      reviewerFeedback,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `Fix all the issues listed above. Focus on critical and major severity issues first.`,
    `You MUST edit the actual files to make your changes. Use your tools to read and modify the source files directly.`,
    `Do NOT just describe changes or output code blocks — actually apply the fixes to the files on disk.`,
    `After making all changes, briefly summarize what you fixed.`,
  );
  return lines.join('\n');
}

function buildSynthesisPrompt(reviewerResponses) {
  return [
    `You are a code review synthesis engine.`,
    '',
    `## Reviewer Responses`,
    JSON.stringify(reviewerResponses, null, 2),
    '',
    `## Instructions`,
    `Consolidate the reviewer feedback into a single list of unique issues.`,
    `Merge duplicate issues. Resolve conflicting assessments by choosing the higher severity.`,
    '',
    `Respond ONLY with a JSON object in this exact format:`,
    `{`,
    `  "synthesis": {`,
    `    "added": [{ "title", "severity", "description", "suggestion", "source_reviewers": [] }],`,
    `    "resolved": [{ "title", "reason" }],`,
    `    "unchanged": [{ "title" }]`,
    `  },`,
    `  "consolidated_issues": [{ "id", "title", "severity", "description", "suggestion", "status": "open"|"resolved", "source_reviewers": ["agent_id"] }]`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseReviewerResponse(text) {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { issues: [], parseError: true };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.issues)) return { issues: [], parseError: true };
    return {
      issues: parsed.issues.map((issue, i) => ({
        id: `issue_${i}`,
        title: String(issue.title || `Issue ${i + 1}`),
        severity: ['critical', 'major', 'minor', 'nit'].includes(issue.severity)
          ? issue.severity : 'minor',
        description: String(issue.description || ''),
        suggestion: issue.suggestion ? String(issue.suggestion) : null,
        status: 'open',
      })),
      parseError: false,
    };
  } catch {
    return { issues: [], parseError: true };
  }
}

function parseSynthesisResponse(text, cycleNumber) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.consolidated_issues)) return null;
    const cyclePrefix = cycleNumber != null ? `c${cycleNumber}_` : '';
    return {
      synthesis: parsed.synthesis || { added: [], resolved: [], unchanged: [] },
      consolidated_issues: parsed.consolidated_issues.map((issue, i) => ({
        id: issue.id || `issue_${cyclePrefix}${i}`,
        title: String(issue.title || `Issue ${i + 1}`),
        severity: ['critical', 'major', 'minor', 'nit'].includes(issue.severity)
          ? issue.severity : 'minor',
        description: String(issue.description || ''),
        suggestion: issue.suggestion ? String(issue.suggestion) : null,
        status: issue.status === 'resolved' ? 'resolved' : 'open',
        source_reviewers: Array.isArray(issue.source_reviewers) ? issue.source_reviewers : [],
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reviewer phase transitions
// ---------------------------------------------------------------------------

/**
 * Compute next phase for a reviewer based on their current phase and issue count.
 *
 * initial_review → always → has_open_issues
 * has_open_issues + 0 issues → clean_review
 * clean_review + 0 issues → done (terminal)
 * clean_review + new issues → has_open_issues
 */
function nextReviewerPhase(currentPhase, issueCount) {
  if (currentPhase === REVIEWER_PHASES.INITIAL_REVIEW) {
    return REVIEWER_PHASES.HAS_OPEN_ISSUES;
  }
  if (currentPhase === REVIEWER_PHASES.HAS_OPEN_ISSUES) {
    return issueCount === 0
      ? REVIEWER_PHASES.CLEAN_REVIEW
      : REVIEWER_PHASES.HAS_OPEN_ISSUES;
  }
  if (currentPhase === REVIEWER_PHASES.CLEAN_REVIEW) {
    return issueCount === 0
      ? REVIEWER_PHASES.DONE
      : REVIEWER_PHASES.HAS_OPEN_ISSUES;
  }
  // done or withdrawn — no transition
  return currentPhase;
}

// ---------------------------------------------------------------------------
// Convergence evaluation
// ---------------------------------------------------------------------------

function evaluateConvergence(state) {
  const activeReviewers = state.reviewerStates.filter(
    (r) => r.phase !== REVIEWER_PHASES.WITHDRAWN,
  );

  if (activeReviewers.length === 0) {
    // All reviewers withdrawn — stop with open issues if any remain
    const openCount = state.issues.filter((i) => i.status === 'open').length;
    return openCount > 0 ? STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES : STOP_REASON.CONVERGENCE;
  }

  const allDone = activeReviewers.every((r) => r.phase === REVIEWER_PHASES.DONE);
  if (!allDone) return null; // not converged yet

  const openCount = state.issues.filter((i) => i.status === 'open').length;
  return openCount > 0 ? STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES : STOP_REASON.CONVERGENCE;
}

function collectReviewCyclePassThroughPayloads(ctx) {
  const inboundPayloads = Array.isArray(ctx.handoffContext?.payloads)
    ? ctx.handoffContext.payloads
    : [];
  const allowedContracts = new Set(['spec_bundle.v1', 'implementation_bundle.v1', 'test_results.v1']);
  const seenContracts = new Set();
  const outputs = [];

  for (const payload of inboundPayloads) {
    const contract = payload?.contract;
    if (!allowedContracts.has(contract) || seenContracts.has(contract)) continue;
    seenContracts.add(contract);
    outputs.push(payload);
  }

  return outputs;
}

function buildReviewFindingsPayload(ctx, state) {
  const issues = Array.isArray(state?.issues) ? state.issues : [];
  const openIssues = issues.filter((issue) => issue.status === 'open');
  const resolvedIssues = issues.filter((issue) => issue.status === 'resolved');
  const baseReport = typeof ctx.getFinalReport === 'function' ? ctx.getFinalReport() : null;
  const testResults = findInboundPayload(ctx.handoffContext, 'test_results.v1');
  const testSummary = testResults?.data?.summary || null;

  return {
    contract: 'review_findings.v1',
    data: {
      objective: ctx.objective || '',
      roomId: ctx.roomId || null,
      stopReason: baseReport?.stopReason || null,
      cyclesCompleted: state?.currentCycle ?? ctx.cycle ?? 0,
      reviewerStates: Array.isArray(state?.reviewerStates)
        ? state.reviewerStates.map((reviewer) => ({
          agentId: reviewer.agentId,
          displayName: reviewer.displayName,
          phase: reviewer.phase,
          lastIssueCount: reviewer.lastIssueCount || 0,
        }))
        : [],
      summary: {
        totalFindings: issues.length,
        openFindings: openIssues.length,
        resolvedFindings: resolvedIssues.length,
        severitySummary: {
          critical: openIssues.filter((issue) => issue.severity === 'critical').length,
          major: openIssues.filter((issue) => issue.severity === 'major').length,
          minor: openIssues.filter((issue) => issue.severity === 'minor').length,
          nit: openIssues.filter((issue) => issue.severity === 'nit').length,
        },
        validationSignals: testSummary
          ? {
            totalScenarios: Number(testSummary.totalScenarios) || 0,
            passed: Number(testSummary.passed) || 0,
            failed: Number(testSummary.failed) || 0,
            skipped: Number(testSummary.skipped) || 0,
            passRate: Number(testSummary.passRate) || 0,
          }
          : null,
      },
      disposition: deriveReviewDisposition(openIssues),
      documentationIntegrity: buildDocumentationIntegrity(ctx, openIssues),
      referencedArtifacts: collectReferencedArtifacts(ctx),
      findings: issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        severity: issue.severity,
        description: issue.description,
        suggestion: issue.suggestion || null,
        status: issue.status,
        sourceReviewers: Array.isArray(issue.source_reviewers) ? issue.source_reviewers : [],
        resolvedInCycle: issue.resolvedInCycle ?? null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function createReviewCyclePlugin() {
  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    /**
     * Initialize plugin state.
     */
    init(ctx) {
      const participants = ctx.participants;
      const implementer = participants.find((p) => p.role === AGENT_ROLES.IMPLEMENTER);
      const reviewers = participants.filter((p) => p.role === AGENT_ROLES.REVIEWER);

      ctx.setState({
        currentCycle: 0,
        maxCycles: ctx.limits.maxCycles || 5,
        latestImplementation: null,
        latestReviewerFeedback: null,
        issues: [],
        reviewerStates: reviewers.map((r) => ({
          agentId: r.agentId,
          displayName: r.displayName,
          phase: REVIEWER_PHASES.INITIAL_REVIEW,
          lastIssueCount: 0,
        })),
        cycleHistory: [],
        turnLog: [],
        implementerId: implementer ? implementer.agentId : null,
      });
    },

    /**
     * Room starts — send initial review prompts to all reviewers.
     */
    onRoomStart(ctx) {
      const state = ctx.getState();
      const reviewers = ctx.participants.filter((p) => p.role === AGENT_ROLES.REVIEWER);
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      ctx.emitMetrics({ currentPhase: { active: 'reviewing' } });

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: reviewers.map((r) => ({
          agentId: r.agentId,
          message: buildInitialReviewPrompt(ctx.objective, r.displayName, handoffPromptContext) + wsCtx,
        })),
      };
    },

    /**
     * All fan-out reviewers responded — synthesize and decide next action.
     */
    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      // Separate accepted and rejected responses (spec-21 sync rejection)
      const acceptedResponses = responses.filter((r) => !r.rejected);
      const rejectedResponses = responses.filter((r) => r.rejected);

      // Parse reviewer responses (only from accepted submissions)
      const reviewerResults = acceptedResponses.map((r) => ({
        agentId: r.agentId,
        ...parseReviewerResponse(r.response),
      }));

      // Store raw reviewer feedback for the implementer prompt (only accepted)
      state.latestReviewerFeedback = acceptedResponses.map((r) => {
        const p = ctx.participants.find((a) => a.agentId === r.agentId);
        return `### ${p?.displayName || r.agentId}\n${r.response}`;
      }).join('\n\n');

      // Log rejected submissions in the turn log with rejection metadata (spec-21)
      for (const r of rejectedResponses) {
        const p = ctx.participants.find((a) => a.agentId === r.agentId);
        const raw = r.response || '';
        state.turnLog.push({
          cycle: state.currentCycle,
          role: 'reviewer',
          agent: p?.displayName || r.agentId,
          content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
            ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
            : raw,
          rejected: true,
          rejectionReason: r.rejectionReason || 'unknown',
          observedRevision: r.observedRevision || null,
          authoritativeRevision: r.authoritativeRevision || null,
        });
        // Update reviewer sync status for rejected submissions
        const rs = state.reviewerStates.find((s) => s.agentId === r.agentId);
        if (rs) {
          rs.lastObservedRevision = r.observedRevision || null;
          rs.lastSyncStatus = r.rejectionReason === 'revision_mismatch' ? 'mismatch' : 'error';
        }
      }

      // Log accepted reviewer responses for final report (truncate to cap memory).
      // Include observedRevision from sync evidence when available.
      for (const r of acceptedResponses) {
        const p = ctx.participants.find((a) => a.agentId === r.agentId);
        const raw = r.response || '';
        const turnEntry = {
          cycle: state.currentCycle,
          role: 'reviewer',
          agent: p?.displayName || r.agentId,
          content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
            ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
            : raw,
        };
        // Attach observed revision from response (sync evidence)
        if (r.observedRevision) {
          turnEntry.observedRevision = r.observedRevision;
        }
        state.turnLog.push(turnEntry);

        // Update reviewer state with sync evidence
        const rs = state.reviewerStates.find((s) => s.agentId === r.agentId);
        if (rs && r.observedRevision) {
          rs.lastObservedRevision = r.observedRevision;
        }
      }

      // Build this cycle's issue list from reviewer responses.
      // Skip synthesis when all reviewers report zero issues — nothing to consolidate,
      // and LLM hallucinations here can re-open resolved issues and block convergence.
      const totalNewIssues = reviewerResults.reduce((n, rr) => n + rr.issues.length, 0);
      let updatedIssues;

      if (totalNewIssues > 0 && reviewerResults.length > 1) {
        // Synthesize: consolidate overlapping issues from multiple reviewers
        const synthesisResult = await ctx.invokeLLM(
          buildSynthesisPrompt(reviewerResults),
          {
            purpose: 'synthesis',
            allow_tool_use: true,
            permission_profile_override: 'read-only',
          },
        );

        if (synthesisResult.ok && synthesisResult.text) {
          const parsed = parseSynthesisResponse(synthesisResult.text, state.currentCycle);
          if (parsed) {
            updatedIssues = parsed.consolidated_issues;
          }
        }
      }

      // Fallback: merge issues without synthesis
      if (!updatedIssues) {
        updatedIssues = [];
        let issueId = 0;
        for (const rr of reviewerResults) {
          for (const issue of rr.issues) {
            updatedIssues.push({
              ...issue,
              id: `issue_c${state.currentCycle}_${issueId++}`,
              source_reviewers: [rr.agentId],
            });
          }
        }
      }

      // Merge issues: preserve the full issue history across cycles.
      //
      // 1. Previously-open issues absent from the new set are implicitly
      //    resolved (reviewers didn't re-report them → they're fixed).
      // 2. Previously-resolved issues are always carried forward.
      // 3. New issues from synthesis/fallback are added.
      const newById = new Map(updatedIssues.map((i) => [i.id, i]));

      // Stamp resolvedInCycle on newly resolved issues from synthesis
      for (const issue of updatedIssues) {
        if (issue.status === 'resolved' && issue.resolvedInCycle == null) {
          issue.resolvedInCycle = state.currentCycle;
        }
      }

      // Carry forward all previous issues that aren't in the new set
      for (const prev of state.issues) {
        if (newById.has(prev.id)) continue; // new set has a fresh version
        if (prev.status === 'open') {
          // Implicitly resolved — reviewers didn't re-report it
          prev.status = 'resolved';
          if (prev.resolvedInCycle == null) prev.resolvedInCycle = state.currentCycle;
        }
        updatedIssues.push(prev);
      }
      state.issues = updatedIssues;

      // Update reviewer phases.
      // On parseError, treat as 0 issues — the reviewer responded but didn't
      // format as JSON.  Freezing the phase here causes infinite re-review
      // loops when the reviewer gives a prose "all clear" response.
      for (const rr of reviewerResults) {
        const rs = state.reviewerStates.find((s) => s.agentId === rr.agentId);
        if (rs) {
          const issueCount = rr.parseError ? 0 : rr.issues.length;
          rs.lastIssueCount = issueCount;
          rs.phase = nextReviewerPhase(rs.phase, issueCount);
        }
      }

      // Mirror sync status into reviewer state for spec-21 contract extension
      if (ctx.syncState && Array.isArray(ctx.syncState.reviewerRevisions)) {
        for (const rr of ctx.syncState.reviewerRevisions) {
          const rs = state.reviewerStates.find((s) => s.agentId === rr.reviewerId);
          if (rs) {
            rs.lastSyncStatus = rr.status || null;
          }
        }
      }

      // Record cycle snapshot (with per-severity breakdown for trend chart)
      const openForHistory = updatedIssues.filter((i) => i.status === 'open');
      const cycleEntry = {
        cycle: state.currentCycle,
        issueCount: openForHistory.length,
        p1: openForHistory.filter((i) => i.severity === 'critical').length,
        p2: openForHistory.filter((i) => i.severity === 'major').length,
        p3: openForHistory.filter((i) => i.severity === 'minor').length,
        p4: openForHistory.filter((i) => i.severity === 'nit').length,
        reviewerPhases: state.reviewerStates.map((r) => ({
          agentId: r.agentId,
          phase: r.phase,
        })),
      };

      // Attach sync evidence from room syncState if available (spec-21)
      const syncState = ctx.syncState;
      if (syncState && syncState.authoritativeRevision) {
        cycleEntry.authoritativeRevision = syncState.authoritativeRevision;
        cycleEntry.syncMode = syncState.mode || null;
        cycleEntry.syncDurationMs = syncState.syncDurationMs || 0;
        cycleEntry.syncOverride = !!(syncState.override);
        cycleEntry.reviewerRevisionEvidence = (syncState.reviewerRevisions || []).map((rr) => ({
          agentId: rr.reviewerId,
          observedRevision: rr.revision || null,
          status: rr.status || 'unknown',
        }));
      }

      state.cycleHistory.push(cycleEntry);

      // Emit metrics (keyed by manifest panel keys — F8 contract)
      const openIssues = updatedIssues.filter((i) => i.status === 'open');
      const resolvedCount = updatedIssues.filter((i) => i.status === 'resolved').length;

      // F10: severity-to-counter mapping
      const p1Open = openIssues.filter((i) => i.severity === 'critical').length;
      const p2Open = openIssues.filter((i) => i.severity === 'major').length;
      const p3Open = openIssues.filter((i) => i.severity === 'minor').length;

      // Build convergence trend from cycle history (per-severity breakdown)
      const trendLabels = state.cycleHistory.map((h) => `C${h.cycle}`);
      const trendP1 = state.cycleHistory.map((h) => h.p1 || 0);
      const trendP2 = state.cycleHistory.map((h) => h.p2 || 0);
      const trendP3 = state.cycleHistory.map((h) => h.p3 || 0);
      const trendP4 = state.cycleHistory.map((h) => h.p4 || 0);

      ctx.emitMetrics({
        issueSummary: { p1Open, p2Open, p3Open, totalResolved: resolvedCount },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
        currentPhase: { active: 'synthesizing' },
        convergenceTrend: {
          labels: trendLabels,
          series: { p1: trendP1, p2: trendP2, p3: trendP3, p4: trendP4 },
        },
        reviewerStatus: Object.fromEntries(
          state.reviewerStates.map((r) => {
            const p = ctx.participants.find((a) => a.agentId === r.agentId);
            return [p?.displayName || r.agentId, r.phase];
          }),
        ),
        issueLog: {
          rows: state.issues.map((issue) => ({
            id: issue.id,
            severity: issue.severity,
            title: issue.title,
            reportedBy: (issue.source_reviewers || [])
              .map((id) => {
                const p = ctx.participants.find((a) => a.agentId === id);
                return p?.displayName || id;
              })
              .join(', '),
            status: issue.status,
            resolvedInCycle: issue.resolvedInCycle != null ? `C${issue.resolvedInCycle}` : null,
          })),
        },
        turnLog: { entries: state.turnLog },
      });

      ctx.setState(state);

      // Check convergence
      const convergence = evaluateConvergence(state);
      if (convergence) {
        return {
          type: DECISION_TYPES.STOP,
          reason: convergence,
        };
      }

      // Check cycle limit
      if (state.currentCycle >= state.maxCycles) {
        return {
          type: DECISION_TYPES.STOP,
          reason: STOP_REASON.CYCLE_LIMIT,
        };
      }

      // Open issues remain — send to implementer
      if (openIssues.length === 0) {
        // No open issues but not all reviewers done — clean review pass
        const activeReviewers = state.reviewerStates.filter(
          (r) => r.phase !== REVIEWER_PHASES.DONE && r.phase !== REVIEWER_PHASES.WITHDRAWN,
        );
        ctx.emitMetrics({ currentPhase: { active: 'reviewing' } });
        return {
          type: DECISION_TYPES.FAN_OUT,
          targets: activeReviewers.map((r) => {
            const participant = ctx.participants.find((p) => p.agentId === r.agentId);
            return {
              agentId: r.agentId,
              message: buildCleanReviewPrompt(
                ctx.objective,
                participant?.displayName || r.agentId,
                state.latestImplementation,
                handoffPromptContext,
              ) + wsCtx,
            };
          }),
        };
      }

      ctx.emitMetrics({ currentPhase: { active: 'implementing' } });

      return {
        type: DECISION_TYPES.SPEAK,
        agentId: state.implementerId,
        message: buildImplementerPrompt(
          ctx.objective,
          openIssues,
          state.latestReviewerFeedback,
          handoffPromptContext,
        ) + wsCtx,
      };
    },

    /**
     * Implementer responded — increment cycle, fan-out to active reviewers.
     */
    onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      // Log implementer response for final report (truncate to cap memory)
      const implParticipant = ctx.participants.find((a) => a.agentId === state.implementerId);
      const rawImpl = turnResult.response || '';
      state.turnLog.push({
        cycle: state.currentCycle,
        role: 'implementer',
        agent: implParticipant?.displayName || state.implementerId,
        content: rawImpl.length > TURN_LOG_MAX_CONTENT_LENGTH
          ? rawImpl.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
          : rawImpl,
      });

      state.latestImplementation = turnResult.response;
      state.currentCycle += 1;
      ctx.setCycle(state.currentCycle);

      ctx.emitMetrics({
        currentPhase: { active: 'reviewing' },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
        turnLog: { entries: state.turnLog },
      });

      ctx.setState(state);

      // No cycle-limit check here — always let reviewers do one final pass
      // after the implementer's fixes so issue statuses get properly updated
      // (resolved vs still open). The cycle limit is enforced in
      // onFanOutComplete after the issue merge logic runs.

      // Fan-out to active reviewers for re-review
      const activeReviewers = state.reviewerStates.filter(
        (r) => r.phase !== REVIEWER_PHASES.DONE && r.phase !== REVIEWER_PHASES.WITHDRAWN,
      );

      if (activeReviewers.length === 0) {
        // All reviewers done or withdrawn — evaluate convergence
        const convergence = evaluateConvergence(state);
        if (convergence) {
          return { type: DECISION_TYPES.STOP, reason: convergence };
        }
        return { type: DECISION_TYPES.PAUSE };
      }

      const openIssues = state.issues.filter((i) => i.status === 'open');

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: activeReviewers.map((r) => {
          const participant = ctx.participants.find((p) => p.agentId === r.agentId);
          return {
            agentId: r.agentId,
            message: buildReReviewPrompt(
              ctx.objective,
              participant?.displayName || r.agentId,
              openIssues,
              state.latestImplementation,
              handoffPromptContext,
            ) + wsCtx,
          };
        }),
      };
    },

    /**
     * Handle room events (participant disconnect, user edits).
     */
    onEvent(ctx, event) {
      const state = ctx.getState();

      if (event.type === 'participant_disconnected' && event.agentId) {
        const rs = state.reviewerStates.find((s) => s.agentId === event.agentId);
        if (rs) {
          rs.phase = REVIEWER_PHASES.WITHDRAWN;
          ctx.setState(state);
        }
      }

      if (event.type === 'user_edit_state' && event.edits) {
        // Delta edits: apply changes by issue ID to preserve full metadata
        if (Array.isArray(event.edits.issueEdits)) {
          for (const edit of event.edits.issueEdits) {
            const issue = state.issues.find((i) => i.id === edit.id);
            if (!issue) continue;
            if (edit.severity) issue.severity = edit.severity;
            if (edit.status) {
              issue.status = edit.status;
              if (edit.status === 'resolved' && issue.resolvedInCycle == null) {
                issue.resolvedInCycle = state.currentCycle;
              }
            }
          }
          ctx.setState(state);
        }
        // Legacy: full replacement (backwards compat)
        if (Array.isArray(event.edits.issues)) {
          state.issues = event.edits.issues;
          ctx.setState(state);
        }
      }
    },

    /**
     * Regenerate a pending decision's message content using current state.
     * Called by the runtime after editRoomState when a pendingDecision exists,
     * so that approved decisions reflect the user's edits.
     */
    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      const openIssues = state.issues.filter((i) => i.status === 'open');
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      if (pendingDecision.type === DECISION_TYPES.SPEAK) {
        return {
          ...pendingDecision,
          message: buildImplementerPrompt(
            ctx.objective,
            openIssues,
            state.latestReviewerFeedback,
            handoffPromptContext,
          ) + wsCtx,
        };
      }

      if (pendingDecision.type === DECISION_TYPES.FAN_OUT && Array.isArray(pendingDecision.targets)) {
        return {
          ...pendingDecision,
          targets: pendingDecision.targets.map((t) => {
            const participant = ctx.participants.find((p) => p.agentId === t.agentId);
            return {
              ...t,
              message: buildReReviewPrompt(
                ctx.objective,
                participant?.displayName || t.agentId,
                openIssues,
                state.latestImplementation,
                handoffPromptContext,
              ) + wsCtx,
            };
          }),
        };
      }

      return pendingDecision;
    },

    /**
     * Cleanup on shutdown.
     */
    shutdown(_ctx) {
      // No cleanup needed for in-process plugin
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      const handoffPayloads = [];

      if (state) {
        handoffPayloads.push(buildReviewFindingsPayload(ctx, state));
      }

      handoffPayloads.push(...collectReviewCyclePassThroughPayloads(ctx));

      return {
        handoffPayloads,
        artifacts: [],
      };
    },
  };
}

// Export internals for testing
export {
  parseReviewerResponse,
  parseSynthesisResponse,
  nextReviewerPhase,
  evaluateConvergence,
  buildInitialReviewPrompt,
  buildReReviewPrompt,
  buildCleanReviewPrompt,
  buildImplementerPrompt,
  buildSynthesisPrompt,
};
