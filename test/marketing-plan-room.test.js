import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createPlugin } from '../room-plugins/marketing-plan-room/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  let activeFanOut = overrides.activeFanOut || null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Turn our async-team collaboration product into a focused launch marketing plan',
    participants: overrides.participants || [
      { agentId: 'strategist_1', displayName: 'Strategist', role: 'strategist' },
      { agentId: 'growth_1', displayName: 'Growth', role: 'growth' },
      { agentId: 'critic_1', displayName: 'Critic', role: 'critic' },
    ],
    roomConfig: {
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
      throw new Error('invokeLLM should not be called in marketing plan room');
    },
    _setActiveFanOut(nextActiveFanOut) {
      activeFanOut = nextActiveFanOut != null ? JSON.parse(JSON.stringify(nextActiveFanOut)) : null;
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

test('marketing plan room writes, reviews, and emits a bundle', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'marketing-plan-project-'));
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'marketing-plan-output-'));

  try {
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await writeFile(path.join(projectDir, 'README.md'), '# TeamSignal\n\nA premium async planning and team operating rhythm product.', 'utf8');
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'teamsignal',
      description: 'Premium weekly planning and async check-in software',
      keywords: ['team', 'planning', 'async'],
    }, null, 2), 'utf8');

    const ctx = makeMockCtx({
      roomConfig: {
        projectDir,
        outputDir,
        fileName: 'marketing-plan.md',
        marketFocus: 'Founder-led B2B SaaS',
      },
      handoffContext: {
        payloads: [
          {
            contract: 'competitive_analysis_bundle.v1',
            data: {
              summary: {
                title: 'TeamSignal Competitive Analysis',
                oneLiner: 'Premium weekly operating system for small high-output teams.',
                recommendedDirection: 'Lean into founder credibility and weekly operating rhythm.',
              },
              competitorSet: ['Range', 'Fellow', 'Basecamp'],
              positioningGap: 'Founder-friendly premium positioning with clearer weekly operating rhythm.',
              likelyChannels: ['Founder-led social content', 'SEO comparison pages'],
              messagingWeaknesses: ['Competitors sound generic'],
              patternsToAvoid: ['Do not market like an all-in-one suite'],
              recommendedMoves: ['Build comparison pages', 'Ship founder-led launch content'],
            },
          },
        ],
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const startDecision = plugin.onRoomStart(ctx);

    assert.equal(startDecision.type, 'fan_out');
    assert.deepEqual(startDecision.targets.map((target) => target.agentId), ['strategist_1']);
    assert.match(startDecision.targets[0].message, /Competitive analysis context:/);
    assert.match(startDecision.targets[0].message, /Founder-led social content/);

    const planPath = path.join(outputDir, 'marketing-plan.md');
    await writeFile(planPath, [
      '# TeamSignal Marketing Plan',
      '',
      '## Executive Summary',
      'Launch TeamSignal as the premium weekly operating system for small high-output teams.',
      '',
      '## Positioning',
      'Position TeamSignal around founder-caliber weekly execution and async clarity.',
      '',
      '## Audience',
      'Primary buyers are founders and operators at small high-output teams.',
      '',
      '## Messaging Pillars',
      '- Weekly operating rhythm',
      '- Premium founder-grade clarity',
      '',
      '## Channel Priorities',
      '- Founder-led social content',
      '- SEO comparison pages',
      '',
      '## Campaign Bets',
      '- Launch with a founder manifesto',
      '- Publish comparison pages against Range and Fellow',
      '',
      '## Asset Plan',
      '- Landing page refresh',
      '- Launch post',
      '- Email follow-up sequence',
      '',
      '## Launch Plan',
      '- Ship landing page and launch post in the same week',
      '',
      '## Success Metrics',
      '- Demo requests',
      '- Comparison page conversion rate',
      '',
      '## Risks',
      '- Channel effort may spread too wide if launch scope expands.',
      '',
      '## Open Questions',
      '- Which comparison page should ship first?',
      '',
    ].join('\n'), 'utf8');

    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'strategist_1',
        response: [
          '## Result',
          '- Wrote the marketing plan.',
          '## Plan Path',
          `\`${planPath}\``,
          '## Key Calls',
          '- Founder-led social and comparison pages are the opening bets.',
          '## Notes',
          '- Pressure-test whether launch scope is too wide.',
        ].join('\n'),
      },
    ]);

    assert.equal(reviewDecision.type, 'fan_out');
    assert.deepEqual(reviewDecision.targets.map((target) => target.agentId), ['growth_1', 'critic_1']);

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'growth_1',
        response: [
          '## Overall',
          '- Strong and actionable.',
          '## Keep',
          '- Channel prioritization is sharp.',
          '## Must Change',
          '- None.',
          '## Risks',
          '- None.',
          '## Opportunities',
          '- Add a short customer-proof asset later.',
        ].join('\n'),
      },
      {
        agentId: 'critic_1',
        response: [
          '## Overall',
          '- Good v1 plan.',
          '## Keep',
          '- Positioning and asset plan feel aligned.',
          '## Must Change',
          '- None.',
          '## Risks',
          '- Comparison-page sequencing still needs validation.',
          '## Opportunities',
          '- Clarify proof points later.',
        ].join('\n'),
      },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

    const finalReport = plugin.getFinalReport(ctx);
    assert.equal(finalReport.handoffPayloads[0].contract, 'marketing_plan_bundle.v1');
    assert.equal(finalReport.handoffPayloads[0].data.summary.title, 'TeamSignal Marketing Plan');
    assert.match(finalReport.handoffPayloads[0].data.positioning, /founder/i);
    assert.ok(finalReport.handoffPayloads[0].data.channelPriorities.length >= 2);
    assert.ok(finalReport.artifacts.some((artifact) => artifact.path === planPath));

    const written = await readFile(planPath, 'utf8');
    assert.match(written, /## Channel Priorities/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});
