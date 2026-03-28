import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    fileName: safeTrim(roomConfig.fileName || 'competitive-analysis.md', 240) || 'competitive-analysis.md',
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
      readme: '',
      packageSummary: '',
      topLevel: [],
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
        ? `keywords: ${packageJson.keywords.join(', ')}`
        : '',
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
    readme,
    packageSummary,
    topLevel,
    block,
  };
}

function seedAnalysisFile(state) {
  if (!state.analysisPath) return;
  if (existsSync(state.analysisPath)) return;
  mkdirSync(state.config.outputDir, { recursive: true });
  const title = `${state.objective || 'Competitive Analysis'}`.trim();
  const content = [
    `# ${title}`,
    '',
    '## Executive Summary',
    '- Summarize the likely market and the strongest strategic takeaway.',
    '',
    '## Product Read',
    '- What does this product appear to be?',
    '',
    '## Competitor Set',
    '- Likely direct competitors and adjacent alternatives.',
    '',
    '## Positioning Gap',
    '- Where is the market open?',
    '',
    '## Likely Acquisition Channels',
    '- Inferred channels and why.',
    '',
    '## Messaging Strengths',
    '- What competitors appear to do well.',
    '',
    '## Messaging Weaknesses',
    '- What looks weak, repetitive, or stale.',
    '',
    '## Patterns To Avoid',
    '- Tactics or messages not worth copying blindly.',
    '',
    '## Recommended Positioning',
    '- How we should position ourselves.',
    '',
    '## Recommended Moves',
    '- Best next marketing moves.',
    '',
    '## Risks',
    '- Key evidence gaps or risks.',
    '',
    '## Open Questions',
    '- What still needs validation.',
    '',
  ].join('\n');
  writeFileSync(state.analysisPath, content, 'utf-8');
}

function readAnalysisMarkdown(state) {
  return readIfExists(state.analysisPath, TEXT_LIMITS.markdown);
}

function parseAnalysis(markdown) {
  const sections = splitHeadingSections(markdown, '##');
  const titleMatch = String(markdown || '').match(/^#\s+(.+)$/m);
  return {
    title: safeTrim(titleMatch?.[1], 200) || 'Competitive Analysis',
    executiveSummary: sectionToParagraph(sections.get('executive summary'), 1200),
    productRead: sectionToParagraph(sections.get('product read'), 1600),
    competitorSet: sectionToItems(sections.get('competitor set'), 12, 500),
    positioningGap: sectionToParagraph(sections.get('positioning gap'), 1600),
    likelyChannels: sectionToItems(sections.get('likely acquisition channels'), 12, 500),
    messagingStrengths: sectionToItems(sections.get('messaging strengths'), 12, 500),
    messagingWeaknesses: sectionToItems(sections.get('messaging weaknesses'), 12, 500),
    patternsToAvoid: sectionToItems(sections.get('patterns to avoid'), 12, 500),
    recommendedPositioning: sectionToParagraph(sections.get('recommended positioning'), 1600),
    recommendedMoves: sectionToItems(sections.get('recommended moves'), 12, 500),
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
    project_dir: state.config.projectDir,
    project_context: buildProjectContextBlock(state),
    analysis_path: state.analysisPath,
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    market_focus: state.config.marketFocus || '(none)',
    project_dir: state.config.projectDir,
    project_context: buildProjectContextBlock(state),
    analysis_markdown: readAnalysisMarkdown(state) || '_Analysis file missing or empty._',
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
    project_dir: state.config.projectDir,
    project_context: buildProjectContextBlock(state),
    analysis_path: state.analysisPath,
    analysis_markdown: readAnalysisMarkdown(state) || '_Analysis file missing or empty._',
    review_feedback: buildReviewFeedbackBlock(state),
  });
}

function createRound(phase, cycleIndex) {
  return {
    phase,
    cycleIndex,
    responses: [],
  };
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
    displayName: meta.displayName || 'Competitive Analysis Room',
    role: meta.role || 'system',
    agentId: meta.agentId || null,
  });
}

