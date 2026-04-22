import { NONE_KEYS, TEXT_LIMITS } from './constants.js';

export function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function excerpt(value, maxLen = 220) {
  const text = safeTrim(value, maxLen + 20).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

export function titleCase(value) {
  return safeTrim(value, 120)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function canonicalKey(value) {
  return safeTrim(value, 300)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeList(values, maxItems = 8, itemLen = TEXT_LIMITS.item) {
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

export function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

export function splitHeadingSections(markdown, headingPrefix = '##') {
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
