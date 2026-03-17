import path from 'node:path';

import { DEFAULTS, VOLATILE_FUNCTION_PATTERNS } from './constants.js';

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

export function parseConnectionUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      user: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

export function rewriteLocalhostForDocker(url) {
  if (!url || typeof url !== 'string') return url;
  return url
    .replace(/localhost/g, 'host.docker.internal')
    .replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

export function isReadOnlyQuery(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const trimmed = sql.trim().replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const upper = trimmed.toUpperCase();
  return /^\s*(SELECT|WITH)\b/i.test(upper)
    && !/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/i.test(upper);
}

export function detectVolatileFunctions(sql) {
  if (!sql || typeof sql !== 'string') return [];
  const matches = [];
  for (const pattern of VOLATILE_FUNCTION_PATTERNS) {
    const match = sql.match(pattern);
    if (match) matches.push(match[0]);
  }
  return matches;
}

export function sanitizeSQL(sql, maxLen = 50000) {
  if (!sql || typeof sql !== 'string') return '';
  return sql.trim().slice(0, maxLen);
}

/**
 * Extract probable table references from a SQL query.
 * Uses a heuristic regex approach — finds identifiers after FROM and JOIN keywords.
 * Returns lowercased, deduplicated table names (without schema prefix).
 */
export function extractQueryTableRefs(sql) {
  if (!sql || typeof sql !== 'string') return [];
  // Strip comments
  const cleaned = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = new Set();
  // Match FROM/JOIN <table> patterns (handles optional schema.table)
  const pattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    const ref = match[1].toLowerCase();
    // Skip subquery aliases and common keywords
    if (['select', 'lateral', 'unnest', 'generate_series'].includes(ref)) continue;
    // Store both the full ref and the unqualified name
    refs.add(ref);
    if (ref.includes('.')) {
      refs.add(ref.split('.').pop());
    }
  }
  return [...refs];
}

/**
 * Quote a Postgres identifier (schema, table, column name) for safe use in SQL.
 * Doubles any embedded double-quotes and wraps in double-quotes.
 * Handles schema-qualified names like "public"."My Table".
 */
export function quoteIdent(name) {
  if (!name || typeof name !== 'string') return '""';
  // If schema-qualified (contains dot), quote each part separately
  if (name.includes('.')) {
    return name.split('.').map((part) => `"${part.replace(/"/g, '""')}"`).join('.');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function containerName(roomId) {
  const safe = String(roomId || 'pg').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `pqo-harness-${safe}`;
}

export function networkName(roomId) {
  const safe = String(roomId || 'pg').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `pqo-net-${safe}`;
}

export function buildDefaultOutputDir(basePath) {
  return path.resolve(basePath || '.', DEFAULTS.outputDir);
}