function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE) return [];
  if (phase === PHASES.WRITE || phase === PHASES.REVISE) {
    return state.author ? [{
      agentId: state.author.agentId,
      message: phase === PHASES.WRITE
        ? buildWritePrompt(state, state.author)
        : buildRevisePrompt(state, state.author),
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
  const markdown = readAnalysisMarkdown(state);
  return markdown ? [{
    title: path.basename(state.analysisPath),
    language: 'markdown',
    path: state.analysisPath,
    content: markdown,
  }] : [];
}

function emitMetrics(ctx, state) {
  const parsed = parseAnalysis(readAnalysisMarkdown(state));
  const contributorStatus = {};
  for (const participant of state.participants) {
    contributorStatus[participant.displayName] = state.agentStatus[participant.agentId] || 'idle';
  }
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    analysisPhase: { active: state.phase },
    analysisProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    analysisCounts: {
      competitors: parsed.competitorSet.length,
      channels: parsed.likelyChannels.length,
      risks: parsed.risks.length,
      questions: parsed.openQuestions.length,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    analysisArtifacts: { blocks: buildArtifactBlocks(state) },
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
        ? `Starting write pass for ${state.analysisPath}.`
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
  const objective = safeTrim(ctx?.objective, 2400) || 'Competitive analysis';
  const participants = getParticipants(ctx);
  const state = {
    objective,
    config: {
      ...config,
      projectDir,
      outputDir,
    },
    analysisPath: outputDir ? path.join(outputDir, config.fileName) : '',
    participants,
    author: participants.find((participant) => participant.role === 'analyst') || null,
    reviewers: participants.filter((participant) => participant.role !== 'analyst'),
    phase: PHASES.WRITE,
    cycleCount: 1,
    maxCycles: Math.max(1, Math.min(Number(ctx?.limits?.maxCycles) || manifest.limits?.maxCycles?.default || 4, manifest.limits?.maxCycles?.max || 6)),
    rounds: [],
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    projectContext: collectProjectContext(projectDir),
    feedEntries: [],
    missingRoles: [],
  };
  state.missingRoles = findMissingRoles(state);
  appendFeed(state, `Competitive analysis room ready for ${objective}.`);
  if (state.projectContext.summary) {
    appendFeed(state, `Project read: ${state.projectContext.summary}`);
  }
  return state;
}

function stopForMissingRoles(ctx, state) {
  appendFeed(state, `Cannot start without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `missing_required_roles:${state.missingRoles.join(',')}` };
}

function stopForMissingPaths(ctx, state) {
  const missing = [];
  if (!state.config.projectDir) missing.push('projectDir');
  if (!state.config.outputDir) missing.push('outputDir');
  appendFeed(state, `Cannot start without required paths: ${missing.join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason: `missing_required_paths:${missing.join(',')}` };
}

function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Competitive analysis complete. Review ${state.analysisPath}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.WRITE || state.phase === PHASES.REVISE) {
    const exists = state.analysisPath && existsSync(state.analysisPath);
    appendFeed(
      state,
      exists
        ? `${titleCase(state.phase)} pass finished. Analysis file is present.`
        : `${titleCase(state.phase)} pass finished, but the analysis file is still missing.`,
    );
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const reviewSummary = summarizeReviews(ensureRound(state, PHASES.REVIEW, state.cycleCount));
    appendFeed(state, `Review pass collected ${reviewSummary.mustChange.length} required change${reviewSummary.mustChange.length === 1 ? '' : 's'}.`);
    if (reviewSummary.mustChange.length === 0) {
      return finalizeRoom(ctx, state, 'convergence');
    }
    if (state.cycleCount >= state.maxCycles) {
      return finalizeRoom(ctx, state, 'cycle_limit');
    }
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
  const parsed = parseAnalysis(readAnalysisMarkdown(state));
  return {
    contract: 'competitive_analysis_bundle.v1',
    summary: {
      title: parsed.title,
      oneLiner: parsed.executiveSummary,
      recommendedDirection: parsed.recommendedPositioning || (parsed.recommendedMoves[0] || ''),
    },
    productRead: parsed.productRead,
    competitorSet: parsed.competitorSet,
    positioningGap: parsed.positioningGap,
    likelyChannels: parsed.likelyChannels,
    messagingStrengths: parsed.messagingStrengths,
    messagingWeaknesses: parsed.messagingWeaknesses,
    patternsToAvoid: parsed.patternsToAvoid,
    recommendedPositioning: parsed.recommendedPositioning,
    recommendedMoves: parsed.recommendedMoves,
    risks: parsed.risks,
    openQuestions: parsed.openQuestions,
    markdown: parsed.markdown,
    provenance: {
      roomType: 'competitive_analysis_room',
      generatedAt: new Date().toISOString(),
      objective: state.objective,
      projectDir: state.config.projectDir,
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
      if (!state.config.projectDir || !state.config.outputDir) return stopForMissingPaths(ctx, state);
      seedAnalysisFile(state);
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
            bundle.likelyChannels[0] || '',
          ].filter(Boolean),
          outcome: state.phase === PHASES.COMPLETE ? 'competitive_analysis_ready' : 'competitive_analysis_partial',
        },
        metrics: {
          cycles: state.cycleCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts: state.analysisPath && existsSync(state.analysisPath)
          ? [{ type: 'markdown', path: state.analysisPath, label: path.basename(state.analysisPath) }]
          : [],
        handoffPayloads: [
          {
            contract: 'competitive_analysis_bundle.v1',
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
