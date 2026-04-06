import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlugin } from '../room-plugins/explore-room/index.js';

function makeCtx() {
  let state = null;
  return {
    objective: 'Find the next Command Garden feature to ship.',
    participants: [
      {
        agentId: 'gpt_1',
        displayName: 'GPT',
        role: 'explorer',
        profile: { provider: 'openai', model: 'gpt-5.4' },
      },
      {
        agentId: 'claude_1',
        displayName: 'Claude',
        role: 'explorer',
        profile: { provider: 'anthropic', model: 'claude-sonnet-4.5' },
      },
      {
        agentId: 'gemini_1',
        displayName: 'Gemini',
        role: 'explorer',
        profile: { provider: 'google', model: 'gemini-2.5-pro' },
      },
    ],
    limits: { maxCycles: 1 },
    roomConfig: {},
    getState() {
      return state ? JSON.parse(JSON.stringify(state)) : null;
    },
    setState(nextState) {
      state = nextState ? JSON.parse(JSON.stringify(nextState)) : null;
    },
    emitMetrics() {},
  };
}

function conceptResponse(title, oneLiner) {
  return [
    '## Title',
    title,
    '',
    '## One Liner',
    oneLiner,
    '',
    '## Target User',
    'People following the daily evolution of the site.',
    '',
    '## Problem',
    'They need a legible way to understand what changed and why it matters.',
    '',
    '## Core Value',
    'Turns the daily run into a clear public artifact.',
    '',
    '## Required User Flows',
    '- Open the daily entry',
    '- Understand the winning idea quickly',
    '',
    '## Prototype Focus',
    '- Make the decision legible',
    '- Give tomorrow a stronger surface to build on',
    '',
    '## Non-Mock Functionality',
    '- Render real pipeline artifacts',
    '',
    '## Implementation Boundaries',
    '- Keep the scope small enough for one daily run',
    '',
    '## Risks',
    '- Could feel repetitive if the framing is too static',
    '',
    '## Why This Could Win',
    'It makes the project easier to follow and compounds over time.',
    '',
    '## Open Questions',
    '- How much history should show on the homepage?',
  ].join('\n');
}

function reviewBlock(target, score, dimensionScores, why) {
  return [
    `## Target: ${target}`,
    '### Dimension Scores',
    `- Compounding Value: ${dimensionScores.compoundingValue}`,
    `- Usefulness & Clarity: ${dimensionScores.usefulnessClarity}`,
    `- Novelty & Surprise: ${dimensionScores.noveltySurprise}`,
    `- Feasibility: ${dimensionScores.feasibility}`,
    `- Legibility: ${dimensionScores.legibility}`,
    `- Continuity: ${dimensionScores.continuity}`,
    `- Shareability: ${dimensionScores.shareability}`,
    '### Score',
    `- ${score}`,
    '### Keep',
    '- Strong direction',
    '### Must Change',
    '- Tighten the first-run explanation',
    '### Risks',
    '- Might over-explain the result',
    '### Why It Wins Or Loses',
    `- ${why}`,
  ].join('\n');
}

test('explore room emits a command-garden-ready decision bundle', () => {
  const plugin = createPlugin();
  const ctx = makeCtx();

  plugin.init(ctx);

  const state = ctx.getState();
  state.phase = 'complete';
  state.rounds = [
    {
      phase: 'explore',
      cycleIndex: 1,
      responses: [
        {
          agentId: 'gpt_1',
          displayName: 'GPT',
          conceptKey: 'openai',
          response: conceptResponse('Garden Timeline', 'A living timeline of each daily run.'),
          status: 'submitted',
        },
        {
          agentId: 'claude_1',
          displayName: 'Claude',
          conceptKey: 'claude',
          response: conceptResponse('Decision Theater', 'A page that stages the daily AI debate and winner.'),
          status: 'submitted',
        },
        {
          agentId: 'gemini_1',
          displayName: 'Gemini',
          conceptKey: 'gemini',
          response: conceptResponse('Feedback Compost', 'Turn user feedback into tomorrow-ready feature seeds.'),
          status: 'submitted',
        },
      ],
    },
    {
      phase: 'review',
      cycleIndex: 1,
      responses: [
        {
          agentId: 'gpt_1',
          displayName: 'GPT',
          conceptKey: 'openai',
          response: [
            reviewBlock('claude', 9, {
              compoundingValue: 9,
              usefulnessClarity: 9,
              noveltySurprise: 8,
              feasibility: 8,
              legibility: 9,
              continuity: 9,
              shareability: 8,
            }, 'Best combination of clarity and momentum.'),
            '',
            reviewBlock('gemini', 7, {
              compoundingValue: 7,
              usefulnessClarity: 7,
              noveltySurprise: 8,
              feasibility: 8,
              legibility: 6,
              continuity: 7,
              shareability: 7,
            }, 'Interesting, but less immediately legible.'),
          ].join('\n\n'),
          status: 'submitted',
        },
        {
          agentId: 'claude_1',
          displayName: 'Claude',
          conceptKey: 'claude',
          response: [
            reviewBlock('openai', 8, {
              compoundingValue: 8,
              usefulnessClarity: 8,
              noveltySurprise: 7,
              feasibility: 9,
              legibility: 8,
              continuity: 8,
              shareability: 7,
            }, 'Strong continuity play, but slightly less vivid.'),
            '',
            reviewBlock('gemini', 7, {
              compoundingValue: 7,
              usefulnessClarity: 6,
              noveltySurprise: 8,
              feasibility: 8,
              legibility: 6,
              continuity: 7,
              shareability: 7,
            }, 'Good ingredient for later, weaker as today\'s winner.'),
          ].join('\n\n'),
          status: 'submitted',
        },
        {
          agentId: 'gemini_1',
          displayName: 'Gemini',
          conceptKey: 'gemini',
          response: [
            reviewBlock('openai', 8, {
              compoundingValue: 8,
              usefulnessClarity: 8,
              noveltySurprise: 7,
              feasibility: 8,
              legibility: 8,
              continuity: 8,
              shareability: 7,
            }, 'Dependable and strong, but more expected.'),
            '',
            reviewBlock('claude', 9, {
              compoundingValue: 9,
              usefulnessClarity: 9,
              noveltySurprise: 9,
              feasibility: 8,
              legibility: 9,
              continuity: 8,
              shareability: 9,
            }, 'Feels most like a story people will follow daily.'),
          ].join('\n\n'),
          status: 'submitted',
        },
      ],
    },
  ];
  ctx.setState(state);

  const report = plugin.getFinalReport(ctx);
  const bundle = report.handoffPayloads[0].data;

  assert.equal(bundle.contract, 'concept_bundle.v1');
  assert.equal(bundle.judgePanel.length, 3);
  assert.ok(bundle.decision.scoringDimensions.some((dimension) => dimension.id === 'shareability'));
  assert.equal(bundle.candidates.length, 3);
  assert.equal(bundle.selectedConcept.id, 'claude');
  assert.ok(bundle.selectedConcept.aggregateScores.overall > 8);
  assert.ok(bundle.selectedConcept.aggregateScores.dimensions.usefulnessClarity.average > 8);
  assert.equal(bundle.candidates[0].reviewerBreakdown.length, 2);
  assert.ok(['gpt', 'claude', 'gemini'].includes(bundle.candidates[0].reviewerBreakdown[0].reviewer.modelFamily));
});
