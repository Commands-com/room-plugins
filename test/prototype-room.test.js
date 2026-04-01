import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createPlugin } from '../room-plugins/prototype-room/index.js';

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function makeMockCtx(overrides = {}) {
  let state = null;
  let activeFanOut = overrides.activeFanOut || null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Build a prototype for a control room that orchestrates room pipelines',
    participants: overrides.participants || [
      {
        agentId: 'openai_1',
        displayName: 'OpenAI',
        role: 'prototyper',
        profile: { id: 'p1', name: 'GPT-5.4', provider: 'openai', model: 'gpt-5.4' },
      },
      {
        agentId: 'claude_1',
        displayName: 'Claude',
        role: 'prototyper',
        profile: { id: 'p2', name: 'Claude 4.6 Opus', provider: 'anthropic', model: 'claude-opus-4.6' },
      },
      {
        agentId: 'gemini_1',
        displayName: 'Gemini',
        role: 'prototyper',
        profile: { id: 'p3', name: 'Gemini 2.5 Pro', provider: 'google', model: 'gemini-2.5-pro' },
      },
    ],
    roomConfig: {
      readmeFileName: 'README.md',
      ...(overrides.roomConfig || {}),
    },
    handoffContext: overrides.handoffContext || null,
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
      throw new Error('invokeLLM should not be called in prototype room');
    },
    _setActiveFanOut(nextActiveFanOut) {
      activeFanOut = nextActiveFanOut != null ? JSON.parse(JSON.stringify(nextActiveFanOut)) : null;
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

async function writePrototypeFiles(ctx, prototypeKey, files) {
  const state = ctx.getState();
  const participant = state.participants.find((entry) => entry.prototypeKey === prototypeKey);
  assert.ok(participant, `participant for ${prototypeKey} should exist`);
  await mkdir(participant.prototypeDir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = path.join(participant.prototypeDir, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf8');
    }),
  );
  return participant;
}

function buildConceptBundle() {
  return {
    seed: {
      objective: 'Makeup',
      requestedMode: 'domain_search',
      requestedModeLabel: 'Domain Search',
      resolvedMode: 'domain_search',
      resolvedModeLabel: 'Domain Search',
      guidance: 'Treat the seed as a space to search. Your job is to find the single strongest concept direction worth sending into Prototype Room next.',
    },
    summary: {
      title: 'Makeup Fit Advisor',
      oneLiner: 'A guided advisor that turns a few inputs into a strong personal makeup starting point.',
      recommendedDirection: 'Prototype Makeup Fit Advisor and keep the recommendation-to-routine loop strong.',
    },
    selection: {
      mode: 'room_default',
      conceptId: 'claude',
      conceptTitle: 'Makeup Fit Advisor',
    },
    selectedConcept: {
      id: 'claude',
      title: 'Makeup Fit Advisor',
      oneLiner: 'A guided advisor that turns a few inputs into a strong personal makeup starting point.',
      targetUser: 'Users who want makeup guidance without overwhelming product sprawl.',
      problem: 'Users want specific guidance but struggle to translate general beauty advice into a personal plan.',
      coreValue: 'Give users a personally relevant makeup starting point quickly.',
      requiredUserFlows: ['Answer a short fit quiz', 'Review recommendation', 'Refine or save the routine'],
      prototypeFocus: ['Fit quiz', 'Recommendation result', 'Routine refinement'],
      nonMockFunctionality: ['Save recommendation', 'Edit routine inputs'],
      implementationBoundaries: ['Do not build real-time face analysis in v1'],
      improvementTargets: ['Clarify the post-recommendation editing flow'],
    },
  };
}

