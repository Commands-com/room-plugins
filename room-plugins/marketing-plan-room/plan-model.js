import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { TEXT_LIMITS } from './constants.js';
import {
  excerpt,
  normalizeList,
  safeTrim,
  sectionToItems,
  sectionToParagraph,
  splitHeadingSections,
} from './utils.js';

export function readIfExists(targetPath, maxLen = TEXT_LIMITS.markdown) {
  try {
    return safeTrim(readFileSync(targetPath, 'utf-8'), maxLen);
  } catch {
    return '';
  }
}

export function collectProjectContext(projectDir) {
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

export function extractCompetitiveContext(ctx) {
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

export function seedPlanFile(state) {
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

export function readPlanMarkdown(state) {
  return readIfExists(state.planPath, TEXT_LIMITS.markdown);
}

export function parsePlan(markdown) {
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

export function parseReviewResponse(markdown) {
  const sections = splitHeadingSections(markdown, '##');
  return {
    overall: sectionToParagraph(sections.get('overall'), 500),
    keep: sectionToItems(sections.get('keep'), 10, 500),
    mustChange: sectionToItems(sections.get('must change'), 10, 500),
    risks: sectionToItems(sections.get('risks'), 10, 500),
    opportunities: sectionToItems(sections.get('opportunities'), 10, 500),
  };
}

export function summarizeReviews(round) {
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
