import { VOLATILE_FUNCTION_PATTERNS } from './constants.js';

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

export function detectVolatileFunctions(sql) {
  if (!sql || typeof sql !== 'string') return [];
  const matches = [];
  for (const pattern of VOLATILE_FUNCTION_PATTERNS) {
    const match = sql.match(pattern);
    if (match) matches.push(match[0]);
  }
  return matches;
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
