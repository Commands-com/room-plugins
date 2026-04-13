/**
 * UI/UX Testing Plugin — deterministic test/fix/revalidate loop.
 *
 * Six-phase orchestration:
 *   discovery -> scenario_planning -> test_writing -> test_execution -> fix_retry -> evaluation -> complete
 *
 * Discovery is UI/UX-specific: asks workers to inventory components, routes,
 * test frameworks, selector patterns, and accessibility setup — not generic
 * project exploration.
 */

import {
  DECISION_TYPES,
  AGENT_ROLES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';

import { createUiUxCompatibilityService } from './uiux-compatibility-service.js';
import {
  DOMAIN_CONTEXT,
  buildUiUxDiscoveryPrompt,
  parseUiUxDiscoveryResponse,
  buildScenarioPlanningPrompt,
  buildTestWritingPrompt,
  buildTestExecutionPrompt,
  buildFixPrompt,
  buildEvaluationPrompt,
  parseScenarioPlanResponse,
  parseTestWritingResponse,
  parseTestExecutionResponse,
  parseFixResponse,
} from './uiux-prompts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'ui_ux_testing';
const TURN_LOG_MAX = 20_000;
const HANDOFF_LIST_LIMIT = 4;
const HANDOFF_TEXT_LIMIT = 220;

const PHASES = Object.freeze({
  DISCOVERY: 'discovery',
  SCENARIO_PLANNING: 'scenario_planning',
  TEST_WRITING: 'test_writing',
  TEST_EXECUTION: 'test_execution',
  FIX_RETRY: 'fix_retry',
  EVALUATION: 'evaluation',
  COMPLETE: 'complete',
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const MANIFEST = Object.freeze({
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

// ---------------------------------------------------------------------------
// Config helper — merge orchestratorConfig + roomConfig into one object
// ---------------------------------------------------------------------------

function getConfig(ctx) {
  return {
    plannedScenarios: ctx.orchestratorConfig?.plannedScenarios ?? 12,
    parallelism: ctx.orchestratorConfig?.parallelism ?? 2,
    maxRetriesPerScenario: ctx.orchestratorConfig?.maxRetriesPerScenario ?? 2,
    scenarioTimeoutMin: ctx.orchestratorConfig?.scenarioTimeoutMin ?? 10,
    minPassRatePct: ctx.orchestratorConfig?.minPassRatePct ?? 90,
    runAccessibility: ctx.orchestratorConfig?.runAccessibility ?? 1,
    runVisualDiff: ctx.orchestratorConfig?.runVisualDiff ?? 0,
    visualDiffThresholdPct: ctx.orchestratorConfig?.visualDiffThresholdPct ?? 1.0,
    exhaustFixRetries: ctx.orchestratorConfig?.exhaustFixRetries ?? 1,
    maxFixTasksPerCycle: ctx.orchestratorConfig?.maxFixTasksPerCycle ?? 20,
    targetPath: ctx.roomConfig?.targetPath || '',
    harnessCommand: ctx.roomConfig?.harnessCommand || '',
    targetRuntime: ctx.roomConfig?.targetRuntime || 'auto',
    testPersonas: ctx.roomConfig?.testPersonas || ['default'],
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function emitBoardMetrics(ctx, state) {
  const s = state.scenarios;
  const pending = s.filter((x) => x.status === 'pending' || x.status === 'writing').length;
  const inProgress = s.filter((x) => x.status === 'written' || x.status === 'running' || x.status === 'fixing').length;
  const passed = s.filter((x) => x.status === 'passed').length;
  const failed = s.filter((x) => x.status === 'failed').length;
  const skipped = s.filter((x) => x.status === 'skipped' || x.status === 'blocked').length;
  const done = passed + failed + skipped;
  const tested = passed + failed;
  const passRate = tested > 0 ? Math.round((passed / tested) * 100) : 0;
  state.passRate = passRate;

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    taskSummary: { pending, inProgress, done, blocked: s.filter((x) => x.status === 'blocked').length },
    taskProgress: { value: done, max: s.length || 0 },
    passRate: { value: passRate, max: 100 },
    taskBoard: {
      rows: s.map((sc, idx) => {
        const p = ctx.participants.find((pp) => pp.agentId === sc.assignedTo);
        return {
          id: sc.id,
          taskNum: String(idx + 1),
          title: sc.title,
          agentId: sc.assignedTo,
          assignedTo: p?.displayName || sc.assignedTo,
          status: sc.status,
          result: sc.lastResult ? (sc.lastResult.passed ? 'PASS' : 'FAIL') : '-',
          retries: `${sc.retries}/${sc.maxRetries}`,
        };
      }),
    },
    turnLog: { entries: state.turnLog },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logTurn(state, agentId, response, ctx) {
  const participant = ctx.participants.find((p) => p.agentId === agentId);
  const raw = response || '';
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'worker',
    agent: participant?.displayName || agentId,
    content: raw.length > TURN_LOG_MAX ? raw.slice(0, TURN_LOG_MAX) + '\n... [truncated]' : raw,
  });
}

function logOrchestrator(state, text) {
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'reviewer',
    agent: 'Orchestrator',
    content: (text || '').slice(0, TURN_LOG_MAX),
  });
}

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

function collectPassThroughPayloads(handoffContext) {
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

function buildInboundPromptContext(handoffContext) {
  const sections = [
    buildSpecBundlePromptContext(handoffContext),
    buildImplementationBundlePromptContext(handoffContext),
    buildReviewFindingsPromptContext(handoffContext),
  ].filter(Boolean);

  return sections.join('\n\n');
}

function wrapForSemiAuto(ctx, state, decision) {
  if (!decision) return decision;
  if (ctx.mode !== 'semi_auto') return decision;
  if (decision.type === DECISION_TYPES.STOP || decision.type === DECISION_TYPES.PAUSE) return decision;
  if (decision.type === DECISION_TYPES.FAN_OUT) {
    state.pendingFanOut = decision;
    return { type: DECISION_TYPES.PAUSE, reason: 'semi_auto_review' };
  }
  return decision;
}

function findScenarioForAgent(state, agentId, ...statuses) {
  return state.scenarios.find(
    (s) => s.assignedTo === agentId && statuses.includes(s.status),
  );
}

// ---------------------------------------------------------------------------
// Dispatch builders
// ---------------------------------------------------------------------------

/**
 * Select up to `parallelism` scenarios, one per worker.
 * Prevents marking scenarios that can't be dispatched in this round.
 */
function selectBatch(scenarios, parallelism) {
  const seen = new Set();
  const batch = [];
  for (const s of scenarios) {
    if (batch.length >= parallelism) break;
    if (!seen.has(s.assignedTo)) {
      seen.add(s.assignedTo);
      batch.push(s);
    }
  }
  return batch;
}

function dispatchBatch(scenarios, promptFn, config, upstreamContext = '') {
  if (scenarios.length === 0) return null;
  if (scenarios.length === 1) {
    return {
      type: DECISION_TYPES.SPEAK,
      agentId: scenarios[0].assignedTo,
      message: promptFn(scenarios[0], config, upstreamContext),
    };
  }
  return {
    type: DECISION_TYPES.FAN_OUT,
    targets: scenarios.map((s) => ({
      agentId: s.assignedTo,
      message: promptFn(s, config, upstreamContext),
    })),
  };
}

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

function buildTestResultsReport(ctx, state) {
  const scenarios = Array.isArray(state?.scenarios) ? state.scenarios : [];
  const artifacts = collectFileArtifacts(scenarios.map((scenario) => scenario.testFilePath));
  const baseReport = typeof ctx.getFinalReport === 'function' ? ctx.getFinalReport() : null;
  const config = getConfig(ctx);

  return {
    artifacts,
    payload: {
      contract: 'test_results.v1',
      data: {
        objective: ctx.objective || '',
        roomId: ctx.roomId || null,
        stopReason: baseReport?.stopReason || null,
        cyclesCompleted: state?.currentCycle ?? ctx.cycle ?? 0,
        target: {
          path: config.targetPath,
          runtime: config.targetRuntime,
          harnessCommand: config.harnessCommand,
          personas: config.testPersonas,
        },
        threshold: {
          minPassRatePct: config.minPassRatePct,
          maxRetriesPerScenario: config.maxRetriesPerScenario,
        },
        summary: {
          totalScenarios: scenarios.length,
          passed: state?.totalPassed ?? scenarios.filter((scenario) => scenario.status === 'passed').length,
          failed: state?.totalFailed ?? scenarios.filter((scenario) => scenario.status === 'failed').length,
          skipped: state?.totalSkipped ?? scenarios.filter((scenario) => ['blocked', 'skipped'].includes(scenario.status)).length,
          passRate: state?.passRate ?? 0,
        },
        scenarios: scenarios.map((scenario) => ({
          id: scenario.id,
          title: scenario.title,
          description: scenario.description,
          category: scenario.category,
          assignedTo: scenario.assignedTo,
          status: scenario.status,
          retries: scenario.retries,
          maxRetries: scenario.maxRetries,
          testFilePath: scenario.testFilePath || '',
          completedInCycle: scenario.completedInCycle ?? null,
          lastResult: scenario.lastResult
            ? {
              passed: !!scenario.lastResult.passed,
              passCount: scenario.lastResult.passCount || 0,
              failCount: scenario.lastResult.failCount || 0,
              errors: Array.isArray(scenario.lastResult.errors) ? scenario.lastResult.errors : [],
              output: scenario.lastResult.output || '',
              summary: scenario.lastResult.summary || '',
              fixApplied: scenario.lastResult.fixApplied || null,
            }
            : null,
        })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

async function handleDiscoveryComplete(ctx, state, responses) {
  const config = getConfig(ctx);

  for (const r of responses) {
    const parsed = parseUiUxDiscoveryResponse(r.response);
    const cap = state.workerCapabilities[r.agentId];
    if (cap) {
      if (!parsed.parseError) {
        Object.assign(cap, {
          workingDirectory: parsed.workingDirectory,
          uiFramework: parsed.uiFramework,
          componentPages: parsed.componentPages,
          routeMap: parsed.routeMap,
          testFramework: parsed.testFramework,
          testConfigPath: parsed.testConfigPath,
          exampleTestFile: parsed.exampleTestFile,
          selectorPattern: parsed.selectorPattern,
          stylingApproach: parsed.stylingApproach,
          keyInteractions: parsed.keyInteractions,
          accessibilitySetup: parsed.accessibilitySetup,
          entryPoints: parsed.entryPoints,
          existingTestCoverage: parsed.existingTestCoverage,
        });
      }
      cap.fullReport = (r.response || '').slice(0, TURN_LOG_MAX);
    }
    logTurn(state, r.agentId, r.response, ctx);
  }

  // Mark non-respondents unavailable
  const responded = new Set(responses.map((r) => r.agentId));
  for (const [id, cap] of Object.entries(state.workerCapabilities)) {
    if (!responded.has(id)) cap.available = false;
  }

  const available = Object.values(state.workerCapabilities).filter((c) => c.available !== false);
  if (available.length === 0) {
    ctx.setState(state);
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
  }

  // Phase 2: Scenario Planning via orchestrator LLM
  state.phase = PHASES.SCENARIO_PLANNING;
  ctx.emitMetrics({ currentPhase: { active: PHASES.SCENARIO_PLANNING } });

  const MAX_PLAN_ATTEMPTS = 3;
  let rawScenarios = null;
  let lastPlanError = '';

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const planResult = await ctx.invokeLLM(
      buildScenarioPlanningPrompt(ctx.objective, available, config, state.handoffPromptContext || ''),
      {
        purpose: 'planning',
        allow_tool_use: true,
        permission_profile_override: 'read-only',
        timeoutMs: ctx.limits.agentTimeoutMs,
        max_output_chars: 120_000,
      },
    );

    if (!planResult.ok || !planResult.text) {
      lastPlanError = `scenario_planning_failed: ${planResult.error?.message || 'no response'}`;
      continue;
    }

    logOrchestrator(state, planResult.text);

    rawScenarios = parseScenarioPlanResponse(planResult.text);
    if (rawScenarios && rawScenarios.length > 0) break;
    lastPlanError = 'scenario_plan_parse_failed';
    rawScenarios = null;
  }

  if (!rawScenarios || rawScenarios.length === 0) {
    ctx.setState(state);
    return { type: DECISION_TYPES.PAUSE, reason: lastPlanError || 'scenario_plan_parse_failed' };
  }

  // Build scenario objects, validate worker assignments
  const availableIds = available.map((w) => w.agentId);
  state.scenarios = rawScenarios.map((s, i) => ({
    id: s.id || `scenario_${i + 1}`,
    title: s.title,
    description: s.description,
    assignedTo: availableIds.includes(s.assignedTo) ? s.assignedTo : availableIds[i % availableIds.length],
    category: s.category,
    status: 'pending',
    retries: 0,
    maxRetries: config.maxRetriesPerScenario,
    testFilePath: '',
    lastResult: null,
    assignedInCycle: null,
    completedInCycle: null,
  }));
  state.nextScenarioId = state.scenarios.length + 1;

  return transitionToTestWriting(ctx, state, config);
}

function transitionToTestWriting(ctx, state, config) {
  // Only increment currentCycle on phase entry, not on every batch dispatch
  if (state.phase !== PHASES.TEST_WRITING) {
    state.phase = PHASES.TEST_WRITING;
    state.currentCycle += 1;
    ctx.setCycle(state.currentCycle);

    if (state.currentCycle > ctx.limits.maxCycles) {
      emitBoardMetrics(ctx, state);
      ctx.setState(state);
      return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CYCLE_LIMIT };
    }
  }

  const pending = state.scenarios.filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    return transitionToTestExecution(ctx, state, config);
  }

  const batch = selectBatch(pending, config.parallelism);
  for (const s of batch) {
    s.status = 'writing';
    s.assignedInCycle = state.currentCycle;
  }

  const decision = dispatchBatch(batch, buildTestWritingPrompt, config, state.handoffPromptContext || '');

  emitBoardMetrics(ctx, state);
  if (!decision) { ctx.setState(state); return null; }
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);
  return wrapped;
}

function processWriteResult(state, agentId, response, ctx) {
  const scenario = findScenarioForAgent(state, agentId, 'writing');
  if (!scenario) return;

  logTurn(state, agentId, response, ctx);
  const parsed = parseTestWritingResponse(response);

  if (parsed.status === 'blocked') {
    scenario.status = 'blocked';
  } else {
    scenario.status = 'written';
    scenario.testFilePath = parsed.testFilePath;
  }
}

async function handleTestWritingComplete(ctx, state, responses) {
  const config = getConfig(ctx);
  for (const r of responses) processWriteResult(state, r.agentId, r.response, ctx);

  // Reconcile non-responding in-flight scenarios: mark still-writing scenarios
  // whose agents did not respond as 'failed' (or 'blocked' if worker is unavailable)
  // so they are not silently dropped.
  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const s of state.scenarios) {
    if (s.status === 'writing' && !respondedIds.has(s.assignedTo)) {
      const workerAvailable = state.workerCapabilities[s.assignedTo]?.available !== false;
      s.status = workerAvailable ? 'failed' : 'blocked';
      s.lastResult = { passed: false, errors: ['No response from agent during test writing'], output: '' };
    }
  }

  const stillPending = state.scenarios.filter((s) => s.status === 'pending');
  if (stillPending.length > 0) return transitionToTestWriting(ctx, state, config);
  return transitionToTestExecution(ctx, state, config);
}

async function handleSingleWriteResult(ctx, state, turnResult) {
  const config = getConfig(ctx);
  processWriteResult(state, turnResult.agentId, turnResult.response, ctx);

  // Check if any writing scenarios remain dispatched
  const stillWriting = state.scenarios.filter((s) => s.status === 'writing');
  if (stillWriting.length > 0) {
    emitBoardMetrics(ctx, state);
    ctx.setState(state);
    return null; // wait for remaining
  }

  const stillPending = state.scenarios.filter((s) => s.status === 'pending');
  if (stillPending.length > 0) return transitionToTestWriting(ctx, state, config);
  return transitionToTestExecution(ctx, state, config);
}

function transitionToTestExecution(ctx, state, config) {
  state.phase = PHASES.TEST_EXECUTION;
  ctx.emitMetrics({ currentPhase: { active: PHASES.TEST_EXECUTION } });

  const written = state.scenarios.filter((s) => s.status === 'written');
  if (written.length === 0) {
    // Nothing to execute — go to evaluation
    return transitionToEvaluation(ctx, state, config);
  }

  const batch = selectBatch(written, config.parallelism);
  for (const s of batch) {
    s.status = 'running';
  }

  const decision = dispatchBatch(batch, buildTestExecutionPrompt, config);

  emitBoardMetrics(ctx, state);
  if (!decision) { ctx.setState(state); return null; }
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);
  return wrapped;
}

function processExecResult(state, agentId, response, ctx) {
  const scenario = findScenarioForAgent(state, agentId, 'running');
  if (!scenario) return;

  logTurn(state, agentId, response, ctx);
  const parsed = parseTestExecutionResponse(response);
  scenario.lastResult = parsed;

  if (parsed.passed) {
    scenario.status = 'passed';
    scenario.completedInCycle = state.currentCycle;
  } else {
    scenario.status = 'failed';
    scenario.completedInCycle = state.currentCycle;
  }
}

async function handleTestExecutionComplete(ctx, state, responses) {
  const config = getConfig(ctx);
  for (const r of responses) processExecResult(state, r.agentId, r.response, ctx);

  // Reconcile non-responding in-flight scenarios: mark still-running scenarios
  // whose agents did not respond as 'failed' (or 'blocked' if worker is unavailable)
  // so they are not silently dropped.
  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const s of state.scenarios) {
    if (s.status === 'running' && !respondedIds.has(s.assignedTo)) {
      const workerAvailable = state.workerCapabilities[s.assignedTo]?.available !== false;
      s.status = workerAvailable ? 'failed' : 'blocked';
      s.lastResult = { passed: false, errors: ['No response from agent during test execution'], output: '' };
      s.completedInCycle = state.currentCycle;
    }
  }

  // More written scenarios waiting?
  const stillWritten = state.scenarios.filter((s) => s.status === 'written');
  if (stillWritten.length > 0) return transitionToTestExecution(ctx, state, config);

  return afterExecution(ctx, state, config);
}

async function handleSingleExecResult(ctx, state, turnResult) {
  const config = getConfig(ctx);
  processExecResult(state, turnResult.agentId, turnResult.response, ctx);

  const stillRunning = state.scenarios.filter((s) => s.status === 'running');
  if (stillRunning.length > 0) {
    emitBoardMetrics(ctx, state);
    ctx.setState(state);
    return null;
  }

  const stillWritten = state.scenarios.filter((s) => s.status === 'written');
  if (stillWritten.length > 0) return transitionToTestExecution(ctx, state, config);

  return afterExecution(ctx, state, config);
}

function afterExecution(ctx, state, config) {
  // Check pass rate
  const passed = state.scenarios.filter((s) => s.status === 'passed').length;
  const failed = state.scenarios.filter((s) => s.status === 'failed').length;
  const tested = passed + failed;
  const passRate = tested > 0 ? Math.round((passed / tested) * 100) : 0;

  if (passRate >= config.minPassRatePct) {
    return transitionToEvaluation(ctx, state, config);
  }

  // Are there scenarios eligible for retry?
  const retriable = state.scenarios.filter((s) => s.status === 'failed' && s.retries < s.maxRetries);
  if (retriable.length === 0) {
    return transitionToEvaluation(ctx, state, config);
  }

  return transitionToFixRetry(ctx, state, config);
}

function transitionToFixRetry(ctx, state, config) {
  state.phase = PHASES.FIX_RETRY;

  // Filter eligible scenarios: failed, retriable, and assigned to available workers.
  const eligible = state.scenarios
    .filter((s) =>
      s.status === 'failed' &&
      s.retries < s.maxRetries &&
      state.workerCapabilities[s.assignedTo]?.available !== false)
    // Sort by retries ascending so under-retried scenarios are prioritized (prevent starvation).
    .sort((a, b) => a.retries - b.retries)
    .slice(0, config.maxFixTasksPerCycle);

  if (eligible.length === 0) {
    return transitionToEvaluation(ctx, state, config);
  }

  // Track logical retry rounds: a new round begins when the minimum retries
  // count among eligible scenarios reaches or exceeds the current retryRound.
  // Within a round, multiple batches can be dispatched without incrementing the
  // cycle (since later batches at the same retry level are just parallelism-
  // constrained continuations). A new cycle is consumed only when all scenarios
  // at the previous retry level have been attempted and we advance to the next.
  const minRetries = eligible[0].retries; // sorted ascending, so first is min
  if (minRetries >= state.retryRound) {
    state.retryRound = minRetries + 1;
    state.currentCycle += 1;
    ctx.setCycle(state.currentCycle);

    if (state.currentCycle > ctx.limits.maxCycles) {
      emitBoardMetrics(ctx, state);
      ctx.setState(state);
      return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CYCLE_LIMIT };
    }
  }

  ctx.emitMetrics({ currentPhase: { active: PHASES.FIX_RETRY } });

  const batch = selectBatch(eligible, config.parallelism);
  for (const s of batch) {
    s.status = 'fixing';
    s.retries += 1;
  }

  const decision = dispatchBatch(batch, buildFixPrompt, config, state.handoffPromptContext || '');

  emitBoardMetrics(ctx, state);
  if (!decision) { ctx.setState(state); return null; }
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);
  return wrapped;
}

function processFixResult(state, agentId, response, ctx) {
  const scenario = findScenarioForAgent(state, agentId, 'fixing');
  if (!scenario) return;

  logTurn(state, agentId, response, ctx);
  const parsed = parseFixResponse(response);
  scenario.lastResult = parsed;

  if (parsed.passed) {
    scenario.status = 'passed';
    scenario.completedInCycle = state.currentCycle;
  } else {
    scenario.status = 'failed';
  }
}

async function handleFixRetryComplete(ctx, state, responses) {
  const config = getConfig(ctx);
  for (const r of responses) processFixResult(state, r.agentId, r.response, ctx);

  // Reconcile non-responding in-flight scenarios: mark still-fixing scenarios
  // whose agents did not respond as 'failed' (or 'blocked' if worker is unavailable)
  // so they are not silently dropped.
  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const s of state.scenarios) {
    if (s.status === 'fixing' && !respondedIds.has(s.assignedTo)) {
      const workerAvailable = state.workerCapabilities[s.assignedTo]?.available !== false;
      s.status = workerAvailable ? 'failed' : 'blocked';
      s.lastResult = { passed: false, errors: ['No response from agent during fix retry'], output: '' };
    }
  }

  // More failed scenarios needing fix in this batch?
  const stillFailing = state.scenarios.filter((s) => s.status === 'failed' && s.retries < s.maxRetries);
  if (stillFailing.length > 0 && config.exhaustFixRetries) {
    return transitionToFixRetry(ctx, state, config);
  }

  return afterExecution(ctx, state, config);
}

