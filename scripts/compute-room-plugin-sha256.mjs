#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

async function collectPluginFiles(dirPath, relativePath = '') {
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
      throw new Error(`Symlink not allowed while hashing: ${relPath}`);
    }

    if (stat.isDirectory()) {
      const nested = await collectPluginFiles(fullPath, relPath);
      files.push(...nested);
      continue;
    }

    if (stat.isFile()) {
      files.push({ relativePath: relPath, fullPath });
    }
  }

  return files;
}

export async function computeRoomPluginSha256(pluginPath) {
  const files = await collectPluginFiles(pluginPath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Per-file digest with null-byte separator between path and content,
  // then aggregate all per-file digests into a final hash.
  const digests = [];
  for (const file of files) {
    const h = createHash('sha256');
    h.update(file.relativePath, 'utf8');
    h.update('\0');
    h.update(await fs.readFile(file.fullPath));
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
