// ---------------------------------------------------------------------------
// Phase flow — discovery → scenario_planning → test_writing → test_execution
// → fix_retry → evaluation → complete. Handlers ingest worker responses,
// reconcile non-responding in-flight scenarios, and call into the next
// transitionTo* helper. transitionToFixRetry owns retry-round bookkeeping
// so batches at the same retry level don't each consume a cycle.
// ---------------------------------------------------------------------------

import { DECISION_TYPES, STOP_REASON } from '../../core-room-support/room-contracts.js';
import {
  buildEvaluationPrompt,
  buildFixPrompt,
  buildScenarioPlanningPrompt,
  buildTestExecutionPrompt,
  buildTestWritingPrompt,
  parseFixResponse,
  parseScenarioPlanResponse,
  parseTestExecutionResponse,
  parseTestWritingResponse,
  parseUiUxDiscoveryResponse,
} from '../uiux-prompts.js';
import { PHASES, TURN_LOG_MAX } from './constants.js';
import { getConfig } from './config.js';
import {
  dispatchBatch,
  findScenarioForAgent,
  selectBatch,
  wrapForSemiAuto,
} from './dispatch.js';
import {
  emitBoardMetrics,
  logOrchestrator,
  logTurn,
} from './metrics.js';

export async function handleDiscoveryComplete(ctx, state, responses) {
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

  const responded = new Set(responses.map((r) => r.agentId));
  for (const [id, cap] of Object.entries(state.workerCapabilities)) {
    if (!responded.has(id)) cap.available = false;
  }

  const available = Object.values(state.workerCapabilities).filter((c) => c.available !== false);
  if (available.length === 0) {
    ctx.setState(state);
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
  }

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

export async function handleTestWritingComplete(ctx, state, responses) {
  const config = getConfig(ctx);
  for (const r of responses) processWriteResult(state, r.agentId, r.response, ctx);

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

export async function handleSingleWriteResult(ctx, state, turnResult) {
  const config = getConfig(ctx);
  processWriteResult(state, turnResult.agentId, turnResult.response, ctx);

  const stillWriting = state.scenarios.filter((s) => s.status === 'writing');
  if (stillWriting.length > 0) {
    emitBoardMetrics(ctx, state);
    ctx.setState(state);
    return null;
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

export async function handleTestExecutionComplete(ctx, state, responses) {
  const config = getConfig(ctx);
  for (const r of responses) processExecResult(state, r.agentId, r.response, ctx);

  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const s of state.scenarios) {
    if (s.status === 'running' && !respondedIds.has(s.assignedTo)) {
      const workerAvailable = state.workerCapabilities[s.assignedTo]?.available !== false;
      s.status = workerAvailable ? 'failed' : 'blocked';
      s.lastResult = { passed: false, errors: ['No response from agent during test execution'], output: '' };
      s.completedInCycle = state.currentCycle;
    }
  }

  const stillWritten = state.scenarios.filter((s) => s.status === 'written');
  if (stillWritten.length > 0) return transitionToTestExecution(ctx, state, config);

  return afterExecution(ctx, state, config);
}

export async function handleSingleExecResult(ctx, state, turnResult) {
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
  const passed = state.scenarios.filter((s) => s.status === 'passed').length;
  const failed = state.scenarios.filter((s) => s.status === 'failed').length;
  const tested = passed + failed;
  const passRate = tested > 0 ? Math.round((passed / tested) * 100) : 0;

  if (passRate >= config.minPassRatePct) {
    return transitionToEvaluation(ctx, state, config);
  }

  const retriable = state.scenarios.filter((s) => s.status === 'failed' && s.retries < s.maxRetries);
  if (retriable.length === 0) {
    return transitionToEvaluation(ctx, state, config);
  }

  return transitionToFixRetry(ctx, state, config);
}

function transitionToFixRetry(ctx, state, config) {
  state.phase = PHASES.FIX_RETRY;

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

  // retryRound / currentCycle bookkeeping: a new logical round begins only
  // when the minimum retries count among eligible scenarios reaches or
  // exceeds the current retryRound. Batches at the same retry level consume
  // one cycle in total, not one per batch.
  const minRetries = eligible[0].retries;
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

export async function handleFixRetryComplete(ctx, state, responses) {
  const config = getConfig(ctx);
  for (const r of responses) processFixResult(state, r.agentId, r.response, ctx);

  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const s of state.scenarios) {
    if (s.status === 'fixing' && !respondedIds.has(s.assignedTo)) {
      const workerAvailable = state.workerCapabilities[s.assignedTo]?.available !== false;
      s.status = workerAvailable ? 'failed' : 'blocked';
      s.lastResult = { passed: false, errors: ['No response from agent during fix retry'], output: '' };
    }
  }

  const stillFailing = state.scenarios.filter((s) => s.status === 'failed' && s.retries < s.maxRetries);
  if (stillFailing.length > 0 && config.exhaustFixRetries) {
    return transitionToFixRetry(ctx, state, config);
  }

  return afterExecution(ctx, state, config);
}

export async function handleSingleFixResult(ctx, state, turnResult) {
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
