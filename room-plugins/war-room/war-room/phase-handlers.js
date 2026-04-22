// ---------------------------------------------------------------------------
// Phase handlers for discovery → planning and execution fan-out/single
// turn. These ingest worker responses, update capabilities + the task
// board, run orchestrator planning/review, and then hand off to buildDecision
// via wrapForSemiAuto to produce the next runtime directive.
// ---------------------------------------------------------------------------

import { DECISION_TYPES, STOP_REASON } from '../../core-room-support/room-contracts.js';
import {
  STRUCTURED_ROOM_LLM_OUTPUT_CHARS,
  TURN_LOG_MAX_CONTENT_LENGTH,
} from './manifest.js';
import {
  buildPlanningPrompt,
  parseDiscoveryResponse,
  parsePlanningResponse,
  parseTaskResponse,
} from '../war-room-prompts.js';
import {
  getMaxDynamicWorkers,
  getMaxParallelWrites,
  getMaxReplicasPerWorker,
  useElasticWorkers,
  useIsolatedWriteWorktrees,
} from './config.js';
import { mergePromptContexts } from './handoff-context.js';
import { validatePlan } from './plan-validation.js';
import { buildDecision, wrapForSemiAuto } from './decision.js';
import { emitBoardMetrics } from './metrics.js';
import { applyParsedTaskResult } from './task-result.js';
import { invokeResultReview } from './orchestrator-review.js';

export async function handleDiscoveryComplete(ctx, state, responses, domainContext = '') {
  for (const r of responses) {
    const parsed = parseDiscoveryResponse(r.response);
    const cap = state.workerCapabilities[r.agentId];
    if (cap) {
      if (!parsed.parseError) {
        Object.assign(cap, {
          workingDirectory: parsed.workingDirectory,
          projectState: parsed.projectState,
          projectDescription: parsed.projectDescription,
          techStack: parsed.techStack,
          responsibilities: parsed.responsibilities,
          structure: parsed.structure,
          relevantFiles: parsed.relevantFiles,
          keyInterfaces: parsed.keyInterfaces,
          testInfo: parsed.testInfo,
          bootstrapGaps: parsed.bootstrapGaps,
          notes: parsed.notes,
        });
      }
      // Always store the full raw response — context survives parse errors.
      cap.fullReport = (r.response || '').slice(0, TURN_LOG_MAX_CONTENT_LENGTH);
    }

    const participant = ctx.participants.find((p) => p.agentId === r.agentId);
    const raw = r.response || '';
    state.turnLog.push({
      cycle: 0,
      role: 'worker',
      agent: participant?.displayName || r.agentId,
      content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
        ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
        : raw,
    });
  }

  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const [agentId, cap] of Object.entries(state.workerCapabilities)) {
    if (!respondedIds.has(agentId)) cap.available = false;
  }

  const availableWorkers = Object.values(state.workerCapabilities)
    .filter((c) => c.available !== false);
  if (availableWorkers.length === 0) {
    ctx.setState(state);
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
  }

  state.phase = 'planning';
  ctx.emitMetrics({ currentPhase: { active: 'planning' } });
  const effectiveDomainContext = mergePromptContexts(domainContext, state.handoffPromptContext || '');

  const planResult = await ctx.invokeLLM(
    buildPlanningPrompt(ctx.objective, availableWorkers, effectiveDomainContext, {
      maxParallelWrites: getMaxParallelWrites(ctx),
      isolatedWriteWorktrees: useIsolatedWriteWorktrees(ctx),
      elasticWorkers: useElasticWorkers(ctx),
      maxDynamicWorkers: getMaxDynamicWorkers(ctx),
      maxReplicasPerWorker: getMaxReplicasPerWorker(ctx),
    }),
    {
      purpose: 'planning',
      allow_tool_use: true,
      permission_profile_override: 'read-only',
      timeoutMs: ctx.limits.agentTimeoutMs,
      max_output_chars: STRUCTURED_ROOM_LLM_OUTPUT_CHARS,
    },
  );

  if (!planResult.ok || !planResult.text) {
    const detail = planResult.error?.message || planResult.error?.code || 'no response';
    ctx.setState(state);
    return { type: DECISION_TYPES.PAUSE, reason: `planning_failed: ${detail}` };
  }

  const planRaw = planResult.text || '';
  state.turnLog.push({
    cycle: 0,
    role: 'reviewer',
    agent: 'Orchestrator',
    content: planRaw.length > TURN_LOG_MAX_CONTENT_LENGTH
      ? planRaw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
      : planRaw,
  });

  const plan = parsePlanningResponse(planResult.text);
  if (!plan) {
    const preview = planResult.text.slice(0, 200).replace(/\n/g, ' ');
    ctx.setState(state);
    return { type: DECISION_TYPES.PAUSE, reason: `planning_parse_failed: ${preview}` };
  }

  const availableIds = availableWorkers.map((c) => c.agentId);
  const planValidation = validatePlan(plan.tasks, availableIds, {
    capacityRequests: plan.capacityRequests,
    workerCapabilities: state.workerCapabilities,
  });
  if (!planValidation.valid) {
    ctx.setState(state);
    return { type: DECISION_TYPES.PAUSE, reason: 'planning_validation_failed' };
  }

  state.taskBoard = plan.tasks.map((t, i) => ({
    ...t,
    id: t.id || `task_${i + 1}`,
    status: 'pending',
  }));
  state.pendingCapacityRequests = Array.isArray(plan.capacityRequests) ? plan.capacityRequests : [];
  state.nextTaskId = state.taskBoard.length + 1;

  state.phase = 'executing';

  const decision = buildDecision(ctx, state);
  emitBoardMetrics(ctx, state);
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);

  return wrapped;
}

