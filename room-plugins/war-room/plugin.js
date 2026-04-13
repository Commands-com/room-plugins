/**
 * War Room Orchestrator Plugin — multi-agent task coordination.
 *
 * Decision logic for war room orchestration:
 *   LLM "general" discovers worker capabilities, decomposes objective into tasks,
 *   dispatches in parallel/sequentially, manages cross-worker integration.
 *
 * This is pure decision logic — no Electron deps, no I/O, no timeouts.
 * The room runtime owns all enforcement (limits, retries, fan-out, quorum).
 */

import {
  DECISION_TYPES,
  AGENT_ROLES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';
import { validateWarRoomStateEdit } from './war-room-state.js';
import {
  buildDiscoveryPrompt,
  buildPlanningPrompt,
  buildTaskContext,
  buildTaskAssignmentPrompt,
  buildResultProcessingPrompt,
  buildCompletionPrompt,
  parseDiscoveryResponse,
  parsePlanningResponse,
  parseTaskResponse,
  parseResultProcessingResponse,
  applyResultProcessing,
  parseReplicaPlaceholder,
} from './war-room-prompts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'war_room';

/** Max characters stored per turnLog entry content to prevent unbounded growth. */
const TURN_LOG_MAX_CONTENT_LENGTH = 20_000;
const STRUCTURED_ROOM_LLM_OUTPUT_CHARS = 120_000;
const HANDOFF_LIST_LIMIT = 4;
const HANDOFF_TEXT_LIMIT = 220;

const MANIFEST = Object.freeze({
  id: PLUGIN_ID,
  name: 'Implementation Room',
  version: '1.0.0',
  orchestratorType: 'war_room',
  description: 'Parallel task execution with optional quorum decisions',
  supportsQuorum: true,
  dashboard: Object.freeze({
    panels: Object.freeze([
      Object.freeze({
        type: 'phase',
        key: 'currentPhase',
        label: 'Phase',
        phases: Object.freeze(['discovery', 'planning', 'executing', 'complete']),
      }),
      Object.freeze({
        type: 'counter-group',
        key: 'taskSummary',
        label: 'Tasks',
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
        type: 'agent-status',
        key: 'workerStatus',
        label: 'Workers',
        states: Object.freeze(['discovering', 'idle', 'working', 'done', 'unavailable']),
      }),
      Object.freeze({
        type: 'table',
        key: 'taskBoard',
        label: 'Task Board',
        columns: Object.freeze([
          Object.freeze({ key: 'taskNum', label: '#', width: 30 }),
          Object.freeze({ key: 'title', label: 'Task' }),
          Object.freeze({ key: 'assignedTo', label: 'Worker' }),
          Object.freeze({ key: 'status', label: 'Status', width: 90 }),
          Object.freeze({ key: 'dependencies', label: 'Depends On', width: 100 }),
          Object.freeze({ key: 'completedInCycle', label: 'Cycle', width: 50 }),
        ]),
        sortable: true,
        filterable: Object.freeze(['status', 'assignedTo']),
      }),
    ]),
  }),
  limits: Object.freeze({
    maxCycles: Object.freeze({ default: 10 }),
    maxTurns: Object.freeze({ default: 80, min: 3, max: 1000 }),
    maxDurationMs: Object.freeze({ default: 10_800_000, max: 43_200_000 }),
    maxFailures: Object.freeze({ default: 5 }),
    agentTimeoutMs: Object.freeze({ default: 1_800_000, max: 10_800_000 }),
    pluginHookTimeoutMs: Object.freeze({ default: 300_000, max: 600_000 }),
    llmTimeoutMs: Object.freeze({ default: 300_000, max: 600_000 }),
    turnFloorRole: 'worker',
    turnFloorFormula: '2 + N',
  }),
  roles: Object.freeze({
    required: Object.freeze(['worker']),
    optional: Object.freeze([]),
    forbidden: Object.freeze(['implementer', 'reviewer']),
    minCount: Object.freeze({ worker: 1 }),
  }),
  endpointConstraints: Object.freeze({
    requiresLocalParticipant: true,
    perRole: Object.freeze({}),
  }),
  handoff: Object.freeze({
    inputs: Object.freeze([
      Object.freeze({ contract: 'spec_bundle.v1', required: false, multiple: false }),
      Object.freeze({ contract: 'review_findings.v1', required: false, multiple: false }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ contract: 'implementation_bundle.v1', default: true }),
    ]),
    defaultApprovalMode: 'auto',
  }),
  roomConfigSchema: Object.freeze({
    elasticWorkers: Object.freeze({
      type: 'boolean',
      label: 'Use Elastic Workers',
      default: false,
      description: 'Allow the runtime to add temporary replicas of existing local workers when the planner requests extra capacity.',
    }),
    maxDynamicWorkers: Object.freeze({
      type: 'integer',
      label: 'Max Dynamic Workers',
      default: 0,
      min: 0,
      max: 8,
      description: 'Maximum number of temporary worker replicas the runtime may add during this room run.',
    }),
    maxReplicasPerWorker: Object.freeze({
      type: 'integer',
      label: 'Max Replicas Per Worker',
      default: 1,
      min: 1,
      max: 4,
      description: 'Maximum number of temporary replicas allowed for any one source worker.',
    }),
    maxParallelWrites: Object.freeze({
      type: 'integer',
      label: 'Max Parallel Writes',
      default: 1,
      min: 1,
      max: 8,
      description: 'Maximum number of write tasks that may run in the same dispatch window. Read-only tasks can still run in parallel.',
    }),
    isolatedWriteWorktrees: Object.freeze({
      type: 'boolean',
      label: 'Use Isolated Write Worktrees',
      default: true,
      description: 'Run write tasks in branch-backed git worktrees and merge them back through a runtime-owned squash merge.',
    }),
  }),
  display: Object.freeze({
    typeLabel: 'Implementation Room',
    typeTag: 'WR',
    cycleNoun: 'Execution',
    reportTitle: 'Implementation Room Report',
    activityMessages: Object.freeze({
      idle: 'Waiting...',
      discovery: 'Workers exploring the codebase',
      fanOut: 'Workers executing tasks',
      singleTurn: 'Worker executing task',
      synthesis: 'Processing results',
      planning: 'Planning tasks',
    }),
    defaultRoster: Object.freeze([
      Object.freeze({ role: 'worker', displayName: 'Worker 1' }),
      Object.freeze({ role: 'worker', displayName: 'Worker 2' }),
    ]),
    defaultAddRole: 'worker',
  }),
  report: Object.freeze({
    summaryMetrics: Object.freeze(['taskBoard']),
    table: Object.freeze({
      metricKey: 'taskBoard',
      columns: Object.freeze([
        Object.freeze({ key: 'title', label: 'Task' }),
        Object.freeze({ key: 'assignedTo', label: 'Worker', width: 120 }),
        Object.freeze({ key: 'status', label: 'Status', width: 80 }),
        Object.freeze({ key: 'dependencies', label: 'Deps', width: 100 }),
        Object.freeze({ key: 'completedInCycle', label: 'Cycle', width: 60 }),
      ]),
    }),
  }),
});

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

