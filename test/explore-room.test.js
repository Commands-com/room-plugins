import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlugin } from '../room-plugins/explore-room/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  let activeFanOut = overrides.activeFanOut || null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Makeup',
    participants: overrides.participants || [
      {
        agentId: 'openai_1',
        displayName: 'OpenAI',
        role: 'explorer',
        profile: { id: 'p1', name: 'GPT-5.4', provider: 'openai', model: 'gpt-5.4' },
      },
      {
        agentId: 'claude_1',
        displayName: 'Claude',
        role: 'explorer',
        profile: { id: 'p2', name: 'Claude 4.6 Opus', provider: 'anthropic', model: 'claude-opus-4.6' },
      },
      {
        agentId: 'gemini_1',
        displayName: 'Gemini',
        role: 'explorer',
        profile: { id: 'p3', name: 'Gemini 2.5 Pro', provider: 'google', model: 'gemini-2.5-pro' },
      },
    ],
    roomConfig: {
      seedMode: 'Domain Search',
      ...(overrides.roomConfig || {}),
    },
    limits: {
      maxCycles: 2,
      ...(overrides.limits || {}),
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
    getFinalReport() {
      return {};
    },
    getActiveFanOut() {
      return activeFanOut != null ? JSON.parse(JSON.stringify(activeFanOut)) : null;
    },
    async invokeLLM() {
      throw new Error('invokeLLM should not be called in explore room');
    },
    _setActiveFanOut(nextActiveFanOut) {
      activeFanOut = nextActiveFanOut != null ? JSON.parse(JSON.stringify(nextActiveFanOut)) : null;
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

function conceptResponse({
  title,
  oneLiner,
  targetUser,
  problem,
  coreValue,
  requiredUserFlows,
  prototypeFocus,
  nonMockFunctionality,
  implementationBoundaries,
  risks,
  whyThisCouldWin,
  openQuestions = [],
}) {
  return [
    '## Title',
    title,
    '',
    '## One Liner',
    oneLiner,
    '',
    '## Target User',
    targetUser,
    '',
    '## Problem',
    problem,
    '',
    '## Core Value',
    coreValue,
    '',
    '## Required User Flows',
    ...requiredUserFlows.map((item) => `- ${item}`),
    '',
    '## Prototype Focus',
    ...prototypeFocus.map((item) => `- ${item}`),
    '',
    '## Non-Mock Functionality',
    ...nonMockFunctionality.map((item) => `- ${item}`),
    '',
    '## Implementation Boundaries',
    ...implementationBoundaries.map((item) => `- ${item}`),
    '',
    '## Risks',
    ...risks.map((item) => `- ${item}`),
    '',
    '## Why This Could Win',
    whyThisCouldWin,
    '',
    '## Open Questions',
    ...(openQuestions.length > 0 ? openQuestions.map((item) => `- ${item}`) : ['- None.']),
  ].join('\n');
}

test('explore room switches into refine mode when review requests changes and then converges', async () => {
  const ctx = makeMockCtx();
  const plugin = createPlugin();

  plugin.init(ctx);

  const startDecision = plugin.onRoomStart(ctx);
  assert.equal(startDecision.type, 'fan_out');
  assert.deepEqual(startDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);
  assert.match(startDecision.targets[0].message, /Domain Search/);

  const reviewDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'openai_1',
      response: conceptResponse({
        title: 'Collaborative Makeup Routine Planner',
        oneLiner: 'A makeup planning product that helps users build routines around occasions, budget, and confidence level.',
        targetUser: 'Beauty enthusiasts who want guided routine building rather than product overload.',
        problem: 'People interested in makeup often get overwhelmed by product choice and do not know how to turn looks into repeatable routines.',
        coreValue: 'Turn makeup inspiration into a reusable, confidence-building routine.',
        requiredUserFlows: ['Choose an occasion or outcome', 'Assemble a routine', 'Save and revisit a look'],
        prototypeFocus: ['Routine builder', 'Occasion-based look selection', 'Saved looks library'],
        nonMockFunctionality: ['Save a routine', 'Edit a routine', 'Compare products in a routine'],
        implementationBoundaries: ['Do not build marketplace checkout in v1', 'Do not require social network features in the prototype'],
        risks: ['Could feel too broad without a clear first-use moment'],
        whyThisCouldWin: 'It gives the prototype room a concrete core workflow to design and compare.',
      }),
    },
    {
      agentId: 'claude_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that matches users to makeup routines based on skin tone, comfort level, and event type.',
        targetUser: 'People who want makeup guidance but are intimidated by beauty content.',
        problem: 'Users want specific guidance but struggle to translate general beauty advice into a personal plan.',
        coreValue: 'Give users a personally relevant makeup starting point quickly.',
        requiredUserFlows: ['Answer a short fit quiz', 'See recommended routine', 'Refine or save the routine'],
        prototypeFocus: ['Fit quiz', 'Recommendation result', 'Routine refinement'],
        nonMockFunctionality: ['Persist quiz answers', 'Save recommendation', 'Adjust recommendation inputs'],
        implementationBoundaries: ['Do not build real-time face analysis in v1'],
        risks: ['Could feel too wizard-driven if the payoff is weak'],
        whyThisCouldWin: 'It creates a clear first-run prototype experience with a strong recommendation moment.',
      }),
    },
    {
      agentId: 'gemini_1',
      response: conceptResponse({
        title: 'Makeup Capsule Builder',
        oneLiner: 'A product that helps users build a minimal makeup kit with routines for a few repeatable looks.',
        targetUser: 'Users who want a smaller, more intentional makeup setup.',
        problem: 'People buy too many products without understanding the smallest effective set for their goals.',
        coreValue: 'Reduce makeup complexity into a compact, useful kit and a few repeatable looks.',
        requiredUserFlows: ['Define the looks you need', 'Build a capsule kit', 'See which products map to which looks'],
        prototypeFocus: ['Capsule builder', 'Look-to-product mapping', 'Kit summary'],
        nonMockFunctionality: ['Save capsule', 'Edit capsule', 'Map one product to multiple looks'],
        implementationBoundaries: ['Do not build inventory sync in v1'],
        risks: ['May feel too utilitarian if the look payoff is not visible'],
        whyThisCouldWin: 'It creates a constrained prototype surface with strong product logic.',
      }),
    },
  ]);

  assert.equal(reviewDecision.type, 'fan_out');
  assert.deepEqual(reviewDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);
  assert.match(reviewDecision.targets[0].message, /Makeup Fit Advisor/);
  assert.match(reviewDecision.targets[0].message, /Makeup Capsule Builder/);
  assert.doesNotMatch(reviewDecision.targets[0].message, /Collaborative Makeup Routine Planner/);

  const refineDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'openai_1',
      response: [
        '## Target: claude',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong first-run recommendation moment.',
        '### Must Change',
        '- Clarify what happens after the recommendation so the prototype has staying power.',
        '### Risks',
        '- Could feel too wizard-heavy.',
        '### Why It Wins Or Loses',
        '- Best immediate prototype hook.',
        '',
        '## Target: gemini',
        '### Score',
        '- 7',
        '### Keep',
        '- Constrained product logic.',
        '### Must Change',
        '- Make the user payoff more visible.',
        '### Risks',
        '- Could feel dry.',
        '### Why It Wins Or Loses',
        '- Strong structure but weaker emotional hook.',
      ].join('\n'),
    },
    {
      agentId: 'claude_1',
      response: [
        '## Target: openai',
        '### Score',
        '- 8',
        '### Keep',
        '- Strong reusable workflow.',
        '### Must Change',
        '- Narrow the first-run moment.',
        '### Risks',
        '- Could feel too broad.',
        '### Why It Wins Or Loses',
        '- Good product depth, weaker immediate entry.',
        '',
        '## Target: gemini',
        '### Score',
        '- 7',
        '### Keep',
        '- Clear kit logic.',
        '### Must Change',
        '- Make the concept feel more aspirational.',
        '### Risks',
        '- Could feel utilitarian.',
        '### Why It Wins Or Loses',
        '- Strong logic, weaker magic.',
      ].join('\n'),
    },
    {
      agentId: 'gemini_1',
      response: [
        '## Target: openai',
        '### Score',
        '- 8',
        '### Keep',
        '- Strong repeatable routine framing.',
        '### Must Change',
        '- Sharpen the initial selection flow.',
        '### Risks',
        '- Scope may sprawl.',
        '### Why It Wins Or Loses',
        '- Good retention logic, less immediate than Claude.',
        '',
        '## Target: claude',
        '### Score',
        '- 9',
        '### Keep',
        '- Very clear seed for a prototype room.',
        '### Must Change',
        '- Ensure the recommendation result leads into something editable and saveable.',
        '### Risks',
        '- If refinement is weak, the concept stalls after first run.',
        '### Why It Wins Or Loses',
        '- Best current prototype starter concept.',
      ].join('\n'),
    },
  ]);

  assert.equal(refineDecision.type, 'fan_out');
  assert.deepEqual(refineDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);
  assert.match(refineDecision.targets[0].message, /Current selected concept:/);
  assert.match(refineDecision.targets[0].message, /Makeup Fit Advisor/);
  assert.match(refineDecision.targets[0].message, /Keep the underlying business and product thesis fixed\./);

  const secondReviewDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'openai_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that quickly recommends a starter routine and makes it easy to refine and save.',
        targetUser: 'People who want makeup guidance but are intimidated by beauty content.',
        problem: 'Users want specific guidance and need a clear path from recommendation into an editable routine.',
        coreValue: 'Give users a confident starting point, then let them shape it into a saved routine.',
        requiredUserFlows: ['Answer a short fit quiz', 'Review recommendation', 'Refine products and save routine'],
        prototypeFocus: ['Quiz', 'Result explanation', 'Routine editor'],
        nonMockFunctionality: ['Persist quiz answers', 'Save a routine', 'Edit recommendation inputs'],
        implementationBoundaries: ['Do not build real-time face analysis in v1', 'Do not add marketplace checkout in v1'],
        risks: ['Could still feel too wizard-heavy if editing is weak'],
        whyThisCouldWin: 'It keeps the strongest first-run hook while making the post-recommendation loop much clearer.',
      }),
    },
    {
      agentId: 'claude_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that personalizes a makeup routine and carries the user into a routine they can refine, save, and revisit.',
        targetUser: 'People who want makeup guidance but are intimidated by beauty content.',
        problem: 'Users need a personally relevant starting point plus a believable path to editing and saving the result.',
        coreValue: 'Make makeup advice feel personal, actionable, and reusable.',
        requiredUserFlows: ['Answer a short fit quiz', 'See the recommendation', 'Edit the routine', 'Save and revisit later'],
        prototypeFocus: ['Quiz flow', 'Recommendation result', 'Editable saved routine'],
        nonMockFunctionality: ['Persist quiz answers', 'Save recommendation', 'Edit routine inputs'],
        implementationBoundaries: ['Do not build face analysis', 'Do not add social network features'],
        risks: ['If the routine editor is too weak, the concept still stalls after first run'],
        whyThisCouldWin: 'It sharpens the exact post-recommendation behavior reviewers wanted without changing the thesis.',
      }),
    },
    {
      agentId: 'gemini_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that matches users to a starter routine, then helps them refine it into a saved personal plan.',
        targetUser: 'People who want makeup guidance but are intimidated by beauty content.',
        problem: 'Users want recommendation plus confidence that they can adjust the outcome to fit their real needs.',
        coreValue: 'Give users a personal recommendation and an easy refinement path.',
        requiredUserFlows: ['Take fit quiz', 'Review recommendation', 'Adjust routine', 'Save routine'],
        prototypeFocus: ['Recommendation moment', 'Adjustable routine', 'Saved plan'],
        nonMockFunctionality: ['Persist quiz answers', 'Save routine', 'Adjust recommendation inputs'],
        implementationBoundaries: ['Do not build real-time face analysis in v1'],
        risks: ['Could become too utilitarian if the result screen feels flat'],
        whyThisCouldWin: 'It stays inside the winning concept while improving the execution details that matter for prototyping.',
      }),
    },
  ]);

  assert.equal(secondReviewDecision.type, 'fan_out');
  assert.deepEqual(secondReviewDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);

  const stopDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'openai_1',
      response: [
        '## Target: claude',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong recommendation-to-editor flow.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Strongest current refinement.',
        '',
        '## Target: gemini',
        '### Score',
        '- 8',
        '### Keep',
        '- Clear saved-plan framing.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- Result screen may need more emotion.',
        '### Why It Wins Or Loses',
        '- Very close, slightly less polished.',
      ].join('\n'),
    },
    {
      agentId: 'claude_1',
      response: [
        '## Target: openai',
        '### Score',
        '- 8',
        '### Keep',
        '- Strong route from recommendation into editing.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Strong refinement, slightly less complete than the leader.',
        '',
        '## Target: gemini',
        '### Score',
        '- 8',
        '### Keep',
        '- Good saved-plan framing.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Solid refinement, not as crisp as the leader.',
      ].join('\n'),
    },
    {
      agentId: 'gemini_1',
      response: [
        '## Target: openai',
        '### Score',
        '- 8',
        '### Keep',
        '- Good editability framing.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Strong, but a little less cohesive than the leader.',
        '',
        '## Target: claude',
        '### Score',
        '- 9',
        '### Keep',
        '- Best balance of recommendation, editing, and saved routine.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Best current refinement.',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

  const finalState = ctx.getState();
  assert.equal(finalState.phase, 'complete');
  assert.equal(finalState.cycleCount, 2);
  assert.equal(finalState.synthesis.selected.conceptKey, 'claude');
  assert.equal(ctx._emittedMetrics.at(-1).leaderboardTable.rows[0].concept, 'Makeup Fit Advisor');

  const finalReport = plugin.getFinalReport(ctx);
  assert.ok(finalReport);
  assert.equal(finalReport.handoffPayloads[0].contract, 'concept_bundle.v1');
  assert.equal(finalReport.handoffPayloads[0].data.selectedConcept.id, 'claude');
  assert.equal(finalReport.handoffPayloads[0].data.selectedConcept.title, 'Makeup Fit Advisor');
  assert.ok(finalReport.handoffPayloads[0].data.selectedConcept.prototypeFocus.length > 0);
  assert.ok(finalReport.handoffPayloads[0].data.selectedConcept.implementationBoundaries.length > 0);
});

