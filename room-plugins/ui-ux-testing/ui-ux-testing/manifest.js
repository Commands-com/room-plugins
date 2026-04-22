// ---------------------------------------------------------------------------
// UI/UX Testing plugin manifest. Frozen declarative config: roles, limits,
// handoff inputs/outputs, dashboard panels, report layout, orchestratorConfig
// schema, roomConfigSchema, and the compatibility gate.
// ---------------------------------------------------------------------------

import { PLUGIN_ID } from './constants.js';

export const MANIFEST = Object.freeze({
  id: PLUGIN_ID,
  name: 'UI/UX Testing',
  version: '2.0.0',
  orchestratorType: 'ui_ux_testing',
  description: 'Deterministic Electron/Web UI workflow testing with fix-and-retest cycles',
  supportsQuorum: true,
  roles: Object.freeze({
    required: Object.freeze(['worker']),
    optional: Object.freeze([]),
    forbidden: Object.freeze(['implementer', 'reviewer']),
    minCount: Object.freeze({ worker: 1 }),
  }),
  limits: Object.freeze({
    maxCycles: Object.freeze({ default: 3, min: 1, max: 20 }),
    maxTurns: Object.freeze({ default: 120, min: 3, max: 2000 }),
    maxDurationMs: Object.freeze({ default: 14_400_000, max: 43_200_000 }),
    maxFailures: Object.freeze({ default: 6 }),
    agentTimeoutMs: Object.freeze({ default: 1_800_000, max: 3_600_000 }),
    pluginHookTimeoutMs: Object.freeze({ default: 120_000, max: 600_000 }),
    llmTimeoutMs: Object.freeze({ default: 120_000, max: 600_000 }),
    turnFloorRole: 'worker',
    turnFloorFormula: '2 + N',
  }),
  endpointConstraints: Object.freeze({
    requiresLocalParticipant: true,
    perRole: Object.freeze({}),
  }),
  handoff: Object.freeze({
    inputs: Object.freeze([
      Object.freeze({ contract: 'spec_bundle.v1', required: false, multiple: false }),
      Object.freeze({ contract: 'implementation_bundle.v1', required: false, multiple: false }),
      Object.freeze({ contract: 'review_findings.v1', required: false, multiple: false }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ contract: 'test_results.v1', default: true }),
      Object.freeze({ contract: 'spec_bundle.v1' }),
      Object.freeze({ contract: 'implementation_bundle.v1' }),
      Object.freeze({ contract: 'review_findings.v1' }),
    ]),
    defaultApprovalMode: 'auto',
  }),
  display: Object.freeze({
    typeLabel: 'UI/UX Testing',
    typeTag: 'UXT',
    cycleNoun: 'Cycle',
    reportTitle: 'UI/UX Testing Report',
    activityMessages: Object.freeze({
      idle: 'Waiting...',
      discovery: 'Workers exploring the codebase',
      writing: 'Worker writing test',
      fanOut: 'Workers running test scenarios',
      singleTurn: 'Worker running scenario',
      synthesis: 'Evaluating test results',
      planning: 'Generating UI test scenarios',
    }),
    defaultRoster: Object.freeze([
      Object.freeze({ role: 'worker', displayName: 'Tester 1' }),
      Object.freeze({ role: 'worker', displayName: 'Tester 2' }),
    ]),
    defaultAddRole: 'worker',
  }),
  dashboard: Object.freeze({
    panels: Object.freeze([
      Object.freeze({
        type: 'phase',
        key: 'currentPhase',
        label: 'Phase',
        phases: Object.freeze([
          'discovery', 'scenario_planning', 'test_writing',
          'test_execution', 'fix_retry', 'evaluation', 'complete',
        ]),
        phaseLabels: Object.freeze({
          discovery: 'Discovery',
          scenario_planning: 'Scenario Planning',
          test_writing: 'Test Writing',
          test_execution: 'Test Execution',
          fix_retry: 'Fix & Retry',
          evaluation: 'Evaluation',
          complete: 'Complete',
        }),
      }),
      Object.freeze({
        type: 'counter-group',
        key: 'taskSummary',
        label: 'Scenarios',
        layout: 'row',
        counters: Object.freeze([
          Object.freeze({ key: 'pending', label: 'Pending', color: 'gray' }),
          Object.freeze({ key: 'inProgress', label: 'Active', color: 'blue' }),
          Object.freeze({ key: 'done', label: 'Done', color: 'green' }),
          Object.freeze({ key: 'blocked', label: 'Blocked', color: 'red' }),
        ]),
      }),
      Object.freeze({
        type: 'progress',
        key: 'taskProgress',
        label: 'Progress',
        format: '{value} / {max}',
      }),
      Object.freeze({
        type: 'progress',
        key: 'passRate',
        label: 'Pass Rate',
        format: '{value}%',
      }),
      Object.freeze({
        type: 'table',
        key: 'taskBoard',
        label: 'Scenarios',
        columns: Object.freeze([
          Object.freeze({ key: 'taskNum', label: '#', width: 30 }),
          Object.freeze({ key: 'title', label: 'Scenario' }),
          Object.freeze({ key: 'assignedTo', label: 'Worker' }),
          Object.freeze({ key: 'status', label: 'Status', width: 90 }),
          Object.freeze({ key: 'result', label: 'Result', width: 80 }),
          Object.freeze({ key: 'retries', label: 'Retries', width: 60 }),
        ]),
        sortable: true,
        filterable: Object.freeze(['status', 'assignedTo']),
      }),
    ]),
  }),
  report: Object.freeze({
    summaryMetrics: Object.freeze(['taskBoard']),
    table: Object.freeze({
      metricKey: 'taskBoard',
      columns: Object.freeze([
        Object.freeze({ key: 'title', label: 'Scenario' }),
        Object.freeze({ key: 'assignedTo', label: 'Worker', width: 120 }),
        Object.freeze({ key: 'status', label: 'Status', width: 80 }),
        Object.freeze({ key: 'result', label: 'Result', width: 80 }),
        Object.freeze({ key: 'retries', label: 'Retries', width: 60 }),
      ]),
    }),
  }),
  configSchema: Object.freeze({
    plannedScenarios: Object.freeze({ type: 'integer', min: 1, max: 100, default: 12 }),
    parallelism: Object.freeze({ type: 'integer', min: 1, max: 8, default: 2 }),
    maxRetriesPerScenario: Object.freeze({ type: 'integer', min: 0, max: 3, default: 2 }),
    scenarioTimeoutMin: Object.freeze({ type: 'integer', min: 1, max: 30, default: 10 }),
    minPassRatePct: Object.freeze({ type: 'integer', min: 50, max: 100, default: 90 }),
    runAccessibility: Object.freeze({ type: 'integer', min: 0, max: 1, default: 1 }),
    runVisualDiff: Object.freeze({ type: 'integer', min: 0, max: 1, default: 0 }),
    visualDiffThresholdPct: Object.freeze({ type: 'number', min: 0, max: 10, default: 1.0 }),
    exhaustFixRetries: Object.freeze({ type: 'integer', min: 0, max: 1, default: 1 }),
    maxFixTasksPerCycle: Object.freeze({ type: 'integer', min: 1, max: 50, default: 20 }),
  }),
  roomConfigSchema: Object.freeze({
    targetPath: Object.freeze({
      type: 'directory',
      label: 'Pick Directory (Repo)',
      required: true,
      placeholder: 'Select a repository directory',
    }),
    targetRuntime: Object.freeze({
      type: 'enum',
      label: 'Target Runtime',
      default: 'auto',
      options: Object.freeze(['auto', 'electron', 'web']),
    }),
    harnessCommand: Object.freeze({
      type: 'string',
      label: 'Harness Command',
      placeholder: 'e.g. npm run test:uiux',
    }),
    testPersonas: Object.freeze({
      type: 'string_array',
      label: 'Personas',
      default: Object.freeze(['default']),
      placeholder: 'One persona per line',
    }),
  }),
  setup: Object.freeze({
    compatibilityGate: true,
    compatibilityTitle: 'Compatibility',
    compatibilityDescription: 'Run compatibility checks before creating the room.',
    checkLabel: 'Check Compatibility',
    fixLabel: 'Make Compatible',
    allowMakeCompatible: true,
  }),
});
