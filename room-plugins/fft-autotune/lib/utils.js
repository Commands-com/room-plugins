import fs from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from './constants.js';

export function safeTrim(value, maxLen = 12000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function isPowerOfTwo(value) {
  return Number.isInteger(value) && value >= 2 && value <= 16384 && (value & (value - 1)) === 0;
}

export function uniq(values) {
  return Array.from(new Set(values));
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
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function optionalInteger(value) {
  const numeric = optionalFiniteNumber(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : undefined;
}

export function normalizeStringArray(value, maxItems = Infinity) {
  if (!Array.isArray(value)) return [];
  return uniq(
    value
      .map((item) => safeTrim(item, 400))
      .filter(Boolean),
  ).slice(0, maxItems);
}

export function normalizeNumberArray(value, maxItems = Infinity) {
  if (!Array.isArray(value)) return [];
  return uniq(
    value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item)),
  ).slice(0, maxItems);
}

export function resolveBucketKey(size, config) {
  return `n${size}-${config.targetArch}`;
}

export function buildDefaultOutputDir(workspacePath) {
  return path.resolve(workspacePath, DEFAULTS.outputDir);
}

export function isSafeSubpath(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(candidatePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Resolve a reported artifact path against allowed roots and verify it exists.
 * Returns the resolved absolute path if valid, or null if the path is outside
 * the allowed roots, empty, or does not exist on disk.
 */
export function resolveAndVerifyPath(reportedPath, allowedRoots) {
  if (!reportedPath || typeof reportedPath !== 'string') return null;
  const trimmed = reportedPath.trim();
  if (!trimmed) return null;

  for (const root of allowedRoots) {
    if (!root) continue;
    const resolved = path.resolve(root, trimmed);
    if (isSafeSubpath(root, resolved)) {
      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) return resolved;
      } catch {
        // Does not exist under this root – try next.
      }
    }
  }
  return null;
}
