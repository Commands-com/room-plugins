// ---------------------------------------------------------------------------
// Markdown parsing helpers. These all operate on raw markdown strings and
// return either parsed section maps (Map<canonicalKey, lines[]>), extracted
// titles/paragraphs, or decision-item lists. renderPromptTemplate lives here
// too — it's a {{placeholder}} substitution used by every prompt builder.
// ---------------------------------------------------------------------------

import { canonicalKey, normalizeList, safeTrim } from './text-utils.js';

export function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

export function parseMarkdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let current = null;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
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

export function getMarkdownTitle(markdown, fallback = 'Prototype') {
  const match = String(markdown || '').match(/^#\s+(.+)$/m);
  return safeTrim(match?.[1], 200) || fallback;
}

export function getFirstParagraph(markdown, fallback = '') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const paragraph = [];

  for (const line of lines) {
    const trimmed = safeTrim(line, 1000);
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#/.test(trimmed)) continue;
    if (/^[-*+]\s+/.test(trimmed)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }

  return safeTrim(paragraph.join(' '), 600) || fallback;
}

export function parseDecisionItems(lines) {
  const items = normalizeList(
    Array.isArray(lines) ? lines.map((line) => safeTrim(line, 800)) : [],
    8,
    800,
  );

  return items.map((item) => {
    const match = item.match(/^(?:decision\s*:\s*)?(.+?)(?:\s*[—-]\s*|\s*:\s+)(.+)$/i);
    if (match) {
      return {
        decision: safeTrim(match[1], 300),
        reason: safeTrim(match[2], 500),
      };
    }
    return {
      decision: safeTrim(item, 300),
      reason: '',
    };
  });
}

export function splitHeadingSections(markdown, headingPrefix = '###') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let currentSection = null;

  for (const line of lines) {
    const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = line.match(new RegExp(`^\\s*${escaped}\\s+(.+)$`));
    if (match) {
      currentSection = canonicalKey(match[1]);
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }

    if (currentSection) {
      sections.get(currentSection).push(line);
    }
  }

  return sections;
}

export function sectionToItems(lines, maxItems = 12, itemLen = 500) {
  if (!Array.isArray(lines)) return [];
  return normalizeList(
    lines
      .map((line) => safeTrim(line, itemLen))
      .filter(Boolean),
    maxItems,
    itemLen,
  );
}

export function sectionToScore(lines) {
  const text = safeTrim(
    Array.isArray(lines)
      ? lines.map((line) => safeTrim(line, 80)).join(' ')
      : '',
    120,
  );
  const match = text.match(/\b(10|[1-9])(?:\.\d+)?\b/);
  return match ? Number(match[1]) : null;
}
