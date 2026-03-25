import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));
const promptsDir = path.join(__dirname, 'prompts');
const promptTemplates = {
  write: readFileSync(path.join(promptsDir, 'research.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'critique.md'), 'utf-8'),
  revise: readFileSync(path.join(promptsDir, 'final-write.md'), 'utf-8'),
};

const PHASES = {
  WRITE: 'write',
  REVIEW: 'review',
  REVISE: 'revise',
  COMPLETE: 'complete',
};

const SPEC_TEXT_LIMITS = {
  summary: 8000,
  problem: 30000,
  shortItem: 2000,
  mediumItem: 4000,
  longItem: 8000,
  parsedLine: 20000,
  paragraph: 30000,
  storedResponse: 100000,
};

const ROLE_FOCUS = {
  planner: {
    short: 'Product clarity, scope, user value',
    review: 'Review the spec for product clarity, scope discipline, goals, and user value.',
  },
  critic: {
    short: 'Ambiguity, risks, cuts',
    review: 'Review the spec for ambiguity, missing constraints, risks, and scope that should be cut or deferred.',
  },
  implementer: {
    short: 'Author and maintain the canonical spec',
    write: 'Inspect the repo/docs/contracts and author the initial spec file directly.',
    revise: 'Apply reviewer feedback to the same spec file while keeping the document coherent and buildable.',
  },
  researcher: {
    short: 'Patterns, precedents, repo grounding',
    review: 'Review the spec for grounding, precedents, and alignment with observed repo patterns and contracts.',
  },
};

function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function stripListPrefix(value, maxLen = SPEC_TEXT_LIMITS.parsedLine) {
  return safeTrim(String(value ?? ''), maxLen)
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

function canonicalKey(value) {
  return stripListPrefix(value)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeList(values, maxItems = 12, itemLen = SPEC_TEXT_LIMITS.shortItem) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    const cleaned = stripListPrefix(String(value ?? ''), itemLen);
    const key = canonicalKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(cleaned);
    if (deduped.length >= maxItems) break;
  }

  return deduped;
}

function titleCase(value) {
  return safeTrim(value, 80)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function excerpt(value, maxLen = 220) {
  const text = safeTrim(value, maxLen + 20).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

function sanitizeFileName(value, fallbackStem = 'spec-room') {
  const raw = safeTrim(value, 240);
  const stem = safeTrim(raw.replace(/\.md$/i, ''), 200)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedStem = stem && stem !== '.' && stem !== '..'
    ? stem
    : fallbackStem;
  return `${normalizedStem}.md`;
}

function getConfig(ctx) {
  const roomConfig = ctx?.roomConfig || {};
  const deliverableTypeMap = {
    product_spec: 'product_spec',
    'product spec': 'product_spec',
    technical_spec: 'technical_spec',
    'technical spec': 'technical_spec',
    implementation_plan: 'implementation_plan',
    'implementation plan': 'implementation_plan',
  };
  const audienceMap = {
    mixed: 'mixed',
    engineering: 'engineering',
    product: 'product',
  };
  const detailLevelMap = {
    concise: 'concise',
    balanced: 'balanced',
    detailed: 'detailed',
  };

  return {
    deliverableType: deliverableTypeMap[safeTrim(roomConfig.deliverableType, 80).toLowerCase()] || 'technical_spec',
    audience: audienceMap[safeTrim(roomConfig.audience, 80).toLowerCase()] || 'engineering',
    detailLevel: detailLevelMap[safeTrim(roomConfig.detailLevel, 80).toLowerCase()] || 'detailed',
    mustInclude: dedupeList(roomConfig.mustInclude || [], 8),
    knownConstraints: dedupeList(roomConfig.knownConstraints || [], 8),
    outputDir: safeTrim(roomConfig.outputDir, 4000),
    fileName: safeTrim(roomConfig.fileName, 240),
  };
}

function getParticipants(ctx) {
  return Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role && ROLE_FOCUS[participant.role])
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
        }))
    : [];
}

function findMissingRoles(participants) {
  const counts = {};
  for (const participant of participants) {
    counts[participant.role] = (counts[participant.role] || 0) + 1;
  }

  const minCount = manifest.roles?.minCount || {};
  return Object.entries(minCount)
    .filter(([role, min]) => (counts[role] || 0) < min)
    .map(([role]) => role);
}

