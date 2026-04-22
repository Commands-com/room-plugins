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

export function seedAnalysisFile(state) {
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

export function readAnalysisMarkdown(state) {
  return readIfExists(state.analysisPath, TEXT_LIMITS.markdown);
}

export function parseAnalysis(markdown) {
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
