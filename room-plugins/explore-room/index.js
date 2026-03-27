import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));
const promptsDir = path.join(__dirname, 'prompts');
const promptTemplates = {
  explore: readFileSync(path.join(promptsDir, 'explore.md'), 'utf-8'),
  refine: readFileSync(path.join(promptsDir, 'refine.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
};

const PHASES = {
  EXPLORE: 'explore',
  REFINE: 'refine',
  REVIEW: 'review',
  SYNTHESIZE: 'synthesize',
  COMPLETE: 'complete',
};

const TEXT_LIMITS = {
  response: 60000,
  summary: 1200,
  item: 800,
  paragraph: 2400,
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

function canonicalKey(value) {
  return safeTrim(value, 300)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value) {
  return safeTrim(value, 120)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

function splitHeadingSections(markdown, headingPrefix = '##') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let current = null;

  for (const line of lines) {
    const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = line.match(new RegExp(`^\\s*${escaped}\\s+(.+)$`));
    if (match) {
      current = canonicalKey(match[1]);
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current) {
      sections.get(current).push(line);
    }
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

function inferSeedModeFromObjective(objective) {
  const text = safeTrim(objective, 2400);
  if (!text) return 'domain_search';

  const normalized = text.toLowerCase();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  let score = 0;

  if (text.length >= 80) score += 2;
  if (wordCount >= 8) score += 2;
  if (/[.:;!?]/.test(text)) score += 1;
  if (/\b(app|product|platform|tool|room|workflow|pipeline|feature|dashboard|system|prototype)\b/.test(normalized)) score += 1;
  if (/\b(help|helps|let|lets|allow|allows|build|create|design|manage|save|compare|prototype|orchestrate|plan)\b/.test(normalized)) score += 1;
  if (/\b(that|which|for)\b/.test(normalized)) score += 1;
  if (wordCount <= 3) score -= 2;

  return score >= 2 ? 'refine_seeded_concept' : 'domain_search';
}

function buildSeedGuidance(seedMode) {
  if (seedMode === 'refine_seeded_concept') {
    return [
      'Treat the seed as an already-selected concept.',
      'Keep the underlying business and product thesis fixed.',
      'Your job is to identify the product core, required user flows, prototype focus, non-mock functionality, and implementation boundaries that matter most for the prototype room.',
      'Refine and sharpen the concept for prototyping; do not reinvent it into a different business.',
    ].join(' ');
  }

  return [
    'Treat the seed as a space to search.',
    'Your job is to find the single strongest concept direction worth sending into Prototype Room next.',
    'Choose the best business/product concept, then make the prototype-driving components explicit.',
  ].join(' ');
}

function getConfig(ctx, objective) {
  const roomConfig = ctx?.roomConfig || {};
  const modeMap = {
    auto: 'auto',
    'domain search': 'domain_search',
    domain_search: 'domain_search',
    'refine seeded concept': 'refine_seeded_concept',
    refine_seeded_concept: 'refine_seeded_concept',
  };
  const requestedMode = modeMap[safeTrim(roomConfig.seedMode, 80).toLowerCase()] || 'auto';
  const labelMap = {
    auto: 'Auto',
    domain_search: 'Domain Search',
    refine_seeded_concept: 'Refine Seeded Concept',
  };
  const resolvedMode = requestedMode === 'auto'
    ? inferSeedModeFromObjective(objective)
    : requestedMode;
  const resolvedLabel = labelMap[resolvedMode] || 'Auto';
  return {
    requestedSeedMode: requestedMode,
    requestedSeedModeLabel: labelMap[requestedMode] || 'Auto',
    seedMode: resolvedMode,
    seedModeLabel: requestedMode === 'auto'
      ? `Auto (detected: ${resolvedLabel})`
      : resolvedLabel,
    resolvedSeedModeLabel: resolvedLabel,
    seedGuidance: buildSeedGuidance(resolvedMode),
  };
}

function inferConceptBaseName(participant) {
  const displayName = safeTrim(participant?.displayName, 120).toLowerCase();
  if (displayName) {
    if (/(openai|gpt)/.test(displayName)) return 'openai';
    if (/(anthropic|claude)/.test(displayName)) return 'claude';
    if (/(google|gemini)/.test(displayName)) return 'gemini';
    const fallback = displayName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (fallback) return fallback;
  }

  const fields = [
    participant?.profile?.name,
    participant?.profile?.model,
    participant?.profile?.provider,
    participant?.agentId,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(openai|gpt)/.test(fields)) return 'openai';
  if (/(anthropic|claude)/.test(fields)) return 'claude';
  if (/(google|gemini)/.test(fields)) return 'gemini';
  return safeTrim(participant?.displayName || participant?.agentId || 'concept', 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'concept';
}

function getParticipants(ctx) {
  const participants = Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role === 'explorer')
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
          profile: participant.profile || null,
        }))
    : [];

  const counts = {};
  return participants.map((participant) => {
    const base = inferConceptBaseName(participant);
    counts[base] = (counts[base] || 0) + 1;
    const suffix = counts[base] > 1 ? `-${counts[base]}` : '';
    return {
      ...participant,
      conceptKey: `${base}${suffix}`,
    };
  });
}

function findMissingRoles(participants) {
  const minCount = manifest.roles?.minCount || {};
  const counts = {};
  for (const participant of participants) {
    counts[participant.role] = (counts[participant.role] || 0) + 1;
  }
  return Object.entries(minCount)
    .filter(([role, min]) => (counts[role] || 0) < min)
    .map(([role]) => role);
}

function createRound(phase, cycleIndex) {
  return {
    phase,
    cycleIndex,
    label: `Cycle ${cycleIndex} — ${titleCase(phase)}`,
    responses: [],
  };
}

function ensureRound(state, phase, cycleIndex) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.cycleIndex === cycleIndex);
  if (!round) {
    round = createRound(phase, cycleIndex);
    state.rounds.push(round);
  }
  return round;
}

