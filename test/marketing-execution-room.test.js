import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createPlugin } from '../room-plugins/marketing-execution-room/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  let activeFanOut = overrides.activeFanOut || null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Execute the launch marketing package for TeamSignal',
    participants: overrides.participants || [
      { agentId: 'operator_1', displayName: 'Operator', role: 'operator' },
      { agentId: 'copywriter_1', displayName: 'Copywriter', role: 'copywriter' },
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
      throw new Error('invokeLLM should not be called in marketing execution room');
    },
    _setActiveFanOut(nextActiveFanOut) {
      activeFanOut = nextActiveFanOut != null ? JSON.parse(JSON.stringify(nextActiveFanOut)) : null;
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

test('marketing execution room emits an execution bundle with generated assets', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'marketing-exec-project-'));
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'marketing-exec-output-'));

  try {
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await writeFile(path.join(projectDir, 'README.md'), '# TeamSignal\n\nPremium async planning and weekly operating rhythm software.', 'utf8');

    const ctx = makeMockCtx({
      roomConfig: {
        projectDir,
        outputDir,
        fileName: 'marketing-execution.md',
      },
      handoffContext: {
        payloads: [
          {
            contract: 'marketing_plan_bundle.v1',
            data: {
              summary: {
                title: 'TeamSignal Marketing Plan',
                oneLiner: 'Position TeamSignal as the premium weekly operating system for small high-output teams.',
                recommendedDirection: 'Lead with founder credibility and weekly execution.',
              },
              positioning: 'Premium founder-grade weekly operating rhythm.',
              audience: 'Founders and operators at small high-output teams.',
              channelPriorities: ['Founder-led social', 'Comparison pages'],
              campaignBets: ['Founder manifesto launch'],
              assetPlan: ['Landing page refresh', 'Launch post', 'Email sequence'],
              launchPlan: ['Ship launch post and landing page in the same week'],
              successMetrics: ['Demo requests'],
            },
          },
        ],
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const startDecision = plugin.onRoomStart(ctx);

    assert.equal(startDecision.type, 'fan_out');
    assert.deepEqual(startDecision.targets.map((target) => target.agentId), ['operator_1']);
    assert.match(startDecision.targets[0].message, /Marketing plan context:/);
    assert.match(startDecision.targets[0].message, /Landing page refresh/);

    const summaryPath = path.join(outputDir, 'marketing-execution.md');
    const launchPostPath = path.join(outputDir, 'launch-post.md');
    await writeFile(summaryPath, [
      '# TeamSignal Launch Package',
      '',
      '## Executive Summary',
      'Built the first launch-ready asset package around founder credibility and weekly operating rhythm.',
      '',
      '## Selected Priorities',
      '- Founder-led launch content',
      '- Landing page clarity',
      '',
      '## Asset Inventory',
      '- launch-post.md - Founder launch post for the first announcement wave',
      '',
      '## Messaging Notes',
      '- Lean on premium weekly operating rhythm and founder credibility',
      '',
      '## Launch Checklist',
      '- Finalize launch post',
      '- Publish landing page refresh',
      '',
      '## Risks',
      '- Landing-page copy still needs proof points.',
      '',
      '## Open Questions',
      '- Which customer example should anchor the launch post?',
      '',
    ].join('\n'), 'utf8');
    await writeFile(launchPostPath, '# Launch Post\n\nTeamSignal is the premium weekly operating system for small high-output teams.\n', 'utf8');

    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'operator_1',
        response: [
          '## Result',
          '- Built the initial execution package.',
          '## Summary Path',
          `\`${summaryPath}\``,
          '## Asset Paths',
          `- ${launchPostPath}`,
          '## Notes',
          '- Pressure-test whether the launch post needs more proof.',
        ].join('\n'),
      },
    ]);

    assert.equal(reviewDecision.type, 'fan_out');
    assert.deepEqual(reviewDecision.targets.map((target) => target.agentId), ['copywriter_1', 'critic_1']);

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'copywriter_1',
        response: [
          '## Overall',
          '- Good first execution package.',
          '## Keep',
          '- The messaging is tight.',
          '## Must Change',
          '- None.',
          '## Risks',
          '- None.',
          '## Opportunities',
          '- Add an email sequence in the next pass if needed.',
        ].join('\n'),
      },
      {
        agentId: 'critic_1',
        response: [
          '## Overall',
          '- Launch-ready enough for v1.',
          '## Keep',
          '- Good focus on a small asset set.',
          '## Must Change',
          '- None.',
          '## Risks',
          '- Proof still needs validation.',
          '## Opportunities',
          '- Add more social variants later.',
        ].join('\n'),
      },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

    const finalReport = plugin.getFinalReport(ctx);
    assert.equal(finalReport.handoffPayloads[0].contract, 'marketing_execution_bundle.v1');
    assert.equal(finalReport.handoffPayloads[0].data.summary.title, 'TeamSignal Launch Package');
    assert.ok(finalReport.handoffPayloads[0].data.artifacts.some((artifact) => artifact.path === launchPostPath));
    assert.ok(finalReport.artifacts.some((artifact) => artifact.path === launchPostPath));

    const written = await readFile(summaryPath, 'utf8');
    assert.match(written, /## Asset Inventory/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});
