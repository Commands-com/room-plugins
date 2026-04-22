// ---------------------------------------------------------------------------
// Spec model — canonical shape + markdown rendering + markdown parsing +
// reviewer-response parsing + implementation-cycle hint estimation.
//
// normalizeSpec() is the narrow waist: every input path (fallback LLM
// response, parsed final markdown from disk) produces a spec through this
// function so downstream consumers see the same fields with the same caps.
// ---------------------------------------------------------------------------

import {
  SPEC_TEXT_LIMITS,
  PROTOTYPE_INFLUENCE_PROPOSAL,
  PROTOTYPE_INFLUENCE_ACCEPTANCE,
  IMPLEMENTATION_CYCLE_BANDS,
  IMPLEMENTATION_COMPLEXITY_KEYWORDS,
} from './constants.js';
import {
  safeTrim,
  stripListPrefix,
  canonicalKey,
  dedupeList,
  titleCase,
  inferTitle,
} from './text-utils.js';

export function normalizeSpec(payload, state, stage) {
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

  if (state.prototypeContext?.selectedPrototype) {
    const proposalKeys = normalized.proposal.map((item) => canonicalKey(item));
    if (!proposalKeys.some((item) => item.includes('prototype') && (item.includes('input') || item.includes('direction')))) {
      normalized.proposal = dedupeList(
        [...normalized.proposal, PROTOTYPE_INFLUENCE_PROPOSAL],
        16,
        SPEC_TEXT_LIMITS.longItem,
      );
    }

    const acceptanceKeys = normalized.acceptanceCriteria.map((item) => canonicalKey(item));
    if (!acceptanceKeys.some((item) => item.includes('prototype') && item.includes('implementation'))) {
      normalized.acceptanceCriteria = dedupeList(
        [...normalized.acceptanceCriteria, PROTOTYPE_INFLUENCE_ACCEPTANCE],
        16,
        SPEC_TEXT_LIMITS.mediumItem,
      );
    }
  }

  return normalized;
}

function clampImplementationCycleRecommendation(value) {
  if (!Number.isFinite(value)) return 4;
  return Math.max(3, Math.min(Math.trunc(value), 14));
}

export function estimateImplementationHints(spec) {
  if (!spec || typeof spec !== 'object') {
    return {
      recommendedMaxCycles: 4,
      complexity: 'small',
      rationale: ['Defaulted to a small single-flow build because the spec was not available.'],
    };
  }

  let score = 0;
  const rationale = [];

  const goalsCount = Array.isArray(spec.goals) ? spec.goals.length : 0;
  const acceptanceCount = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria.length : 0;
  const implementationCount = Array.isArray(spec.implementationPlan) ? spec.implementationPlan.length : 0;
  const prerequisiteCount = Array.isArray(spec.prerequisites) ? spec.prerequisites.length : 0;
  const riskCount = Array.isArray(spec.risks) ? spec.risks.length : 0;

  if (goalsCount >= 3) {
    score += 2;
    rationale.push('Covers several concrete product goals.');
  } else if (goalsCount >= 2) {
    score += 1;
  }

  if (acceptanceCount >= 6) {
    score += 3;
    rationale.push('Defines many acceptance criteria that will need verification.');
  } else if (acceptanceCount >= 3) {
    score += 2;
  } else if (acceptanceCount >= 2) {
    score += 1;
  }

  if (implementationCount >= 6) {
    score += 4;
    rationale.push('Implementation plan spans many concrete build steps.');
  } else if (implementationCount >= 4) {
    score += 3;
  } else if (implementationCount >= 2) {
    score += 1;
  }

  if (prerequisiteCount >= 2) {
    score += 2;
    rationale.push('Requires prerequisite platform or host changes before feature work.');
  } else if (prerequisiteCount === 1) {
    score += 1;
  }

  if (riskCount >= 3) {
    score += 1;
  }

  const combinedText = [
    spec.title,
    spec.summary,
    spec.problem,
    ...(Array.isArray(spec.goals) ? spec.goals : []),
    ...(Array.isArray(spec.proposal) ? spec.proposal : []),
    ...(Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : []),
    ...(Array.isArray(spec.implementationPlan) ? spec.implementationPlan : []),
    ...(Array.isArray(spec.prerequisites) ? spec.prerequisites : []),
    ...(Array.isArray(spec.risks) ? spec.risks : []),
  ].filter(Boolean).join('\n');

  for (const keyword of IMPLEMENTATION_COMPLEXITY_KEYWORDS) {
    if (keyword.regex.test(combinedText)) {
      score += keyword.weight;
      rationale.push(keyword.reason);
    }
  }

  const band = IMPLEMENTATION_CYCLE_BANDS.find((entry) => score >= entry.minScore && score <= entry.maxScore)
    || IMPLEMENTATION_CYCLE_BANDS[IMPLEMENTATION_CYCLE_BANDS.length - 1];
  const recommendedMaxCycles = clampImplementationCycleRecommendation(band.recommendedMaxCycles);

  return {
    recommendedMaxCycles,
    complexity: band.key,
    rationale: dedupeList(
      rationale.length > 0
        ? rationale
        : [`Sized as a ${band.label} based on the current product scope and implementation plan.`],
      5,
      SPEC_TEXT_LIMITS.mediumItem,
    ),
  };
}

function renderSection(title, items, ordered = false) {
  if (!Array.isArray(items) || items.length === 0) return `## ${title}\n- None yet.`;
  const lines = items.map((item, index) => ordered ? `${index + 1}. ${item}` : `- ${item}`);
  return `## ${title}\n${lines.join('\n')}`;
}

export function renderSpecMarkdown(spec, state) {
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

export function parseFinalSpecMarkdown(markdown, state) {
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

export function summarizeReviewRound(round) {
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

export function buildReviewFeedback(round) {
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
