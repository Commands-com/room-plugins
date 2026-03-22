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

  // ---------------------------------------------------------------------------
  // Lifecycle hooks for declarative runtime (empirical-search-runtime)
  // ---------------------------------------------------------------------------

  async setup(ctx, _state, config, emitProgress) {
    const roomId = ctx.roomId || 'default';

    emitProgress('Cleaning up prior harness (if any)...');
    await teardownAll();

    emitProgress('Checking Docker availability...');
    const docker = await checkDockerAvailability();
    if (!docker.ok) {
      emitProgress('Docker not available');
      return { type: 'stop', reason: 'docker_unavailable' };
    }

    const isDemoMode = config.demoMode;
    const mutations = { demoMode: isDemoMode };

    if (isDemoMode) {
      try {
        emitProgress('Loading demo assets...');
        const demoAssets = await loadDemoAssets();
        mutations.demoQuery = demoAssets.querySQL;
      } catch (err) {
        await teardown(roomId);
        emitProgress(`Demo asset load failed: ${err.message}`);
        return { type: 'stop', reason: `demo_asset_load_failed: ${err.message}` };
      }
    }

    if (config.schemaSource === 'introspect' && config.dbUrl) {
      emitProgress('Detecting source database version...');
      const versionResult = await detectSourceVersion(config.dbUrl, config.postgresVersion);
      if (versionResult.ok && versionResult.version) {
        config._detectedSourceVersion = versionResult.version;
        if (!config._postgresVersionExplicit) {
          config.postgresVersion = versionResult.version;
        }
        emitProgress(`Source database: Postgres ${versionResult.version}`);
      }
    }

    emitProgress(`Starting Postgres ${config.postgresVersion} container...`);
    await createNetwork(roomId);
    const { containerId, containerNameStr, port } = await startContainer(roomId, config);

    emitProgress('Waiting for Postgres to be ready...');
    const ready = await waitForReady(containerNameStr);
    if (!ready) {
      await teardown(roomId);
      emitProgress('Container failed to start');
      return { type: 'stop', reason: 'container_start_failed' };
    }

    emitProgress(`Loading schema (${config.schemaSource})...`);
    const schemaResult = await loadSchema(containerNameStr, config);
    if (!schemaResult.ok) {
      await teardown(roomId);
      emitProgress(`Schema load failed: ${schemaResult.message}`);
      return { type: 'stop', reason: 'schema_load_failed' };
    }
    emitProgress(`Schema loaded: ${schemaResult.message}`);

    const FULL_PULL_THRESHOLD = 10_000_000;
    if (config.seedFromSource && config.dbUrl) {
      config.scaleFactor = FULL_PULL_THRESHOLD;
      emitProgress(`Loading full data from source (up to ${FULL_PULL_THRESHOLD.toLocaleString()} rows per table)...`);
    } else {
      emitProgress(`Loading data (scale: ${(config.scaleFactor || 100000).toLocaleString()})...`);
    }

    const dataResult = await loadData(containerNameStr, config, { onProgress: emitProgress });
    if (!dataResult.ok) {
      await teardown(roomId);
      emitProgress(`Data load failed: ${dataResult.message}`);
      return { type: 'stop', reason: `data_load_failed: ${dataResult.message}` };
    }
    if (dataResult.tier === 'none' || dataResult.tier === 'error') {
      await teardown(roomId);
      emitProgress('No data source configured');
      return { type: 'stop', reason: 'no_data_source: No data source configured — provide seedDataPath, seedFromSource, or use demo mode' };
    }
    emitProgress(`Data loaded: ${dataResult.message}`);

    mutations.dataTier = dataResult.tier === 'demo' ? 0
      : dataResult.tier === 'seed' ? 1
      : dataResult.tier === 'sampled' ? 2
      : 3;
    if (dataResult.warnings) mutations.dataWarnings = dataResult.warnings;
    mutations.totalRowsLoaded = dataResult.totalRowsLoaded || null;

    emitProgress('Creating baseline snapshot...');
    let snapshotPath = null;
    try {
      const outputDir = config.outputDir || '.commands/postgres-tuner';
      snapshotPath = await createSnapshot(containerNameStr, outputDir);
    } catch {
      // Snapshot failure is non-fatal
    }

    const connStr = await getConnectionString(containerNameStr);

    mutations.harnessState = {
      containerId,
      containerName: containerNameStr,
      port,
      snapshotPath,
      connectionString: connStr,
    };

    emitProgress('Harness ready');
    return mutations;
  },

  async teardown(ctx, state) {
    try {
      await teardown(ctx?.roomId || 'default');
    } catch {
      // Best-effort
    }
    if (state?.harnessState?.snapshotPath) {
      try {
        await fs.promises.unlink(state.harnessState.snapshotPath);
      } catch {
        // Best-effort
      }
    }
  },
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
