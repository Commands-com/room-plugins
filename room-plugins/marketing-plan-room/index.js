import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));
const promptsDir = path.join(__dirname, 'prompts');
const promptTemplates = {
  write: readFileSync(path.join(promptsDir, 'write.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
  revise: readFileSync(path.join(promptsDir, 'revise.md'), 'utf-8'),
};

const PHASES = {
  WRITE: 'write',
  REVIEW: 'review',
  REVISE: 'revise',
  COMPLETE: 'complete',
};

const TEXT_LIMITS = {
  response: 60000,
  markdown: 40000,
  paragraph: 2400,
  item: 600,
};

const NONE_KEYS = new Set(['none', 'none yet', 'n a', 'na', 'nothing', 'nope']);

function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function excerpt(value, maxLen = 220) {
  const text = safeTrim(value, maxLen + 20).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

function titleCase(value) {
  return safeTrim(value, 120)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function canonicalKey(value) {
  return safeTrim(value, 300)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeList(values, maxItems = 8, itemLen = TEXT_LIMITS.item) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const results = [];
  for (const value of values) {
    const cleaned = safeTrim(
      String(value ?? '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, ''),
      itemLen,
    );
    const key = canonicalKey(cleaned);
    if (!key || NONE_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    results.push(cleaned);
    if (results.length >= maxItems) break;
  }
  return results;
}

function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

function splitHeadingSections(markdown, headingPrefix = '##') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let current = null;
  const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^\\s*${escaped}\\s+(.+)$`);

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      current = canonicalKey(match[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }

  return sections;
}

function sectionToParagraph(lines, maxLen = TEXT_LIMITS.paragraph) {
  if (!Array.isArray(lines)) return '';
  return safeTrim(
    lines
      .map((line) => safeTrim(line, maxLen).replace(/^[-*+]\s+/, '').trim())
      .filter(Boolean)
      .join(' '),
    maxLen,
  );
}

function sectionToItems(lines, maxItems = 8, itemLen = TEXT_LIMITS.item) {
  return normalizeList(Array.isArray(lines) ? lines : [], maxItems, itemLen);
}

function getConfig(ctx) {
  const roomConfig = ctx?.roomConfig || {};
  return {
    projectDir: safeTrim(roomConfig.projectDir, 4000),
    outputDir: safeTrim(roomConfig.outputDir, 4000),
    fileName: safeTrim(roomConfig.fileName || 'marketing-plan.md', 240) || 'marketing-plan.md',
    marketFocus: safeTrim(roomConfig.marketFocus, 400),
  };
}

function getParticipants(ctx) {
  return Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role)
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
        }))
    : [];
}

function findRequiredParticipant(state, role) {
  return state.participants.find((participant) => participant.role === role) || null;
}

function findMissingRoles(state) {
  const required = manifest.roles?.required || [];
  return required.filter((role) => !findRequiredParticipant(state, role));
}

function readIfExists(targetPath, maxLen = TEXT_LIMITS.markdown) {
  try {
    return safeTrim(readFileSync(targetPath, 'utf-8'), maxLen);
  } catch {
    return '';
  }
}

function collectProjectContext(projectDir) {
  const normalized = safeTrim(projectDir, 4000);
  if (!normalized) {
    return {
      summary: 'No project directory provided.',
      block: 'No project directory provided.',
    };
  }

  const topLevel = [];
  try {
    const entries = readdirSync(normalized, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 40);
    for (const entry of entries) {
      topLevel.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }
  } catch {
    // ignore
  }

  const readme = readIfExists(path.join(normalized, 'README.md'), 5000)
    || readIfExists(path.join(normalized, 'readme.md'), 5000);
  let packageSummary = '';
  try {
    const packageJson = JSON.parse(readFileSync(path.join(normalized, 'package.json'), 'utf-8'));
    packageSummary = [
      packageJson.name ? `name: ${packageJson.name}` : '',
      packageJson.description ? `description: ${packageJson.description}` : '',
      Array.isArray(packageJson.keywords) && packageJson.keywords.length > 0
        ? `keywords: ${packageJson.keywords.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
  } catch {
    // ignore
  }

  const block = [
    `Project directory: ${normalized}`,
    packageSummary ? `Package summary: ${packageSummary}` : '',
    topLevel.length > 0 ? `Top-level files:\n- ${topLevel.join('\n- ')}` : 'Top-level files: unavailable',
    readme ? `README excerpt:\n${excerpt(readme, 1000)}` : 'README excerpt: unavailable',
  ].filter(Boolean).join('\n\n');

  return {
    summary: packageSummary || excerpt(readme, 220) || 'Project context gathered from directory scan.',
    block,
  };
}

function extractCompetitiveContext(ctx) {
  const payloads = Array.isArray(ctx?.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const bundle = payloads.find((payload) => payload?.contract === 'competitive_analysis_bundle.v1' && payload?.data);
  if (!bundle?.data || typeof bundle.data !== 'object') return null;
  const data = bundle.data;
  return {
    title: safeTrim(data?.summary?.title, 200),
    oneLiner: safeTrim(data?.summary?.oneLiner, 1000),
    recommendedDirection: safeTrim(data?.summary?.recommendedDirection, 1000),
    competitorSet: normalizeList(data?.competitorSet, 12, 500),
    positioningGap: safeTrim(data?.positioningGap, 1600),
    likelyChannels: normalizeList(data?.likelyChannels, 12, 500),
    messagingStrengths: normalizeList(data?.messagingStrengths, 12, 500),
    messagingWeaknesses: normalizeList(data?.messagingWeaknesses, 12, 500),
    patternsToAvoid: normalizeList(data?.patternsToAvoid, 12, 500),
    recommendedMoves: normalizeList(data?.recommendedMoves, 12, 500),
    risks: normalizeList(data?.risks, 10, 500),
  };
}

function buildCompetitiveContextBlock(state) {
  if (!state.competitiveContext) return 'No inbound competitive analysis bundle provided.';
  const context = state.competitiveContext;
  return [
    context.title ? `Title: ${context.title}` : '',
    context.oneLiner ? `Summary: ${context.oneLiner}` : '',
    context.recommendedDirection ? `Recommended direction: ${context.recommendedDirection}` : '',
    context.positioningGap ? `Positioning gap: ${context.positioningGap}` : '',
    context.competitorSet.length > 0 ? `Competitors:\n- ${context.competitorSet.join('\n- ')}` : 'Competitors: none listed',
    context.likelyChannels.length > 0 ? `Likely channels:\n- ${context.likelyChannels.join('\n- ')}` : 'Likely channels: none listed',
    context.messagingStrengths.length > 0 ? `Messaging strengths:\n- ${context.messagingStrengths.join('\n- ')}` : '',
    context.messagingWeaknesses.length > 0 ? `Messaging weaknesses:\n- ${context.messagingWeaknesses.join('\n- ')}` : '',
    context.patternsToAvoid.length > 0 ? `Patterns to avoid:\n- ${context.patternsToAvoid.join('\n- ')}` : '',
    context.recommendedMoves.length > 0 ? `Recommended moves:\n- ${context.recommendedMoves.join('\n- ')}` : '',
    context.risks.length > 0 ? `Risks:\n- ${context.risks.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n');
}

function seedPlanFile(state) {
  if (!state.planPath) return;
  if (existsSync(state.planPath)) return;
  mkdirSync(state.config.outputDir, { recursive: true });
  const title = `${state.objective || 'Marketing Plan'}`.trim();
  const content = [
    `# ${title}`,
    '',
    '## Executive Summary',
    '- Summarize the main marketing direction and why it should work.',
    '',
    '## Positioning',
    '- How should the product be positioned in the market?',
    '',
    '## Audience',
    '- Who is the plan actually for?',
    '',
    '## Messaging Pillars',
    '- What messages should repeat consistently?',
    '',
    '## Channel Priorities',
    '- Which channels deserve focus first?',
    '',
    '## Campaign Bets',
    '- Which concrete campaign bets are worth making?',
    '',
    '## Asset Plan',
    '- Which assets should be created next?',
    '',
    '## Launch Plan',
    '- What should happen at launch?',
    '',
    '## Success Metrics',
    '- How should success be measured?',
    '',
    '## Risks',
    '- What could make the plan fail?',
    '',
    '## Open Questions',
    '- What still needs validation?',
    '',
  ].join('\n');
  writeFileSync(state.planPath, content, 'utf-8');
}

function readPlanMarkdown(state) {
  return readIfExists(state.planPath, TEXT_LIMITS.markdown);
}

function parsePlan(markdown) {
  const sections = splitHeadingSections(markdown, '##');
  const titleMatch = String(markdown || '').match(/^#\s+(.+)$/m);
  return {
    title: safeTrim(titleMatch?.[1], 200) || 'Marketing Plan',
    executiveSummary: sectionToParagraph(sections.get('executive summary'), 1200),
    positioning: sectionToParagraph(sections.get('positioning'), 1600),
    audience: sectionToParagraph(sections.get('audience'), 1600),
    messagingPillars: sectionToItems(sections.get('messaging pillars'), 12, 500),
    channelPriorities: sectionToItems(sections.get('channel priorities'), 12, 500),
    campaignBets: sectionToItems(sections.get('campaign bets'), 12, 500),
    assetPlan: sectionToItems(sections.get('asset plan'), 12, 500),
    launchPlan: sectionToItems(sections.get('launch plan'), 12, 500),
    successMetrics: sectionToItems(sections.get('success metrics'), 12, 500),
    risks: sectionToItems(sections.get('risks'), 10, 500),
    openQuestions: sectionToItems(sections.get('open questions'), 10, 500),
    markdown: safeTrim(markdown, TEXT_LIMITS.markdown),
  };
}

function parseReviewResponse(markdown) {
  const sections = splitHeadingSections(markdown, '##');
  return {
    overall: sectionToParagraph(sections.get('overall'), 500),
    keep: sectionToItems(sections.get('keep'), 10, 500),
    mustChange: sectionToItems(sections.get('must change'), 10, 500),
    risks: sectionToItems(sections.get('risks'), 10, 500),
    opportunities: sectionToItems(sections.get('opportunities'), 10, 500),
  };
}

function summarizeReviews(round) {
  const parsed = (round?.responses || []).map((response) => ({
    ...response,
    review: parseReviewResponse(response.response),
  }));
  return {
    parsed,
    mustChange: normalizeList(parsed.flatMap((entry) => entry.review.mustChange), 20, 500),
    risks: normalizeList(parsed.flatMap((entry) => entry.review.risks), 20, 500),
    opportunities: normalizeList(parsed.flatMap((entry) => entry.review.opportunities), 20, 500),
  };
}

function buildProjectContextBlock(state) {
  return state.projectContext?.block || 'No project context available.';
}

function buildWritePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_context: buildProjectContextBlock(state),
    competitive_context: buildCompetitiveContextBlock(state),
    plan_path: state.planPath,
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_context: buildProjectContextBlock(state),
    competitive_context: buildCompetitiveContextBlock(state),
    plan_markdown: readPlanMarkdown(state) || '_Marketing plan file missing or empty._',
  });
}

function buildReviewFeedbackBlock(state) {
  const round = getRound(state, PHASES.REVIEW, state.cycleCount);
  if (!round || round.responses.length === 0) return '- None yet.';
  const summary = summarizeReviews(round);
  return [
    '## Keep',
    ...(summary.parsed.flatMap((entry) => entry.review.keep).length > 0
      ? normalizeList(summary.parsed.flatMap((entry) => entry.review.keep), 12, 500).map((item) => `- ${item}`)
      : ['- None.']),
    '',
    '## Must Change',
    ...(summary.mustChange.length > 0 ? summary.mustChange.map((item) => `- ${item}`) : ['- None.']),
    '',
    '## Risks',
    ...(summary.risks.length > 0 ? summary.risks.map((item) => `- ${item}`) : ['- None.']),
    '',
    '## Opportunities',
    ...(summary.opportunities.length > 0 ? summary.opportunities.map((item) => `- ${item}`) : ['- None.']),
  ].join('\n');
}

function buildRevisePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.revise, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_context: buildProjectContextBlock(state),
    competitive_context: buildCompetitiveContextBlock(state),
    plan_path: state.planPath,
    plan_markdown: readPlanMarkdown(state) || '_Marketing plan file missing or empty._',
    review_feedback: buildReviewFeedbackBlock(state),
  });
}

function createRound(phase, cycleIndex) {
  return { phase, cycleIndex, responses: [] };
}

function ensureRound(state, phase, cycleIndex = state.cycleCount) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.cycleIndex === cycleIndex);
  if (!round) {
    round = createRound(phase, cycleIndex);
    state.rounds.push(round);
  }
  return round;
}

