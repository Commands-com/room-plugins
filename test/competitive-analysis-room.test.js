import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createPlugin } from '../room-plugins/competitive-analysis-room/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  let activeFanOut = overrides.activeFanOut || null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Analyze the competitive landscape for our team collaboration SaaS',
    participants: overrides.participants || [
      { agentId: 'analyst_1', displayName: 'Analyst', role: 'analyst' },
      { agentId: 'strategist_1', displayName: 'Strategist', role: 'strategist' },
      { agentId: 'critic_1', displayName: 'Critic', role: 'critic' },
    ],
    roomConfig: {
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
      throw new Error('invokeLLM should not be called in competitive analysis room');
    },
    _setActiveFanOut(nextActiveFanOut) {
      activeFanOut = nextActiveFanOut != null ? JSON.parse(JSON.stringify(nextActiveFanOut)) : null;
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

test('competitive analysis room writes, reviews, and emits a bundle', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'competitive-project-'));
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'competitive-output-'));

  try {
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await writeFile(path.join(projectDir, 'README.md'), '# TeamSignal\n\nA team collaboration SaaS for async check-ins and weekly planning.', 'utf8');
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'teamsignal',
      description: 'Async team planning and check-ins',
      keywords: ['team', 'planning', 'async'],
    }, null, 2), 'utf8');

    const ctx = makeMockCtx({
      roomConfig: {
        projectDir,
        outputDir,
        fileName: 'competitive-analysis.md',
        marketFocus: 'B2B team collaboration',
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const startDecision = plugin.onRoomStart(ctx);

    assert.equal(startDecision.type, 'fan_out');
    assert.deepEqual(startDecision.targets.map((target) => target.agentId), ['analyst_1']);
    assert.match(startDecision.targets[0].message, /Project directory:/);
    assert.match(startDecision.targets[0].message, /README excerpt:/);

    const analysisPath = path.join(outputDir, 'competitive-analysis.md');
    await writeFile(analysisPath, [
      '# TeamSignal Competitive Analysis',
      '',
      '## Executive Summary',
      'TeamSignal looks like an async planning and check-in product entering a crowded but still differentiable space.',
      '',
      '## Product Read',
      'The project appears to focus on async planning, weekly check-ins, and lightweight coordination for teams.',
      '',
      '## Competitor Set',
      '- Range',
      '- Fellow',
      '- Basecamp',
      '',
      '## Positioning Gap',
      'There is room for a more founder-friendly, premium, less enterprise-heavy angle around clear weekly operating rhythms.',
      '',
      '## Likely Acquisition Channels',
      '- SEO around async planning and check-ins',
      '- Founder-led social content',
      '- Integration/directories',
      '',
      '## Messaging Strengths',
      '- Competitors often explain category pain well.',
      '',
      '## Messaging Weaknesses',
      '- Many competitors sound generic and team-productivity-blurry.',
      '',
      '## Patterns To Avoid',
      '- Do not sound like another all-in-one productivity suite.',
      '',
      '## Recommended Positioning',
      'Position TeamSignal as the premium weekly operating system for small high-output teams.',
      '',
      '## Recommended Moves',
      '- Lean into founder credibility',
      '- Build comparison pages',
      '',
      '## Risks',
      '- Competitor set still needs live validation.',
      '',
      '## Open Questions',
      '- Which competitor owns the strongest search footprint?',
      '',
    ].join('\n'), 'utf8');

    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'analyst_1',
        response: [
          '## Result',
          '- Wrote the analysis.',
          '## Analysis Path',
          `\`${analysisPath}\``,
          '## Key Calls',
          '- Range, Fellow, and Basecamp are the main reference points.',
          '## Notes',
          '- Review the acquisition-channel inference.',
        ].join('\n'),
      },
    ]);

    assert.equal(reviewDecision.type, 'fan_out');
    assert.deepEqual(reviewDecision.targets.map((target) => target.agentId), ['strategist_1', 'critic_1']);

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'strategist_1',
        response: [
          '## Overall',
          '- Strong draft.',
          '## Keep',
          '- The premium positioning angle.',
          '## Must Change',
          '- None.',
          '## Risks',
          '- None.',
          '## Opportunities',
          '- Add one stronger marketing move around founder-led content.',
        ].join('\n'),
      },
      {
        agentId: 'critic_1',
        response: [
          '## Overall',
          '- Strong and usable.',
          '## Keep',
          '- Clear positioning gap.',
          '## Must Change',
          '- None.',
          '## Risks',
          '- Competitor inference remains directional.',
          '## Opportunities',
          '- Sharpen comparison-page recommendations later.',
        ].join('\n'),
      },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

    const finalReport = plugin.getFinalReport(ctx);
    assert.equal(finalReport.handoffPayloads[0].contract, 'competitive_analysis_bundle.v1');
    assert.equal(finalReport.handoffPayloads[0].data.summary.title, 'TeamSignal Competitive Analysis');
    assert.match(finalReport.handoffPayloads[0].data.recommendedPositioning, /premium weekly operating system/i);
    assert.ok(finalReport.handoffPayloads[0].data.competitorSet.length >= 3);
    assert.ok(finalReport.artifacts.some((artifact) => artifact.path === analysisPath));

    const written = await readFile(analysisPath, 'utf8');
    assert.match(written, /## Competitor Set/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});
