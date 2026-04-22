import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlugin } from '../room-plugins/code-arena/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Focus on array and string manipulation challenges',
    participants: overrides.participants || [
      { agentId: 'judge_1', displayName: 'Judge', role: 'judge' },
      { agentId: 'contestant_1', displayName: 'Alpha', role: 'contestant' },
      { agentId: 'contestant_2', displayName: 'Beta', role: 'contestant' },
    ],
    roomConfig: {
      rounds: 1,
      ...(overrides.roomConfig || {}),
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

test('code arena runs a single-round tournament flow', () => {
  const ctx = makeMockCtx();
  const plugin = createPlugin();

  plugin.init(ctx);
  const startDecision = plugin.onRoomStart(ctx);
  assert.equal(startDecision.type, 'speak');
  assert.equal(startDecision.agentId, 'judge_1');

  const codingDecision = plugin.onTurnResult(ctx, {
    agentId: 'judge_1',
    response: [
      'Welcome to Code Arena!',
      '```json',
      JSON.stringify({
        title: 'Deduplicate Strings',
        description: 'Write a function that removes duplicate strings while preserving order.',
        difficulty: 'Easy',
        language: 'javascript',
      }, null, 2),
      '```',
    ].join('\n'),
  });

  assert.equal(codingDecision.type, 'fan_out');
  assert.deepEqual(codingDecision.targets.map((target) => target.agentId), ['contestant_1', 'contestant_2']);

  const judgingDecision = plugin.onFanOutComplete(ctx, [
    { agentId: 'contestant_1', response: '```javascript\nfunction dedupe(items){ return [...new Set(items)]; }\n```' },
    { agentId: 'contestant_2', response: '```javascript\nfunction dedupe(items){ const seen=new Set(); return items.filter((item)=>{ if(seen.has(item)) return false; seen.add(item); return true; }); }\n```' },
  ]);

  assert.equal(judgingDecision.type, 'speak');
  assert.equal(judgingDecision.agentId, 'judge_1');

  const stopDecision = plugin.onTurnResult(ctx, {
    agentId: 'judge_1',
    response: [
      '```json',
      JSON.stringify({
        winner: 'Beta',
        contestant1Score: 81,
        contestant2Score: 89,
        commentary: 'Beta edges this one with a clearer implementation.',
      }, null, 2),
      '```',
    ].join('\n'),
  });

  assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });
});