function getRound(state, phase, cycleIndex = state.cycleCount) {
  return state.rounds.find((entry) => entry.phase === phase && entry.cycleIndex === cycleIndex) || null;
}

function upsertRoundResponse(round, participant, response) {
  const next = {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    response: safeTrim(response?.response, TEXT_LIMITS.response),
    status: safeTrim(response?.status, 120) || 'submitted',
    summary: excerpt(response?.response, 220) || 'No response summary available.',
  };
  const index = round.responses.findIndex((entry) => entry.agentId === participant.agentId);
  if (index >= 0) round.responses[index] = next;
  else round.responses.push(next);
}

function updateAgentStatuses(state, agentIds, status) {
  for (const agentId of agentIds) {
    if (!agentId) continue;
    state.agentStatus[agentId] = status;
  }
}

function appendFeed(state, content, meta = {}) {
  state.feedEntries.push({
    id: `feed-${state.feedEntries.length + 1}`,
    content: safeTrim(content, 2400),
    createdAt: Date.now(),
    displayName: meta.displayName || 'Marketing Plan Room',
    role: meta.role || 'system',
    agentId: meta.agentId || null,
  });
}

function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE) return [];
  if (phase === PHASES.WRITE || phase === PHASES.REVISE) {
    return state.author ? [{
      agentId: state.author.agentId,
      message: phase === PHASES.WRITE ? buildWritePrompt(state, state.author) : buildRevisePrompt(state, state.author),
    }] : [];
  }
  if (phase === PHASES.REVIEW) {
    return state.reviewers.map((participant) => ({
      agentId: participant.agentId,
      message: buildReviewPrompt(state, participant),
    }));
  }
  return [];
}