function inferTitle(objective) {
  const words = safeTrim(objective, 200)
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (words.length === 0) return 'Untitled Spec';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function selectAuthor(participants) {
  return participants.find((participant) => participant.role === 'implementer')
    || participants[0]
    || null;
}

function selectReviewers(participants, authorAgentId) {
  const roleRank = { planner: 1, critic: 2, researcher: 3, implementer: 4 };
  return participants
    .filter((participant) => participant.agentId !== authorAgentId)
    .sort((left, right) => {
      const leftRank = roleRank[left.role] || 99;
      const rightRank = roleRank[right.role] || 99;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.displayName.localeCompare(right.displayName);
    });
}

function getMaxPasses(ctx) {
  const configured = Number(ctx?.limits?.maxCycles);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.max(1, Math.min(Math.trunc(configured), manifest.limits?.maxCycles?.max || 4));
  }
  return manifest.limits?.maxCycles?.default || 4;
}

function buildSpecFileTarget(config) {
  if (!config.outputDir || !config.fileName) return null;
  const fileName = sanitizeFileName(config.fileName, 'spec-room');
  const outputDir = path.resolve(config.outputDir);
  return {
    outputDir,
    path: path.join(outputDir, fileName),
  };
}

function createInitialState(ctx) {
  const participants = getParticipants(ctx);
  const objective = safeTrim(ctx?.objective, 2400) || 'No objective provided.';
  const config = getConfig(ctx);
  const author = selectAuthor(participants);
  const reviewers = selectReviewers(participants, author?.agentId || null);
  const specTarget = buildSpecFileTarget(config);

  return {
    objective,
    config,
    participants,
    authorAgentId: author?.agentId || null,
    reviewerAgentIds: reviewers.map((participant) => participant.agentId),
    maxPasses: getMaxPasses(ctx),
    passCount: 0,
    phase: PHASES.WRITE,
    rounds: [],
    draftSpec: null,
    finalSpec: null,
    currentSpecMarkdown: '',
    specFilePath: specTarget?.path || '',
    exportedSpecPath: '',
    exportError: '',
    finalRevisionPass: false,
    missingRoles: findMissingRoles(participants),
    feedEntries: [
      {
        displayName: 'Spec Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Captured objective: ${excerpt(objective, 180)}`,
      },
      {
        displayName: 'Spec Room',
        role: 'system',
        createdAt: Date.now(),
        content: specTarget
          ? `Canonical spec file: ${specTarget.path}`
          : 'Spec Room needs an export directory and export file name from the room setup UI before it can start.',
      },
    ],
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    disconnectedAgents: [],
  };
}

function buildRoundLabel(phase, passIndex) {
  return `Pass ${passIndex} — ${titleCase(phase)}`;
}

function ensureRound(state, phase, passIndex = state.passCount) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.passIndex === passIndex);
  if (!round) {
    round = {
      phase,
      passIndex,
      label: buildRoundLabel(phase, passIndex),
      responses: [],
    };
    state.rounds.push(round);
  }
  return round;
}

function getLatestRound(state, phase) {
  return state.rounds
    .filter((entry) => entry.phase === phase)
    .sort((left, right) => right.passIndex - left.passIndex)[0] || null;
}

function appendFeed(state, content, extra = {}) {
  const entry = {
    displayName: extra.displayName || 'Spec Room',
    role: extra.role || 'system',
    agentId: extra.agentId || null,
    createdAt: typeof extra.createdAt === 'number' ? extra.createdAt : Date.now(),
    content: safeTrim(content, 1200),
  };
  if (!entry.content) return;
  state.feedEntries.push(entry);
  if (state.feedEntries.length > 60) {
    state.feedEntries = state.feedEntries.slice(-60);
  }
}

function formatConfigSummary(config) {
  const lines = [
    `Deliverable type: ${titleCase(config.deliverableType)}`,
    `Audience: ${titleCase(config.audience)}`,
    `Detail level: ${titleCase(config.detailLevel)}`,
  ];

  if (config.mustInclude.length > 0) {
    lines.push(`Must include: ${config.mustInclude.map((item) => `"${item}"`).join(', ')}`);
  }
  if (config.knownConstraints.length > 0) {
    lines.push(`Known constraints: ${config.knownConstraints.map((item) => `"${item}"`).join(', ')}`);
  }

  return lines.join('\n');
}

function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

function buildWritePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.write, {
    display_name: participant.displayName,
    role_title: titleCase(participant.role),
    role_focus: ROLE_FOCUS[participant.role]?.write || ROLE_FOCUS.implementer.write,
    config_summary: formatConfigSummary(state.config),
    objective: state.objective,
    spec_file_path: state.specFilePath,
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    role_title: titleCase(participant.role),
    role_focus: ROLE_FOCUS[participant.role]?.review || 'Review the current spec from your assigned lens.',
    config_summary: formatConfigSummary(state.config),
    objective: state.objective,
    spec_file_path: state.specFilePath,
    spec_markdown: state.currentSpecMarkdown || renderSpecMarkdown(state.draftSpec, state),
  });
}

