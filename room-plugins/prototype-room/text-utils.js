// ---------------------------------------------------------------------------
// Generic string helpers used across the Prototype Room modules. No
// Prototype-Room-specific state here — everything in this file is pure text
// manipulation (trimming, excerpting, case conversion, list normalization).
// ---------------------------------------------------------------------------

import { NONE_KEYS } from './constants.js';

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

export function slugify(value, fallback = 'prototype') {
  const slug = safeTrim(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

export function canonicalKey(value) {
  return safeTrim(value, 200)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isNoneLike(value) {
  return NONE_KEYS.has(canonicalKey(value));
}

export function normalizeList(values, maxItems = 12, itemLen = 400) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const results = [];
  for (const value of values) {
    const cleaned = safeTrim(String(value ?? '').replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''), itemLen);
    const key = canonicalKey(cleaned);
    if (!key || isNoneLike(cleaned) || seen.has(key)) continue;
    seen.add(key);
    results.push(cleaned);
    if (results.length >= maxItems) break;
  }
  return results;
}

export function sanitizeFileName(value, fallback = 'README.md') {
  const raw = safeTrim(value, 240);
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}