function buildInboundPromptContext(handoffContext) {
  const sections = [
    buildSpecBundlePromptContext(handoffContext),
    buildReviewFindingsPromptContext(handoffContext),
  ].filter(Boolean);

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

function mergePromptContexts(...sections) {
  return sections
    .map((section) => (typeof section === 'string' ? section.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Orchestrator review between rounds
// ---------------------------------------------------------------------------

/**
 * Invoke the orchestrator LLM to review just-completed tasks and update the
 * task board (descriptions, new tasks, removals) before the next dispatch.
 * Skipped when there are no completions or no remaining work.
 */
async function invokeResultReview(ctx, state) {
  const justCompleted = state.taskBoard.filter(
    (t) => t.completedInCycle === state.currentCycle && t.status === 'done',
  );
  const hasRemainingWork = state.taskBoard.some(
    (t) => t.status === 'pending' || t.status === 'blocked',
  );

  if (justCompleted.length === 0 || !hasRemainingWork) return;

  const availableWorkerIds = Object.entries(state.workerCapabilities)
    .filter(([, cap]) => cap.available !== false)
    .map(([id]) => id);

  const reviewResult = await ctx.invokeLLM(
    buildResultProcessingPrompt(justCompleted, state.taskBoard, ctx.objective, {
      elasticWorkers: useElasticWorkers(ctx),
    }),
    {
      purpose: 'synthesis',
      allow_tool_use: true,
      permission_profile_override: 'read-only',
      max_output_chars: STRUCTURED_ROOM_LLM_OUTPUT_CHARS,
    },
  );

  if (!reviewResult.ok || !reviewResult.text) return;

  const review = parseResultProcessingResponse(reviewResult.text);
  if (!review) return;

  applyResultProcessing(state, review, availableWorkerIds, {
    assignmentValidator: (assignedTo) => isAssignableWorkerId(assignedTo, availableWorkerIds, {
      capacityBudget: buildCapacityBudget(review.capacityRequests),
      workerCapabilities: state.workerCapabilities,
    }),
  });
  state.pendingCapacityRequests = Array.isArray(review.capacityRequests) ? review.capacityRequests : [];

  // Log the orchestrator's review to the activity log
  const raw = reviewResult.text || '';
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'reviewer',
    agent: 'Orchestrator',
    content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
      ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
      : raw,
  });
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

function buildWorkerCapability(participant, available = true) {
  return {
    agentId: participant.agentId,
    displayName: participant.displayName,
    available,
    temporary: participant.temporary === true,
    replicaOfAgentId: participant.replicaOfAgentId || null,
    endpointType: participant.endpoint?.type || null,
    profileId: participant.endpoint?.profileId || null,
  };
}

function useElasticWorkers(ctx) {
  return ctx?.roomConfig?.elasticWorkers === true;
}

function getMaxDynamicWorkers(ctx) {
  const configured = Number(ctx?.roomConfig?.maxDynamicWorkers);
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return 0;
}

function getMaxReplicasPerWorker(ctx) {
  const configured = Number(ctx?.roomConfig?.maxReplicasPerWorker);
  if (Number.isInteger(configured) && configured >= 1) return configured;
  return 1;
}

function buildCapacityBudget(capacityRequests) {
  const budget = new Map();
  for (const request of Array.isArray(capacityRequests) ? capacityRequests : []) {
    const sourceAgentId = typeof request?.sourceAgentId === 'string' ? request.sourceAgentId.trim() : '';
    const count = Number(request?.count);
    if (!sourceAgentId || !Number.isInteger(count) || count < 1) continue;
    budget.set(sourceAgentId, (budget.get(sourceAgentId) || 0) + count);
  }
  return budget;
}

function isAssignableWorkerId(assignedTo, availableWorkerIds, options = {}) {
  if (typeof assignedTo !== 'string' || assignedTo.trim().length === 0) return false;
  if (availableWorkerIds.includes(assignedTo)) return true;
  const placeholder = parseReplicaPlaceholder(assignedTo);
  if (!placeholder) return false;
  const sourceCap = options?.workerCapabilities?.[placeholder.sourceAgentId];
  if (!sourceCap || sourceCap.available === false) return false;
  if (sourceCap.temporary === true || sourceCap.replicaOfAgentId) return false;
  const budget = options?.capacityBudget instanceof Map ? options.capacityBudget : new Map();
  return placeholder.index <= (budget.get(placeholder.sourceAgentId) || 0);
}

function validatePlan(tasks, availableWorkerIds, options = {}) {
  const errors = [];
  const taskIds = new Set();
  const capacityBudget = buildCapacityBudget(options.capacityRequests);

  // Check for duplicate task IDs
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      errors.push(`Duplicate task ID: "${task.id}"`);
    }
    taskIds.add(task.id);
  }

  for (const task of tasks) {
    if (task.assignedTo === null) {
      errors.push(`Task "${task.id}" must have an assigned worker`);
    } else if (typeof task.assignedTo !== 'string' || task.assignedTo.trim().length === 0) {
      errors.push(`Task "${task.id}" must have an assigned worker`);
    } else if (!isAssignableWorkerId(task.assignedTo, availableWorkerIds, {
      capacityBudget,
      workerCapabilities: options.workerCapabilities || {},
    })) {
      errors.push(`Task "${task.id}" assigned to unknown worker "${task.assignedTo}"`);
    }
    if (typeof task.requiresWrite !== 'boolean') {
      errors.push(`Task "${task.id}" must declare requiresWrite as true or false`);
    }
    for (const dep of task.dependencies) {
      if (!taskIds.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Check for circular dependencies
  const depMap = new Map(tasks.map((t) => [t.id, t.dependencies]));
  if (hasCyclicDeps(depMap)) {
    errors.push('Task plan contains circular dependencies');
  }

  // At least one root task (no dependencies)
  const rootTasks = tasks.filter((t) => t.dependencies.length === 0);
  if (rootTasks.length === 0 && tasks.length > 0) {
    errors.push('Task plan has no root tasks (every task has dependencies)');
  }

  return { valid: errors.length === 0, errors };
}

function hasCyclicDeps(depMap) {
  const visited = new Set();
  const inStack = new Set();

  function dfs(id) {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    for (const dep of (depMap.get(id) || [])) {
      if (dfs(dep)) return true;
    }
    inStack.delete(id);
    return false;
  }

  for (const id of depMap.keys()) {
    if (dfs(id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

function deduplicateByWorker(tasks) {
  const seen = new Set();
  const result = [];
  for (const task of tasks) {
    if (!seen.has(task.assignedTo)) {
      seen.add(task.assignedTo);
      result.push(task);
    }
  }
  return result;
}

function isWriteTask(task) {
  return task?.requiresWrite !== false;
}

function getWorkerCapabilityForAssignment(state, assignedTo) {
  if (typeof assignedTo !== 'string' || assignedTo.trim().length === 0) return null;
  const direct = state.workerCapabilities[assignedTo];
  if (direct) return direct;
  const placeholder = parseReplicaPlaceholder(assignedTo);
  if (!placeholder) return null;
  return state.workerCapabilities[placeholder.sourceAgentId] || null;
}

function getMaxParallelWrites(ctx) {
  const configured = Number(ctx?.roomConfig?.maxParallelWrites);
  if (Number.isInteger(configured) && configured >= 1) return configured;
  return 1;
}

function useIsolatedWriteWorktrees(ctx) {
  return ctx?.roomConfig?.isolatedWriteWorktrees !== false;
}

function selectDispatchableTasks(ctx, tasks) {
  const uniqueTasks = deduplicateByWorker(tasks);
  const maxParallelWrites = getMaxParallelWrites(ctx);
  const dispatchable = [];
  let writeCount = 0;

  for (const task of uniqueTasks) {
    if (isWriteTask(task)) {
      if (writeCount >= maxParallelWrites) continue;
      writeCount += 1;
    }
    dispatchable.push(task);
  }

  return dispatchable;
}

function buildImmediateCapacityRequests(dispatchable, pendingCapacityRequests = []) {
  const directSourceAssignments = new Set();
  const highestPlaceholderIndexBySource = new Map();

  for (const task of Array.isArray(dispatchable) ? dispatchable : []) {
    const assignedTo = typeof task?.assignedTo === 'string' ? task.assignedTo.trim() : '';
    if (!assignedTo) continue;
    const placeholder = parseReplicaPlaceholder(assignedTo);
    if (placeholder) {
      highestPlaceholderIndexBySource.set(
        placeholder.sourceAgentId,
        Math.max(highestPlaceholderIndexBySource.get(placeholder.sourceAgentId) || 0, placeholder.index),
      );
      continue;
    }
    directSourceAssignments.add(assignedTo);
  }

  const filtered = [];
  for (const request of Array.isArray(pendingCapacityRequests) ? pendingCapacityRequests : []) {
    const sourceAgentId = typeof request?.sourceAgentId === 'string' ? request.sourceAgentId.trim() : '';
    if (!sourceAgentId) continue;
    const highestPlaceholderIndex = highestPlaceholderIndexBySource.get(sourceAgentId) || 0;
    if (highestPlaceholderIndex <= 0) continue;
    const baselineCapacity = directSourceAssignments.has(sourceAgentId) ? 0 : 1;
    const immediateReplicaNeed = Math.max(0, highestPlaceholderIndex - baselineCapacity);
    if (immediateReplicaNeed <= 0) continue;
    filtered.push({
      ...request,
      count: Math.min(
        immediateReplicaNeed,
        Number.isInteger(request?.count) && request.count >= 1 ? request.count : immediateReplicaNeed,
      ),
    });
  }

  return filtered;
}

function buildDispatchMetadata(ctx, state, dispatchable) {
  const metadata = {
    taskIds: dispatchable.map((task) => task.id),
    writeTaskIds: dispatchable.filter((task) => isWriteTask(task)).map((task) => task.id),
    maxParallelWrites: getMaxParallelWrites(ctx),
    isolatedWriteWorktrees: useIsolatedWriteWorktrees(ctx),
  };
  if (useElasticWorkers(ctx)) {
    metadata.elasticWorkers = {
      enabled: true,
      capacityRequests: buildImmediateCapacityRequests(dispatchable, state.pendingCapacityRequests),
    };
  }
  return metadata;
}

function getReadyTasks(taskBoard) {
  return taskBoard.filter((t) =>
    t.status === 'pending' &&
    typeof t.assignedTo === 'string' &&
    t.assignedTo.trim().length > 0 &&
    t.dependencies.every((dep) => {
      const depTask = taskBoard.find((d) => d.id === dep);
      return depTask && depTask.status === 'done';
    }),
  );
}

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

function buildDecision(ctx, state) {
  const readyTasks = getReadyTasks(state.taskBoard);
  const readyButUnassigned = state.taskBoard.filter((t) =>
    t.status === 'pending' &&
    (!t.assignedTo || typeof t.assignedTo !== 'string' || t.assignedTo.trim().length === 0) &&
    t.dependencies.every((dep) => {
      const depTask = state.taskBoard.find((d) => d.id === dep);
      return depTask && depTask.status === 'done';
    }),
  );

  if (readyTasks.length === 0) {
    const allDone = state.taskBoard.every((t) => t.status === 'done');
    if (allDone) {
      return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE };
    }

    const inProgressTasks = state.taskBoard.filter((t) => t.status === 'in_progress');
    const blockedTasks = state.taskBoard.filter((t) => t.status === 'blocked');
    const integrationFailedTasks = state.taskBoard.filter((t) => t.status === 'integration_failed');
    const isDeadlocked = inProgressTasks.length === 0 && blockedTasks.length > 0;

    if (readyButUnassigned.length > 0 || integrationFailedTasks.length > 0) {
      return { type: DECISION_TYPES.PAUSE, reason: 'tasks_unassigned' };
    }

    if (isDeadlocked) {
      if (state.blockedPauseIssued) {
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES };
      }
      state.blockedPauseIssued = true;
      return { type: DECISION_TYPES.PAUSE, reason: 'tasks_blocked' };
    }

    if (inProgressTasks.length > 0) {
      return null; // wait for responses
    }

    return { type: DECISION_TYPES.PAUSE, reason: 'waiting_for_dependencies' };
  }

  // Filter out tasks assigned to unavailable workers
  const availableReady = readyTasks.filter((t) => {
    const cap = getWorkerCapabilityForAssignment(state, t.assignedTo);
    return cap && cap.available !== false;
  });

  if (availableReady.length === 0) {
    // All ready tasks assigned to unavailable workers
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
  }

  const dispatchable = selectDispatchableTasks(ctx, availableReady);

  // Increment cycle counter before dispatching
  state.currentCycle += 1;
  ctx.setCycle(state.currentCycle);

  // Check cycle limit (plugin-enforced)
  if (state.currentCycle > ctx.limits.maxCycles) {
    return {
      type: DECISION_TYPES.STOP,
      reason: STOP_REASON.CYCLE_LIMIT,
    };
  }

  // Mark dispatched tasks as in_progress
  for (const task of dispatchable) {
    task.status = 'in_progress';
    task.assignedInCycle = state.currentCycle;
  }

  if (dispatchable.length === 1) {
    return {
      type: DECISION_TYPES.SPEAK,
      agentId: dispatchable[0].assignedTo,
      message: buildTaskAssignmentPrompt(
        dispatchable[0],
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: dispatchable[0].id,
      taskTitle: dispatchable[0].title,
      dependencies: Array.isArray(dispatchable[0].dependencies) ? [...dispatchable[0].dependencies] : [],
      requiresWrite: dispatchable[0].requiresWrite,
      metadata: buildDispatchMetadata(ctx, state, dispatchable),
    };
  }

  return {
    type: DECISION_TYPES.FAN_OUT,
    targets: dispatchable.map((t) => ({
      agentId: t.assignedTo,
      message: buildTaskAssignmentPrompt(
        t,
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: t.id,
      taskTitle: t.title,
      dependencies: Array.isArray(t.dependencies) ? [...t.dependencies] : [],
      requiresWrite: t.requiresWrite,
    })),
    metadata: buildDispatchMetadata(ctx, state, dispatchable),
  };
}

function wrapForSemiAuto(ctx, state, decision) {
  if (!decision) return decision;
  if (ctx.mode !== 'semi_auto') return decision;
  if (decision.type === DECISION_TYPES.STOP || decision.type === DECISION_TYPES.PAUSE) return decision;

  // For FAN_OUT in semi_auto, store and pause so user can review
  if (decision.type === DECISION_TYPES.FAN_OUT) {
    state.pendingFanOut = decision;
    return { type: DECISION_TYPES.PAUSE, reason: 'semi_auto_review' };
  }

  // SPEAK is handled by runtime's built-in semi_auto gate
  return decision;
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

function emitBoardMetrics(ctx, state) {
  const board = state.taskBoard;
  const pending = board.filter((t) => t.status === 'pending').length;
  const inProgress = board.filter((t) => t.status === 'in_progress').length;
  const done = board.filter((t) => t.status === 'done').length;
  const blocked = board.filter((t) => t.status === 'blocked').length;

  const workerStatusMap = {};
  for (const [agentId, cap] of Object.entries(state.workerCapabilities)) {
    const participant = ctx.participants.find((p) => p.agentId === agentId);
    const displayName = participant?.displayName || agentId;
    if (!cap.available) {
      workerStatusMap[displayName] = 'unavailable';
    } else {
      const workerTasks = board.filter((t) => t.assignedTo === agentId);
      const hasInProgress = workerTasks.some((t) => t.status === 'in_progress');
      const allDone = workerTasks.length > 0 && workerTasks.every((t) => t.status === 'done');
      if (hasInProgress) workerStatusMap[displayName] = 'working';
      else if (allDone) workerStatusMap[displayName] = 'done';
      else workerStatusMap[displayName] = 'idle';
    }
  }

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    taskSummary: { pending, inProgress, done, blocked },
    taskProgress: { value: done, max: board.length },
    workerStatus: workerStatusMap,
    taskBoard: {
      rows: board.map((t, idx) => {
        const participant = ctx.participants.find((p) => p.agentId === t.assignedTo);
        // Extract numeric part from task IDs for display (task_1 → 1)
        const taskNum = String(idx + 1);
        const depNums = t.dependencies.map((depId) => {
        const depIdx = board.findIndex((bt) => bt.id === depId);
        return depIdx >= 0 ? String(depIdx + 1) : depId.replace('task_', '#');
      });
      const assignedLabel = t.assignedTo
        ? (participant?.displayName || t.assignedTo)
        : 'Unassigned';
      return {
        id: t.id,
        taskNum,
        title: t.title,
        agentId: t.assignedTo,
        assignedTo: assignedLabel,
        status: t.status,
        dependencies: depNums.join(', '),
        completedInCycle: t.completedInCycle != null ? `C${t.completedInCycle}` : null,
        };
      }),
    },
    turnLog: { entries: state.turnLog },
  });
}

// ---------------------------------------------------------------------------
// Edit application (mutation — separate from pure validation in contracts)
// ---------------------------------------------------------------------------

function applyTaskBoardEdits(state, edits) {
  // Apply taskRemovals first
  if (edits.taskRemovals?.length) {
    const removeSet = new Set(edits.taskRemovals);
    state.taskBoard = state.taskBoard.filter((t) => !removeSet.has(t.id));
    // Cascade: remove from dependency lists
    for (const task of state.taskBoard) {
      task.dependencies = task.dependencies.filter((d) => !removeSet.has(d));
    }
  }

  // Apply taskEdits
  if (edits.taskEdits?.length) {
    for (const edit of edits.taskEdits) {
      const task = state.taskBoard.find((t) => t.id === edit.id);
      if (!task) continue;
      if (edit.assignedTo !== undefined) {
        // If task was in_progress and reassigned, revert to pending
        if (task.status === 'in_progress') task.status = 'pending';
        task.assignedTo = edit.assignedTo;
      }
      if (edit.status !== undefined) task.status = edit.status;
      if (edit.dependencies !== undefined) task.dependencies = edit.dependencies;
      if (edit.requiresIntegration !== undefined) task.requiresIntegration = Boolean(edit.requiresIntegration);
      if (edit.requiresWrite !== undefined) task.requiresWrite = Boolean(edit.requiresWrite);
      if (edit.title !== undefined) task.title = edit.title;
      if (edit.description !== undefined) task.description = edit.description;
    }
  }

  // Apply taskAdds
  if (edits.taskAdds?.length) {
    const clientIdMap = new Map();
    const newTaskIds = new Set();
    for (const add of edits.taskAdds) {
      const newId = `task_${state.nextTaskId++}`;
      newTaskIds.add(newId);
      if (add.clientId) clientIdMap.set(add.clientId, newId);

      state.taskBoard.push({
        id: newId,
        title: add.title,
        description: add.description,
        assignedTo: add.assignedTo,
        dependencies: Array.isArray(add.dependencies) ? [...add.dependencies] : [],
        requiresIntegration: Boolean(add.requiresIntegration),
        requiresWrite: Boolean(add.requiresWrite),
        status: 'pending',
      });
    }

    // Resolve clientId references in dependencies — only for newly added tasks.
    // Remapping globally would corrupt existing dependencies if a clientId
    // happened to match a pre-existing task ID. We remap for ALL newly added
    // tasks (not just those with their own clientId) because a new task without
    // a clientId may still reference another new task's clientId in its deps.
    if (clientIdMap.size > 0) {
      for (const task of state.taskBoard) {
        if (!newTaskIds.has(task.id)) continue;
        task.dependencies = task.dependencies.map((dep) => clientIdMap.get(dep) || dep);
      }
    }
  }

  // Final dependency integrity check: ensure all dependency IDs resolve to real
  // tasks and no self-dependencies exist. Remove invalid references to prevent
  // deadlocks. Runs after ALL edit operations (removals, edits, adds) so that
  // dangling references from any source are cleaned up.
  const allTaskIds = new Set(state.taskBoard.map((t) => t.id));
  for (const task of state.taskBoard) {
    task.dependencies = task.dependencies.filter(
      (dep) => dep !== task.id && allTaskIds.has(dep),
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function createWarRoomPlugin(opts = {}) {
  const domainContext = opts.domainContext || '';

  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    /**
     * Initialize plugin state.
     */
    init(ctx) {
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);

      ctx.setState({
        phase: 'discovery',
        handoffPromptContext: buildInboundPromptContext(ctx.handoffContext),
        workerCapabilities: Object.fromEntries(
          workers.map((w) => [w.agentId, buildWorkerCapability(w)]),
        ),
        taskBoard: [],
        currentCycle: 0,
        blockedPauseIssued: false,
        pendingFanOut: null,
        pendingCapacityRequests: [],
        turnLog: [],
        nextTaskId: 1,
      });
    },

    /**
     * Room starts — send discovery prompt to all workers.
     */
    onRoomStart(ctx) {
      const state = ctx.getState();
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      const effectiveDomainContext = mergePromptContexts(domainContext, state?.handoffPromptContext || '');

      ctx.emitMetrics({
        currentPhase: { active: 'discovery' },
        workerStatus: Object.fromEntries(
          workers.map((w) => [w.displayName, 'discovering']),
        ),
      });

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: workers.map((w) => ({
          agentId: w.agentId,
          message: buildDiscoveryPrompt(ctx.objective, effectiveDomainContext),
        })),
      };
    },

    /**
     * Fan-out responses received — phase-branched.
     */
    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();

      if (state.phase === 'discovery') {
        return await handleDiscoveryComplete(ctx, state, responses, domainContext);
      }
      if (state.phase === 'executing') {
        return await handleExecutionFanOutComplete(ctx, state, responses);
      }
      return null;
    },

    /**
     * Single-task result — executing phase only.
     */
    async onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      if (state.phase !== 'executing') return null;

      return await handleSingleTaskResult(ctx, state, turnResult);
    },

    /**
     * Resume hook — pop stored pendingFanOut for semi_auto mode.
     */
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

    /**
     * Handle room events.
     */
    onEvent(ctx, event) {
      const state = ctx.getState();

      if (event.type === 'participant_disconnected' && event.agentId) {
        const cap = state.workerCapabilities[event.agentId];
        if (cap) {
          cap.available = false;
          // Reassign pending tasks from this worker
          for (const task of state.taskBoard) {
            if (task.assignedTo === event.agentId && task.status === 'pending') {
              if (cap.temporary) {
                task.assignedTo = null;
                task.unassignedReason = 'replica_failed';
                task.unassignedDetails = `Temporary replica ${event.agentId} disconnected`;
              } else {
                task.status = 'blocked';
                task.blockedReason = `Worker ${event.agentId} disconnected`;
              }
            }
          }
          ctx.setState(state);
        }
      }

      if (event.type === 'elastic_workers_materialized') {
        const grantedReplicaIds = Array.isArray(event.grantedReplicaIds) ? event.grantedReplicaIds : [];
        const placeholderMap = event.placeholderMap && typeof event.placeholderMap === 'object'
          ? event.placeholderMap
          : {};
        const deniedPlaceholders = event.deniedPlaceholders && typeof event.deniedPlaceholders === 'object'
          ? event.deniedPlaceholders
          : {};

        for (const replicaId of grantedReplicaIds) {
          const participant = ctx.participants.find((p) => p.agentId === replicaId);
          if (!participant) continue;
          state.workerCapabilities[replicaId] = buildWorkerCapability(participant);
        }

        for (const task of state.taskBoard) {
          const assignedTo = typeof task.assignedTo === 'string' ? task.assignedTo.trim() : '';
          if (!assignedTo) continue;
          if (placeholderMap[assignedTo]) {
            task.assignedTo = placeholderMap[assignedTo];
            task.unassignedReason = null;
            task.unassignedDetails = null;
            continue;
          }
          if (deniedPlaceholders[assignedTo]) {
            task.assignedTo = null;
            if (task.status === 'in_progress') task.status = 'pending';
            task.unassignedReason = deniedPlaceholders[assignedTo].reason || 'replica_not_granted';
            task.unassignedDetails = deniedPlaceholders[assignedTo].details || null;
          }
        }

        state.pendingCapacityRequests = [];
        ctx.setState(state);
        emitBoardMetrics(ctx, state);
      }

      if (event.type === 'user_edit_state' && event.edits) {
        const availableWorkerIds = Object.entries(state.workerCapabilities)
          .filter(([, cap]) => cap.available !== false)
          .map(([id]) => id);

        const validation = validateWarRoomStateEdit(event.edits, state.taskBoard, availableWorkerIds);
        if (!validation.valid) {
          throw new Error(`Invalid state edit: ${validation.errors.join('; ')}`);
        }

        applyTaskBoardEdits(state, event.edits);

        // Reset blockedPauseIssued on board edits — user may have unblocked tasks
        state.blockedPauseIssued = false;

        // Refresh plugin-owned pending FAN_OUT if it exists (semi_auto).
        // Tasks in the pending dispatch were already marked in_progress by
        // buildDecision, but haven't actually been sent yet.  Revert them to
        // pending first so regenerateDispatch (which uses getReadyTasks on
        // pending tasks) can rebuild the dispatch correctly.
        if (state.pendingFanOut) {
          const queuedAgentIds = new Set(
            state.pendingFanOut.targets
              ? state.pendingFanOut.targets.map((t) => t.agentId)
              : state.pendingFanOut.agentId ? [state.pendingFanOut.agentId] : [],
          );
          for (const task of state.taskBoard) {
            if (task.status === 'in_progress' && queuedAgentIds.has(task.assignedTo)) {
              task.status = 'pending';
            }
          }
          state.pendingFanOut = regenerateDispatch(ctx, state);
        }

        ctx.setState(state);
        emitBoardMetrics(ctx, state);
      }
    },

    /**
     * Regenerate a pending decision using the updated task board.
     */
    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (state.phase !== 'executing') return pendingDecision;

      // Regenerate dispatch from current board
      const fresh = regenerateDispatch(ctx, state);
      return fresh || pendingDecision;
    },

    /**
     * Shutdown — set phase to complete, emit final metrics.
     */
    shutdown(ctx) {
      const state = ctx.getState();
      state.phase = 'complete';
      emitBoardMetrics(ctx, state);
      ctx.setState(state);
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) {
        return {
          handoffPayloads: [],
          artifacts: [],
        };
      }

      const { payload, artifacts } = buildImplementationBundleReport(ctx, state);
      return {
        handoffPayloads: [payload],
        artifacts,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Phase handlers (private to factory)
// ---------------------------------------------------------------------------

async function handleDiscoveryComplete(ctx, state, responses, domainContext = '') {
  // Parse discovery responses and store full reports
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
      // Always store the full raw response — it has context even if JSON parsing failed
      cap.fullReport = (r.response || '').slice(0, TURN_LOG_MAX_CONTENT_LENGTH);
    }

    // Log response
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

  // Mark workers that didn't respond as unavailable
  const respondedIds = new Set(responses.map((r) => r.agentId));
  for (const [agentId, cap] of Object.entries(state.workerCapabilities)) {
    if (!respondedIds.has(agentId)) cap.available = false;
  }

  // Check if any workers are available
  const availableWorkers = Object.values(state.workerCapabilities)
    .filter((c) => c.available !== false);
  if (availableWorkers.length === 0) {
    ctx.setState(state);
    return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
  }

  // Phase 2: Planning — invoke LLM with full worker reports
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

  // Log the orchestrator's planning response to the activity log
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

  // Validate plan
  const availableIds = availableWorkers.map((c) => c.agentId);
  const planValidation = validatePlan(plan.tasks, availableIds, {
    capacityRequests: plan.capacityRequests,
    workerCapabilities: state.workerCapabilities,
  });
  if (!planValidation.valid) {
    ctx.setState(state);
    return { type: DECISION_TYPES.PAUSE, reason: 'planning_validation_failed' };
  }

  // Store task board with proper IDs
  state.taskBoard = plan.tasks.map((t, i) => ({
    ...t,
    id: t.id || `task_${i + 1}`,
    status: 'pending',
  }));
  state.pendingCapacityRequests = Array.isArray(plan.capacityRequests) ? plan.capacityRequests : [];
  state.nextTaskId = state.taskBoard.length + 1;

  // Transition to executing
  state.phase = 'executing';

  // Decide first action (marks dispatched tasks in_progress)
  const decision = buildDecision(ctx, state);
  emitBoardMetrics(ctx, state);
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);

  return wrapped;
}

async function handleExecutionFanOutComplete(ctx, state, responses) {
  const respondedAgentIds = new Set(responses.map((r) => r.agentId));

  // Process parallel task results
  for (const r of responses) {
    // Find the task assigned to this worker that's in_progress
    const task = state.taskBoard.find(
      (t) => t.assignedTo === r.agentId && t.status === 'in_progress',
    );

    // Stale response guard
    if (!task) continue;

    const parsed = parseTaskResponse(r.response);

    // Log response
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

    // Update task
    if (r.integration?.status === 'integration_failed') {
      task.status = 'integration_failed';
      task.integrationNotes = r.integration?.error?.message || null;
      task.integration = r.integration;
      continue;
    }

    if (parsed.status === 'blocked') {
      task.status = 'blocked';
      task.blockedReason = parsed.blockedReason;
    } else {
      task.status = 'done';
      task.result = parsed.summary;
      task.filesChanged = parsed.filesChanged;
      task.integrationNotes = mergeIntegrationNotes(parsed.integrationNotes, r.integration);
      task.integration = r.integration || null;
      task.completedInCycle = state.currentCycle;
    }
  }

  // Revert in_progress tasks whose workers didn't respond (partial fan-out
  // failure) back to pending so they can be retried in the next cycle instead
  // of deadlocking the room.
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

  // --- Orchestrator LLM review between rounds ---
  // The orchestrator reviews completed work and can update pending task
  // descriptions, add new tasks, or remove obsolete ones.  This ensures
  // downstream workers receive accurate API contracts, file paths, etc.
  await invokeResultReview(ctx, state);

  // Decide next action (marks dispatched tasks in_progress)
  const decision = buildDecision(ctx, state);
  emitBoardMetrics(ctx, state);
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);

  return wrapped;
}

async function handleSingleTaskResult(ctx, state, turnResult) {
  // Find the task targeted by this turn
  const task = state.taskBoard.find(
    (t) => t.assignedTo === turnResult.agentId && t.status === 'in_progress',
  );

  // Stale response guard
  if (!task) {
    ctx.setState(state);
    return null;
  }

  const parsed = parseTaskResponse(turnResult.response);

  // Log response
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

  // Update task
  if (turnResult.integration?.status === 'integration_failed') {
    task.status = 'integration_failed';
    task.integrationNotes = turnResult.integration?.error?.message || null;
    task.integration = turnResult.integration;
  } else if (parsed.status === 'blocked') {
    task.status = 'blocked';
    task.blockedReason = parsed.blockedReason;
  } else {
    task.status = 'done';
    task.result = parsed.summary;
    task.filesChanged = parsed.filesChanged;
    task.integrationNotes = mergeIntegrationNotes(parsed.integrationNotes, turnResult.integration);
    task.integration = turnResult.integration || null;
    task.completedInCycle = state.currentCycle;
  }

  // --- Orchestrator LLM review between rounds ---
  await invokeResultReview(ctx, state);

  // Decide next action (marks dispatched tasks in_progress)
  const decision = buildDecision(ctx, state);
  emitBoardMetrics(ctx, state);
  const wrapped = wrapForSemiAuto(ctx, state, decision);
  ctx.setState(state);

  return wrapped;
}

// ---------------------------------------------------------------------------
// Dispatch regeneration (for edit refresh)
// ---------------------------------------------------------------------------

function regenerateDispatch(ctx, state) {
  const readyTasks = getReadyTasks(state.taskBoard);
  if (readyTasks.length === 0) return null;

  const availableReady = readyTasks.filter((t) => {
    const cap = getWorkerCapabilityForAssignment(state, t.assignedTo);
    return cap && cap.available !== false;
  });
  if (availableReady.length === 0) return null;

  const dispatchable = selectDispatchableTasks(ctx, availableReady);

  // Mark dispatched tasks as in_progress
  for (const task of dispatchable) {
    task.status = 'in_progress';
  }

  if (dispatchable.length === 1) {
    return {
      type: DECISION_TYPES.SPEAK,
      agentId: dispatchable[0].assignedTo,
      message: buildTaskAssignmentPrompt(
        dispatchable[0],
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: dispatchable[0].id,
      taskTitle: dispatchable[0].title,
      dependencies: Array.isArray(dispatchable[0].dependencies) ? [...dispatchable[0].dependencies] : [],
      requiresWrite: dispatchable[0].requiresWrite,
      metadata: buildDispatchMetadata(ctx, state, dispatchable),
    };
  }

  return {
    type: DECISION_TYPES.FAN_OUT,
    targets: dispatchable.map((t) => ({
      agentId: t.assignedTo,
      message: buildTaskAssignmentPrompt(
        t,
        state.taskBoard,
        state.handoffPromptContext || '',
        { workerCapabilities: state.workerCapabilities },
      ),
      taskId: t.id,
      taskTitle: t.title,
      dependencies: Array.isArray(t.dependencies) ? [...t.dependencies] : [],
      requiresWrite: t.requiresWrite,
    })),
    metadata: buildDispatchMetadata(ctx, state, dispatchable),
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

function buildImplementationBundleReport(ctx, state) {
  const tasks = Array.isArray(state?.taskBoard) ? state.taskBoard : [];
  const artifacts = collectFileArtifacts(tasks.flatMap((task) => (
    Array.isArray(task.filesChanged) ? task.filesChanged : []
  )));
  const baseReport = typeof ctx.getFinalReport === 'function' ? ctx.getFinalReport() : null;
  const completedTasks = tasks.filter((task) => task.status === 'done');
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const pendingTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'blocked');

  return {
    artifacts,
    payload: {
      contract: 'implementation_bundle.v1',
      data: {
        objective: ctx.objective || '',
        roomId: ctx.roomId || null,
        stopReason: baseReport?.stopReason || null,
        cyclesCompleted: state?.currentCycle ?? ctx.cycle ?? 0,
        workerAssignments: Object.values(state?.workerCapabilities || {}).map((worker) => ({
          agentId: worker.agentId,
          displayName: worker.displayName,
          available: worker.available !== false,
          responsibilities: worker.responsibilities || '',
        })),
        summary: {
          totalTasks: tasks.length,
          completedTasks: completedTasks.length,
          blockedTasks: blockedTasks.length,
          pendingTasks: pendingTasks.length,
          changedFileCount: artifacts.length,
        },
        changedFiles: artifacts.map((artifact) => artifact.path),
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          assignedTo: task.assignedTo,
          dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
          status: task.status,
          result: task.result || '',
          blockedReason: task.blockedReason || null,
          filesChanged: Array.isArray(task.filesChanged) ? task.filesChanged : [],
          integrationNotes: task.integrationNotes || null,
          completedInCycle: task.completedInCycle ?? null,
        })),
      },
    },
  };
}

// Re-export prompts/parsers so existing test imports keep working
export {
  buildDiscoveryPrompt,
  buildPlanningPrompt,
  buildTaskContext,
  buildTaskAssignmentPrompt,
  buildResultProcessingPrompt,
  buildCompletionPrompt,
  parseDiscoveryResponse,
  parsePlanningResponse,
  parseTaskResponse,
  parseResultProcessingResponse,
  applyResultProcessing,
} from './war-room-prompts.js';

// Export internals for testing
export {
  validatePlan,
  deduplicateByWorker,
  getReadyTasks,
  buildDecision,
  applyTaskBoardEdits,
  buildInboundPromptContext,
};
