// ---------------------------------------------------------------------------
// Metrics emission + turnLog helpers. emitBoardMetrics computes scenario
// counts, pass rate, and the rendered taskBoard rows, then hands them to
// ctx.emitMetrics. logTurn/logOrchestrator push bounded entries into the
// shared turnLog consumed by the dashboard and the final report.
// ---------------------------------------------------------------------------

import { TURN_LOG_MAX } from './constants.js';

export function emitBoardMetrics(ctx, state) {
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

export function logTurn(state, agentId, response, ctx) {
  const participant = ctx.participants.find((p) => p.agentId === agentId);
  const raw = response || '';
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'worker',
    agent: participant?.displayName || agentId,
    content: raw.length > TURN_LOG_MAX ? raw.slice(0, TURN_LOG_MAX) + '\n... [truncated]' : raw,
  });
}

export function logOrchestrator(state, text) {
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'reviewer',
    agent: 'Orchestrator',
    content: (text || '').slice(0, TURN_LOG_MAX),
  });
}