function buildRevisePrompt(state, participant) {
  const latestReviewRound = getLatestRound(state, PHASES.REVIEW);
  const prompt = renderPromptTemplate(promptTemplates.revise, {
    display_name: participant.displayName,
    role_title: titleCase(participant.role),
    role_focus: ROLE_FOCUS[participant.role]?.revise || ROLE_FOCUS.implementer.revise,
    config_summary: formatConfigSummary(state.config),
    objective: state.objective,
    spec_file_path: state.specFilePath,
    spec_markdown: state.currentSpecMarkdown || renderSpecMarkdown(state.draftSpec, state),
    review_feedback: buildReviewFeedback(latestReviewRound),
  });

  if (!state.finalRevisionPass) return prompt;

  return `${prompt}\nThis is the final revise pass before the room stops. Apply the highest-value requested changes now.`;
}

function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE) return [];

  if (phase === PHASES.WRITE || phase === PHASES.REVISE) {
    const author = state.participants.find((participant) => participant.agentId === state.authorAgentId);
    if (!author) return [];
    return [{
      agentId: author.agentId,
      message: phase === PHASES.WRITE
        ? buildWritePrompt(state, author)
        : buildRevisePrompt(state, author),
    }];
  }

  return state.participants
    .filter((participant) => state.reviewerAgentIds.includes(participant.agentId))
    .map((participant) => ({
      agentId: participant.agentId,
      message: buildReviewPrompt(state, participant),
    }));
}

function normalizeSpec(payload, state, stage) {
  const spec = payload && typeof payload === 'object' ? payload : {};
  const objective = state.objective;

  const normalized = {
    title: safeTrim(spec.title, 160) || inferTitle(objective),
    summary: safeTrim(spec.summary, SPEC_TEXT_LIMITS.summary) || `Spec ${stage === 'draft' ? 'draft' : 'revision'} for ${inferTitle(objective)}.`,
    problem: safeTrim(spec.problem, SPEC_TEXT_LIMITS.problem) || objective,
    goals: dedupeList(spec.goals, 12, SPEC_TEXT_LIMITS.shortItem),
    nonGoals: dedupeList(spec.nonGoals, 12, SPEC_TEXT_LIMITS.shortItem),
    assumptions: dedupeList(spec.assumptions, 12, SPEC_TEXT_LIMITS.mediumItem),
    prerequisites: dedupeList(spec.prerequisites, 12, SPEC_TEXT_LIMITS.mediumItem),
    proposal: dedupeList(spec.proposal, 16, SPEC_TEXT_LIMITS.longItem),
    acceptanceCriteria: dedupeList(spec.acceptanceCriteria, 16, SPEC_TEXT_LIMITS.mediumItem),
    implementationPlan: dedupeList(spec.implementationPlan, 16, SPEC_TEXT_LIMITS.longItem),
    risks: dedupeList(spec.risks, 12, SPEC_TEXT_LIMITS.mediumItem),
    openQuestions: dedupeList(spec.openQuestions, 12, SPEC_TEXT_LIMITS.mediumItem),
  };

  if (normalized.goals.length === 0) {
    normalized.goals = [`Produce a useful ${titleCase(state.config.deliverableType)} for the stated objective.`];
  }
  if (normalized.proposal.length === 0) {
    normalized.proposal = ['Clarify the objective, constraints, and v1 shape before implementation begins.'];
  }
  if (normalized.acceptanceCriteria.length === 0) {
    normalized.acceptanceCriteria = ['The work can be judged complete without re-explaining the objective.'];
  }
  if (normalized.implementationPlan.length === 0) {
    normalized.implementationPlan = ['Break the approved scope into concrete implementation tasks.'];
  }

  return normalized;
}

function renderSection(title, items, ordered = false) {
  if (!Array.isArray(items) || items.length === 0) return `## ${title}\n- None yet.`;
  const lines = items.map((item, index) => ordered ? `${index + 1}. ${item}` : `- ${item}`);
  return `## ${title}\n${lines.join('\n')}`;
}

