import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { createPlugin } from '../room-plugins/spec-room/index.js';

function makeMockCtx(overrides = {}) {
  let state = null;
  let activeFanOut = overrides.activeFanOut || null;
  const emittedMetrics = [];
  const cycles = [];

  return {
    objective: overrides.objective || 'Build a control room that can orchestrate a sequence of child rooms',
    participants: overrides.participants || [
      { agentId: 'planner_1', displayName: 'Planner', role: 'planner' },
      { agentId: 'critic_1', displayName: 'Critic', role: 'critic' },
      { agentId: 'implementer_1', displayName: 'Implementer', role: 'implementer' },
    ],
    roomConfig: {
      deliverableType: 'Technical Spec',
      audience: 'Engineering',
      detailLevel: 'Detailed',
      mustInclude: ['acceptance criteria', 'implementation plan'],
      knownConstraints: ['first pass only'],
      ...(overrides.roomConfig || {}),
    },
    handoffContext: overrides.handoffContext || null,
    limits: {
      llmTimeoutMs: 1000,
      maxCycles: 4,
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
      throw new Error('invokeLLM should not be called in the file-first spec room flow');
    },
    _setActiveFanOut(nextActiveFanOut) {
      activeFanOut = nextActiveFanOut != null ? JSON.parse(JSON.stringify(nextActiveFanOut)) : null;
    },
    _emittedMetrics: emittedMetrics,
    _cycles: cycles,
  };
}

async function writeCanonicalSpec(ctx, markdown) {
  const state = ctx.getState();
  await writeFile(state.specFilePath, markdown, 'utf8');
  return state.specFilePath;
}

function buildPrototypeBundle() {
  return {
    summary: {
      title: 'Prototype Bundle Ready',
      oneLiner: 'Claude direction is the clearest current landing page concept.',
      recommendedDirection: 'Carry Claude Direction into the next stage.',
    },
    selection: {
      mode: 'human_gate',
      prototypeId: 'claude',
      prototypeTitle: 'Claude Direction',
    },
    prototypes: [
      {
        id: 'claude',
        title: 'Claude Direction',
        directory: '/tmp/prototypes/claude',
        summaryPath: '/tmp/prototypes/claude/README.md',
        status: 'ready',
        summary: 'Editorial, high-trust direction.',
        artifactPaths: ['/tmp/prototypes/claude/index.html'],
        entryHtmlPath: '/tmp/prototypes/claude/index.html',
        previewImagePath: '/tmp/prototypes/claude/preview.png',
      },
      {
        id: 'gemini',
        title: 'Gemini Direction',
        directory: '/tmp/prototypes/gemini',
        summaryPath: '/tmp/prototypes/gemini/README.md',
        status: 'ready',
        summary: 'Sharper developer-tool direction.',
        artifactPaths: ['/tmp/prototypes/gemini/index.html'],
        entryHtmlPath: '/tmp/prototypes/gemini/index.html',
        previewImagePath: '',
      },
    ],
    leaderboard: [
      { rank: 1, prototypeId: 'claude', prototypeTitle: 'Claude Direction', averageScore: 8.8, reviewCount: 2 },
      { rank: 2, prototypeId: 'gemini', prototypeTitle: 'Gemini Direction', averageScore: 8.1, reviewCount: 2 },
    ],
  };
}

