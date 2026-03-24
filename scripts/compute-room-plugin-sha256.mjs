#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}

function ensureRelativeSymlinkStaysWithinRoot(rootPath, symlinkPath, rawTarget, relPath) {
  if (path.isAbsolute(rawTarget)) {
    throw new Error(`Absolute symlink not allowed while hashing: ${relPath}`);
  }

  const resolvedTarget = path.resolve(path.dirname(symlinkPath), rawTarget);
  const relativeToRoot = path.relative(rootPath, resolvedTarget);
  if (
    relativeToRoot === ''
    || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot))
  ) {
    return toPosixPath(path.normalize(rawTarget));
  }

  throw new Error(`Symlink escapes plugin root while hashing: ${relPath}`);
}

async function collectPluginEntries(rootPath, dirPath, relativePath = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === '.git') {
      // Still reject symlinks for excluded names — a symlink named .git
      // could point outside the plugin root and bypass integrity checks.
      const excludedPath = path.join(dirPath, entry.name);
      const excludedStat = await fs.lstat(excludedPath);
      if (excludedStat.isSymbolicLink()) {
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        throw new Error(`Symlink not allowed while hashing: ${relPath}`);
      }
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const stat = await fs.lstat(fullPath);

    if (stat.isSymbolicLink()) {
      const rawTarget = await fs.readlink(fullPath, 'utf8');
      const normalizedTarget = ensureRelativeSymlinkStaysWithinRoot(rootPath, fullPath, rawTarget, relPath);
      files.push({ relativePath: relPath, fullPath, type: 'symlink', target: normalizedTarget });
      continue;
    }

    if (stat.isDirectory()) {
      const nested = await collectPluginEntries(rootPath, fullPath, relPath);
      files.push(...nested);
      continue;
    }

    if (stat.isFile()) {
      files.push({ relativePath: relPath, fullPath, type: 'file' });
    }
  }

  return files;
}

export async function computeRoomPluginSha256(pluginPath) {
  const rootPath = path.resolve(pluginPath);
  const files = await collectPluginEntries(rootPath, rootPath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Per-entry digest with null-byte separators between type, path, and payload,
  // then aggregate all per-entry digests into a final hash.
  const digests = [];
  for (const file of files) {
    const h = createHash('sha256');
    h.update(file.type, 'utf8');
    h.update('\0');
    h.update(file.relativePath, 'utf8');
    h.update('\0');
    if (file.type === 'symlink') {
      h.update(file.target, 'utf8');
    } else {
      h.update(await fs.readFile(file.fullPath));
    }
    digests.push(h.digest());
  }

  const finalHash = createHash('sha256');
  for (const digest of digests) {
    finalHash.update(digest);
  }

  return finalHash.digest('hex');
}

async function main() {
  const pluginPath = process.argv[2];
  if (!pluginPath) {
    console.error('Usage: node compute-room-plugin-sha256.mjs <pluginDir>');
    process.exit(1);
  }

  const resolved = path.resolve(pluginPath);
  const digest = await computeRoomPluginSha256(resolved);
  process.stdout.write(`${digest}\n`);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