function renderSpecMarkdown(spec, state) {
  if (!spec) return 'No spec available yet.';

  const parts = [
    `# ${spec.title}`,
    '',
    spec.summary,
    '',
    `> Deliverable: ${titleCase(state.config.deliverableType)} | Audience: ${titleCase(state.config.audience)} | Detail: ${titleCase(state.config.detailLevel)}`,
    '',
    '## Problem',
    spec.problem,
  ];

  if (state.config.knownConstraints.length > 0) {
    parts.push('', renderSection('Known Constraints', state.config.knownConstraints));
  }
  if (state.config.mustInclude.length > 0) {
    parts.push('', renderSection('Must Include', state.config.mustInclude));
  }

  parts.push(
    '',
    renderSection('Goals', spec.goals),
    '',
    renderSection('Non-Goals', spec.nonGoals),
    '',
    renderSection('Assumptions', spec.assumptions),
    '',
    renderSection('Prerequisites', spec.prerequisites),
    '',
    renderSection('Proposed Approach', spec.proposal),
    '',
    renderSection('Acceptance Criteria', spec.acceptanceCriteria),
    '',
    renderSection('Implementation Plan', spec.implementationPlan, true),
    '',
    renderSection('Risks', spec.risks),
    '',
    renderSection('Open Questions', spec.openQuestions),
  );

  return parts.join('\n');
}

function extractMarkdownTitle(markdown) {
  const match = String(markdown || '').match(/^\s*#\s+(.+)$/m);
  return safeTrim(match?.[1], 160);
}

function splitMarkdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  const summaryLines = [];
  let currentSection = null;
  let seenTitle = false;

  for (const line of lines) {
    if (!seenTitle && /^\s*#\s+/.test(line)) {
      seenTitle = true;
      continue;
    }

    const headingMatch = line.match(/^\s*##\s+(.+)$/);
    if (headingMatch) {
      currentSection = canonicalKey(headingMatch[1]);
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }

    if (currentSection) {
      sections.get(currentSection).push(line);
    } else if (seenTitle) {
      summaryLines.push(line);
    }
  }

  const summary = safeTrim(
    summaryLines
      .map((line) => safeTrim(line, SPEC_TEXT_LIMITS.parsedLine))
      .filter((line) => line && !line.startsWith('>'))
      .join(' '),
    SPEC_TEXT_LIMITS.summary,
  );

  return { sections, summary };
}

function sectionToItems(lines, maxItems = 12, itemLen = SPEC_TEXT_LIMITS.shortItem) {
  if (!Array.isArray(lines)) return [];
  return dedupeList(
    lines
      .map((line) => safeTrim(line, itemLen))
      .filter((line) => line && !line.startsWith('>')),
    maxItems,
    itemLen,
  );
}

function sectionToParagraph(lines, maxLen = SPEC_TEXT_LIMITS.paragraph) {
  if (!Array.isArray(lines)) return '';
  return safeTrim(
    lines
      .map((line) => stripListPrefix(line, SPEC_TEXT_LIMITS.parsedLine))
      .filter((line) => line && !line.startsWith('>'))
      .join(' '),
    maxLen,
  );
}

function parseFinalSpecMarkdown(markdown, state) {
  const parsedTitle = extractMarkdownTitle(markdown);
  const titleKey = canonicalKey(parsedTitle);
  const title = (
    parsedTitle
    && titleKey
    && !['title', 'spec', 'product spec', 'technical spec', 'implementation plan', 'new room'].includes(titleKey)
  ) ? parsedTitle : inferTitle(state.objective);
  const { sections, summary } = splitMarkdownSections(markdown);

  const problem = sectionToParagraph(sections.get('problem'), SPEC_TEXT_LIMITS.problem);
  const goals = sectionToItems(sections.get('goals'));
  const nonGoals = sectionToItems(sections.get('non goals'));
  const assumptions = sectionToItems(sections.get('assumptions'), 12, SPEC_TEXT_LIMITS.mediumItem);
  const prerequisites = sectionToItems(sections.get('prerequisites'), 12, SPEC_TEXT_LIMITS.mediumItem);
  const proposal = sectionToItems(sections.get('proposed approach'), 16, SPEC_TEXT_LIMITS.longItem);
  const acceptanceCriteria = sectionToItems(sections.get('acceptance criteria'), 16, SPEC_TEXT_LIMITS.mediumItem);
  const implementationPlan = sectionToItems(sections.get('implementation plan'), 16, SPEC_TEXT_LIMITS.longItem);
  const risks = sectionToItems(sections.get('risks'), 12, SPEC_TEXT_LIMITS.mediumItem);
  const openQuestions = sectionToItems(sections.get('open questions'), 12, SPEC_TEXT_LIMITS.mediumItem);

  const presentSections = [
    problem ? 'problem' : '',
    goals.length > 0 ? 'goals' : '',
    proposal.length > 0 ? 'proposed approach' : '',
    acceptanceCriteria.length > 0 ? 'acceptance criteria' : '',
    implementationPlan.length > 0 ? 'implementation plan' : '',
  ].filter(Boolean);

  if (presentSections.length < 4) {
    return {
      ok: false,
      reason: `missing_required_sections:${presentSections.join(',') || 'none'}`,
    };
  }

  return {
    ok: true,
    spec: normalizeSpec({
      title,
      summary,
      problem,
      goals,
      nonGoals,
      assumptions,
      prerequisites,
      proposal,
      acceptanceCriteria,
      implementationPlan,
      risks,
      openQuestions,
    }, state, 'final'),
  };
}

function parseReviewResponse(responseText) {
  const { sections } = splitMarkdownSections(responseText);
  const hasStructuredSections = ['verdict', 'keep', 'must change', 'nice to have', 'risks', 'open questions']
    .some((key) => sections.has(key));

  if (!hasStructuredSections) {
    return {
      verdict: 'revise',
      keep: [],
      mustChange: ['Reviewer response did not follow the required review structure.'],
      niceToHave: [],
      risks: [],
      openQuestions: [],
    };
  }

  const verdictText = sectionToParagraph(sections.get('verdict'), 120).toLowerCase();
  const mustChange = sectionToItems(sections.get('must change'), 20, SPEC_TEXT_LIMITS.mediumItem);
  const niceToHave = sectionToItems(sections.get('nice to have'), 20, SPEC_TEXT_LIMITS.mediumItem);

  let verdict = 'revise';
  if (mustChange.length === 0 && verdictText.includes('approve')) {
    verdict = 'approve';
  } else if (mustChange.length === 0 && !verdictText) {
    verdict = 'approve';
  }

  return {
    verdict,
    keep: sectionToItems(sections.get('keep'), 20, SPEC_TEXT_LIMITS.mediumItem),
    mustChange,
    niceToHave,
    risks: sectionToItems(sections.get('risks'), 20, SPEC_TEXT_LIMITS.mediumItem),
    openQuestions: sectionToItems(sections.get('open questions'), 20, SPEC_TEXT_LIMITS.mediumItem),
  };
}

function summarizeReviewRound(round) {
  const results = (round?.responses || []).map((response) => ({
    response,
    parsed: parseReviewResponse(response.response),
  }));

  const mustChangeCount = results.reduce((total, entry) => total + entry.parsed.mustChange.length, 0);
  const approvalCount = results.filter((entry) => entry.parsed.verdict === 'approve').length;

  return {
    results,
    reviewerCount: results.length,
    approvalCount,
    mustChangeCount,
    needsRevision: results.some((entry) => entry.parsed.verdict !== 'approve' || entry.parsed.mustChange.length > 0),
  };
}

function buildReviewFeedback(round) {
  const blocks = [];
  let totalChars = 0;

  for (const response of round?.responses || []) {
    const block = [
      `### ${response.displayName} (${titleCase(response.role)})`,
      safeTrim(response.response, 5000),
    ].join('\n');

    const nextLength = block.length + (blocks.length > 0 ? 2 : 0);
    if (blocks.length > 0 && totalChars + nextLength > 18000) break;
    blocks.push(block);
    totalChars += nextLength;
  }

  return blocks.join('\n\n') || '(none yet)';
}

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => ({
    phase: round.label,
    contributor: response.displayName,
    role: titleCase(response.role),
    focus: ROLE_FOCUS[response.role]?.short || titleCase(response.role),
    status: response.status || 'submitted',
    summary: excerpt(response.response, 180) || 'No response summary available.',
  })));
}