test('explore room ends immediately after review when no one requests refinements', async () => {
  const ctx = makeMockCtx({
    limits: {
      maxCycles: 3,
    },
  });
  const plugin = createPlugin();

  plugin.init(ctx);
  plugin.onRoomStart(ctx);

  await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'openai_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that personalizes a starter makeup routine.',
        targetUser: 'People who want makeup guidance.',
        problem: 'Users want a personal starting point.',
        coreValue: 'Quickly recommend the right routine.',
        requiredUserFlows: ['Take quiz', 'Review recommendation', 'Save routine'],
        prototypeFocus: ['Quiz', 'Result', 'Save'],
        nonMockFunctionality: ['Save recommendation'],
        implementationBoundaries: ['Do not build face analysis'],
        risks: ['Could feel too simple'],
        whyThisCouldWin: 'Strong prototype hook.',
      }),
    },
    {
      agentId: 'claude_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that personalizes a starter makeup routine.',
        targetUser: 'People who want makeup guidance.',
        problem: 'Users want a personal starting point.',
        coreValue: 'Quickly recommend the right routine.',
        requiredUserFlows: ['Take quiz', 'Review recommendation', 'Save routine'],
        prototypeFocus: ['Quiz', 'Result', 'Save'],
        nonMockFunctionality: ['Save recommendation'],
        implementationBoundaries: ['Do not build face analysis'],
        risks: ['Could feel too simple'],
        whyThisCouldWin: 'Strong prototype hook.',
      }),
    },
    {
      agentId: 'gemini_1',
      response: conceptResponse({
        title: 'Makeup Fit Advisor',
        oneLiner: 'A guided advisor that personalizes a starter makeup routine.',
        targetUser: 'People who want makeup guidance.',
        problem: 'Users want a personal starting point.',
        coreValue: 'Quickly recommend the right routine.',
        requiredUserFlows: ['Take quiz', 'Review recommendation', 'Save routine'],
        prototypeFocus: ['Quiz', 'Result', 'Save'],
        nonMockFunctionality: ['Save recommendation'],
        implementationBoundaries: ['Do not build face analysis'],
        risks: ['Could feel too simple'],
        whyThisCouldWin: 'Strong prototype hook.',
      }),
    },
  ]);

  const stopDecision = await plugin.onFanOutComplete(ctx, [
    {
      agentId: 'openai_1',
      response: [
        '## Target: claude',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong concept.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Ready for prototyping.',
        '',
        '## Target: gemini',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong concept.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Ready for prototyping.',
      ].join('\n'),
    },
    {
      agentId: 'claude_1',
      response: [
        '## Target: openai',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong concept.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Ready for prototyping.',
        '',
        '## Target: gemini',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong concept.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Ready for prototyping.',
      ].join('\n'),
    },
    {
      agentId: 'gemini_1',
      response: [
        '## Target: openai',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong concept.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Ready for prototyping.',
        '',
        '## Target: claude',
        '### Score',
        '- 9',
        '### Keep',
        '- Strong concept.',
        '### Must Change',
        '- None.',
        '### Risks',
        '- None.',
        '### Why It Wins Or Loses',
        '- Ready for prototyping.',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });
  assert.equal(ctx.getState().cycleCount, 1);
});

