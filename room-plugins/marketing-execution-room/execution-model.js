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

export function extractPlanContext(ctx) {
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

export function seedSummaryFile(state) {
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

export function readSummaryMarkdown(state) {
  return readIfExists(state.summaryPath, TEXT_LIMITS.markdown);
}

export function parseSummary(markdown) {
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

export function collectArtifactFiles(outputDir, summaryPath) {
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

export function guessArtifactType(targetPath) {
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === '.html') return 'html';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif') return 'image';
  if (ext === '.md') return 'markdown';
  if (ext === '.json') return 'json';
  return 'text';
}
