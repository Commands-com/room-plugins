import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlugin } from '../room-plugins/break-room/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    roomId: overrides.roomId || 'break-room-test',
    objective: overrides.objective || 'Brainstorm product launch angles',
    participants: overrides.participants || [
      { agentId: 'worker_1', displayName: 'Worker 1', role: 'worker' },
      { agentId: 'worker_2', displayName: 'Worker 2', role: 'worker' },
      { agentId: 'worker_3', displayName: 'Worker 3', role: 'worker' },
    ],
    orchestratorConfig: {
      rounds: 2,
      ...(overrides.orchestratorConfig || {}),
    },
    getState() {
      return state != null ? JSON.parse(JSON.stringify(state)) : null;
    },
    setState(nextState) {
      state = nextState != null ? JSON.parse(JSON.stringify(nextState)) : null;
    },
    setCycle(value) {
      cycles.push(value);
    },
    emitMetrics(metrics) {
      emittedMetrics.push(metrics);
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

test('break room picks speakers and avoids consecutive turns', () => {
  const ctx = makeMockCtx();
  const plugin = createPlugin();

  plugin.init(ctx);
  const startDecision = plugin.onRoomStart(ctx);

  assert.equal(startDecision.type, 'speak');
  assert.ok(['worker_1', 'worker_2', 'worker_3'].includes(startDecision.agentId));

  const nextDecision = plugin.onTurnResult(ctx, {
    agentId: startDecision.agentId,
    response: 'Worker 2, you should react to the pricing angle next.',
  });

  assert.equal(nextDecision.type, 'speak');
  assert.notEqual(nextDecision.agentId, startDecision.agentId);
  if (startDecision.agentId !== 'worker_2') {
    assert.equal(nextDecision.agentId, 'worker_2');
  }
});
