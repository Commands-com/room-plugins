import path from 'node:path';

export function safeTrim(value, maxLen = 12000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const intValue = Math.floor(numeric);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

export function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function optionalInteger(value) {
  const numeric = optionalFiniteNumber(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : undefined;
}

export function normalizeStringArray(value, maxItems = Infinity) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => safeTrim(item, 400))
      .filter(Boolean),
  )).slice(0, maxItems);
}

export function isSafeSubpath(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(candidatePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function isReadOnlyQuery(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const trimmed = sql.trim().replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const upper = trimmed.toUpperCase();
  return /^\s*(SELECT|WITH)\b/i.test(upper)
    && !/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/i.test(upper);
}

export function sanitizeSQL(sql, maxLen = 50000) {
  if (!sql || typeof sql !== 'string') return '';
  return sql.trim().slice(0, maxLen);
}

export function extractQueryTableRefs(sql) {
  if (!sql || typeof sql !== 'string') return [];
  const cleaned = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = new Set();
  const pattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    const ref = match[1].toLowerCase();
    if (['select', 'lateral', 'unnest', 'generate_series'].includes(ref)) continue;
    refs.add(ref);
    if (ref.includes('.')) {
      refs.add(ref.split('.').pop());
    }
  }
  return [...refs];
}