function buildPendingTargetsForPhase(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  const completed = new Set(round.responses.map((response) => response.agentId));
  return buildTargetsForPhase(state, phase).filter((target) => !completed.has(target.agentId));
}

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => ({
    phase: `Pass ${round.cycleIndex} — ${titleCase(round.phase)}`,
    contributor: response.displayName,
    role: titleCase(response.role),
    status: titleCase(response.status),
    summary: response.summary,
  })));
}

function buildArtifactBlocks(state) {
  const markdown = readPlanMarkdown(state);
  return markdown ? [{
    title: path.basename(state.planPath),
    language: 'markdown',
    path: state.planPath,
    content: markdown,
  }] : [];
}

function emitMetrics(ctx, state) {
  const parsed = parsePlan(readPlanMarkdown(state));
  const contributorStatus = {};
  for (const participant of state.participants) {
    contributorStatus[participant.displayName] = state.agentStatus[participant.agentId] || 'idle';
  }
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    planPhase: { active: state.phase },
    planProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    planCounts: {
      channels: parsed.channelPriorities.length,
      campaigns: parsed.campaignBets.length,
      assets: parsed.assetPlan.length,
      metrics: parsed.successMetrics.length,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    planArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: state.phase === PHASES.COMPLETE ? buildArtifactBlocks(state) : [] },
  });
}