async function handleSingleFixResult(ctx, state, turnResult) {
  const config = getConfig(ctx);
  processFixResult(state, turnResult.agentId, turnResult.response, ctx);

  const stillFixing = state.scenarios.filter((s) => s.status === 'fixing');
  if (stillFixing.length > 0) {
    emitBoardMetrics(ctx, state);
    ctx.setState(state);
    return null;
  }

  const stillFailing = state.scenarios.filter((s) => s.status === 'failed' && s.retries < s.maxRetries);
  if (stillFailing.length > 0 && config.exhaustFixRetries) {
    return transitionToFixRetry(ctx, state, config);
  }

  return afterExecution(ctx, state, config);
}

async function transitionToEvaluation(ctx, state, config) {
  state.phase = PHASES.EVALUATION;
  ctx.emitMetrics({ currentPhase: { active: PHASES.EVALUATION } });

  const passed = state.scenarios.filter((s) => s.status === 'passed').length;
  const failed = state.scenarios.filter((s) => s.status === 'failed').length;
  const tested = passed + failed;
  const passRate = tested > 0 ? Math.round((passed / tested) * 100) : 0;
  state.passRate = passRate;
  state.totalPassed = passed;
  state.totalFailed = failed;
  state.totalSkipped = state.scenarios.filter((s) => s.status === 'blocked' || s.status === 'skipped').length;

  const evalResult = await ctx.invokeLLM(
    buildEvaluationPrompt(ctx.objective, state.scenarios, passRate, config, state.handoffPromptContext || ''),
    {
      purpose: 'synthesis',
      allow_tool_use: true,
      permission_profile_override: 'read-only',
    },
  );

  if (evalResult.ok && evalResult.text) {
    logOrchestrator(state, evalResult.text);
  }

  emitBoardMetrics(ctx, state);
  ctx.setState(state);

  if (passRate >= config.minPassRatePct) {
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE };
  }
  return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function createUiUxTestingPlugin() {
  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    checkCompatibility(payload, context) {
      const service = createUiUxCompatibilityService(context);
      return service.checkCompatibility({
        targetPath: payload.roomConfig?.targetPath,
        targetRuntime: payload.roomConfig?.targetRuntime,
        harnessCommand: payload.roomConfig?.harnessCommand,
        testPersonas: payload.roomConfig?.testPersonas,
        localAgentProfileIds: payload.localAgentProfileIds,
        workspace: payload.workspace || null,
      });
    },

    makeCompatible(payload, context) {
      const service = createUiUxCompatibilityService(context);
      return service.makeCompatible({
        targetPath: payload.roomConfig?.targetPath,
        targetRuntime: payload.roomConfig?.targetRuntime,
        harnessCommand: payload.roomConfig?.harnessCommand,
        testPersonas: payload.roomConfig?.testPersonas,
        localAgentProfileIds: payload.localAgentProfileIds,
        workspace: payload.workspace || null,
      });
    },

    init(ctx) {
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      ctx.setState({
        phase: PHASES.DISCOVERY,
        handoffPromptContext: buildInboundPromptContext(ctx.handoffContext),
        workerCapabilities: Object.fromEntries(
          workers.map((w) => [w.agentId, { agentId: w.agentId, displayName: w.displayName, available: true }]),
        ),
        scenarios: [],
        nextScenarioId: 1,
        currentCycle: 0,
        retryRound: 0,
        pendingFanOut: null,
        turnLog: [],
        passRate: 0,
        totalPassed: 0,
        totalFailed: 0,
        totalSkipped: 0,
      });
    },

    onRoomStart(ctx) {
      const state = ctx.getState();
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      const config = getConfig(ctx);
      ctx.emitMetrics({ currentPhase: { active: PHASES.DISCOVERY } });

      const discoveryPrompt = buildUiUxDiscoveryPrompt(ctx.objective, config, state?.handoffPromptContext || '');
      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: workers.map((w) => ({
          agentId: w.agentId,
          message: discoveryPrompt,
        })),
      };
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();
      switch (state.phase) {
        case PHASES.DISCOVERY: return await handleDiscoveryComplete(ctx, state, responses);
        case PHASES.TEST_WRITING: return await handleTestWritingComplete(ctx, state, responses);
        case PHASES.TEST_EXECUTION: return await handleTestExecutionComplete(ctx, state, responses);
        case PHASES.FIX_RETRY: return await handleFixRetryComplete(ctx, state, responses);
        default: return null;
      }
    },

    async onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      switch (state.phase) {
        case PHASES.TEST_WRITING: return await handleSingleWriteResult(ctx, state, turnResult);
        case PHASES.TEST_EXECUTION: return await handleSingleExecResult(ctx, state, turnResult);
        case PHASES.FIX_RETRY: return await handleSingleFixResult(ctx, state, turnResult);
        default: return null;
      }
    },

    onResume(ctx) {
      const state = ctx.getState();
      if (state.pendingFanOut) {
        const decision = state.pendingFanOut;
        state.pendingFanOut = null;
        ctx.setState(state);
        return decision;
      }
      return null;
    },

    onEvent(ctx, event) {
      const state = ctx.getState();
      if (event.type === 'participant_disconnected' && event.agentId) {
        const cap = state.workerCapabilities[event.agentId];
        if (cap) {
          cap.available = false;
          for (const s of state.scenarios) {
            if (s.assignedTo === event.agentId && ['pending', 'writing', 'written', 'failed', 'running', 'fixing'].includes(s.status)) {
              s.status = 'blocked';
            }
          }
          emitBoardMetrics(ctx, state);
          ctx.setState(state);
        }
      }
    },

    shutdown(ctx) {
      const state = ctx.getState();
      if (state) {
        state.phase = PHASES.COMPLETE;
        emitBoardMetrics(ctx, state);
        ctx.setState(state);
      }
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) {
        return {
          handoffPayloads: [],
          artifacts: [],
        };
      }

      const { payload, artifacts } = buildTestResultsReport(ctx, state);
      return {
        handoffPayloads: [payload, ...collectPassThroughPayloads(ctx.handoffContext)],
        artifacts,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  PHASES,
  DOMAIN_CONTEXT,
  buildInboundPromptContext,
  buildUiUxDiscoveryPrompt,
  parseUiUxDiscoveryResponse,
  parseScenarioPlanResponse,
  parseTestWritingResponse,
  parseTestExecutionResponse,
  parseFixResponse,
  buildScenarioPlanningPrompt,
  buildTestWritingPrompt,
  buildTestExecutionPrompt,
  buildFixPrompt,
  buildEvaluationPrompt,
  getConfig,
};