function buildSpecMarkdown({
  title = 'Control Room v1: Sequential Room Pipelines',
  summary = 'Control Room v1 should orchestrate a predefined sequence of child rooms and carry report-based handoffs from one stage to the next.',
  problem = 'Teams currently have to manually create each room, copy outputs forward, and keep track of room status by hand.',
  goals = ['Launch and track a predefined sequence of child rooms from one parent room.'],
  nonGoals = ['Parallel room execution in v1.'],
  assumptions = ['Existing room types and report output are sufficient for the first release.'],
  prerequisites = [],
  proposal = ['Add a built-in control room that launches validated child rooms and passes report-based handoffs between them.'],
  acceptanceCriteria = ['A control room can launch at least two sequential child rooms and halt cleanly on failure.'],
  implementationPlan = ['Add parent and child room linkage.', 'Add child room spawning.', 'Add report-based handoff wiring.'],
  risks = ['Report payloads may be too weak for some workflows.'],
  openQuestions = ['Should reports be the only v1 handoff artifact?'],
} = {}) {
  return [
    `# ${title}`,
    '',
    summary,
    '',
    '## Problem',
    problem,
    '',
    '## Goals',
    ...goals.map((item) => `- ${item}`),
    '',
    '## Non-Goals',
    ...nonGoals.map((item) => `- ${item}`),
    '',
    '## Assumptions',
    ...assumptions.map((item) => `- ${item}`),
    '',
    '## Prerequisites',
    ...(prerequisites.length > 0 ? prerequisites.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Proposed Approach',
    ...proposal.map((item) => `- ${item}`),
    '',
    '## Acceptance Criteria',
    ...acceptanceCriteria.map((item) => `- ${item}`),
    '',
    '## Implementation Plan',
    ...implementationPlan.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## Risks',
    ...risks.map((item) => `- ${item}`),
    '',
    '## Open Questions',
    ...openQuestions.map((item) => `- ${item}`),
  ].join('\n');
}

test('spec room runs a write-review-revise-review loop and produces a final spec from the canonical file', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-loop-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1',
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);

    const startDecision = plugin.onRoomStart(ctx);
    assert.equal(startDecision.type, 'fan_out');
    assert.deepEqual(startDecision.targets.map((target) => target.agentId), ['implementer_1']);
    assert.match(startDecision.targets[0].message, /canonical spec file/i);

    const specPath = await writeCanonicalSpec(ctx, buildSpecMarkdown());
    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'implementer_1',
        response: '## Result\n- Wrote the initial spec to disk.\n## File Path\n- control-room-v1.md\n## Highlights\n- Added a concrete v1 scope.\n## Risks\n- Report handoffs may be underspecified.\n## Open Questions\n- Should failure always halt the pipeline?',
      },
    ]);

    assert.equal(reviewDecision.type, 'fan_out');
    assert.deepEqual(reviewDecision.targets.map((target) => target.agentId), ['planner_1', 'critic_1']);

    const afterWrite = ctx.getState();
    assert.equal(afterWrite.phase, 'review');
    assert.equal(afterWrite.draftSpec.title, 'Control Room v1: Sequential Room Pipelines');
    assert.equal(afterWrite.exportedSpecPath, specPath);

    const reviseDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'planner_1',
        response: '## Verdict\nrevise\n## Keep\n- The parent-child framing is clear.\n## Must Change\n- Add explicit acceptance criteria for the parent room status view.\n## Nice To Have\n- Clarify what users see when a child room is waiting.\n## Risks\n- The UX contract is still thin.\n## Open Questions\n- Should the parent room show child room summaries inline?',
      },
      {
        agentId: 'critic_1',
        response: '## Verdict\nrevise\n## Keep\n- Sequential-only scope is the right cut.\n## Must Change\n- Spell out halt behavior on child-room failure.\n## Nice To Have\n- Add a stronger non-goal about nested control rooms.\n## Risks\n- Ambiguity around partial failure could slow implementation.\n## Open Questions\n- Should retries be a non-goal in v1?',
      },
    ]);

    assert.equal(reviseDecision.type, 'fan_out');
    assert.deepEqual(reviseDecision.targets.map((target) => target.agentId), ['implementer_1']);
    assert.match(reviseDecision.targets[0].message, /Reviewer feedback/i);
    assert.match(reviseDecision.targets[0].message, /Add explicit acceptance criteria for the parent room status view/);
    assert.doesNotMatch(reviseDecision.targets[0].message, /\(none yet\)/i);

    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      prerequisites: [
        'Extend the host room runtime so a parent room can launch child rooms programmatically.',
      ],
      acceptanceCriteria: [
        'A control room can launch at least two sequential child rooms and halt cleanly on failure.',
        'The parent room status clearly shows which child room is active, completed, or failed.',
      ],
      proposal: [
        'Add a built-in control room that launches validated child rooms and passes report-based handoffs between them.',
        'Persist halt behavior and parent-child status so the parent room can explain why the pipeline stopped.',
      ],
      risks: [
        'Report payloads may be too weak for some workflows.',
        'Parent-room status design could drift without a narrow v1 contract.',
      ],
      openQuestions: [
        'Should reports be the only v1 handoff artifact?',
        'How should child-room summaries appear in the parent room UI?',
      ],
    }));

    const secondReviewDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'implementer_1',
        response: '## Result\n- Updated the canonical spec with the required reviewer changes.\n## File Path\n- control-room-v1.md\n## Applied Changes\n- Added explicit halt behavior and status visibility.\n## Deferred\n- Retry semantics remain out of scope.\n## Open Questions\n- None beyond the spec itself.',
      },
    ]);

    assert.equal(secondReviewDecision.type, 'fan_out');
    assert.deepEqual(secondReviewDecision.targets.map((target) => target.agentId), ['planner_1', 'critic_1']);

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'planner_1',
        response: '## Verdict\napprove\n## Keep\n- The spec now explains user-visible parent-room status clearly.\n## Must Change\n## Nice To Have\n- None for v1.\n## Risks\n- None beyond those already stated.\n## Open Questions\n- None.',
      },
      {
        agentId: 'critic_1',
        response: '## Verdict\napprove\n## Keep\n- Halt behavior is now concrete.\n## Must Change\n## Nice To Have\n- None for v1.\n## Risks\n- None beyond those already stated.\n## Open Questions\n- None.',
      },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

    const finalState = ctx.getState();
    assert.equal(finalState.phase, 'complete');
    assert.equal(finalState.finalSpec.prerequisites.length, 1);
    assert.equal(finalState.finalSpec.acceptanceCriteria.length, 2);
    assert.equal(finalState.exportedSpecPath, specPath);
    assert.deepEqual(ctx._cycles, [1, 2, 3, 4]);
    assert.equal(ctx._emittedMetrics.at(-1).currentPhase.active, 'complete');

    const savedContent = await readFile(specPath, 'utf8');
    assert.match(savedContent, /## Prerequisites/);
    assert.match(savedContent, /launch child rooms programmatically/);
    assert.match(savedContent, /The parent room status clearly shows which child room is active/);

    const finalReport = plugin.getFinalReport(ctx);
    assert.ok(finalReport);
    assert.equal(finalReport.handoffPayloads[0].contract, 'spec_bundle.v1');
    assert.equal(finalReport.handoffPayloads[0].data.summary.title, 'Control Room v1: Sequential Room Pipelines');
    assert.match(finalReport.handoffPayloads[0].data.summary.recommendedDirection, /built-in control room/i);
    assert.equal(finalReport.handoffPayloads[0].data.spec.acceptanceCriteria.length, 2);
    assert.equal(finalReport.handoffPayloads[0].data.artifacts[0].path, specPath);
    assert.equal(finalReport.artifacts[0].path, specPath);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room carries selected prototype handoff context into the authoring prompt', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-prototype-handoff-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1',
      },
      handoffContext: {
        payloads: [
          { contract: 'prototype_bundle.v1', data: buildPrototypeBundle() },
        ],
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    const initialState = ctx.getState();
    assert.equal(initialState.prototypeContext.selectedPrototype.id, 'claude');
    assert.match(initialState.feedEntries.at(-1).content, /Selected inbound prototype: Claude Direction \(claude\)/);

    const startDecision = plugin.onRoomStart(ctx);
    assert.equal(startDecision.type, 'fan_out');
    assert.match(startDecision.targets[0].message, /Selected prototype: Claude Direction \(claude\)/);
    assert.match(startDecision.targets[0].message, /HTML entry point: \/tmp\/prototypes\/claude\/index\.html/);
    assert.match(startDecision.targets[0].message, /Carry-forward guidance: Carry Claude Direction into the next stage\./);
    assert.match(startDecision.targets[0].message, /Use the prototype to inform the spec, not to define the implementation blindly\./);
    assert.match(startDecision.targets[0].message, /Define the non-mock functionality the shipped system must deliver\./);
    assert.match(startDecision.targets[0].message, /3-5 cycles for a small\/single-flow build/i);
    assert.match(startDecision.targets[0].message, /10-14 cycles for a larger multi-flow build/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room reinforces prototype influence boundaries in the normalized final spec', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-prototype-boundaries-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1',
      },
      handoffContext: {
        payloads: [
          { contract: 'prototype_bundle.v1', data: buildPrototypeBundle() },
        ],
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    plugin.onRoomStart(ctx);

    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      proposal: [
        'Add a built-in control room that launches validated child rooms and passes report-based handoffs between them.',
      ],
      acceptanceCriteria: [
        'A control room can launch at least two sequential child rooms and halt cleanly on failure.',
      ],
    }));

    await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'implementer_1',
        response: '## Result\n- Wrote the initial spec to disk.\n## File Path\n- control-room-v1.md\n## Highlights\n- Added a concrete v1 scope.\n## Risks\n- Report handoffs may be underspecified.\n## Open Questions\n- Should failure always halt the pipeline?',
      },
    ]);

    const state = ctx.getState();
    assert.ok(state.draftSpec.proposal.some((item) => /prototype/i.test(item) && /implementation boundaries/i.test(item)));
    assert.ok(state.draftSpec.acceptanceCriteria.some((item) => /prototype/i.test(item) && /implementation artifact/i.test(item)));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room emits implementation cycle guidance in the spec bundle', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-implementation-hints-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'full-saas-v1',
      },
      objective: 'Build a credible SaaS product with auth, billing, dashboard workflows, and persistent user data.',
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    plugin.onRoomStart(ctx);

    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      title: 'Full SaaS v1',
      summary: 'Define the first real version of a SaaS business with real authentication, billing, and dashboard flows.',
      goals: [
        'Launch a public marketing site and signed-in product shell.',
        'Support account creation, login, and role-aware access.',
        'Persist user data and workspace state.',
      ],
      prerequisites: [
        'Add backend persistence for accounts, workspaces, and product data.',
        'Integrate billing and subscription state into the account model.',
      ],
      proposal: [
        'Build a real account system with signup, login, and role-aware dashboard routing.',
        'Implement persistent workspace state and API-backed product flows rather than frontend-only mock data.',
        'Integrate subscription billing and settings management into the core product.',
      ],
      acceptanceCriteria: [
        'A user can sign up, log in, and reach an authenticated dashboard.',
        'Workspace and product data persist between sessions.',
        'Billing or subscription state is visible in the account settings flow.',
        'The main dashboard workflow performs real non-mock product actions.',
      ],
      implementationPlan: [
        'Create auth flows and session handling.',
        'Add database schema and persistence layer.',
        'Implement API endpoints for core product actions.',
        'Build the authenticated dashboard and settings views.',
        'Integrate billing/subscription management.',
      ],
      risks: [
        'Billing integration can expand the implementation surface quickly.',
        'Auth and data migration errors would block the whole product core.',
      ],
    }));

    await plugin.onFanOutComplete(ctx, [
      {
        agentId: 'implementer_1',
        response: '## Result\n- Wrote the initial spec to disk.\n## File Path\n- full-saas-v1.md\n## Highlights\n- Covers auth, billing, persistence, and dashboard flows.\n## Risks\n- Billing complexity remains significant.\n## Open Questions\n- None.',
      },
    ]);

    const report = plugin.getFinalReport(ctx);
    assert.ok(report?.handoffPayloads?.[0]);
    assert.equal(report.handoffPayloads[0].contract, 'spec_bundle.v1');
    assert.equal(report.handoffPayloads[0].data.implementationHints.complexity, 'extensive');
    assert.equal(report.handoffPayloads[0].data.implementationHints.recommendedMaxCycles, 13);
    assert.ok(report.handoffPayloads[0].data.implementationHints.rationale.some((item) => /auth/i.test(item)));
    assert.ok(report.handoffPayloads[0].data.implementationHints.rationale.some((item) => /persistence|data-layer/i.test(item)));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room stops with the latest authored spec when the pass limit is reached', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-max-cycles-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1',
      },
      limits: {
        maxCycles: 3,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    plugin.onRoomStart(ctx);
    await writeCanonicalSpec(ctx, buildSpecMarkdown());
    await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Wrote the initial spec.\n## File Path\n- control-room-v1.md\n## Highlights\n- Initial draft is on disk.\n## Risks\n- Needs review.\n## Open Questions\n- None.' },
    ]);
    await plugin.onFanOutComplete(ctx, [
      { agentId: 'planner_1', response: '## Verdict\nrevise\n## Keep\n- Clear scope.\n## Must Change\n- Add stronger parent-room status details.\n## Nice To Have\n## Risks\n- UX ambiguity remains.\n## Open Questions\n- None.' },
      { agentId: 'critic_1', response: '## Verdict\nrevise\n## Keep\n- Good first cut.\n## Must Change\n- Add explicit halt semantics.\n## Nice To Have\n## Risks\n- Failure handling is unclear.\n## Open Questions\n- None.' },
    ]);

    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      title: 'Control Room v1: Latest Authored Spec',
      proposal: [
        'Add a built-in control room that launches validated child rooms.',
        'Show parent-room status and halt behavior explicitly.',
      ],
    }));

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Revised the file with the requested changes.\n## File Path\n- control-room-v1.md\n## Applied Changes\n- Added halt behavior and status.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'cycle_limit' });

    const finalState = ctx.getState();
    assert.equal(finalState.phase, 'complete');
    assert.equal(finalState.finalSpec.title, 'Control Room v1: Latest Authored Spec');
    assert.deepEqual(ctx._cycles, [1, 2, 3]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room gives the implementer the final pass when review hits the cycle limit with requested changes', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-final-implementer-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1',
      },
      limits: {
        maxCycles: 4,
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    plugin.onRoomStart(ctx);
    await writeCanonicalSpec(ctx, buildSpecMarkdown());

    await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Wrote the initial spec.\n## File Path\n- control-room-v1.md\n## Highlights\n- Initial draft is on disk.\n## Risks\n- Needs review.\n## Open Questions\n- None.' },
    ]);
    await plugin.onFanOutComplete(ctx, [
      { agentId: 'planner_1', response: '## Verdict\nrevise\n## Keep\n- Good scope.\n## Must Change\n- Add stronger parent-room status details.\n## Nice To Have\n## Risks\n- UX ambiguity remains.\n## Open Questions\n- None.' },
      { agentId: 'critic_1', response: '## Verdict\nrevise\n## Keep\n- Good first cut.\n## Must Change\n- Add explicit halt semantics.\n## Nice To Have\n## Risks\n- Failure handling is unclear.\n## Open Questions\n- None.' },
    ]);

    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      title: 'Control Room v1: Revised Before Final Review',
      proposal: [
        'Add a built-in control room that launches validated child rooms.',
        'Show parent-room status and halt behavior explicitly.',
      ],
    }));

    const finalReviseDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Revised the file with the requested changes.\n## File Path\n- control-room-v1.md\n## Applied Changes\n- Added halt behavior and status.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.equal(finalReviseDecision.type, 'fan_out');
    assert.deepEqual(finalReviseDecision.targets.map((target) => target.agentId), ['planner_1', 'critic_1']);

    const finalAuthorDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'planner_1', response: '## Verdict\nrevise\n## Keep\n- Clear scope.\n## Must Change\n- Tighten the wording around child-room summaries.\n## Nice To Have\n## Risks\n- Minor UX ambiguity.\n## Open Questions\n- None.' },
      { agentId: 'critic_1', response: '## Verdict\nrevise\n## Keep\n- Halt behavior is clearer.\n## Must Change\n- Clarify whether parent status updates are live.\n## Nice To Have\n## Risks\n- Minor runtime ambiguity.\n## Open Questions\n- None.' },
    ]);

    assert.equal(finalAuthorDecision.type, 'fan_out');
    assert.deepEqual(finalAuthorDecision.targets.map((target) => target.agentId), ['implementer_1']);
    assert.match(finalAuthorDecision.targets[0].message, /final revise pass/i);
    assert.equal(ctx.getState().passCount, 4);

    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      title: 'Control Room v1: Final Implementer Pass',
      proposal: [
        'Add a built-in control room that launches validated child rooms.',
        'Show live parent-room status, halt behavior, and child-room summaries explicitly.',
      ],
    }));

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Applied the final requested review changes.\n## File Path\n- control-room-v1.md\n## Applied Changes\n- Tightened parent status and child summary wording.\n## Deferred\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'cycle_limit' });
    assert.equal(ctx.getState().finalSpec.title, 'Control Room v1: Final Implementer Pass');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room resume and pending-decision refresh only target missing reviewers', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-resume-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1',
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);
    plugin.onRoomStart(ctx);
    await writeCanonicalSpec(ctx, buildSpecMarkdown());
    const reviewDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Wrote the initial spec.\n## File Path\n- control-room-v1.md\n## Highlights\n- Initial draft is ready.\n## Risks\n- Needs review.\n## Open Questions\n- None.' },
    ]);

    ctx._setActiveFanOut({
      id: 'fanout-1',
      startedAt: Date.now(),
      metadata: reviewDecision.metadata || {},
      targets: [
        { agentId: 'planner_1', role: 'planner', displayName: 'Planner', message: reviewDecision.targets[0].message },
        { agentId: 'critic_1', role: 'critic', displayName: 'Critic', message: reviewDecision.targets[1].message },
      ],
      completedAgentIds: ['planner_1'],
      pendingAgentIds: ['critic_1'],
      disconnectedAgentIds: [],
      partials: {
        planner_1: {
          response: '## Verdict\nrevise\n## Keep\n- Good scope.\n## Must Change\n- Add stronger status details.\n## Nice To Have\n## Risks\n- UX ambiguity.\n## Open Questions\n- None.',
          responseLength: 120,
          updatedAt: Date.now(),
        },
      },
    });

    await plugin.onEvent(ctx, {
      type: 'fan_out_partial',
      fanOutId: 'fanout-1',
      agentId: 'planner_1',
      displayName: 'Planner',
      detail: {
        response: '## Verdict\nrevise\n## Keep\n- Good scope.\n## Must Change\n- Add stronger status details.\n## Nice To Have\n## Risks\n- UX ambiguity.\n## Open Questions\n- None.',
        responseLength: 120,
      },
      progress: {
        completedAgentIds: ['planner_1'],
        pendingAgentIds: ['critic_1'],
      },
    });

    const resumedDecision = await plugin.onResume(ctx);
    assert.deepEqual(resumedDecision, { type: 'continue_fan_out' });
    assert.match(ctx.getState().feedEntries.at(-1).content, /Resuming review pass/);

    const refreshedDecision = plugin.refreshPendingDecision(ctx, {
      type: 'fan_out',
      targets: [
        { agentId: 'planner_1', message: 'old planner prompt' },
        { agentId: 'critic_1', message: 'old critic prompt' },
      ],
    });

    assert.equal(refreshedDecision.type, 'fan_out');
    assert.deepEqual(refreshedDecision.targets.map((target) => target.agentId), ['critic_1']);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room requires the canonical spec file path to come from room setup', () => {
  const ctx = makeMockCtx();
  const plugin = createPlugin();

  plugin.init(ctx);
  const decision = plugin.onRoomStart(ctx);

  assert.deepEqual(decision, { type: 'stop', reason: 'missing_spec_output_path' });
  assert.match(ctx.getState().feedEntries.at(-1).content, /export directory and export file name/i);
});

