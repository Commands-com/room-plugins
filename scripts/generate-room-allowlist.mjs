#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeRoomPluginSha256 } from './compute-room-plugin-sha256.mjs';

async function main() {
  const pluginRoot = process.argv[2];
  const outputPath = process.argv[3];

  if (!pluginRoot || !outputPath) {
    console.error('Usage: node generate-room-allowlist.mjs <pluginsDir> <outputFile>');
    process.exit(1);
  }

  const root = path.resolve(pluginRoot);
  const out = path.resolve(outputPath);

  const entries = await fs.readdir(root, { withFileTypes: true });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const allowed = [];
  for (const name of pluginDirs) {
    const pluginPath = path.join(root, name);
    const digest = await computeRoomPluginSha256(pluginPath);
    allowed.push({ name, sha256: digest });
  }

  const payload = { allowed };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${out}`);
  console.log(`Entries: ${allowed.length}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