export async function handleExecutionFanOutComplete(ctx, state, responses) {
  const respondedAgentIds = new Set(responses.map((r) => r.agentId));

  for (const r of responses) {
    const task = state.taskBoard.find(
      (t) => t.assignedTo === r.agentId && t.status === 'in_progress',
    );

    if (!task) continue; // stale response guard

    const parsed = parseTaskResponse(r.response);

    const participant = ctx.participants.find((p) => p.agentId === r.agentId);
    const raw = r.response || '';
    state.turnLog.push({
      cycle: state.currentCycle,
      role: 'worker',
      agent: participant?.displayName || r.agentId,
      content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
        ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
        : raw,
    });

    if (r.integration?.status === 'integration_failed') {
      task.status = 'integration_failed';
      task.integrationNotes = r.integration?.error?.message || null;
      task.integration = r.integration;
      continue;
    }

    applyParsedTaskResult(task, parsed, r.integration, state.currentCycle);
  }

  // Revert in_progress tasks whose workers didn't respond so the next cycle
  // can retry them instead of deadlocking.
  for (const task of state.taskBoard) {
    if (task.status === 'in_progress' && !respondedAgentIds.has(task.assignedTo)) {
      const cap = state.workerCapabilities[task.assignedTo];
      if (cap?.temporary) {
        task.status = 'pending';
        task.assignedTo = null;
        task.unassignedReason = 'replica_failed';
        task.unassignedDetails = `Temporary replica ${cap.displayName || task.assignedTo} did not complete the task`;
      } else {
        task.status = 'pending';
      }
    }
  }

  await invokeResultReview(ctx, state);

  const decision = buildDecision(ctx, state);
  emitBoardMetrics(ctx, state);
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);

  return wrapped;
}

export async function handleSingleTaskResult(ctx, state, turnResult) {
  const task = state.taskBoard.find(
    (t) => t.assignedTo === turnResult.agentId && t.status === 'in_progress',
  );

  if (!task) {
    ctx.setState(state);
    return null;
  }

  const parsed = parseTaskResponse(turnResult.response);

  const participant = ctx.participants.find((p) => p.agentId === turnResult.agentId);
  const raw = turnResult.response || '';
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'worker',
    agent: participant?.displayName || turnResult.agentId,
    content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
      ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
      : raw,
  });

  if (turnResult.integration?.status === 'integration_failed') {
    task.status = 'integration_failed';
    task.integrationNotes = turnResult.integration?.error?.message || null;
    task.integration = turnResult.integration;
  } else {
    applyParsedTaskResult(task, parsed, turnResult.integration, state.currentCycle);
  }

  await invokeResultReview(ctx, state);

  const decision = buildDecision(ctx, state);
  emitBoardMetrics(ctx, state);
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);

  return wrapped;
}