function upsertRoundResponse(round, participant, response) {
  const text = safeTrim(response?.response, TEXT_LIMITS.response);
  const next = {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    conceptKey: participant.conceptKey,
    response: text,
    status: safeTrim(response?.status, 120) || 'submitted',
    summary: excerpt(text, 220) || 'No response summary available.',
  };

  const index = round.responses.findIndex((entry) => entry.agentId === participant.agentId);
  if (index >= 0) {
    round.responses[index] = next;
  } else {
    round.responses.push(next);
  }
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
    content: safeTrim(content, 4000),
    createdAt: Date.now(),
    displayName: meta.displayName || 'Explore Room',
    role: meta.role || 'system',
    agentId: meta.agentId || null,
  });
}

function parseConceptResponse(responseText, participant) {
  const sections = splitHeadingSections(responseText, '##');
  const title = sectionToParagraph(sections.get('title'), 200) || titleCase(participant.conceptKey);
  return {
    agentId: participant.agentId,
    displayName: participant.displayName,
    conceptKey: participant.conceptKey,
    title,
    oneLiner: sectionToParagraph(sections.get('one liner'), 300),
    targetUser: sectionToParagraph(sections.get('target user'), 300),
    problem: sectionToParagraph(sections.get('problem'), 700),
    coreValue: sectionToParagraph(sections.get('core value'), 400),
    requiredUserFlows: sectionToItems(sections.get('required user flows'), 10, 400),
    prototypeFocus: sectionToItems(sections.get('prototype focus'), 10, 400),
    nonMockFunctionality: sectionToItems(sections.get('non mock functionality'), 10, 400),
    implementationBoundaries: sectionToItems(sections.get('implementation boundaries'), 10, 400),
    risks: sectionToItems(sections.get('risks'), 8, 400),
    whyThisCouldWin: sectionToParagraph(sections.get('why this could win'), 500),
    openQuestions: sectionToItems(sections.get('open questions'), 8, 400),
    markdown: safeTrim(responseText, TEXT_LIMITS.response),
  };
}

function getConceptPhaseForCycle(cycleIndex) {
  return cycleIndex <= 1 ? PHASES.EXPLORE : PHASES.REFINE;
}

function getConceptsForCycle(state, cycleIndex = state.cycleCount) {
  const round = ensureRound(state, getConceptPhaseForCycle(cycleIndex), cycleIndex);
  return round.responses.map((response) => {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId) || {
      agentId: response.agentId,
      displayName: response.displayName,
      conceptKey: response.conceptKey,
    };
    return parseConceptResponse(response.response, participant);
  });
}