function issuePhaseDecision(ctx, state, phase, options = {}) {
  state.phase = phase;
  ensureRound(state, phase, state.cycleCount);
  const targets = options.pendingOnly ? buildPendingTargetsForPhase(state, phase) : buildTargetsForPhase(state, phase);
  updateAgentStatuses(state, targets.map((target) => target.agentId), 'assigned');
  appendFeed(
    state,
    options.pendingOnly
      ? `Resuming ${phase} pass — ${targets.length} contributor(s) remaining.`
      : phase === PHASES.WRITE
        ? `Starting write pass for ${state.planPath}.`
        : phase === PHASES.REVIEW
          ? `Starting review pass for pass ${state.cycleCount}.`
          : `Starting revise pass for pass ${state.cycleCount}.`,
  );
  ctx.setCycle(state.cycleCount);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'fan_out',
    targets,
    metadata: {
      phase,
      cycle: state.cycleCount,
      label: options.pendingOnly ? `resume-${phase}-${state.cycleCount}` : `${phase}-${state.cycleCount}`,
    },
  };
}

function mergeResponsesIntoRound(state, phase, responses) {
  const round = ensureRound(state, phase, state.cycleCount);
  for (const response of Array.isArray(responses) ? responses : []) {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId);
    if (!participant) continue;
    upsertRoundResponse(round, participant, response);
  }
  updateAgentStatuses(state, state.participants.map((participant) => participant.agentId), 'idle');
}

