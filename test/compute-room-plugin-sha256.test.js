import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';

import { computeRoomPluginSha256 } from '../scripts/compute-room-plugin-sha256.mjs';

test('computeRoomPluginSha256 supports relative symlinks that stay within the plugin root', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'room-hash-'));
  const pluginDir = path.join(tempRoot, 'plugin');

  try {
    await mkdir(path.join(pluginDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(path.join(pluginDir, 'node_modules', 'esbuild', 'bin'), { recursive: true });
    await writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"example"}\n');
    await writeFile(path.join(pluginDir, 'index.js'), 'export default {};\n');
    await writeFile(path.join(pluginDir, 'node_modules', 'esbuild', 'bin', 'esbuild'), '#!/usr/bin/env node\n');
    await symlink('../esbuild/bin/esbuild', path.join(pluginDir, 'node_modules', '.bin', 'esbuild'));

    const digest = await computeRoomPluginSha256(pluginDir);
    assert.match(digest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('computeRoomPluginSha256 rejects symlinks that escape the plugin root', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'room-hash-'));
  const pluginDir = path.join(tempRoot, 'plugin');

  try {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"example"}\n');
    await writeFile(path.join(pluginDir, 'index.js'), 'export default {};\n');
    await writeFile(path.join(tempRoot, 'outside.txt'), 'outside\n');
    await symlink('../outside.txt', path.join(pluginDir, 'bad-link'));

    await assert.rejects(
      () => computeRoomPluginSha256(pluginDir),
      /escapes plugin root while hashing/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