function getLatestConcepts(state) {
  return getConceptsForCycle(state, state.cycleCount);
}

function getParticipantConceptForCycle(state, participant, cycleIndex) {
  return getConceptsForCycle(state, cycleIndex).find((concept) => concept.agentId === participant.agentId) || null;
}

function buildConceptMarkdown(candidate) {
  return [
    `# ${candidate.title}`,
    '',
    candidate.oneLiner || '_No one-liner provided._',
    '',
    '## Target User',
    candidate.targetUser || '- None yet.',
    '',
    '## Problem',
    candidate.problem || '- None yet.',
    '',
    '## Core Value',
    candidate.coreValue || '- None yet.',
    '',
    '## Required User Flows',
    ...(candidate.requiredUserFlows.length > 0 ? candidate.requiredUserFlows.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Prototype Focus',
    ...(candidate.prototypeFocus.length > 0 ? candidate.prototypeFocus.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Non-Mock Functionality',
    ...(candidate.nonMockFunctionality.length > 0 ? candidate.nonMockFunctionality.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Implementation Boundaries',
    ...(candidate.implementationBoundaries.length > 0 ? candidate.implementationBoundaries.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Risks',
    ...(candidate.risks.length > 0 ? candidate.risks.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Why This Could Win',
    candidate.whyThisCouldWin || '- None yet.',
    '',
    '## Open Questions',
    ...(candidate.openQuestions.length > 0 ? candidate.openQuestions.map((item) => `- ${item}`) : ['- None yet.']),
  ].join('\n');
}

function buildPeerCatalog(state, participant) {
  const peers = getLatestConcepts(state).filter((candidate) => candidate.agentId !== participant.agentId);
  if (peers.length === 0) return '- None.';
  return peers.map((candidate) => [
    `### ${candidate.conceptKey}`,
    `- Title: ${candidate.title}`,
    candidate.oneLiner ? `- One-liner: ${candidate.oneLiner}` : '',
    candidate.targetUser ? `- Target user: ${candidate.targetUser}` : '',
    candidate.problem ? `- Problem: ${candidate.problem}` : '',
    candidate.coreValue ? `- Core value: ${candidate.coreValue}` : '',
    candidate.requiredUserFlows.length > 0 ? `- Required user flows: ${candidate.requiredUserFlows.join(' | ')}` : '',
    candidate.prototypeFocus.length > 0 ? `- Prototype focus: ${candidate.prototypeFocus.join(' | ')}` : '',
    candidate.nonMockFunctionality.length > 0 ? `- Non-mock functionality: ${candidate.nonMockFunctionality.join(' | ')}` : '',
    candidate.implementationBoundaries.length > 0 ? `- Implementation boundaries: ${candidate.implementationBoundaries.join(' | ')}` : '',
    candidate.risks.length > 0 ? `- Risks: ${candidate.risks.join(' | ')}` : '',
    candidate.whyThisCouldWin ? `- Why this could win: ${candidate.whyThisCouldWin}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function buildExplorePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.explore, {
    display_name: participant.displayName,
    objective: state.objective,
    seed_mode_label: state.config.seedModeLabel,
    seed_guidance: state.config.seedGuidance,
  });
}

function buildRefinePrompt(state, participant) {
  const selected = state.synthesis?.selected || null;
  const previousConcept = state.cycleCount > 1
    ? getParticipantConceptForCycle(state, participant, state.cycleCount - 1)
    : null;

  return renderPromptTemplate(promptTemplates.refine, {
    display_name: participant.displayName,
    objective: state.objective,
    seed_mode_label: state.config.seedModeLabel,
    seed_guidance: state.config.seedGuidance,
    cycle_index: String(state.cycleCount),
    max_cycles: String(state.maxCycles),
    selected_concept_markdown: selected ? buildConceptMarkdown(selected) : '_No selected concept yet._',
    synthesis_markdown: safeTrim(state.synthesis?.markdown, 12000) || '_No synthesis yet._',
    previous_concept_markdown: previousConcept ? buildConceptMarkdown(previousConcept) : '_No previous concept brief yet._',
    refinement_targets: selected?.mustChange?.length
      ? selected.mustChange.map((item) => `- ${item}`).join('\n')
      : '- None yet.',
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    seed_mode_label: state.config.seedModeLabel,
    seed_guidance: state.config.seedGuidance,
    cycle_index: String(state.cycleCount),
    peer_catalog: buildPeerCatalog(state, participant),
  });
}

function findParticipantForTarget(state, targetName) {
  const key = canonicalKey(targetName);
  return state.participants.find((participant) => (
    canonicalKey(participant.conceptKey) === key
    || canonicalKey(participant.displayName) === key
  )) || null;
}

function sectionToScore(lines) {
  const text = sectionToParagraph(lines, 80);
  const match = text.match(/\b(10|[1-9])(?:\.\d+)?\b/);
  return match ? Number(match[1]) : null;
}

function parseReviewTargets(responseText, state) {
  const text = String(responseText || '').replace(/\r\n/g, '\n');
  const targetMatches = Array.from(text.matchAll(/^##\s*Target:\s*(.+)$/gim));
  if (targetMatches.length === 0) return [];

  return targetMatches.map((match, index) => {
    const targetName = safeTrim(match[1], 120);
    const start = match.index + match[0].length;
    const end = index + 1 < targetMatches.length ? targetMatches[index + 1].index : text.length;
    const block = text.slice(start, end);
    const sections = splitHeadingSections(block, '###');
    const participant = findParticipantForTarget(state, targetName);
    if (!participant) return null;
    return {
      targetAgentId: participant.agentId,
      targetConceptKey: participant.conceptKey,
      score: sectionToScore(sections.get('score')),
      keep: sectionToItems(sections.get('keep'), 10, 400),
      mustChange: sectionToItems(sections.get('must change'), 10, 400),
      risks: sectionToItems(sections.get('risks'), 10, 400),
      whyItWinsOrLoses: sectionToItems(sections.get('why it wins or loses'), 5, 400),
    };
  }).filter(Boolean);
}

function summarizeReviewRound(round, state) {
  const parsed = (round?.responses || []).map((response) => ({
    reviewer: response,
    targets: parseReviewTargets(response.response, state),
  }));

  const reviewBlockCount = parsed.reduce((sum, entry) => sum + entry.targets.length, 0);
  const mustChangeCount = parsed.reduce((sum, entry) => (
    sum + entry.targets.reduce((inner, target) => inner + target.mustChange.length, 0)
  ), 0);

  return {
    parsed,
    reviewBlockCount,
    mustChangeCount,
  };
}

function mergeUnique(items, maxItems = 8) {
  return normalizeList(items, maxItems, 400);
}

function synthesizeConcepts(state) {
  const concepts = getLatestConcepts(state);
  const reviewSummary = summarizeReviewRound(ensureRound(state, PHASES.REVIEW, state.cycleCount), state);
  const ranking = concepts.map((concept) => {
    const reviews = reviewSummary.parsed.flatMap((entry) => entry.targets)
      .filter((target) => target.targetAgentId === concept.agentId);
    const scored = reviews.filter((review) => typeof review.score === 'number');
    const averageScore = scored.length > 0
      ? scored.reduce((sum, review) => sum + review.score, 0) / scored.length
      : 0;
    return {
      ...concept,
      averageScore,
      reviewCount: scored.length,
      keep: mergeUnique(reviews.flatMap((review) => review.keep), 10),
      mustChange: mergeUnique(reviews.flatMap((review) => review.mustChange), 10),
      risks: mergeUnique(reviews.flatMap((review) => review.risks), 10),
      whyItWinsOrLoses: mergeUnique(reviews.flatMap((review) => review.whyItWinsOrLoses), 8),
    };
  }).sort((left, right) => {
    if (right.averageScore !== left.averageScore) return right.averageScore - left.averageScore;
    if (left.mustChange.length !== right.mustChange.length) return left.mustChange.length - right.mustChange.length;
    return left.title.localeCompare(right.title);
  }).map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));

  const selected = ranking[0] || null;
  const synthesis = {
    cycleIndex: state.cycleCount,
    ranked: ranking,
    selected,
    reviewBlockCount: reviewSummary.reviewBlockCount,
    mustChangeCount: reviewSummary.mustChangeCount,
    markdown: buildSynthesisMarkdown(state, ranking),
  };
  state.synthesis = synthesis;
  return synthesis;
}

function buildSynthesisMarkdown(state, ranked) {
  if (!Array.isArray(ranked) || ranked.length === 0) return 'No concept synthesis available.';
  const leader = ranked[0];
  return [
    `# Explore Room Synthesis`,
    '',
    `Cycle: **${state.cycleCount} / ${state.maxCycles}**`,
    '',
    `Seed interpretation: **${state.config.seedModeLabel}**`,
    '',
    state.config.seedGuidance,
    '',
    `Selected concept: **${leader.title}**`,
    '',
    '## Why This Direction',
    leader.oneLiner ? `- ${leader.oneLiner}` : '- No one-liner provided.',
    leader.whyThisCouldWin ? `- ${leader.whyThisCouldWin}` : '- No explicit rationale provided.',
    '',
    '## Prototype Focus',
    ...(leader.prototypeFocus.length > 0 ? leader.prototypeFocus.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Required User Flows',
    ...(leader.requiredUserFlows.length > 0 ? leader.requiredUserFlows.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Non-Mock Functionality',
    ...(leader.nonMockFunctionality.length > 0 ? leader.nonMockFunctionality.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Implementation Boundaries',
    ...(leader.implementationBoundaries.length > 0 ? leader.implementationBoundaries.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    '## Leaderboard',
    ...ranked.map((entry) => `- #${entry.rank} ${entry.title} — ${entry.averageScore.toFixed(1)} / 10 (${entry.reviewCount} reviews)`),
  ].join('\n');
}

function buildConceptBundle(state) {
  const synthesis = state.synthesis || synthesizeConcepts(state);
  const selected = synthesis.selected;
  if (!selected) {
    return {
      contract: 'concept_bundle.v1',
      summary: {
        title: 'No concept selected',
        oneLiner: '',
        recommendedDirection: 'Run Explore Room again with more concrete concept briefs.',
      },
      seed: {
        objective: state.objective,
        requestedMode: state.config.requestedSeedMode,
        requestedModeLabel: state.config.requestedSeedModeLabel,
        resolvedMode: state.config.seedMode,
        resolvedModeLabel: state.config.resolvedSeedModeLabel,
        guidance: state.config.seedGuidance,
      },
      selectedConcept: null,
      alternatives: [],
      leaderboard: [],
      provenance: {
        roomType: 'explore_room',
        generatedAt: new Date().toISOString(),
        seedMode: state.config.seedMode,
        requestedSeedMode: state.config.requestedSeedMode,
        cycleCount: state.cycleCount,
        objective: state.objective,
      },
    };
  }

  return {
    contract: 'concept_bundle.v1',
    summary: {
      title: selected.title,
      oneLiner: selected.oneLiner,
      recommendedDirection: selected.mustChange.length > 0
        ? (state.config.seedMode === 'refine_seeded_concept'
            ? `Prototype the seeded concept using ${selected.title} as the guide, but address: ${selected.mustChange.slice(0, 2).join(' | ')}`
            : `Prototype ${selected.title}, but address: ${selected.mustChange.slice(0, 2).join(' | ')}`)
        : (state.config.seedMode === 'refine_seeded_concept'
            ? `Prototype the seeded concept using ${selected.title} as the guide.`
            : `Prototype ${selected.title}.`),
    },
    seed: {
      objective: state.objective,
      requestedMode: state.config.requestedSeedMode,
      requestedModeLabel: state.config.requestedSeedModeLabel,
      resolvedMode: state.config.seedMode,
      resolvedModeLabel: state.config.resolvedSeedModeLabel,
      guidance: state.config.seedGuidance,
    },
    selection: {
      mode: state.config.seedMode,
      conceptId: selected.conceptKey,
      conceptTitle: selected.title,
    },
    selectedConcept: {
      id: selected.conceptKey,
      title: selected.title,
      oneLiner: selected.oneLiner,
      targetUser: selected.targetUser,
      problem: selected.problem,
      coreValue: selected.coreValue,
      requiredUserFlows: selected.requiredUserFlows,
      prototypeFocus: selected.prototypeFocus,
      nonMockFunctionality: selected.nonMockFunctionality,
      implementationBoundaries: selected.implementationBoundaries,
      risks: selected.risks,
      openQuestions: selected.openQuestions,
      whyThisCouldWin: selected.whyThisCouldWin,
      improvementTargets: selected.mustChange,
    },
    alternatives: synthesis.ranked.slice(1).map((entry) => ({
      id: entry.conceptKey,
      title: entry.title,
      oneLiner: entry.oneLiner,
      averageScore: Number(entry.averageScore.toFixed(2)),
      whyItLost: entry.mustChange[0] || entry.risks[0] || '',
    })),
    leaderboard: synthesis.ranked.map((entry) => ({
      rank: entry.rank,
      conceptId: entry.conceptKey,
      conceptTitle: entry.title,
      averageScore: Number(entry.averageScore.toFixed(2)),
      reviewCount: entry.reviewCount,
      mustChangeCount: entry.mustChange.length,
      riskCount: entry.risks.length,
    })),
    provenance: {
      roomType: 'explore_room',
      generatedAt: new Date().toISOString(),
      seedMode: state.config.seedMode,
      requestedSeedMode: state.config.requestedSeedMode,
      cycleCount: state.cycleCount,
      objective: state.objective,
    },
  };
}

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => {
    const concept = (round.phase === PHASES.EXPLORE || round.phase === PHASES.REFINE)
      ? parseConceptResponse(response.response, { conceptKey: response.conceptKey, displayName: response.displayName, agentId: response.agentId })
      : null;
    return {
      phase: `Cycle ${round.cycleIndex} — ${titleCase(round.phase)}`,
      contributor: response.displayName,
      concept: concept?.title || (round.phase === PHASES.REVIEW ? response.conceptKey : '-'),
      status: titleCase(response.status),
      summary: excerpt(response.response, 220) || 'No response summary available.',
    };
  }));
}

function buildLeaderboardRows(state) {
  const ranked = state.synthesis?.ranked || [];
  if (ranked.length === 0) {
    return getLatestConcepts(state).map((concept) => ({
      rank: '-',
      concept: concept.title,
      score: '-',
      reviews: '-',
      mustChange: '-',
      risks: '-',
      status: 'Awaiting review',
    }));
  }

  return ranked.map((entry) => ({
    rank: String(entry.rank),
    concept: entry.title,
    score: entry.reviewCount > 0 ? entry.averageScore.toFixed(1) : '-',
    reviews: String(entry.reviewCount),
    mustChange: String(entry.mustChange.length),
    risks: String(entry.risks.length),
    status: entry.rank === 1
      ? (entry.mustChange.length === 0 ? 'Selected concept, no required changes' : 'Selected concept')
      : 'Alternative direction',
  }));
}

function buildArtifactBlocks(state) {
  const conceptBlocks = state.rounds
    .filter((round) => round.phase === PHASES.EXPLORE || round.phase === PHASES.REFINE)
    .flatMap((round) => round.responses.map((response) => {
      const participant = state.participants.find((entry) => entry.agentId === response.agentId) || {
        agentId: response.agentId,
        displayName: response.displayName,
        conceptKey: response.conceptKey,
      };
      const concept = parseConceptResponse(response.response, participant);
      return {
        title: `Cycle ${round.cycleIndex}: ${concept.title} (${concept.conceptKey})`,
        language: 'markdown',
        content: buildConceptMarkdown(concept),
      };
    }));

  if (state.synthesis?.markdown) {
    conceptBlocks.push({
      title: 'Explore Room Synthesis',
      language: 'markdown',
      content: state.synthesis.markdown,
    });
  }

  return conceptBlocks;
}

function emitMetrics(ctx, state) {
  const displayNameCounts = {};
  for (const participant of state.participants) {
    const name = participant.displayName || participant.agentId;
    displayNameCounts[name] = (displayNameCounts[name] || 0) + 1;
  }

  const contributorStatus = {};
  for (const participant of state.participants) {
    const baseName = participant.displayName || participant.agentId;
    const label = displayNameCounts[baseName] > 1 ? `${baseName} (${participant.agentId})` : baseName;
    contributorStatus[label] = state.agentStatus[participant.agentId] || 'idle';
  }

  const selected = state.synthesis?.selected || null;
  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    explorePhase: { active: state.phase },
    conceptCounts: {
      concepts: getLatestConcepts(state).length,
      reviews: ensureRound(state, PHASES.REVIEW, state.cycleCount).responses.length,
      flows: selected?.requiredUserFlows?.length || 0,
      boundaries: selected?.implementationBoundaries?.length || 0,
    },
    contributorStatus,
    leaderboardTable: { rows: buildLeaderboardRows(state) },
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries.slice(-40) },
    conceptArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: state.phase === PHASES.COMPLETE ? buildArtifactBlocks(state) : [] },
  });
}

function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE || phase === PHASES.SYNTHESIZE) return [];
  return state.participants.map((participant) => ({
    agentId: participant.agentId,
    message: phase === PHASES.EXPLORE
      ? buildExplorePrompt(state, participant)
      : phase === PHASES.REFINE
        ? buildRefinePrompt(state, participant)
        : buildReviewPrompt(state, participant),
  }));
}

function buildPendingTargetsForPhase(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  const completed = new Set(round.responses.map((response) => response.agentId));
  return buildTargetsForPhase(state, phase).filter((target) => !completed.has(target.agentId));
}

function issuePhaseDecision(ctx, state, phase, options = {}) {
  state.phase = phase;
  ensureRound(state, phase, state.cycleCount);

  const targets = options.pendingOnly
    ? buildPendingTargetsForPhase(state, phase)
    : buildTargetsForPhase(state, phase);

  updateAgentStatuses(state, targets.map((target) => target.agentId), 'assigned');
  appendFeed(
    state,
    options.pendingOnly
      ? `Resuming ${phase} pass — ${targets.length} contributor(s) remaining.`
      : (phase === PHASES.EXPLORE
          ? `Starting explore pass for seed mode ${state.config.seedModeLabel}.`
          : phase === PHASES.REFINE
            ? `Starting refine pass for cycle ${state.cycleCount}.`
            : `Starting peer review for cycle ${state.cycleCount}.`),
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
      label: options.pendingOnly ? `resume-${phase}` : `${phase}-${state.cycleCount}`,
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
  const participants = getParticipants(ctx);
  const objective = safeTrim(ctx?.objective, 2400) || 'No seed provided.';
  const config = getConfig(ctx, objective);
  const configuredMaxCycles = Number(ctx?.limits?.maxCycles);
  const manifestDefault = manifest.limits?.maxCycles?.default || 2;
  const manifestMax = manifest.limits?.maxCycles?.max || 5;
  const maxCycles = Number.isFinite(configuredMaxCycles)
    ? Math.max(1, Math.min(Math.trunc(configuredMaxCycles), manifestMax))
    : manifestDefault;
  return {
    objective,
    config,
    participants,
    phase: PHASES.EXPLORE,
    cycleCount: 1,
    maxCycles,
    rounds: [],
    synthesis: null,
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    missingRoles: findMissingRoles(participants),
    feedEntries: [
      {
        id: 'feed-1',
        content: `Explore Room ready. Seed mode: ${config.seedModeLabel}.`,
        createdAt: Date.now(),
        displayName: 'Explore Room',
        role: 'system',
        agentId: null,
      },
    ],
  };
}

function stopForMissingRoles(ctx, state) {
  appendFeed(state, `Cannot start Explore Room without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `missing_required_roles:${state.missingRoles.join(',')}`,
  };
}

function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, 'Explore room complete. The selected concept bundle is ready for downstream rooms.');
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.EXPLORE || state.phase === PHASES.REFINE) {
    const conceptCount = ensureRound(state, state.phase, state.cycleCount).responses.length;
    appendFeed(state, `Collected ${conceptCount} concept brief${conceptCount === 1 ? '' : 's'}.`);
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const summary = summarizeReviewRound(ensureRound(state, PHASES.REVIEW, state.cycleCount), state);
    appendFeed(state, `Collected ${summary.reviewBlockCount} peer review block${summary.reviewBlockCount === 1 ? '' : 's'}.`);
    state.phase = PHASES.SYNTHESIZE;
    const synthesis = synthesizeConcepts(state);
    if (synthesis.selected) {
      appendFeed(state, `${synthesis.selected.title} is the selected concept at ${synthesis.selected.averageScore.toFixed(1)} / 10.`);
    }
    if (summary.mustChangeCount === 0) {
      appendFeed(state, 'No material refinements were requested in review. Ending exploration.');
      return finalizeRoom(ctx, state, 'convergence');
    }
    if (state.cycleCount >= state.maxCycles) {
      appendFeed(state, `Reached the cycle limit at cycle ${state.cycleCount} with remaining refinement requests.`);
      return finalizeRoom(ctx, state, 'cycle_limit');
    }
    state.cycleCount += 1;
    return issuePhaseDecision(ctx, state, PHASES.REFINE);
  }

  appendFeed(state, `Unexpected collected-response continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `unexpected_resume_phase:${state.phase}`,
  };
}

function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
  }));
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
      if (state.missingRoles.length > 0) {
        return stopForMissingRoles(ctx, state);
      }
      return issuePhaseDecision(ctx, state, PHASES.EXPLORE);
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState() || createInitialState(ctx);
      mergeResponsesIntoRound(state, state.phase, responses);
      if (state.phase === PHASES.EXPLORE || state.phase === PHASES.REFINE || state.phase === PHASES.REVIEW) {
        return continueFromCollectedResponses(ctx, state);
      }

      appendFeed(state, `Unexpected fan-out completion while in phase "${state.phase}".`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `unexpected_fan_out_phase:${state.phase}`,
      };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState() || createInitialState(ctx);
      appendFeed(state, `Received unexpected single-turn response from ${turnResult?.agentId || 'unknown agent'}.`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: 'unexpected_single_turn',
      };
    },

    onEvent(ctx, event) {
      const state = ctx.getState() || createInitialState(ctx);

      if (event?.type === 'fan_out_partial' && event.agentId) {
        if (event.progress?.completedAgentIds) {
          updateAgentStatuses(state, event.progress.completedAgentIds, 'submitted');
        }
        if (event.progress?.pendingAgentIds) {
          updateAgentStatuses(state, event.progress.pendingAgentIds, 'assigned');
        }
        state.agentStatus[event.agentId] = 'submitted';
        const round = ensureRound(state, state.phase, state.cycleCount);
        const participant = state.participants.find((entry) => entry.agentId === event.agentId);
        if (participant && event.detail?.response) {
          upsertRoundResponse(round, participant, {
            response: event.detail.response,
            status: 'submitted',
          });
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
        return {
          type: 'pause',
          reason: `participant_disconnected:${event.agentId}`,
        };
      }

      return null;
    },

    async onResume(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      emitMetrics(ctx, state);
      if (state.phase === PHASES.COMPLETE) return null;

      const activeFanOut = typeof ctx.getActiveFanOut === 'function'
        ? ctx.getActiveFanOut()
        : null;
      if (activeFanOut?.pendingAgentIds?.length > 0) {
        updateAgentStatuses(state, activeFanOut.completedAgentIds || [], 'submitted');
        updateAgentStatuses(state, activeFanOut.pendingAgentIds, 'assigned');
        appendFeed(state, `Resuming ${state.phase} pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'continue_fan_out' };
      }

      const targets = buildPendingTargetsForPhase(state, state.phase);
      if (targets.length > 0) {
        return issuePhaseDecision(ctx, state, state.phase, { pendingOnly: true });
      }

      const phaseResponses = getPhaseResponses(state, state.phase);
      if (phaseResponses.length > 0) {
        return continueFromCollectedResponses(ctx, state);
      }

      return null;
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (!pendingDecision || pendingDecision.type !== 'fan_out' || !state) {
        return pendingDecision;
      }
      const targets = buildPendingTargetsForPhase(state, state.phase);
      return targets.length > 0 ? { ...pendingDecision, targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state?.participants?.length) return null;
      const bundle = buildConceptBundle(state);
      const selected = bundle.selectedConcept;

      return {
        summary: {
          title: bundle.summary.title,
          highlights: [
            bundle.summary.oneLiner,
            bundle.summary.recommendedDirection,
            selected?.prototypeFocus?.[0] || '',
          ].filter(Boolean).slice(0, 6),
          outcome: state.phase === PHASES.COMPLETE ? 'concept_bundle_ready' : 'concept_bundle_partial',
        },
        metrics: {
          cycles: state.cycleCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts: [],
        handoffPayloads: [
          {
            contract: 'concept_bundle.v1',
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