test('prototype room runs multi-cycle build, review, synthesize, and improve across per-model folders', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prototype-room-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);

    const startDecision = plugin.onRoomStart(ctx);
    assert.equal(startDecision.type, 'fan_out');
    assert.deepEqual(startDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);
    assert.match(startDecision.targets[0].message, /design quality as part of the competition/i);
    assert.match(startDecision.targets[0].message, /clear aesthetic direction/i);

    const initialState = ctx.getState();
    assert.deepEqual(initialState.participants.map((participant) => participant.prototypeKey), ['openai', 'claude', 'gemini']);
    const seededReadme = await readFile(path.join(outputDir, 'openai', 'README.md'), 'utf8');
    assert.match(seededReadme, /## Prototype Thesis/);
    assert.match(seededReadme, /## What I Built/);
    assert.match(seededReadme, /## Visual Direction/);
    assert.match(seededReadme, /## Interaction Model/);

    await writePrototypeFiles(ctx, 'openai', {
      'README.md': '# OpenAI Prototype\n\nA bold dashboard-first prototype with live pipeline cards.',
      'index.html': '<html><body>OpenAI Prototype</body></html>',
      'hero.png': 'openai preview',
    });
    await writePrototypeFiles(ctx, 'claude', {
      'README.md': '# Claude Prototype\n\nA calmer inspector-first prototype with strong artifact detail.',
      'index.html': '<html><body>Claude Prototype</body></html>',
      'app.js': 'console.log("claude");',
    });
    await writePrototypeFiles(ctx, 'gemini', {
      'README.md': '# Gemini Prototype\n\nA structured workflow-first prototype with stage handoff emphasis.',
      'prototype.txt': 'gemini notes',
    });

    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Built a dashboard-first prototype.\n## Prototype Path\n`openai`\n## Key Files\n- index.html\n## Notes\n- Emphasize at-a-glance pipeline state.' },
      { agentId: 'claude_1', response: '## Result\n- Built an inspector-first prototype.\n## Prototype Path\n`claude`\n## Key Files\n- app.js\n## Notes\n- Focus on artifact depth.' },
      { agentId: 'gemini_1', response: '## Result\n- Built a workflow-first prototype.\n## Prototype Path\n`gemini`\n## Key Files\n- prototype.txt\n## Notes\n- Focus on handoff structure.' },
    ]);

    assert.equal(reviewDecision.type, 'fan_out');
    assert.deepEqual(reviewDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);

    const openaiReviewPrompt = reviewDecision.targets.find((target) => target.agentId === 'openai_1').message;
    assert.match(openaiReviewPrompt, /claude/i);
    assert.match(openaiReviewPrompt, /gemini/i);
    assert.doesNotMatch(openaiReviewPrompt, /### openai/i);

    const improveDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'openai_1',
        response: [
          '## Target: claude',
          '### Score',
          '- 7',
          '### Keep',
          '- The artifact detail is strong.',
          '### Must Change',
          '- Make the main entry point more visual.',
          '### Nice To Have',
          '- Add a compact pipeline overview.',
          '### Risks',
          '- It may feel too dense.',
          '',
          '## Target: gemini',
          '### Score',
          '- 6',
          '### Keep',
          '- The stage model is clear.',
          '### Must Change',
          '- Show what the child room looks like.',
          '### Nice To Have',
          '- Add a more visual stage card.',
          '### Risks',
          '- It may read too abstractly.',
        ].join('\n'),
      },
      {
        agentId: 'claude_1',
        response: [
          '## Target: openai',
          '### Score',
          '- 8',
          '### Keep',
          '- The dashboard has strong energy.',
          '### Must Change',
          '- Add more artifact drill-down.',
          '### Nice To Have',
          '- Clarify halt-state handling.',
          '### Risks',
          '- The current prototype may hide details.',
          '',
          '## Target: gemini',
          '### Score',
          '- 7',
          '### Keep',
          '- The orchestration model is easy to follow.',
          '### Must Change',
          '- Add a stronger visual identity.',
          '### Nice To Have',
          '- Show more real UI.',
          '### Risks',
          '- It may feel too document-like.',
        ].join('\n'),
      },
      {
        agentId: 'gemini_1',
        response: [
          '## Target: openai',
          '### Score',
          '- 8',
          '### Keep',
          '- The pipeline overview feels immediate.',
          '### Must Change',
          '- Make handoff artifacts visible.',
          '### Nice To Have',
          '- Add a stage timeline.',
          '### Risks',
          '- Users may miss why a stage failed.',
          '',
          '## Target: claude',
          '### Score',
          '- 7',
          '### Keep',
          '- The artifact framing is excellent.',
          '### Must Change',
          '- Add a higher-level room overview.',
          '### Nice To Have',
          '- Show status chips in the header.',
          '### Risks',
          '- It may feel too inspectorial.',
        ].join('\n'),
      },
    ]);

    assert.equal(improveDecision.type, 'fan_out');
    assert.deepEqual(improveDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);

    const claudeImprovePrompt = improveDecision.targets.find((target) => target.agentId === 'claude_1').message;
    assert.match(claudeImprovePrompt, /Current leaderboard:/);
    assert.match(claudeImprovePrompt, /Make the main entry point more visual/);
    assert.match(claudeImprovePrompt, /Add a higher-level room overview/);
    assert.match(claudeImprovePrompt, /Rank this cycle:/);
    assert.match(claudeImprovePrompt, /Score gap to leader:/);
    assert.match(claudeImprovePrompt, /claude/i);
    assert.equal(ctx._emittedMetrics.at(-1).leaderboardTable.rows[0].prototype, 'OpenAI');
    assert.equal(ctx._emittedMetrics.at(-1).leaderboardTable.rows[0].rank, '1');

    await writePrototypeFiles(ctx, 'openai', {
      'README.md': '# OpenAI Prototype\n\nNow includes visible handoff artifacts and deeper drill-down.',
      'index.html': '<html><body>OpenAI Prototype v2</body></html>',
      'timeline.md': '# Stage Timeline',
    });
    await writePrototypeFiles(ctx, 'claude', {
      'README.md': '# Claude Prototype\n\nNow includes a clearer overview and a more visual entry point.',
      'index.html': '<html><body>Claude Prototype v2</body></html>',
      'app.js': 'console.log("claude v2");',
      'overview.md': '# Overview',
    });
    await writePrototypeFiles(ctx, 'gemini', {
      'README.md': '# Gemini Prototype\n\nNow includes more visual stage cards and stronger UI grounding.',
      'prototype.txt': 'gemini notes v2',
      'cards.md': '# Stage Cards',
    });

    const secondReviewDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Added artifact drill-down and handoff visibility.\n## Prototype Path\n`openai`\n## Applied Changes\n- Added stage timeline.\n## Deferred\n- None.\n## Open Questions\n- None.' },
      { agentId: 'claude_1', response: '## Result\n- Added a clearer overview and more visual landing view.\n## Prototype Path\n`claude`\n## Applied Changes\n- Added overview.\n## Deferred\n- None.\n## Open Questions\n- None.' },
      { agentId: 'gemini_1', response: '## Result\n- Added more visual UI and stronger child-room presentation.\n## Prototype Path\n`gemini`\n## Applied Changes\n- Added cards.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.equal(secondReviewDecision.type, 'fan_out');
    assert.deepEqual(secondReviewDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);

    const secondImproveDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'openai_1',
        response: [
          '## Target: claude',
          '### Score',
          '- 8',
          '### Keep',
          '- The overview is much clearer now.',
          '### Must Change',
          '- Tighten the first-run explanation.',
          '### Nice To Have',
          '- Add one stronger hero screenshot.',
          '### Risks',
          '- It may still feel slightly dense.',
          '',
          '## Target: gemini',
          '### Score',
          '- 8',
          '### Keep',
          '- The stage cards are more tangible now.',
          '### Must Change',
          '- Show more child-room output detail.',
          '### Nice To Have',
          '- Add one stronger visual anchor.',
          '### Risks',
          '- The overview may still feel abstract to new users.',
        ].join('\n'),
      },
      {
        agentId: 'claude_1',
        response: [
          '## Target: openai',
          '### Score',
          '- 9',
          '### Keep',
          '- The handoff visibility is much stronger now.',
          '### Must Change',
          '- Clarify how failed stages appear in the timeline.',
          '### Nice To Have',
          '- Add one more artifact preview.',
          '### Risks',
          '- None major.',
          '',
          '## Target: gemini',
          '### Score',
          '- 8',
          '### Keep',
          '- The child-room presentation is clearer.',
          '### Must Change',
          '- Make the summary of each stage more immediate.',
          '### Nice To Have',
          '- Add a more opinionated color system.',
          '### Risks',
          '- It could still feel a bit document-heavy.',
        ].join('\n'),
      },
      {
        agentId: 'gemini_1',
        response: [
          '## Target: openai',
          '### Score',
          '- 9',
          '### Keep',
          '- The timeline and artifacts now work well together.',
          '### Must Change',
          '- Add a stronger failure-state legend.',
          '### Nice To Have',
          '- Show one room card expanded by default.',
          '### Risks',
          '- The dashboard could still hide some nuance.',
          '',
          '## Target: claude',
          '### Score',
          '- 8',
          '### Keep',
          '- The overview makes the prototype easier to enter.',
          '### Must Change',
          '- Show more live room status context.',
          '### Nice To Have',
          '- Add a more visible top-level navigation frame.',
          '### Risks',
          '- It may still bias toward detail over momentum.',
        ].join('\n'),
      },
    ]);

    assert.equal(secondImproveDecision.type, 'fan_out');
    assert.deepEqual(secondImproveDecision.targets.map((target) => target.agentId), ['openai_1', 'claude_1', 'gemini_1']);
    assert.match(secondImproveDecision.targets[0].message, /Cycle: 2/);

    await writePrototypeFiles(ctx, 'openai', {
      'README.md': '# OpenAI Prototype\n\nNow includes a failure-state legend and stronger artifact previews.',
      'index.html': '<html><body>OpenAI Prototype v3</body></html>',
      'timeline.md': '# Stage Timeline v2',
      'legend.md': '# Failure Legend',
    });
    await writePrototypeFiles(ctx, 'claude', {
      'README.md': '# Claude Prototype\n\nNow includes clearer top-level navigation and live room status framing.',
      'index.html': '<html><body>Claude Prototype v3</body></html>',
      'app.js': 'console.log("claude v3");',
      'overview.md': '# Overview v2',
      'nav.md': '# Navigation',
    });
    await writePrototypeFiles(ctx, 'gemini', {
      'README.md': '# Gemini Prototype\n\nNow includes stronger stage summaries and more grounded child-room output detail.',
      'prototype.txt': 'gemini notes v3',
      'cards.md': '# Stage Cards v2',
      'summary.md': '# Stage Summary',
    });

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Added a failure-state legend and stronger artifact previews.\n## Prototype Path\n`openai`\n## Applied Changes\n- Added legend.\n## Deferred\n- None.\n## Open Questions\n- None.' },
      { agentId: 'claude_1', response: '## Result\n- Added clearer navigation and live room status framing.\n## Prototype Path\n`claude`\n## Applied Changes\n- Added nav.\n## Deferred\n- None.\n## Open Questions\n- None.' },
      { agentId: 'gemini_1', response: '## Result\n- Added stronger stage summaries and more grounded child-room detail.\n## Prototype Path\n`gemini`\n## Applied Changes\n- Added summary.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'cycle_limit' });

    const finalState = ctx.getState();
    assert.equal(finalState.phase, 'complete');
    assert.equal(finalState.reviewSyntheses.length, 2);
    assert.deepEqual(ctx._cycles, [1, 1, 1, 2, 2]);
    assert.equal(ctx._emittedMetrics.at(-1).currentPhase.active, 'complete');
    assert.equal(ctx._emittedMetrics.at(-1).finalArtifacts.blocks.length, 5);

    const claudeReadme = await readFile(path.join(outputDir, 'claude', 'README.md'), 'utf8');
    assert.match(claudeReadme, /live room status framing/i);
    assert.equal(await pathExists(path.join(outputDir, '.commands-preview')), false);

    const finalReport = plugin.getFinalReport(ctx);
    assert.ok(finalReport);
    assert.equal(finalReport.handoffPayloads[0].contract, 'prototype_bundle.v1');
    assert.equal(finalReport.handoffPayloads[0].data.summary.title, 'OpenAI Prototype');
    assert.match(finalReport.handoffPayloads[0].data.summary.recommendedDirection, /OpenAI/i);
    assert.equal(finalReport.handoffPayloads[0].data.prototypes.length, 3);
    const openaiPrototype = finalReport.handoffPayloads[0].data.prototypes.find((prototype) => prototype.id === 'openai');
    assert.equal(openaiPrototype.entryHtmlPath, path.join(outputDir, 'openai', 'index.html'));
    assert.equal(openaiPrototype.previewImagePath, path.join(outputDir, 'openai', 'hero.png'));
    assert.equal(openaiPrototype.previewPath, path.join(outputDir, 'openai', 'hero.png'));
    const claudePrototype = finalReport.handoffPayloads[0].data.prototypes.find((prototype) => prototype.id === 'claude');
    assert.equal(claudePrototype.entryHtmlPath, path.join(outputDir, 'claude', 'index.html'));
    const expectedClaudePreviewPath = path.join(outputDir, '.commands-preview', 'claude', 'index.html.png');
    if (claudePrototype.previewImagePath) {
      assert.equal(claudePrototype.previewImagePath, expectedClaudePreviewPath);
      assert.equal(claudePrototype.previewPath, expectedClaudePreviewPath);
    } else {
      assert.equal(claudePrototype.previewPath, path.join(outputDir, 'claude', 'index.html'));
    }
    assert.equal(await pathExists(path.join(outputDir, 'claude', '.commands-preview')), false);
    assert.equal(finalReport.handoffPayloads[0].data.leaderboard[0].prototypeTitle, 'OpenAI');
    assert.ok(finalReport.handoffPayloads[0].data.artifacts.some((artifact) => artifact.kind === 'html'));
    assert.ok(finalReport.artifacts.some((artifact) => artifact.type === 'html'));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('prototype room requires an output directory from room setup', () => {
  const ctx = makeMockCtx();
  const plugin = createPlugin();

  plugin.init(ctx);
  const decision = plugin.onRoomStart(ctx);

  assert.deepEqual(decision, { type: 'stop', reason: 'missing_output_directory' });
});

test('prototype room keeps all prototypes focused on the selected inbound concept', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prototype-room-concept-handoff-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
      },
      handoffContext: {
        payloads: [
          { contract: 'concept_bundle.v1', data: buildConceptBundle() },
        ],
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const state = ctx.getState();
    assert.equal(state.conceptContext.selectedConcept.title, 'Makeup Fit Advisor');
    assert.match(state.feedEntries.at(-1).content, /Selected inbound concept: Makeup Fit Advisor \(claude\)\./);

    const startDecision = plugin.onRoomStart(ctx);
    assert.equal(startDecision.type, 'fan_out');
    assert.match(startDecision.targets[0].message, /Seed concept context:/);
    assert.match(startDecision.targets[0].message, /Selected concept: Makeup Fit Advisor \(claude\)/);
    assert.match(startDecision.targets[0].message, /Explore-room interpretation: Domain Search/);
    assert.match(startDecision.targets[0].message, /All prototypes in this room must stay within this selected concept\./);
    assert.match(startDecision.targets[0].message, /Do not invent a different business or product thesis\./);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('prototype room prefers an explicit summary entry point and falls back to index.html when metadata is missing', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prototype-room-entrypoint-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    plugin.onRoomStart(ctx);

    await writePrototypeFiles(ctx, 'openai', {
      'README.md': [
        '# OpenAI Prototype',
        '',
        'A strong prototype with an explicit non-index entry point.',
        '',
        '## Entry Point',
        '- app/main.html',
      ].join('\n'),
      'index.html': '<html><body>fallback</body></html>',
      'app/main.html': '<html><body>canonical</body></html>',
    });
    await writePrototypeFiles(ctx, 'claude', {
      'README.md': '# Claude Prototype\n\nA strong prototype with the default index fallback.',
      'index.html': '<html><body>claude</body></html>',
    });
    await writePrototypeFiles(ctx, 'gemini', {
      'README.md': '# Gemini Prototype\n\nA text-only prototype for now.',
      'notes.md': '# Notes',
    });

    await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Built the prototype.\n## Prototype Path\n`openai`\n## Entry Point\n- app/main.html\n## Key Files\n- app/main.html\n## Notes\n- Explicit entry point.' },
      { agentId: 'claude_1', response: '## Result\n- Built the prototype.\n## Prototype Path\n`claude`\n## Entry Point\n- index.html\n## Key Files\n- index.html\n## Notes\n- Default entry point.' },
      { agentId: 'gemini_1', response: '## Result\n- Built the prototype.\n## Prototype Path\n`gemini`\n## Entry Point\n- None.\n## Key Files\n- notes.md\n## Notes\n- No HTML yet.' },
    ]);

    const state = ctx.getState();
    assert.equal(state.snapshots.openai_1.entryHtmlPath, path.join(outputDir, 'openai', 'app', 'main.html'));
    assert.equal(state.snapshots.claude_1.entryHtmlPath, path.join(outputDir, 'claude', 'index.html'));
    assert.equal(state.snapshots.gemini_1.entryHtmlPath, '');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('prototype room de-duplicates provider folder names when two participants share the same family', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prototype-room-slugs-'));

  try {
    const ctx = makeMockCtx({
      participants: [
        {
          agentId: 'openai_1',
          displayName: 'OpenAI One',
          role: 'prototyper',
          profile: { id: 'p1', name: 'GPT-5.4', provider: 'openai', model: 'gpt-5.4' },
        },
        {
          agentId: 'openai_2',
          displayName: 'OpenAI Two',
          role: 'prototyper',
          profile: { id: 'p2', name: 'GPT-5.4-Mini', provider: 'openai', model: 'gpt-5.4-mini' },
        },
        {
          agentId: 'claude_1',
          displayName: 'Claude',
          role: 'prototyper',
          profile: { id: 'p3', name: 'Claude 4.6 Opus', provider: 'anthropic', model: 'claude-opus-4.6' },
        },
      ],
      roomConfig: {
        outputDir,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const state = ctx.getState();

    assert.deepEqual(state.participants.map((participant) => participant.prototypeKey), ['openai', 'openai-2', 'claude']);
    assert.equal(state.participants[1].prototypeDir, path.join(outputDir, 'openai-2'));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('prototype room prefers the roster display label over the underlying provider family for naming', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prototype-room-display-label-'));

  try {
    const ctx = makeMockCtx({
      participants: [
        {
          agentId: 'openai_1',
          displayName: 'OpenAI',
          role: 'prototyper',
          profile: { id: 'p1', name: 'GPT-5.4', provider: 'openai', model: 'gpt-5.4' },
        },
        {
          agentId: 'claude_1',
          displayName: 'Claude',
          role: 'prototyper',
          profile: { id: 'p2', name: 'GPT-5.4', provider: 'openai', model: 'gpt-5.4' },
        },
        {
          agentId: 'gemini_1',
          displayName: 'Gemini',
          role: 'prototyper',
          profile: { id: 'p3', name: 'Gemini 2.5 Pro', provider: 'google', model: 'gemini-2.5-pro' },
        },
      ],
      roomConfig: {
        outputDir,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const state = ctx.getState();

    assert.deepEqual(state.participants.map((participant) => participant.prototypeKey), ['openai', 'claude', 'gemini']);
    assert.equal(state.participants[1].prototypeDir, path.join(outputDir, 'claude'));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('prototype room stops after an improve pass once reviewers stop asking for material changes', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prototype-room-converged-'));

  try {
    const ctx = makeMockCtx({
      participants: [
        {
          agentId: 'openai_1',
          displayName: 'OpenAI',
          role: 'prototyper',
          profile: { id: 'p1', name: 'GPT-5.4', provider: 'openai', model: 'gpt-5.4' },
        },
        {
          agentId: 'claude_1',
          displayName: 'Claude',
          role: 'prototyper',
          profile: { id: 'p2', name: 'Claude 4.6 Opus', provider: 'anthropic', model: 'claude-opus-4.6' },
        },
      ],
      roomConfig: {
        outputDir,
      },
      limits: {
        maxCycles: 4,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const startDecision = plugin.onRoomStart(ctx);
    assert.equal(startDecision.type, 'fan_out');

    await writePrototypeFiles(ctx, 'openai', {
      'README.md': '# OpenAI Prototype\n\nFirst pass.',
      'index.html': '<html><body>OpenAI v1</body></html>',
    });
    await writePrototypeFiles(ctx, 'claude', {
      'README.md': '# Claude Prototype\n\nFirst pass.',
      'index.html': '<html><body>Claude v1</body></html>',
    });

    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Built the first OpenAI prototype.\n## Prototype Path\n`openai`\n## Key Files\n- index.html\n## Notes\n- First version.' },
      { agentId: 'claude_1', response: '## Result\n- Built the first Claude prototype.\n## Prototype Path\n`claude`\n## Key Files\n- index.html\n## Notes\n- First version.' },
    ]);
    assert.equal(reviewDecision.type, 'fan_out');

    const improveDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'openai_1',
        response: [
          '## Target: claude',
          '### Score',
          '- 7',
          '### Keep',
          '- The overall structure is clear.',
          '### Must Change',
          '- Make the first screen more opinionated.',
          '### Nice To Have',
          '- Add a stronger room summary.',
          '### Risks',
          '- It may feel too flat.',
        ].join('\n'),
      },
      {
        agentId: 'claude_1',
        response: [
          '## Target: openai',
          '### Score',
          '- 7',
          '### Keep',
          '- The prototype feels tangible.',
          '### Must Change',
          '- Clarify the main flow at a glance.',
          '### Nice To Have',
          '- Add one stronger summary panel.',
          '### Risks',
          '- The flow may still feel scattered.',
        ].join('\n'),
      },
    ]);
    assert.equal(improveDecision.type, 'fan_out');

    await writePrototypeFiles(ctx, 'openai', {
      'README.md': '# OpenAI Prototype\n\nSecond pass with a clearer main flow.',
      'index.html': '<html><body>OpenAI v2</body></html>',
    });
    await writePrototypeFiles(ctx, 'claude', {
      'README.md': '# Claude Prototype\n\nSecond pass with a more opinionated first screen.',
      'index.html': '<html><body>Claude v2</body></html>',
    });

    const secondReviewDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Tightened the main flow and summary.\n## Prototype Path\n`openai`\n## Applied Changes\n- Improved clarity.\n## Deferred\n- None.\n## Open Questions\n- None.' },
      { agentId: 'claude_1', response: '## Result\n- Made the first screen more opinionated.\n## Prototype Path\n`claude`\n## Applied Changes\n- Improved entry point.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);
    assert.equal(secondReviewDecision.type, 'fan_out');

    const finalImproveDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'openai_1',
        response: [
          '## Target: claude',
          '### Score',
          '- 9',
          '### Keep',
          '- The first screen is much stronger now.',
          '### Must Change',
          '- None.',
          '### Nice To Have',
          '- Add a little more polish.',
          '### Risks',
          '- None.',
        ].join('\n'),
      },
      {
        agentId: 'claude_1',
        response: [
          '## Target: openai',
          '### Score',
          '- 9',
          '### Keep',
          '- The main flow is much easier to understand now.',
          '### Must Change',
          '- None.',
          '### Nice To Have',
          '- Add a small amount of polish.',
          '### Risks',
          '- None.',
        ].join('\n'),
      },
    ]);
    assert.equal(finalImproveDecision.type, 'fan_out');

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'openai_1', response: '## Result\n- Added final polish only.\n## Prototype Path\n`openai`\n## Applied Changes\n- Minor polish.\n## Deferred\n- None.\n## Open Questions\n- None.' },
      { agentId: 'claude_1', response: '## Result\n- Added final polish only.\n## Prototype Path\n`claude`\n## Applied Changes\n- Minor polish.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });
    assert.equal(ctx.getState().phase, 'complete');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
