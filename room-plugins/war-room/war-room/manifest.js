// ---------------------------------------------------------------------------
// War Room plugin manifest + id. Frozen static config: dashboard panels,
// limits, roles, handoff contracts, room-config schema, display metadata,
// and final-report layout. Re-exported through war-room-plugin.js.
// ---------------------------------------------------------------------------

export const PLUGIN_ID = 'war_room';

/** Max characters stored per turnLog entry content to prevent unbounded growth. */
export const TURN_LOG_MAX_CONTENT_LENGTH = 20_000;
export const STRUCTURED_ROOM_LLM_OUTPUT_CHARS = 120_000;

export const MANIFEST = Object.freeze({
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
