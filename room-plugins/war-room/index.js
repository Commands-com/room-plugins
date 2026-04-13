import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createWarRoomPlugin from './plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

function createPlugin() {
  return createWarRoomPlugin();
}

export { manifest, createPlugin };

export default { manifest, createPlugin };