test('explore room supports refine-seeded-concept mode', () => {
  const ctx = makeMockCtx({
    objective: 'A makeup product that helps users build and save event-based routines',
    roomConfig: {
      seedMode: 'Refine Seeded Concept',
    },
  });
  const plugin = createPlugin();

  plugin.init(ctx);
  const startDecision = plugin.onRoomStart(ctx);

  assert.equal(startDecision.type, 'fan_out');
  assert.match(startDecision.targets[0].message, /Refine Seeded Concept/);
  assert.match(startDecision.targets[0].message, /If the seed is already specific, keep the core concept fixed/);
  assert.match(startDecision.targets[0].message, /Treat the seed as an already-selected concept\./);
  assert.match(startDecision.targets[0].message, /identify the product core, required user flows, prototype focus, non-mock functionality, and implementation boundaries/);
});

test('explore room auto-detects specific seeds and shifts into prototype-component refinement', () => {
  const ctx = makeMockCtx({
    objective: 'A makeup product that helps users build and save event-based routines for weddings, work, and nights out.',
    roomConfig: {
      seedMode: 'Auto',
    },
  });
  const plugin = createPlugin();

  plugin.init(ctx);
  const state = ctx.getState();
  assert.equal(state.config.requestedSeedMode, 'auto');
  assert.equal(state.config.seedMode, 'refine_seeded_concept');

  const startDecision = plugin.onRoomStart(ctx);

  assert.equal(startDecision.type, 'fan_out');
  assert.match(startDecision.targets[0].message, /Auto \(detected: Refine Seeded Concept\)/);
  assert.match(startDecision.targets[0].message, /Treat the seed as an already-selected concept\./);
  assert.match(startDecision.targets[0].message, /For fully baked concepts, focus on prototype-driving decomposition/);
});