test('spec room preserves a provided .md file extension in the canonical spec path', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-file-ext-'));

  try {
    const ctx = makeMockCtx({
      roomConfig: {
        outputDir,
        fileName: 'plan.md',
      },
    });
    const plugin = createPlugin();

    plugin.init(ctx);

    assert.equal(ctx.getState().specFilePath, path.join(outputDir, 'plan.md'));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('spec room accepts human-friendly config labels and normalizes them', () => {
  const ctx = makeMockCtx({
    roomConfig: {
      deliverableType: 'Technical Spec',
      audience: 'Engineering',
      detailLevel: 'Detailed',
    },
  });
  const plugin = createPlugin();

  plugin.init(ctx);
  const state = ctx.getState();

  assert.equal(state.config.deliverableType, 'technical_spec');
  assert.equal(state.config.audience, 'engineering');
  assert.equal(state.config.detailLevel, 'detailed');
});

test('spec room preserves longer authored sections without clipping them mid-thought', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spec-room-long-spec-'));

  try {
    const ctx = makeMockCtx({
      objective: 'control room v1 sequential room pipelines with report based handoffs',
      roomConfig: {
        outputDir,
        fileName: 'control-room-v1-long',
      },
    });
    const plugin = createPlugin();

    const longSummary = Array.from({ length: 18 }, (_, index) => (
      `Summary sentence ${index + 1} explains how the control room carries staged output forward while keeping every child room visible and reusable.`
    )).join(' ');
    const longProblem = Array.from({ length: 55 }, (_, index) => (
      `Problem sentence ${index + 1} describes the manual room creation, handoff copying, status tracking, and orchestration friction that exists without a first-class parent-child control model.`
    )).join(' ');
    const longProposalBullet = `**Pipeline definition.** ${Array.from({ length: 16 }, (_, index) => (
      `Detail ${index + 1} keeps the stage schema explicit, predictable, and debuggable by requiring declared identifiers, orchestrator types, objectives, agents, room config, and controlled handoff behavior.`
    )).join(' ')}`;

    plugin.init(ctx);
    plugin.onRoomStart(ctx);
    await writeCanonicalSpec(ctx, buildSpecMarkdown({
      title: 'Control Room v1: Sequential Room Pipelines With Report-Based Handoffs',
      summary: longSummary,
      problem: longProblem,
      proposal: [
        longProposalBullet,
        '**Spawn and linkage.** Extend the room runtime with spawnChildRoom so the control room can create validated child rooms and record parent child linkage without inventing a second launch path.',
      ],
    }));

    await plugin.onFanOutComplete(ctx, [
      { agentId: 'implementer_1', response: '## Result\n- Wrote the initial long-form technical spec.\n## File Path\n- control-room-v1-long.md\n## Highlights\n- Includes detailed problem and proposal sections.\n## Risks\n- Long sections may expose clipping bugs.\n## Open Questions\n- None.' },
    ]);

    const stopDecision = await plugin.onFanOutComplete(ctx, [
      { agentId: 'planner_1', response: '## Verdict\napprove\n## Keep\n- The scope is concrete and sequential.\n## Must Change\n## Nice To Have\n## Risks\n- None.\n## Open Questions\n- None.' },
      { agentId: 'critic_1', response: '## Verdict\napprove\n## Keep\n- The long sections remain readable.\n## Must Change\n## Nice To Have\n## Risks\n- None.\n## Open Questions\n- None.' },
    ]);

    assert.deepEqual(stopDecision, { type: 'stop', reason: 'convergence' });

    const state = ctx.getState();
    assert.ok(state.finalSpec.summary.includes('Summary sentence 18 explains how the control room carries staged output forward'));
    assert.ok(state.finalSpec.problem.includes('Problem sentence 40 describes the manual room creation'));
    assert.ok(state.finalSpec.proposal[0].includes('Detail 16 keeps the stage schema explicit, predictable, and debuggable'));
    assert.ok(state.finalSpec.summary.length > 2000);
    assert.ok(state.finalSpec.problem.length > 6000);
    assert.ok(state.finalSpec.proposal[0].length > 2500);
    assert.equal(state.finalSpec.summary.endsWith('sequential e'), false);
    assert.equal(state.finalSpec.problem.endsWith('slower to execute,'), false);
    assert.equal(state.finalSpec.proposal[0].endsWith('V1'), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