function buildArtifactMetric(state) {
  if (!state.finalSpec) return null;
  return {
    blocks: [
      {
        title: state.finalSpec.title || 'Final Spec',
        language: 'markdown',
        content: renderSpecMarkdown(state.finalSpec, state),
        path: state.exportedSpecPath || undefined,
        footer: state.exportedSpecPath
          ? `Saved to ${state.exportedSpecPath}`
          : (state.exportError ? `Spec file issue: ${state.exportError}` : undefined),
      },
    ],
  };
}

function buildSpecBundle(state) {
  const spec = state.finalSpec || state.draftSpec;
  if (!spec) return null;

  const markdown = state.currentSpecMarkdown || renderSpecMarkdown(spec, state);
  const primaryPath = state.exportedSpecPath || state.specFilePath || '';
  const recommendedDirection = spec.proposal?.[0]
    || spec.implementationPlan?.[0]
    || `Use ${spec.title} as the canonical ${titleCase(state.config.deliverableType)}.`;

  return {
    contract: 'spec_bundle.v1',
    data: {
      summary: {
        title: spec.title,
        oneLiner: spec.summary,
        recommendedDirection: safeTrim(recommendedDirection, SPEC_TEXT_LIMITS.shortItem),
      },
      artifacts: primaryPath
        ? [{
            kind: 'markdown',
            path: primaryPath,
            label: 'Canonical spec',
            primary: true,
          }]
        : [],
      spec: {
        title: spec.title,
        markdown,
        problem: spec.problem,
        goals: spec.goals || [],
        nonGoals: spec.nonGoals || [],
        assumptions: spec.assumptions || [],
        prerequisites: spec.prerequisites || [],
        proposal: spec.proposal || [],
        acceptanceCriteria: spec.acceptanceCriteria || [],
        implementationPlan: spec.implementationPlan || [],
        risks: spec.risks || [],
        openQuestions: spec.openQuestions || [],
      },
      deliverableType: state.config.deliverableType,
      audience: state.config.audience,
      detailLevel: state.config.detailLevel,
      provenance: {
        roomType: 'spec_room',
        generatedAt: new Date().toISOString(),
        specFilePath: primaryPath || null,
        passCount: state.passCount,
      },
    },
  };
}

