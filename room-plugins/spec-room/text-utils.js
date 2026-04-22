// ---------------------------------------------------------------------------
// Generic string utilities shared across the spec-room submodules. All
// functions are pure and size-bounded — the SPEC_TEXT_LIMITS constants
// ultimately decide how much text survives any given operation.
// ---------------------------------------------------------------------------

import { SPEC_TEXT_LIMITS } from './constants.js';

export function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function stripListPrefix(value, maxLen = SPEC_TEXT_LIMITS.parsedLine) {
  return safeTrim(String(value ?? ''), maxLen)
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

export function canonicalKey(value) {
  return stripListPrefix(value)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeList(values, maxItems = 12, itemLen = SPEC_TEXT_LIMITS.shortItem) {
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

export function titleCase(value) {
  return safeTrim(value, 80)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function excerpt(value, maxLen = 220) {
  const text = safeTrim(value, maxLen + 20).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

export function sanitizeFileName(value, fallbackStem = 'spec-room') {
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

export function inferTitle(objective) {
  const words = safeTrim(objective, 200)
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (words.length === 0) return 'Untitled Spec';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
