// ---------------------------------------------------------------------------
// Review Cycle plugin manifest — static config describing the plugin's
// dashboard panels, limits, roles, handoff contracts, display strings, report
// layout, and CLI integration. All values are deeply frozen so the runtime
// can treat this as read-only data without defensive copying.
// ---------------------------------------------------------------------------

export const PLUGIN_ID = 'review_cycle';

export const MANIFEST = Object.freeze({
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
