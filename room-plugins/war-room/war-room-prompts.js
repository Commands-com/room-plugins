/**
 * War Room prompt builders and response parsers.
 *
 * Pure functions — no state, no I/O, no Electron deps.
 */

import { extractJSON } from './parse-helpers.js';

const REPLICA_PLACEHOLDER_RE = /^replicaOf:([^#\s]+)(?:#(\d+))?$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseReplicaPlaceholder(value) {
  if (!isNonEmptyString(value)) return null;
  const match = value.trim().match(REPLICA_PLACEHOLDER_RE);
  if (!match) return null;
  const sourceAgentId = String(match[1] || '').trim();
  const rawIndex = match[2] ? Number(match[2]) : 1;
  if (!sourceAgentId || !Number.isInteger(rawIndex) || rawIndex < 1) return null;
  return {
    sourceAgentId,
    index: rawIndex,
    placeholder: value.trim(),
  };
}

function normalizeCapacityRequests(rawRequests) {
  if (!Array.isArray(rawRequests)) return [];
  return rawRequests
    .map((request) => {
      const sourceAgentId = isNonEmptyString(request?.sourceAgentId)
        ? request.sourceAgentId.trim()
        : '';
      const count = Number(request?.count);
      if (!sourceAgentId || !Number.isInteger(count) || count < 1) return null;
      return {
        sourceAgentId,
        count,
        reason: isNonEmptyString(request?.reason) ? request.reason.trim() : '',
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

export function buildDiscoveryPrompt(objective, domainContext = '') {
  const domainBlock = domainContext
    ? ['', '## Domain Context', domainContext, '']
    : [];
  return [
    'You are a worker agent in a war room. Your team is about to tackle this objective:',
    '',
    `> ${objective}`,
    ...domainBlock,
    '',
    'Before any tasks are assigned, you need to thoroughly explore the current repository state so the orchestrator can create a good plan. Use your tools to investigate:',
    '',
    '1. **Project state** — Is this an existing codebase, a partial scaffold, or a mostly greenfield repo that only has specs/prototypes/docs?',
    '2. **Project structure** — Run `ls` and explore key directories. What are the main folders and their purposes?',
    '3. **Key files** — What are the important source files, configs, entry points?',
    '4. **Architecture** — How is the code organized today? What patterns are already present (monolith, service split, background jobs, worker queue, etc.)?',
    '5. **Relevant code** — Based on the objective, find and read the specific files/modules that would need to change. Show key function signatures, interfaces, types.',
    '6. **Dependencies** — What external libraries/frameworks are used? What internal modules interact?',
    '7. **Tests** — Where are the tests? How are they run?',
    '8. **Foundation gaps** — If the repo is greenfield or only partially scaffolded, what concrete foundation is missing that must be created first to match the upstream spec (frontend, backend/API, database layer, jobs/services, auth/integrations, env/config, tests)?',
    '',
    'If the upstream spec already defines the target product architecture, treat that as the intended destination and evaluate what exists versus what still needs to be bootstrapped.',
    'Be thorough — the orchestrator cannot see your filesystem. Everything it knows comes from your report.',
    '',
    'After exploring, respond with a JSON object summarizing your findings:',
    '{',
    '  "workingDirectory": "/full/path/to/repo",',
    '  "projectState": "existing_codebase" | "partial_scaffold" | "greenfield",',
    '  "projectDescription": "What this project does",',
    '  "techStack": ["typescript", "react", ...],',
    '  "responsibilities": "What part of the system this codebase covers",',
    '  "structure": "Key directory layout and organization",',
    '  "relevantFiles": ["path/to/file1 — description", "path/to/file2 — description"],',
    '  "keyInterfaces": "Important APIs, types, function signatures relevant to the objective",',
    '  "testInfo": "How to run tests, where test files live",',
    '  "bootstrapGaps": "Only for greenfield/partial repos — what foundational pieces must be created first to match the upstream spec",',
    '  "notes": "Anything else the orchestrator should know for planning"',
    '}',
  ].join('\n');
}

export function buildPlanningPrompt(objective, workers, domainContext = '', options = {}) {
  const maxParallelWrites = Number.isInteger(options?.maxParallelWrites) && options.maxParallelWrites >= 1
    ? options.maxParallelWrites
    : 1;
  const isolatedWriteWorktrees = options?.isolatedWriteWorktrees !== false;
  const elasticWorkers = options?.elasticWorkers === true;
  const maxDynamicWorkers = Number.isInteger(options?.maxDynamicWorkers) && options.maxDynamicWorkers >= 0
    ? options.maxDynamicWorkers
    : 0;
  const maxReplicasPerWorker = Number.isInteger(options?.maxReplicasPerWorker) && options.maxReplicasPerWorker >= 1
    ? options.maxReplicasPerWorker
    : 1;
  const workerSections = workers.map((w) => {
    const lines = [`### ${w.displayName} (${w.agentId})`];
    if (w.fullReport) {
      lines.push(w.fullReport);
    } else {
      // Fallback to structured fields
      if (w.projectState) lines.push(`Project State: ${w.projectState}`);
      if (w.projectDescription) lines.push(`Project: ${w.projectDescription}`);
      if (w.techStack?.length) lines.push(`Tech: ${w.techStack.join(', ')}`);
      if (w.responsibilities) lines.push(`Responsibilities: ${w.responsibilities}`);
      if (w.bootstrapGaps) lines.push(`Bootstrap Gaps: ${w.bootstrapGaps}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  const domainBlock = domainContext
    ? ['', '## Domain Context', domainContext, '']
    : [];

  return [
    'You are the General — an orchestrator coordinating multiple worker agents to complete a task.',
    'You cannot access any files directly. You must rely entirely on the worker reports below.',
    '',
    '## Objective',
    objective,
    ...domainBlock,
    '',
    '## Worker Reports',
    'Each worker explored their codebase and reported their findings:',
    '',
    workerSections,
    '',
    '## Instructions',
    'Based on the worker reports above, decompose the objective into concrete tasks. For each task:',
    '- Write a detailed description with specific files, functions, and changes needed',
    '- Assign it to the most appropriate worker based on their codebase knowledge',
    '- Identify dependencies (which tasks must complete before this one can start)',
    '- State material assumptions explicitly in the task description or execution notes when worker reports leave meaningful ambiguity; do not silently choose between competing interpretations if that would change the implementation',
    '- Set `requiresWrite` to true only if the task will modify tracked repo files or create tracked outputs; use false for analysis, planning, or other read-only work',
    '- Set `requiresIntegration` independently from `requiresWrite`; it should be true when downstream tasks depend on this task’s output, contract, or decision',
    '- Reference specific code from the worker reports (file paths, function names, interfaces)',
    '- Prefer the smallest task graph that fully satisfies the objective; do not create speculative follow-on tasks, abstractions, or cleanup work that is not required to ship the requested outcome',
    '- When practical, include either the lightest local sanity check truly needed to implement safely or the intended downstream validation command/handoff for later validation rooms',
    '- Treat the upstream spec as the source of truth for scope, user flows, and real product behavior; do not turn the plan into a mechanical extension of a prototype',
    '- If the repo is greenfield or only partially scaffolded, begin with the real foundation required by the upstream spec: set up the project structure, runtime surfaces, shared contracts, persistence layer, job/service plumbing, auth/integration seams, and test harnesses that the product actually needs',
    '- Follow the architecture already defined in the upstream spec when it is present; do not substitute a smaller or more elaborate architecture unless the worker reports reveal a concrete constraint',
    '- When planning parallel work, give each ready task a disjoint ownership slice; do not schedule two workers to edit the same file in the same round',
    '- If multiple changes must touch the same file or contract, serialize them with dependencies or collapse them into a single worker-owned task',
    `- Active dispatch constraint: at most ${maxParallelWrites} write task${maxParallelWrites === 1 ? '' : 's'} may run in the same dispatch window`,
    ...(isolatedWriteWorktrees
      ? ['- Write tasks run in isolated git worktrees and will be squash-merged back into the main repo after completion; plan disjoint ownership to reduce merge conflicts']
      : maxParallelWrites === 1
        ? ['- In the current shared-workspace mode, read-only tasks may still run in parallel, but writes must be serialized']
        : []),
    ...(elasticWorkers
      ? [
          `- Elastic workers are enabled for this room. You may request up to ${maxDynamicWorkers} temporary replica worker${maxDynamicWorkers === 1 ? '' : 's'} total, with at most ${maxReplicasPerWorker} replica${maxReplicasPerWorker === 1 ? '' : 's'} per source worker`,
          '- Replica requests must use `capacityRequests` and may only reference an existing non-replica local worker',
          '- Tasks may be assigned to placeholders like `replicaOf:w1` or `replicaOf:w1#2` when you also request matching capacity for that source worker',
          '- Only use replica placeholders for disjoint work. Source workers and their replicas are especially likely to overlap on the same files if you split the work lazily',
          '- Only request replica capacity when the next dispatch window already has more ready, independent work than the base worker roster can execute immediately',
          '- Do not request replicas for speculative later rounds, serial dependency chains, or work that could simply stay assigned to the source worker in the current round',
        ]
      : []),
    '',
    'Respond ONLY with a JSON object — no explanation before or after:',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "task_1",',
    '      "title": "Short title",',
    '      "description": "Detailed description referencing specific files and code",',
    '      "assignedTo": "agentId",',
    '      "dependencies": [],',
    '      "requiresIntegration": true,',
    '      "requiresWrite": true',
    '    }',
    '  ],',
    ...(elasticWorkers
      ? [
          '  "capacityRequests": [',
          '    {',
          '      "sourceAgentId": "w1",',
          '      "count": 1,',
          '      "reason": "There are enough independent tasks to justify an extra temporary worker."',
          '    }',
          '  ],',
        ]
      : []),
    '  "executionNotes": "Any high-level notes about ordering or risks"',
    '}',
  ].join('\n');
}

function buildReplicaSourceContext(task, taskBoard, options = {}) {
  const assignedTo = isNonEmptyString(task?.assignedTo) ? task.assignedTo.trim() : '';
  if (!assignedTo) return '';

  const directCapability = options?.workerCapabilities?.[assignedTo] || null;
  const placeholder = parseReplicaPlaceholder(assignedTo);
  const sourceAgentId = placeholder?.sourceAgentId || directCapability?.replicaOfAgentId || null;
  if (!isNonEmptyString(sourceAgentId)) return '';

  const sourceCapability = options?.workerCapabilities?.[sourceAgentId] || null;
  const sourceDisplayName = isNonEmptyString(sourceCapability?.displayName)
    ? sourceCapability.displayName.trim()
    : sourceAgentId;
  const sourceTasks = taskBoard.filter((candidate) => candidate?.assignedTo === sourceAgentId && candidate?.id !== task.id);
  const sourceCompleted = sourceTasks
    .filter((candidate) => candidate?.status === 'done')
    .slice(-3);
  const sourceActive = sourceTasks
    .filter((candidate) => candidate?.status === 'in_progress' || candidate?.status === 'pending')
    .slice(0, 3);

  if (sourceCompleted.length === 0 && sourceActive.length === 0) {
    return [
      '## Source Worker Context',
      `This task is assigned to a replica of ${sourceDisplayName} (${sourceAgentId}). Start from the source worker's established codebase context, but use a fresh execution thread.`,
      '',
    ].join('\n');
  }

  const lines = [
    '## Source Worker Context',
    `This task is assigned to a replica of ${sourceDisplayName} (${sourceAgentId}). Start from the source worker's recent context, but use a fresh execution thread.`,
  ];

  if (sourceCompleted.length > 0) {
    lines.push('Recent completed work from the source worker:');
    for (const completedTask of sourceCompleted) {
      const summary = isNonEmptyString(completedTask?.result)
        ? completedTask.result.trim().replace(/\s+/g, ' ').slice(0, 180)
        : '';
      const filesChanged = Array.isArray(completedTask?.filesChanged) && completedTask.filesChanged.length > 0
        ? completedTask.filesChanged.join(', ')
        : '';
      const notes = isNonEmptyString(completedTask?.integrationNotes)
        ? completedTask.integrationNotes.trim().replace(/\s+/g, ' ').slice(0, 180)
        : '';
      const details = [summary, filesChanged && `Files: ${filesChanged}`, notes && `Notes: ${notes}`]
        .filter(Boolean)
        .join(' | ');
      lines.push(`- ${completedTask.id}: ${completedTask.title}${details ? ` — ${details}` : ''}`);
    }
  }

  if (sourceActive.length > 0) {
    lines.push('Other source-worker tasks already on the board:');
    for (const activeTask of sourceActive) {
      lines.push(`- ${activeTask.id}: ${activeTask.title} [${activeTask.status}]`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function buildTaskContext(task, taskBoard, options = {}) {
  const directDeps = task.dependencies
    .map((id) => taskBoard.find((t) => t.id === id))
    .filter(Boolean);
  const activePeers = taskBoard.filter(
    (t) => t.status === 'in_progress' && t.id !== task.id,
  );
  const otherDone = taskBoard.filter(
    (t) => t.status === 'done' && !task.dependencies.includes(t.id),
  );
  const pendingBlocked = taskBoard.filter(
    (t) => (t.status === 'pending' || t.status === 'blocked') && t.id !== task.id,
  );

  const lines = [];
  if (directDeps.length > 0) {
    lines.push('## Context from Prior Tasks');
    for (const dep of directDeps) {
      lines.push(`### ${dep.title} (${dep.id})`);
      if (dep.result) lines.push(dep.result);
      if (dep.integrationNotes) lines.push(`Integration notes: ${dep.integrationNotes}`);
      if (dep.filesChanged?.length) lines.push(`Files changed: ${dep.filesChanged.join(', ')}`);
      lines.push('');
    }
  }
  if (activePeers.length > 0) {
    lines.push('## Other Active Tasks This Round');
    for (const t of activePeers) {
      const desc = t.description ? ` — ${t.description.slice(0, 180)}` : '';
      lines.push(`- ${t.id}: ${t.title} → ${t.assignedTo}${desc}`);
    }
    lines.push('');
  }
  if (otherDone.length > 0) {
    lines.push('## Other Completed Tasks');
    for (const t of otherDone) {
      const summary = t.result ? t.result.slice(0, 120) : '';
      lines.push(`- ${t.id}: ${t.title} — ${summary}`);
    }
    lines.push('');
  }
  if (pendingBlocked.length > 0) {
    lines.push('## Remaining Tasks');
    for (const t of pendingBlocked) {
      lines.push(`- ${t.id}: ${t.title} [${t.status}] → ${t.assignedTo}`);
    }
    lines.push('');
  }
  const sourceContext = buildReplicaSourceContext(task, taskBoard, options);
  if (sourceContext) {
    lines.push(sourceContext);
  }
  return lines.join('\n');
}

export function buildTaskAssignmentPrompt(task, taskBoard, upstreamContext = '', options = {}) {
  const context = buildTaskContext(task, taskBoard, options);
  const upstreamBlock = upstreamContext
    ? [upstreamContext, '']
    : [];
  const writeGuidance = task?.requiresWrite === false
    ? [
        'This is a read-only task. Do not modify repository files or create tracked outputs.',
        'Use your tools to inspect, analyze, and report what the rest of the room needs to know.',
        'State material assumptions explicitly and prefer concrete, verifiable observations over speculation.',
      ]
    : [
        'Implement this task in your repository. When done, describe what you changed and any information other workers might need for integration.',
        'Prefer the smallest change that fully completes this task.',
        'If you write 200 lines and it could be 50, rewrite it.',
        'Keep edits surgical. Do not refactor, reformat, or clean up unrelated code. Only remove code or imports that become unused because of your own changes.',
        'Match the existing style and patterns of the codebase unless this task explicitly requires a different approach.',
        'Do not add new abstractions, configurability, or speculative improvements unless they are necessary to complete this task correctly.',
        'Use a lightweight local sanity check only when needed to implement safely. Otherwise, record the intended downstream validation command or follow-up in your summary so later validation rooms can pick it up.',
      ];
  return [
    `## Task: ${task.title}`,
    '',
    task.description,
    '',
    ...upstreamBlock,
    context,
    '## Instructions',
    ...writeGuidance,
    'Treat the upstream spec as the source of truth for what must be built. Use any referenced prototype only as design input, not as the implementation artifact.',
    'If this is a greenfield foundation task, create the real runnable scaffold and contracts the product needs, not placeholder folders or TODO-only stubs.',
    'Stay within the file/module ownership implied by this task. Do not edit the same file as another active task unless this task explicitly depends on that shared integration point.',
    'If there are multiple plausible implementation paths, state the material assumption you chose in your summary, or stop and report the task as blocked if the ambiguity makes the task risky to complete safely.',
    'If you discover that completing this task correctly would require stepping on another active task\'s file ownership, stop and report it as blocked so the orchestrator can re-plan safely.',
    'If you get blocked after making partial progress, still include the completed work in `summary`, list any changed files in `filesChanged`, and capture interface details in `integrationNotes` before explaining the blocker.',
    '',
    '**Important:** In `integrationNotes`, include the **actual content** of any new or changed APIs, schemas, config formats, or interface contracts — not just file paths. Other workers cannot read your files, so they need the full interface definitions to integrate with your changes.',
    '',
    'Respond with a JSON object:',
    '{',
    '  "status": "done" | "blocked",',
    '  "summary": "What was implemented/changed",',
    '  "filesChanged": ["path/to/file1", "path/to/file2"],',
    '  "integrationNotes": "Full content of any new/changed APIs, schemas, types, config formats, or contracts that other workers need.",',
    '  "blockedReason": "Only if status is blocked — what\'s preventing completion"',
    '}',
  ].join('\n');
}

export function buildResultProcessingPrompt(completedTasks, taskBoard, objective, options = {}) {
  const elasticWorkers = options?.elasticWorkers === true;
  const completedSection = completedTasks.map((t) => {
    const lines = [`### ${t.title} (${t.id}) — ${t.assignedTo}`];
    if (t.result) lines.push(`Summary: ${t.result}`);
    if (t.filesChanged?.length) lines.push(`Files changed: ${t.filesChanged.join(', ')}`);
    if (t.integrationNotes) lines.push(`Integration notes: ${t.integrationNotes}`);
    if (t.blockedReason) lines.push(`BLOCKED: ${t.blockedReason}`);
    return lines.join('\n');
  }).join('\n\n');

  const boardSummary = taskBoard.map((t) => {
    const status = t.status;
    const deps = t.dependencies.length ? ` [depends: ${t.dependencies.join(', ')}]` : '';
    if (status === 'done') {
      return `- ${t.id}: ${t.title} [done] → ${t.assignedTo}${deps}`;
    }
    const desc = t.description ? ` — ${t.description.slice(0, 150)}` : '';
    return `- ${t.id}: ${t.title} [${status}] → ${t.assignedTo}${deps}${desc}`;
  }).join('\n');

  return [
    'You are the General reviewing recent task results and planning next steps.',
    '',
    '## Objective',
    objective,
    '',
    '## Recent Task Results',
    completedSection,
    '',
    '## Full Task Board',
    boardSummary,
    '',
    '## Instructions',
    'Review the recent task results and decide:',
    '1. Do any pending/blocked task descriptions need updating based on what was actually implemented? (e.g., API contracts, file paths, interfaces that differ from the original plan)',
    '2. Are any new tasks needed that were not in the original plan?',
    ...(elasticWorkers
      ? [
          '3. If you request extra temporary capacity, only do it for immediately-ready disjoint work in the very next dispatch window',
          '4. Do not request replica capacity for speculative future rounds or serial dependency chains',
        ]
      : []),
    '3. Should any pending tasks be removed or reassigned?',
    '4. Did the completed work reveal any file-ownership conflicts or shared-file hotspots that should be serialized before the next round?',
    '5. For every new task, set `requiresWrite` explicitly. Use true only for repo-changing work; read-only analysis/planning tasks must use false.',
    ...(elasticWorkers
      ? [
          '6. If extra worker capacity is justified, you may request temporary replicas via `capacityRequests` and assign new tasks to placeholders such as `replicaOf:w1` or `replicaOf:w1#2`',
        ]
      : []),
    '',
    'Respond ONLY with a JSON object:',
    '{',
    '  "taskUpdates": [',
    '    { "id": "task_3", "description": "Updated description with actual API contract..." }',
    '  ],',
    '  "newTasks": [',
    '    { "title": "...", "description": "...", "assignedTo": "agentId", "dependencies": ["task_2"], "requiresIntegration": true, "requiresWrite": true }',
    '  ],',
    ...(elasticWorkers
      ? [
          '  "capacityRequests": [',
          '    { "sourceAgentId": "w1", "count": 1, "reason": "Independent follow-up work justifies another temporary worker." }',
          '  ],',
        ]
      : []),
    '  "removeTasks": [],',
    '  "notes": "Brief summary of changes made and why"',
    '}',
    '',
    'If no changes needed, return: { "taskUpdates": [], "newTasks": [], "removeTasks": [], "notes": "No changes needed" }',
  ].join('\n');
}

export function buildCompletionPrompt(objective, taskBoard, workerCapabilities) {
  const boardStr = taskBoard.map((t) => {
    const deps = t.dependencies.length ? ` deps:[${t.dependencies.join(',')}]` : '';
    const result = t.result ? ` — ${t.result.slice(0, 200)}` : '';
    return `- ${t.id}: ${t.title} [${t.status}] → ${t.assignedTo}${deps}${result}`;
  }).join('\n');

  return [
    'You are the General. The war room is complete.',
    '',
    '## Objective',
    objective,
    '',
    '## Task Board (Final State)',
    boardStr,
    '',
    '## Worker Capabilities',
    JSON.stringify(workerCapabilities, null, 2),
    '',
    '## Instructions',
    'Produce a final summary report:',
    '1. What was accomplished',
    '2. Which tasks were completed by which workers',
    '3. Any tasks that remain incomplete or blocked',
    '4. Integration status',
    '5. Recommended follow-up actions',
    '',
    'Respond with a structured summary.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseDiscoveryResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) {
    // No valid JSON — use the full text as the report
    return { rawReport: text || '', parseError: true };
  }
  return {
    workingDirectory: String(parsed.workingDirectory || ''),
    projectState: String(parsed.projectState || ''),
    projectDescription: String(parsed.projectDescription || ''),
    techStack: Array.isArray(parsed.techStack) ? parsed.techStack.map(String) : [],
    responsibilities: String(parsed.responsibilities || ''),
    structure: String(parsed.structure || ''),
    relevantFiles: Array.isArray(parsed.relevantFiles) ? parsed.relevantFiles.map(String) : [],
    keyInterfaces: String(parsed.keyInterfaces || ''),
    testInfo: String(parsed.testInfo || ''),
    bootstrapGaps: String(parsed.bootstrapGaps || ''),
    notes: String(parsed.notes || ''),
    rawReport: '',
    parseError: false,
  };
}

export function parsePlanningResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed || !Array.isArray(parsed.tasks)) return null;
  return {
    tasks: parsed.tasks.map((t, i) => ({
      id: t.id || `task_${i + 1}`,
      title: String(t.title || `Task ${i + 1}`),
      description: String(t.description || ''),
      assignedTo: t.assignedTo === null ? null : String(t.assignedTo || ''),
      dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
      requiresIntegration: typeof t.requiresIntegration === 'boolean'
        ? t.requiresIntegration
        : false,
      requiresWrite: typeof t.requiresWrite === 'boolean'
        ? t.requiresWrite
        : true,
      status: 'pending',
    })),
    capacityRequests: normalizeCapacityRequests(parsed.capacityRequests),
    executionNotes: parsed.executionNotes ? String(parsed.executionNotes) : null,
  };
}

export function parseTaskResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) return { status: 'done', summary: text, parseError: true };
  return {
    status: parsed.status === 'blocked' ? 'blocked' : 'done',
    summary: String(parsed.summary || ''),
    filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged.map(String) : [],
    integrationNotes: parsed.integrationNotes ? String(parsed.integrationNotes) : null,
    blockedReason: parsed.blockedReason ? String(parsed.blockedReason) : null,
    parseError: false,
  };
}

export function parseResultProcessingResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) return null;
  return {
    taskUpdates: Array.isArray(parsed.taskUpdates) ? parsed.taskUpdates : [],
    newTasks: Array.isArray(parsed.newTasks) ? parsed.newTasks : [],
    capacityRequests: normalizeCapacityRequests(parsed.capacityRequests),
    removeTasks: Array.isArray(parsed.removeTasks) ? parsed.removeTasks : [],
    notes: String(parsed.notes || ''),
  };
}

export function applyResultProcessing(state, result, availableWorkerIds, options = {}) {
  const assignmentValidator = typeof options?.assignmentValidator === 'function'
    ? options.assignmentValidator
    : (assignedTo) => availableWorkerIds.includes(assignedTo);
  // Apply task description updates
  for (const update of result.taskUpdates) {
    if (!update.id) continue;
    const task = state.taskBoard.find((t) => t.id === update.id);
    if (task && task.status !== 'done' && task.status !== 'in_progress') {
      if (update.description) task.description = String(update.description);
    }
  }

  // Add new tasks
  for (const newTask of result.newTasks) {
    if (!newTask.title) continue;
    const assignedTo = newTask.assignedTo === null ? null : String(newTask.assignedTo || '');
    if (assignedTo !== null && !assignmentValidator(assignedTo)) continue;
    const id = `task_${state.nextTaskId++}`;
    const deps = Array.isArray(newTask.dependencies) ? newTask.dependencies : [];
    // Only keep deps that reference existing task IDs
    const validDeps = deps.filter((d) => state.taskBoard.some((t) => t.id === d));
    state.taskBoard.push({
      id,
      title: String(newTask.title),
      description: String(newTask.description || ''),
      assignedTo,
      dependencies: validDeps,
      requiresIntegration: Boolean(newTask.requiresIntegration),
      requiresWrite: typeof newTask.requiresWrite === 'boolean' ? newTask.requiresWrite : true,
      status: 'pending',
      unassignedReason: assignedTo === null ? 'restore' : null,
      unassignedDetails: null,
    });
  }

  // Remove tasks (only pending/blocked, never done or in_progress)
  for (const removeId of result.removeTasks) {
    const idx = state.taskBoard.findIndex(
      (t) => t.id === removeId && (t.status === 'pending' || t.status === 'blocked'),
    );
    if (idx >= 0) {
      state.taskBoard.splice(idx, 1);
      // Clean up dangling deps
      for (const t of state.taskBoard) {
        t.dependencies = t.dependencies.filter((d) => d !== removeId);
      }
    }
  }
}
