// ---------------------------------------------------------------------------
// Centralizes the manifest.json read so every submodule (and the entry file)
// shares one parsed copy. The plugin loader (room/plugin-registry.js) also
// reads manifest.json directly from disk and deep-compares the two —
// re-exporting the parsed JSON from the module keeps that assertion satisfied.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const manifest = JSON.parse(
  readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'),
);