function emitMetrics(ctx, state) {
  const activeSpec = state.finalSpec || state.draftSpec;
  const completedContributors = new Set(
    state.rounds.flatMap((round) => round.responses.map((response) => response.agentId)),
  );

  const displayNameCounts = {};
  for (const participant of state.participants) {
    const name = participant.displayName || participant.agentId;
    displayNameCounts[name] = (displayNameCounts[name] || 0) + 1;
  }

  const contributorStatus = {};
  for (const participant of state.participants) {
    const baseName = participant.displayName || participant.agentId;
    const label = displayNameCounts[baseName] > 1
      ? `${baseName} (${participant.agentId})`
      : baseName;
    contributorStatus[label] = state.agentStatus[participant.agentId] || 'idle';
  }

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    specPhase: { active: state.phase },
    specProgress: { value: Math.max(state.passCount, 1), max: state.maxPasses },
    specCounts: {
      contributors: completedContributors.size,
      criteria: activeSpec?.acceptanceCriteria?.length || 0,
      questions: activeSpec?.openQuestions?.length || 0,
      tasks: activeSpec?.implementationPlan?.length || 0,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    roomFeed: { entries: state.feedEntries },
    specArtifacts: buildArtifactMetric(state),
    finalArtifacts: buildArtifactMetric(state),
  });
}

function updateAgentStatuses(state, agentIds, status) {
  for (const agentId of agentIds) {
    state.agentStatus[agentId] = status;
  }
}

function getRoundResponseMap(round) {
  const responses = new Map();
  for (const response of round?.responses || []) {
    if (!response?.agentId) continue;
    responses.set(response.agentId, response);
  }
  return responses;
}

function getCompletedAgentIdsForCurrentPass(state) {
  const round = ensureRound(state, state.phase, state.passCount);
  const completed = new Set(Array.from(getRoundResponseMap(round).keys()));

  for (const [agentId, status] of Object.entries(state.agentStatus || {})) {
    if (status === 'submitted') completed.add(agentId);
  }

  return completed;
}

function buildPendingTargetsForPhase(state, phase) {
  const completed = getCompletedAgentIdsForCurrentPass(state);
  return buildTargetsForPhase(state, phase)
    .filter((target) => !completed.has(target.agentId));
}

function upsertRoundResponse(round, participant, response) {
  const responseMap = getRoundResponseMap(round);
  responseMap.set(participant.agentId, {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    response: safeTrim(response.response, SPEC_TEXT_LIMITS.storedResponse),
    status: response.rejected ? `rejected: ${safeTrim(response.rejectionReason, 120)}` : (response.status || 'submitted'),
  });
  round.responses = Array.from(responseMap.values());
}

