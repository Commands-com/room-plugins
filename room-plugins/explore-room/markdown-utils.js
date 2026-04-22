// ---------------------------------------------------------------------------
// Markdown parsing helpers: {{placeholder}} prompt rendering, heading-aware
// section splitter, and scalar/list converters that the review + concept
// parsers build on.
// ---------------------------------------------------------------------------

import { TEXT_LIMITS } from './constants.js';
import { canonicalKey, normalizeList, safeTrim } from './text-utils.js';

export function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

export function splitHeadingSections(markdown, headingPrefix = '##') {
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

export function sectionToParagraph(lines, maxLen = TEXT_LIMITS.paragraph) {
  if (!Array.isArray(lines)) return '';
  return safeTrim(
    lines
      .map((line) => safeTrim(line, maxLen).replace(/^[-*+]\s+/, '').trim())
      .filter(Boolean)
      .join(' '),
    maxLen,
  );
}

export function sectionToItems(lines, maxItems = 8, itemLen = TEXT_LIMITS.item) {
  return normalizeList(Array.isArray(lines) ? lines : [], maxItems, itemLen);
}

export function sectionToScore(lines) {
  const text = sectionToParagraph(lines, 80);
  const match = text.match(/\b(10|[1-9])(?:\.\d+)?\b/);
  return match ? Number(match[1]) : null;
}
