import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlugin } from '../room-plugins/quality-room/index.js';
import {
  parseReviewerResponse,
  buildInitialReviewPrompt,
} from '../room-plugins/quality-room/plugin.js';

function makeCtx(overrides = {}) {
  let state = null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Raise the current implementation to an A quality bar without adding unnecessary scope.',
    roomId: overrides.roomId || 'room_quality_1',
    participants: overrides.participants || [
      { agentId: 'impl_1', displayName: 'Implementer', role: 'implementer' },
      { agentId: 'rev_1', displayName: 'Reviewer 1', role: 'reviewer' },
      { agentId: 'rev_2', displayName: 'Reviewer 2', role: 'reviewer' },
    ],
    limits: {
      maxCycles: 2,
      ...(overrides.limits || {}),
    },
    handoffContext: overrides.handoffContext || null,
    getState() {
      return state;
    },
    setState(nextState) {
      state = JSON.parse(JSON.stringify(nextState));
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

test('parseReviewerResponse normalizes empty-blocker A responses', () => {
  const parsed = parseReviewerResponse(JSON.stringify({
    overall_grade: 'B',
    category_grades: {
      correctness: 'A',
      simplicity: 'B',
      maintainability: 'B',
      verification: 'B',
      scope_discipline: 'A',
    },
    strengths: ['Clean targeted change'],
    blockers_to_a: [],
    assumptions: [],
  }));

  assert.equal(parsed.overall_grade, 'A');
  assert.equal(parsed.blockers_to_a.length, 0);
});

test('quality room reviews, implements, and converges at A', async () => {
  const ctx = makeCtx({
    handoffContext: {
      payloads: [
        {
          contract: 'spec_bundle.v1',
          data: {
            summary: {
              title: 'Saved Work Redesign',
              oneLiner: 'Improve saved work usability without broadening scope.',
              recommendedDirection: 'Keep the change surgical and preserve the existing product shape.',
            },
            spec: {
              acceptanceCriteria: ['Users can find saved items quickly', 'No unrelated UI rewrite'],
            },
          },
        },
      ],
    },
  });
  const plugin = createPlugin();
  plugin.init(ctx);

  const start = plugin.onRoomStart(ctx);
  assert.equal(start.type, 'fan_out');
  assert.deepEqual(start.targets.map((target) => target.agentId), ['rev_1', 'rev_2']);
  assert.match(start.targets[0].message, /overall_grade/i);
  assert.match(start.targets[0].message, /blockers_to_a/i);
  assert.match(start.targets[0].message, /stable grading rubric/i);

  const implementDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'rev_1',
      response: JSON.stringify({
        overall_grade: 'B',
        category_grades: {
          correctness: 'A',
          simplicity: 'B',
          maintainability: 'B',
          verification: 'C',
          scope_discipline: 'A',
        },
        strengths: ['Behavior is mostly correct'],
        blockers_to_a: [
          {
            title: 'Missing focused regression test',
            severity: 'major',
            description: 'The fix is not protected by a narrow regression test.',
            suggestion: 'Add the narrowest regression test that proves the new behavior.',
          },
        ],
        assumptions: [],
      }),
    },
    {
      agentId: 'rev_2',
      response: JSON.stringify({
        overall_grade: 'B',
        category_grades: {
          correctness: 'A',
          simplicity: 'A',
          maintainability: 'B',
          verification: 'B',
          scope_discipline: 'A',
        },
        strengths: ['Scope stayed mostly controlled'],
        blockers_to_a: [
          {
            title: 'Missing focused regression test',
            severity: 'major',
            description: 'The change still needs a direct test.',
            suggestion: 'Add a focused regression test instead of relying on broader coverage.',
          },
        ],
        assumptions: [],
      }),
    },
  ]);

  assert.equal(implementDecision.type, 'speak');
  assert.equal(implementDecision.agentId, 'impl_1');
  assert.match(implementDecision.message, /Current Reviewer Grades/);
  assert.match(implementDecision.message, /Missing focused regression test/);

  const rereviewDecision = plugin.onTurnResult(ctx, {
    agentId: 'impl_1',
    response: 'Added a focused regression test, removed an unnecessary helper, and verified with the direct test command.',
  });

  assert.equal(rereviewDecision.type, 'fan_out');
  assert.deepEqual(rereviewDecision.targets.map((target) => target.agentId), ['rev_1', 'rev_2']);
  assert.equal(ctx.getState().currentCycle, 2);

  const stopDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'rev_1',
      response: JSON.stringify({
        overall_grade: 'A',
        category_grades: {
          correctness: 'A',
          simplicity: 'A',
          maintainability: 'A',
          verification: 'A',
          scope_discipline: 'A',
        },
        strengths: ['Surgical fix with direct verification'],
        blockers_to_a: [],
        assumptions: [],
      }),
    },
    {
      agentId: 'rev_2',
      response: JSON.stringify({
        overall_grade: 'A',
        category_grades: {
          correctness: 'A',
          simplicity: 'A',
          maintainability: 'A',
          verification: 'A',
          scope_discipline: 'A',
        },
        strengths: ['Ready to ship'],
        blockers_to_a: [],
        assumptions: [],
      }),
    },
  ]);

  assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

  const report = plugin.getFinalReport(ctx);
  assert.ok(Array.isArray(report.handoffPayloads));
  const reviewPayload = report.handoffPayloads.find((payload) => payload.contract === 'review_findings.v1');
  assert.ok(reviewPayload);
  assert.equal(reviewPayload.data.summary.openFindings, 0);
  assert.equal(reviewPayload.data.qualitySummary.targetGrade, 'A');
});

test('buildInitialReviewPrompt includes upstream context when present', () => {
  const prompt = buildInitialReviewPrompt(
    'Raise the quality bar.',
    'Reviewer 1',
    '## Upstream Spec\nTitle: Saved Work Redesign',
  );

  assert.match(prompt, /Upstream Spec/);
  assert.match(prompt, /Saved Work Redesign/);
});