function issuePhaseDecision(ctx, state, phase, options = {}) {
  if (!options.pendingOnly && !options.preservePassCount) {
    state.passCount += 1;
  }

  state.phase = phase;
  state.finalRevisionPass = Boolean(options.preservePassCount && phase === PHASES.REVISE);
  ensureRound(state, phase, state.passCount);

  const targets = options.pendingOnly
    ? buildPendingTargetsForPhase(state, phase)
    : buildTargetsForPhase(state, phase);

  updateAgentStatuses(
    state,
    targets.map((target) => target.agentId),
    'assigned',
  );

  const phaseMessage = options.pendingOnly
    ? (phase === PHASES.WRITE
        ? `Resuming write pass — ${targets.length} contributor(s) remaining.`
        : (phase === PHASES.REVIEW
            ? `Resuming review pass — ${targets.length} contributor(s) remaining.`
            : `Resuming revise pass — ${targets.length} contributor(s) remaining.`))
    : (options.preservePassCount && phase === PHASES.REVISE
        ? `Starting final revise pass against ${state.specFilePath}.`
        : (phase === PHASES.WRITE
        ? `Starting write pass. ${state.specFilePath} is the canonical spec file.`
        : (phase === PHASES.REVIEW
            ? `Starting review pass against ${state.specFilePath}.`
            : `Starting revise pass against ${state.specFilePath}.`)));

  appendFeed(state, phaseMessage);
  ctx.setCycle(state.passCount);
  ctx.setState(state);
  emitMetrics(ctx, state);

  return {
    type: 'fan_out',
    targets,
    metadata: {
      phase,
      pass: state.passCount,
      specFilePath: state.specFilePath,
      label: options.pendingOnly ? `resume-${phase}-${state.passCount}` : `${phase}-${state.passCount}`,
    },
  };
}

function mergeResponsesIntoRound(state, phase, responses) {
  const round = ensureRound(state, phase, state.passCount);

  for (const response of Array.isArray(responses) ? responses : []) {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId);
    if (!participant) continue;
    upsertRoundResponse(round, participant, response);
  }

  updateAgentStatuses(
    state,
    state.participants.map((participant) => participant.agentId),
    'idle',
  );
}

function stopForMissingRoles(ctx, state) {
  appendFeed(
    state,
    `Cannot start Spec Room without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`,
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `missing_required_roles:${state.missingRoles.join(',')}`,
  };
}

function stopForMissingSpecPath(ctx, state) {
  appendFeed(
    state,
    'Cannot start Spec Room without an export directory and export file name from the room setup UI.',
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: 'missing_spec_output_path',
  };
}

function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.passCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
    rejected: response.status?.startsWith('rejected:'),
    rejectionReason: response.status?.startsWith('rejected:') ? response.status.slice('rejected:'.length).trim() : '',
  }));
}

function ensureSpecDirectory(state) {
  if (!state.specFilePath) return;
  try {
    mkdirSync(path.dirname(state.specFilePath), { recursive: true });
  } catch {
    // Let the authoring pass surface any filesystem issue more directly.
  }
}

function loadSpecFromFile(state) {
  try {
    const markdown = readFileSync(state.specFilePath, 'utf-8');
    const cleaned = safeTrim(markdown, SPEC_TEXT_LIMITS.storedResponse * 2);
    if (!cleaned) {
      return { ok: false, reason: 'spec_file_empty' };
    }

    const parsed = parseFinalSpecMarkdown(cleaned, state);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }

    state.currentSpecMarkdown = cleaned;
    state.draftSpec = parsed.spec;
    state.exportedSpecPath = state.specFilePath;
    state.exportError = '';
    return {
      ok: true,
      markdown: cleaned,
      spec: parsed.spec,
      path: state.specFilePath,
    };
  } catch (error) {
    const message = safeTrim(error?.message || String(error), 240) || 'spec_file_missing';
    state.exportedSpecPath = '';
    state.exportError = message;
    return { ok: false, reason: message };
  }
}

