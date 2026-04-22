// ---------------------------------------------------------------------------
// Generic string helpers for Explore Room. Pure text manipulation — safeTrim,
// canonicalization, list normalization. NONE_KEYS live here (scoped to the
// normalizer) so constants.js can depend on canonicalDimensionKey without
// pulling the opposite direction.
// ---------------------------------------------------------------------------

const NONE_KEYS = new Set(['none', 'none yet', 'n a', 'na', 'nothing', 'nope']);

export function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function excerpt(value, maxLen = 220) {
  const text = safeTrim(value, maxLen + 20).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

export function canonicalKey(value) {
  return safeTrim(value, 300)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalDimensionKey(value) {
  return safeTrim(value, 200)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleCase(value) {
  return safeTrim(value, 120)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function normalizeList(values, maxItems = 8, itemLen = 800) {
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
