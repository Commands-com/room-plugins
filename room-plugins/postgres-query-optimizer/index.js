import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCompatibility, makeCompatible, buildCompatibilityReport, getConfig } from './lib/config.js';
import { createPlugin } from './lib/plugin.js';
import { createPostgresEngine } from './lib/engine.js';
import {
  checkDockerAvailability, detectSourceVersion, captureSourcePlan,
  captureHarnessPlan, comparePlanShapes, createNetwork, startContainer,
  waitForReady, getContainerPort, getConnectionString, execSQL,
  loadSchema, loadData, truncateAllTables, createSnapshot, restoreSnapshot,
  runBenchmark, checkParity, getIndexSize, teardown, teardownAll,
  loadDemoAssets,
} from './lib/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// Declarative exports — used when room.yaml is present
// ---------------------------------------------------------------------------

export const engine = createPostgresEngine();

export const harness = {
  checkDockerAvailability,
  detectSourceVersion,
  captureSourcePlan,
  captureHarnessPlan,
  comparePlanShapes,
  createNetwork,
  startContainer,
  waitForReady,
  getContainerPort,
  getConnectionString,
  execSQL,
  loadSchema,
  loadData,
  truncateAllTables,
  createSnapshot,
  restoreSnapshot,
  runBenchmark,
  checkParity,
  getIndexSize,
  teardown,
  teardownAll,
  loadDemoAssets,
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