function finalizeSpec(ctx, state, reason) {
  state.finalSpec = state.draftSpec;
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Final spec ready: ${state.finalSpec?.title || inferTitle(state.objective)}`);
  if (state.exportedSpecPath) {
    appendFeed(state, `Using canonical spec file at ${state.exportedSpecPath}`);
  }
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

async function continueFromCollectedResponses(ctx, state) {
  if (state.phase === PHASES.WRITE) {
    appendFeed(state, `Collected ${ensureRound(state, PHASES.WRITE, state.passCount).responses.length} author response${ensureRound(state, PHASES.WRITE, state.passCount).responses.length === 1 ? '' : 's'}.`);

    const loaded = loadSpecFromFile(state);
    if (!loaded.ok) {
      appendFeed(state, `The canonical spec file could not be loaded after the write pass: ${loaded.reason}`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `spec_file_invalid_after_write:${loaded.reason}`,
      };
    }

    appendFeed(state, `Initial spec loaded from ${loaded.path}.`);
    if (state.passCount >= state.maxPasses) {
      return finalizeSpec(ctx, state, 'max_cycles_reached');
    }
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const reviewRound = ensureRound(state, PHASES.REVIEW, state.passCount);
    const summary = summarizeReviewRound(reviewRound);

    appendFeed(
      state,
      `Collected ${summary.reviewerCount} review response${summary.reviewerCount === 1 ? '' : 's'} with ${summary.mustChangeCount} required change${summary.mustChangeCount === 1 ? '' : 's'}.`,
    );

    const loaded = loadSpecFromFile(state);
    if (!loaded.ok) {
      appendFeed(state, `The canonical spec file could not be loaded during review: ${loaded.reason}`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `spec_file_invalid_during_review:${loaded.reason}`,
      };
    }

    if (!summary.needsRevision) {
      return finalizeSpec(ctx, state, 'spec_complete');
    }

    if (state.passCount >= state.maxPasses) {
      appendFeed(state, 'Reached the pass limit during review. Handing the spec back to the implementer for one final revision pass.');
      return issuePhaseDecision(ctx, state, PHASES.REVISE, { preservePassCount: true });
    }

    return issuePhaseDecision(ctx, state, PHASES.REVISE);
  }

  if (state.phase === PHASES.REVISE) {
    appendFeed(state, `Collected ${ensureRound(state, PHASES.REVISE, state.passCount).responses.length} revise response${ensureRound(state, PHASES.REVISE, state.passCount).responses.length === 1 ? '' : 's'}.`);

    const loaded = loadSpecFromFile(state);
    if (!loaded.ok) {
      appendFeed(state, `The canonical spec file could not be loaded after the revise pass: ${loaded.reason}`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `spec_file_invalid_after_revise:${loaded.reason}`,
      };
    }

    appendFeed(state, `Revised spec loaded from ${loaded.path}.`);
    if (state.passCount >= state.maxPasses) {
      appendFeed(state, 'Reached the pass limit after the revise pass. Stopping with the latest spec file.');
      return finalizeSpec(ctx, state, 'max_cycles_reached');
    }

    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  appendFeed(state, `Unexpected collected-response continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `unexpected_resume_phase:${state.phase}`,
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
      if (state.missingRoles.length > 0) {
        return stopForMissingRoles(ctx, state);
      }
      if (!state.specFilePath) {
        return stopForMissingSpecPath(ctx, state);
      }
      ensureSpecDirectory(state);
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
      return {
        type: 'stop',
        reason: `unexpected_fan_out_phase:${state.phase}`,
      };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState() || createInitialState(ctx);
      appendFeed(
        state,
        `Received unexpected single-turn response from ${turnResult?.agentId || 'unknown agent'}.`,
      );
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
        const round = ensureRound(state, state.phase, state.passCount);
        const participant = state.participants.find((entry) => entry.agentId === event.agentId);
        if (participant && event.detail?.response) {
          upsertRoundResponse(round, participant, {
            response: event.detail.response,
            status: 'submitted',
          });
        }
        appendFeed(
          state,
          `${event.displayName || event.agentId} submitted a partial response.`,
          {
            displayName: event.displayName || event.agentId,
            role: 'participant',
            agentId: event.agentId,
          },
        );
        ctx.setState(state);
        emitMetrics(ctx, state);
        return null;
      }

      if (event?.type === 'participant_disconnected' && event.agentId) {
        state.agentStatus[event.agentId] = 'disconnected';
        if (!state.disconnectedAgents.includes(event.agentId)) {
          state.disconnectedAgents.push(event.agentId);
        }
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

      if (event?.type === 'user_edit_state') {
        emitMetrics(ctx, state);
        return null;
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
        appendFeed(
          state,
          state.phase === PHASES.WRITE
            ? `Resuming write pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`
            : (state.phase === PHASES.REVIEW
                ? `Resuming review pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`
                : `Resuming revise pass — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`),
        );
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
      return targets.length > 0 ? { type: 'fan_out', targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) return null;

      const bundle = buildSpecBundle(state);
      if (!bundle) return null;

      return {
        summary: {
          title: bundle.data.summary.title,
          highlights: [
            bundle.data.summary.oneLiner,
            bundle.data.summary.recommendedDirection,
            bundle.data.spec.acceptanceCriteria?.length
              ? `${bundle.data.spec.acceptanceCriteria.length} acceptance criteria defined.`
              : null,
          ].filter(Boolean).slice(0, 6),
          outcome: state.phase === PHASES.COMPLETE ? 'spec_bundle_ready' : 'spec_bundle_partial',
        },
        metrics: {
          cycles: state.passCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts: bundle.data.artifacts.map((artifact) => ({
          type: artifact.kind || 'file',
          path: artifact.path,
          label: artifact.label,
          ...(artifact.primary ? { primary: true } : {}),
        })),
        handoffPayloads: [bundle],
      };
    },

    shutdown() {
      // No-op.
    },
  };
}

export default { manifest, createPlugin };
export { manifest, createPlugin };
