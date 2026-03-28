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
    fileName: safeTrim(roomConfig.fileName || 'marketing-execution.md', 240) || 'marketing-execution.md',
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

function extractPlanContext(ctx) {
  const payloads = Array.isArray(ctx?.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const bundle = payloads.find((payload) => payload?.contract === 'marketing_plan_bundle.v1' && payload?.data);
  if (!bundle?.data || typeof bundle.data !== 'object') return null;
  const data = bundle.data;
  return {
    title: safeTrim(data?.summary?.title, 200),
    oneLiner: safeTrim(data?.summary?.oneLiner, 1200),
    recommendedDirection: safeTrim(data?.summary?.recommendedDirection, 1200),
    positioning: safeTrim(data?.positioning, 1600),
    audience: safeTrim(data?.audience, 1600),
    messagingPillars: normalizeList(data?.messagingPillars, 12, 500),
    channelPriorities: normalizeList(data?.channelPriorities, 12, 500),
    campaignBets: normalizeList(data?.campaignBets, 12, 500),
    assetPlan: normalizeList(data?.assetPlan, 12, 500),
    launchPlan: normalizeList(data?.launchPlan, 12, 500),
    successMetrics: normalizeList(data?.successMetrics, 12, 500),
    risks: normalizeList(data?.risks, 10, 500),
  };
}

function buildPlanContextBlock(state) {
  if (!state.planContext) return 'No inbound marketing plan bundle provided.';
  const plan = state.planContext;
  return [
    plan.title ? `Title: ${plan.title}` : '',
    plan.oneLiner ? `Summary: ${plan.oneLiner}` : '',
    plan.recommendedDirection ? `Recommended direction: ${plan.recommendedDirection}` : '',
    plan.positioning ? `Positioning: ${plan.positioning}` : '',
    plan.audience ? `Audience: ${plan.audience}` : '',
    plan.messagingPillars.length > 0 ? `Messaging pillars:\n- ${plan.messagingPillars.join('\n- ')}` : '',
    plan.channelPriorities.length > 0 ? `Channel priorities:\n- ${plan.channelPriorities.join('\n- ')}` : '',
    plan.campaignBets.length > 0 ? `Campaign bets:\n- ${plan.campaignBets.join('\n- ')}` : '',
    plan.assetPlan.length > 0 ? `Asset plan:\n- ${plan.assetPlan.join('\n- ')}` : '',
    plan.launchPlan.length > 0 ? `Launch plan:\n- ${plan.launchPlan.join('\n- ')}` : '',
    plan.successMetrics.length > 0 ? `Success metrics:\n- ${plan.successMetrics.join('\n- ')}` : '',
    plan.risks.length > 0 ? `Risks:\n- ${plan.risks.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n');
}

function seedSummaryFile(state) {
  if (!state.summaryPath) return;
  if (existsSync(state.summaryPath)) return;
  mkdirSync(state.config.outputDir, { recursive: true });
  const title = `${state.objective || 'Marketing Execution'}`.trim();
  const content = [
    `# ${title}`,
    '',
    '## Executive Summary',
    '- Summarize what was produced and why.',
    '',
    '## Selected Priorities',
    '- Which plan priorities are being executed here?',
    '',
    '## Asset Inventory',
    '- List each created asset file and what it is for.',
    '',
    '## Messaging Notes',
    '- Call out key copy and positioning choices.',
    '',
    '## Launch Checklist',
    '- What still needs to happen before launch?',
    '',
    '## Risks',
    '- What still feels weak or incomplete?',
    '',
    '## Open Questions',
    '- What still needs validation?',
    '',
  ].join('\n');
  writeFileSync(state.summaryPath, content, 'utf-8');
}

function readSummaryMarkdown(state) {
  return readIfExists(state.summaryPath, TEXT_LIMITS.markdown);
}

function parseSummary(markdown) {
  const sections = splitHeadingSections(markdown, '##');
  const titleMatch = String(markdown || '').match(/^#\s+(.+)$/m);
  return {
    title: safeTrim(titleMatch?.[1], 200) || 'Marketing Execution',
    executiveSummary: sectionToParagraph(sections.get('executive summary'), 1200),
    selectedPriorities: sectionToItems(sections.get('selected priorities'), 12, 500),
    assetInventory: sectionToItems(sections.get('asset inventory'), 20, 500),
    messagingNotes: sectionToItems(sections.get('messaging notes'), 12, 500),
    launchChecklist: sectionToItems(sections.get('launch checklist'), 12, 500),
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

function collectArtifactFiles(outputDir, summaryPath) {
  const root = safeTrim(outputDir, 4000);
  if (!root || !existsSync(root)) return [];
  const summaryResolved = summaryPath ? path.resolve(summaryPath) : '';
  const results = [];

  function walk(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const resolved = path.resolve(fullPath);
      if (resolved === summaryResolved) continue;
      results.push(resolved);
      if (results.length >= 40) return;
    }
  }

  walk(root);
  return results;
}

function guessArtifactType(targetPath) {
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === '.html') return 'html';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif') return 'image';
  if (ext === '.md') return 'markdown';
  if (ext === '.json') return 'json';
  return 'text';
}

function buildAssetInventoryBlock(state) {
  const files = collectArtifactFiles(state.config.outputDir, state.summaryPath);
  if (files.length === 0) return '- No non-summary assets found yet.';
  return files.map((file) => `- ${path.relative(state.config.outputDir, file)}`).join('\n');
}

function buildWritePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    objective: state.objective,
    project_context: state.projectContext?.block || 'No project context available.',
    plan_context: buildPlanContextBlock(state),
    summary_path: state.summaryPath,
    output_dir: state.config.outputDir,
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    project_context: state.projectContext?.block || 'No project context available.',
    plan_context: buildPlanContextBlock(state),
    summary_markdown: readSummaryMarkdown(state) || '_Execution summary file missing or empty._',
    asset_inventory: buildAssetInventoryBlock(state),
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
    project_context: state.projectContext?.block || 'No project context available.',
    plan_context: buildPlanContextBlock(state),
    summary_path: state.summaryPath,
    output_dir: state.config.outputDir,
    summary_markdown: readSummaryMarkdown(state) || '_Execution summary file missing or empty._',
    asset_inventory: buildAssetInventoryBlock(state),
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
    displayName: meta.displayName || 'Marketing Execution Room',
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
  const markdown = readSummaryMarkdown(state);
  return markdown ? [{
    title: path.basename(state.summaryPath),
    language: 'markdown',
    path: state.summaryPath,
    content: markdown,
  }] : [];
}

function emitMetrics(ctx, state) {
  const parsed = parseSummary(readSummaryMarkdown(state));
  const contributorStatus = {};
  for (const participant of state.participants) {
    contributorStatus[participant.displayName] = state.agentStatus[participant.agentId] || 'idle';
  }
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    executionPhase: { active: state.phase },
    executionProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    executionCounts: {
      assets: collectArtifactFiles(state.config.outputDir, state.summaryPath).length,
      priorities: parsed.selectedPriorities.length,
      risks: parsed.risks.length,
      questions: parsed.openQuestions.length,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    executionArtifacts: { blocks: buildArtifactBlocks(state) },
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
        ? `Starting write pass for ${state.summaryPath}.`
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
  const objective = safeTrim(ctx?.objective, 2400) || 'Marketing execution';
  const participants = getParticipants(ctx);
  const state = {
    objective,
    config: { ...config, projectDir, outputDir },
    summaryPath: outputDir ? path.join(outputDir, config.fileName) : '',
    participants,
    author: participants.find((participant) => participant.role === 'operator') || null,
    reviewers: participants.filter((participant) => participant.role !== 'operator'),
    phase: PHASES.WRITE,
    cycleCount: 1,
    maxCycles: Math.max(1, Math.min(Number(ctx?.limits?.maxCycles) || manifest.limits?.maxCycles?.default || 4, manifest.limits?.maxCycles?.max || 6)),
    rounds: [],
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    projectContext: collectProjectContext(projectDir),
    planContext: extractPlanContext(ctx),
    feedEntries: [],
    missingRoles: [],
  };
  state.missingRoles = findMissingRoles(state);
  appendFeed(state, `Marketing execution room ready for ${objective}.`);
  if (state.projectContext.summary) appendFeed(state, `Project read: ${state.projectContext.summary}`);
  if (state.planContext?.oneLiner) appendFeed(state, `Marketing plan context: ${state.planContext.oneLiner}`);
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
  appendFeed(state, `Marketing execution complete. Review ${state.summaryPath}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.WRITE || state.phase === PHASES.REVISE) {
    const exists = state.summaryPath && existsSync(state.summaryPath);
    appendFeed(
      state,
      exists
        ? `${titleCase(state.phase)} pass finished. Execution summary file is present.`
        : `${titleCase(state.phase)} pass finished, but the execution summary file is still missing.`,
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
  const parsed = parseSummary(readSummaryMarkdown(state));
  const assetFiles = collectArtifactFiles(state.config.outputDir, state.summaryPath);
  return {
    contract: 'marketing_execution_bundle.v1',
    summary: {
      title: parsed.title,
      oneLiner: parsed.executiveSummary,
      recommendedDirection: parsed.selectedPriorities[0] || parsed.assetInventory[0] || '',
    },
    selectedPriorities: parsed.selectedPriorities,
    assetInventory: parsed.assetInventory,
    messagingNotes: parsed.messagingNotes,
    launchChecklist: parsed.launchChecklist,
    risks: parsed.risks,
    openQuestions: parsed.openQuestions,
    artifacts: assetFiles.map((artifactPath) => ({
      kind: guessArtifactType(artifactPath),
      path: artifactPath,
      label: path.relative(state.config.outputDir, artifactPath),
      primary: false,
    })),
    markdown: parsed.markdown,
    provenance: {
      roomType: 'marketing_execution_room',
      generatedAt: new Date().toISOString(),
      objective: state.objective,
      projectDir: state.config.projectDir,
      sourceMarketingPlan: state.planContext?.title || '',
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
      seedSummaryFile(state);
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
      const artifacts = [];
      if (state.summaryPath && existsSync(state.summaryPath)) {
        artifacts.push({ type: 'markdown', path: state.summaryPath, label: path.basename(state.summaryPath), primary: true });
      }
      for (const artifact of bundle.artifacts) {
        artifacts.push({ type: artifact.kind, path: artifact.path, label: artifact.label, primary: false });
      }
      return {
        summary: {
          title: bundle.summary.title,
          highlights: [
            bundle.summary.oneLiner,
            bundle.summary.recommendedDirection,
            bundle.assetInventory[0] || '',
          ].filter(Boolean),
          outcome: state.phase === PHASES.COMPLETE ? 'marketing_execution_ready' : 'marketing_execution_partial',
        },
        metrics: {
          cycles: state.cycleCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts,
        handoffPayloads: [
          {
            contract: 'marketing_execution_bundle.v1',
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