function createInitialState(ctx) {
  const config = getConfig(ctx);
  const projectDir = config.projectDir ? path.resolve(config.projectDir) : '';
  const outputDir = config.outputDir ? path.resolve(config.outputDir) : '';
  const objective = safeTrim(ctx?.objective, 2400) || 'Marketing plan';
  const participants = getParticipants(ctx);
  const state = {
    objective,
    config: { ...config, projectDir, outputDir },
    planPath: outputDir ? path.join(outputDir, config.fileName) : '',
    participants,
    author: participants.find((participant) => participant.role === 'strategist') || null,
    reviewers: participants.filter((participant) => participant.role !== 'strategist'),
    phase: PHASES.WRITE,
    cycleCount: 1,
    maxCycles: Math.max(1, Math.min(Number(ctx?.limits?.maxCycles) || manifest.limits?.maxCycles?.default || 4, manifest.limits?.maxCycles?.max || 6)),
    rounds: [],
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    projectContext: collectProjectContext(projectDir),
    competitiveContext: extractCompetitiveContext(ctx),
    feedEntries: [],
    missingRoles: [],
  };
  state.missingRoles = findMissingRoles(state);
  appendFeed(state, `Marketing plan room ready for ${objective}.`);
  if (state.projectContext.summary) appendFeed(state, `Project read: ${state.projectContext.summary}`);
  if (state.competitiveContext?.oneLiner) appendFeed(state, `Competitive context: ${state.competitiveContext.oneLiner}`);
  return state;
}

function stopForMissingRoles(ctx, state) {
  appendFeed(state, `Cannot start without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `missing_required_roles:${state.missingRoles.join(',')}` };
}

function stopForMissingPaths(ctx, state) {
  if (!state.config.outputDir) {
    appendFeed(state, 'Cannot start without required path: outputDir.');
    ctx.setState(state);
    emitMetrics(ctx, state);
    return { type: 'stop', reason: 'missing_required_paths:outputDir' };
  }
  return null;
}

function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Marketing plan complete. Review ${state.planPath}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.WRITE || state.phase === PHASES.REVISE) {
    const exists = state.planPath && existsSync(state.planPath);
    appendFeed(
      state,
      exists
        ? `${titleCase(state.phase)} pass finished. Marketing plan file is present.`
        : `${titleCase(state.phase)} pass finished, but the marketing plan file is still missing.`,
    );
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const reviewSummary = summarizeReviews(ensureRound(state, PHASES.REVIEW, state.cycleCount));
    appendFeed(state, `Review pass collected ${reviewSummary.mustChange.length} required change${reviewSummary.mustChange.length === 1 ? '' : 's'}.`);
    if (reviewSummary.mustChange.length === 0) return finalizeRoom(ctx, state, 'convergence');
    if (state.cycleCount >= state.maxCycles) return finalizeRoom(ctx, state, 'cycle_limit');
    state.cycleCount += 1;
    return issuePhaseDecision(ctx, state, PHASES.REVISE);
  }

  appendFeed(state, `Unexpected continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `unexpected_resume_phase:${state.phase}` };
}

function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
  }));
}

function buildBundle(state) {
  const parsed = parsePlan(readPlanMarkdown(state));
  return {
    contract: 'marketing_plan_bundle.v1',
    summary: {
      title: parsed.title,
      oneLiner: parsed.executiveSummary,
      recommendedDirection: parsed.positioning || parsed.channelPriorities[0] || '',
    },
    positioning: parsed.positioning,
    audience: parsed.audience,
    messagingPillars: parsed.messagingPillars,
    channelPriorities: parsed.channelPriorities,
    campaignBets: parsed.campaignBets,
    assetPlan: parsed.assetPlan,
    launchPlan: parsed.launchPlan,
    successMetrics: parsed.successMetrics,
    risks: parsed.risks,
    openQuestions: parsed.openQuestions,
    markdown: parsed.markdown,
    provenance: {
      roomType: 'marketing_plan_room',
      generatedAt: new Date().toISOString(),
      objective: state.objective,
      projectDir: state.config.projectDir,
      sourceCompetitiveAnalysis: state.competitiveContext?.title || '',
      cycleCount: state.cycleCount,
    },
  };
}

