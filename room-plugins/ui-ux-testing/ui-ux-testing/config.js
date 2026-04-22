// ---------------------------------------------------------------------------
// Config helper — merges orchestratorConfig + roomConfig into a single
// object with sensible defaults. Every phase handler and prompt builder
// reads through this so they never have to worry about missing fields.
// ---------------------------------------------------------------------------

export function getConfig(ctx) {
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
