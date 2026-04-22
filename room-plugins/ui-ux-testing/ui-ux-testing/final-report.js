// ---------------------------------------------------------------------------
// test_results.v1 report assembly. Pulls the final scenario list from state
// and produces the downstream payload (per-scenario status, pass/fail
// counts, pass rate) plus the artifact list for test file paths.
// ---------------------------------------------------------------------------

import { getConfig } from './config.js';

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

export function buildTestResultsReport(ctx, state) {
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