function createPlugin() {
  return {
    init(ctx) {
      const state = createInitialState(ctx);
      ctx.setState(state);
      emitMetrics(ctx, state);
    },

    onRoomStart(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.missingRoles.length > 0) return stopForMissingRoles(ctx, state);
      const missingPathsDecision = stopForMissingPaths(ctx, state);
      if (missingPathsDecision) return missingPathsDecision;
      seedPlanFile(state);
      return issuePhaseDecision(ctx, state, PHASES.WRITE);
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState() || createInitialState(ctx);
      mergeResponsesIntoRound(state, state.phase, responses);
      if (state.phase === PHASES.WRITE || state.phase === PHASES.REVIEW || state.phase === PHASES.REVISE) {
        return continueFromCollectedResponses(ctx, state);
      }
      appendFeed(state, `Unexpected fan-out completion while in phase "${state.phase}".`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return { type: 'stop', reason: `unexpected_fan_out_phase:${state.phase}` };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState() || createInitialState(ctx);
      appendFeed(state, `Received unexpected single-turn response from ${turnResult?.agentId || 'unknown agent'}.`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return { type: 'stop', reason: 'unexpected_single_turn' };
    },

    onEvent(ctx, event) {
      const state = ctx.getState() || createInitialState(ctx);
      if (event?.type === 'fan_out_partial' && event.agentId) {
        if (event.progress?.completedAgentIds) updateAgentStatuses(state, event.progress.completedAgentIds, 'submitted');
        if (event.progress?.pendingAgentIds) updateAgentStatuses(state, event.progress.pendingAgentIds, 'assigned');
        state.agentStatus[event.agentId] = 'submitted';
        const round = ensureRound(state, state.phase, state.cycleCount);
        const participant = state.participants.find((entry) => entry.agentId === event.agentId);
        if (participant && event.detail?.response) {
          upsertRoundResponse(round, participant, { response: event.detail.response, status: 'submitted' });
        }
        appendFeed(state, `${event.displayName || event.agentId} submitted a partial response.`, {
          displayName: event.displayName || event.agentId,
          role: 'participant',
          agentId: event.agentId,
        });
        ctx.setState(state);
        emitMetrics(ctx, state);
        return null;
      }
      if (event?.type === 'participant_disconnected' && event.agentId) {
        state.agentStatus[event.agentId] = 'disconnected';
        appendFeed(state, `${event.agentId} disconnected.`, {
          displayName: event.agentId,
          role: 'participant',
          agentId: event.agentId,
        });
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'pause', reason: `participant_disconnected:${event.agentId}` };
      }
      return null;
    },

    async onResume(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      emitMetrics(ctx, state);
      if (state.phase === PHASES.COMPLETE) return null;
      const activeFanOut = typeof ctx.getActiveFanOut === 'function' ? ctx.getActiveFanOut() : null;
      if (activeFanOut?.pendingAgentIds?.length > 0) {
        updateAgentStatuses(state, activeFanOut.completedAgentIds || [], 'submitted');
        updateAgentStatuses(state, activeFanOut.pendingAgentIds, 'assigned');
        appendFeed(state, `Resuming ${state.phase} pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'continue_fan_out' };
      }
      const targets = buildPendingTargetsForPhase(state, state.phase);
      if (targets.length > 0) return issuePhaseDecision(ctx, state, state.phase, { pendingOnly: true });
      const responses = getPhaseResponses(state, state.phase);
      if (responses.length > 0) return continueFromCollectedResponses(ctx, state);
      return null;
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (!pendingDecision || pendingDecision.type !== 'fan_out' || !state) return pendingDecision;
      const targets = buildPendingTargetsForPhase(state, state.phase);
      return targets.length > 0 ? { ...pendingDecision, targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) return null;
      const bundle = buildBundle(state);
      return {
        summary: {
          title: bundle.summary.title,
          highlights: [
            bundle.summary.oneLiner,
            bundle.summary.recommendedDirection,
            bundle.channelPriorities[0] || '',
          ].filter(Boolean),
          outcome: state.phase === PHASES.COMPLETE ? 'marketing_plan_ready' : 'marketing_plan_partial',
        },
        metrics: {
          cycles: state.cycleCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts: state.planPath && existsSync(state.planPath)
          ? [{ type: 'markdown', path: state.planPath, label: path.basename(state.planPath) }]
          : [],
        handoffPayloads: [
          {
            contract: 'marketing_plan_bundle.v1',
            data: bundle,
          },
        ],
      };
    },

    shutdown() {
      // No-op.
    },
  };
}

export default { manifest, createPlugin };
export { manifest, createPlugin };
