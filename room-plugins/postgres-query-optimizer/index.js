import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCompatibility, makeCompatible } from './lib/config.js';
import { createPlugin } from './lib/plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

export default {
  manifest,
  createPlugin,
  checkCompatibility,
  makeCompatible,
};

export {
  manifest,
  createPlugin,
  checkCompatibility,
  makeCompatible,
};
