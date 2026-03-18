import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCompatibility, makeCompatible, buildCompatibilityReport, getConfig } from './lib/config.js';
import { createPlugin } from './lib/plugin.js';
import { createRedshiftEngine } from './lib/engine.js';
import {
  connect, disconnect, getClusterInfo, getTableMetadata,
} from './lib/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// Declarative exports — used when room.yaml is present
// ---------------------------------------------------------------------------

export const engine = createRedshiftEngine();

export const harness = {
  connect,
  disconnect,
  getClusterInfo,
  getTableMetadata,
  checkCompatibility,
  makeCompatible,
  buildCompatibilityReport,
  getConfig,
};

// ---------------------------------------------------------------------------
// Classic exports — backward compatibility when loaded via manifest.json
// ---------------------------------------------------------------------------

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
