import { buildCompatibilityReport, getConfig } from './config.js';
import { createPostgresEngine } from './engine.js';
import {
  PHASES, setPhase, createBasePlugin,
} from '../../sql-optimizer-core/index.js';
import {
  checkDockerAvailability,
  checkParity,
  createNetwork,
  detectSourceVersion,
  execSQL,
  getIndexSize,
  startContainer,
  waitForReady,
  loadSchema,
  loadData,
  loadDemoAssets,
  createSnapshot,
  restoreSnapshot,
  runBenchmark,
  getConnectionString,
  teardown,
  teardownAll,
} from './harness.js';

// ---------------------------------------------------------------------------
// Postgres-specific helpers
// ---------------------------------------------------------------------------

async function restoreBaselineSnapshot(state) {
  const containerNameStr = state.harnessState?.containerName;
  const snapshotPath = state.harnessState?.snapshotPath;
  if (!containerNameStr || !snapshotPath) return false;
  const result = await restoreSnapshot(containerNameStr, snapshotPath);
  return result.ok;
}

async function verifyRewriteParityFromHarness(state, config) {
  const containerNameStr = state.harnessState?.containerName;
  if (!containerNameStr) return;

  const originalQuery = config.slowQuery || state.demoQuery;
  if (!originalQuery) return;

  for (const candidate of state.candidates) {
    if (candidate.strategyType !== 'rewrite') continue;
    if (!candidate.targetQuery) continue;
    if (candidate._harnessParityVerified) continue;

    try {
      const parityResult = await checkParity(containerNameStr, originalQuery, candidate.targetQuery);
      candidate._harnessParityVerified = true;
      candidate.parityChecked = true;
      candidate.resultParity = parityResult.ok;

      if (!parityResult.ok) {
        candidate.status = 'rejected';
        candidate.rejectedReason = `Harness parity check failed — ${parityResult.differingRows} differing row(s) between original and rewritten query`;
      }
    } catch {
      candidate._harnessParityVerified = true;
      candidate.parityChecked = false;
      candidate.resultParity = false;
      candidate.status = 'rejected';
      candidate.rejectedReason = 'Harness parity check could not be executed';
    }
  }
}

async function harnessVerifyCandidates(state, config) {
  const containerNameStr = state.harnessState?.containerName;
  const snapshotPath = state.harnessState?.snapshotPath;
  if (!containerNameStr || !snapshotPath) return;

  const slowQuery = config.demoMode
    ? state.demoQuery || config.slowQuery
    : config.slowQuery;
  if (!slowQuery) return;

  const newCandidates = state.candidates.filter(
    (c) => c.cycleIndex === state.cycleIndex && c.status !== 'rejected',
  );

  for (const candidate of newCandidates) {
    const restored = await restoreSnapshot(containerNameStr, snapshotPath);
    if (!restored.ok) {
      candidate.notes = (candidate.notes || '') + ' [harness: snapshot restore failed before verification]';
      continue;
    }

    try {
      if (candidate.applySQL) {
        await execSQL(containerNameStr, candidate.applySQL, 60000);
        await execSQL(containerNameStr, 'ANALYZE', 30000);
      }

      const queryToBench = candidate.strategyType === 'rewrite' && candidate.targetQuery
        ? candidate.targetQuery
        : slowQuery;

      const result = await runBenchmark(containerNameStr, queryToBench, config);

      candidate.result = {
        ...candidate.result,
        medianMs: result.medianMs,
        p95Ms: result.p95Ms,
        cvPct: result.cvPct,
        leafAccessNodes: result.leafAccessNodes,
        planNodeSet: result.planNodeSet,
        planStructureHash: result.planStructureHash,
        sharedHitBlocks: result.sharedHitBlocks,
        sharedReadBlocks: result.sharedReadBlocks,
      };
      candidate._harnessVerified = true;

      if (state.baselines?.medianMs && Number.isFinite(result.medianMs)) {
        candidate.speedupPct = ((state.baselines.medianMs - result.medianMs) / state.baselines.medianMs) * 100;
      }

      if (candidate.strategyType === 'index' && candidate.applySQL) {
        const indexMatch = candidate.applySQL.match(
          /CREATE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i,
        );
        if (indexMatch) {
          candidate.indexSizeBytes = await getIndexSize(containerNameStr, indexMatch[1]);
        }
      }

      if (state.planDivergence) {
        candidate._planDivergenceWarning = true;
        const warning = ` [⚠ plan divergence: harness plan differs from source DB — speedup may not transfer to production]`;
        candidate.notes = (candidate.notes || '') + warning;
      }
    } catch (err) {
      candidate._harnessVerified = false;
      candidate.notes = (candidate.notes || '') + ` [harness verification failed: ${err.message}]`;
    }
  }

  await restoreSnapshot(containerNameStr, snapshotPath);
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createPlugin() {
  return createBasePlugin({
    createEngine: createPostgresEngine,
    getConfig,
    engineInitialState: {
      harnessState: null,
      demoMode: false,
      dataTier: null,
    },

    // ---- Engine-specific: Docker harness setup ----
    async onRoomStart(ctx, { state, config, emitStateMetrics: emitMetrics, buildDecision }) {
      const _progressStart = Date.now();
      const _progressLines = [];
      function emitProgress(msg) {
        const elapsed = ((Date.now() - _progressStart) / 1000).toFixed(1);
        _progressLines.push(`[${elapsed}s] ${msg}`);
        ctx.emitMetrics({ preflightStatus: { type: 'text', value: _progressLines.join('\n') } });
      }

      // Compatibility check
      emitProgress('Checking compatibility...');
      const report = await buildCompatibilityReport(config);
      if (!report.compatible) {
        emitProgress('Compatibility check failed');
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'stop', reason: 'global_preflight_failed' };
      }

      // Docker harness setup
      try {
        const roomId = ctx.roomId || 'default';

        emitProgress('Cleaning up prior harness (if any)...');
        await teardownAll();

        emitProgress('Checking Docker availability...');
        const docker = await checkDockerAvailability();
        if (!docker.ok) {
          emitProgress('Docker not available');
          setPhase(state, PHASES.COMPLETE);
          ctx.setState(state);
          emitMetrics(ctx, state);
          return { type: 'stop', reason: 'docker_unavailable' };
        }

        const isDemoMode = config.demoMode;
        state.demoMode = isDemoMode;

        if (isDemoMode) {
          try {
            emitProgress('Loading demo assets...');
            const demoAssets = await loadDemoAssets();
            state.demoQuery = demoAssets.querySQL;
          } catch (err) {
            await teardown(roomId);
            emitProgress(`Demo asset load failed: ${err.message}`);
            setPhase(state, PHASES.COMPLETE);
            ctx.setState(state);
            emitMetrics(ctx, state);
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
          setPhase(state, PHASES.COMPLETE);
          ctx.setState(state);
          emitMetrics(ctx, state);
          return { type: 'stop', reason: 'container_start_failed' };
        }

        emitProgress(`Loading schema (${config.schemaSource})...`);
        const schemaResult = await loadSchema(containerNameStr, config);
        if (!schemaResult.ok) {
          await teardown(roomId);
          emitProgress(`Schema load failed: ${schemaResult.message}`);
          setPhase(state, PHASES.COMPLETE);
          ctx.setState(state);
          emitMetrics(ctx, state);
          return { type: 'stop', reason: 'schema_load_failed' };
        }
        emitProgress(`Schema loaded: ${schemaResult.message}`);

        const FULL_PULL_THRESHOLD = 10_000_000;
        let dataResult = null;
        let snapshotPath = null;

        if (config.seedFromSource && config.dbUrl) {
          config.scaleFactor = FULL_PULL_THRESHOLD;
          emitProgress(`Loading full data from source (up to ${FULL_PULL_THRESHOLD.toLocaleString()} rows per table)...`);
        } else {
          emitProgress(`Loading data (scale: ${(config.scaleFactor || 100000).toLocaleString()})...`);
        }

        dataResult = await loadData(containerNameStr, config, { onProgress: emitProgress });
        if (!dataResult.ok) {
          await teardown(roomId);
          emitProgress(`Data load failed: ${dataResult.message}`);
          setPhase(state, PHASES.COMPLETE);
          ctx.setState(state);
          emitMetrics(ctx, state);
          return { type: 'stop', reason: `data_load_failed: ${dataResult.message}` };
        }
        if (dataResult.tier === 'none' || dataResult.tier === 'error') {
          await teardown(roomId);
          emitProgress('No data source configured');
          setPhase(state, PHASES.COMPLETE);
          ctx.setState(state);
          emitMetrics(ctx, state);
          return { type: 'stop', reason: 'no_data_source: No data source configured — provide seedDataPath, seedFromSource, or use demo mode' };
        }
        emitProgress(`Data loaded: ${dataResult.message}`);

        state.dataTier = dataResult.tier === 'demo' ? 0
          : dataResult.tier === 'seed' ? 1
          : dataResult.tier === 'sampled' ? 2
          : 3;
        if (dataResult.warnings) {
          state.dataWarnings = dataResult.warnings;
        }
        state.totalRowsLoaded = dataResult.totalRowsLoaded || null;

        emitProgress('Creating baseline snapshot...');
        try {
          const outputDir = config.outputDir || '.commands/postgres-tuner';
          snapshotPath = await createSnapshot(containerNameStr, outputDir);
        } catch {
          // Snapshot failure is non-fatal
        }

        const connStr = await getConnectionString(containerNameStr);

        state.harnessState = {
          containerId,
          containerName: containerNameStr,
          port,
          snapshotPath,
          connectionString: connStr,
        };

        emitProgress('Harness ready');
      } catch (err) {
        emitProgress(`Harness error: ${err.message}`);
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'stop', reason: `harness_error: ${err.message}` };
      }

      // Transition to BASELINE
      setPhase(state, PHASES.BASELINE);
      state.pendingFanOut = 'baseline';
      state.proposalBacklog = [];
      ctx.setCycle(0);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return buildDecision(ctx, state, config);
    },

    // ---- Post-cycle: harness verification + parity ----
    async afterCycleMerge(_ctx, state, config, { builtNewCandidates }) {
      if (builtNewCandidates) {
        await harnessVerifyCandidates(state, config);
        await verifyRewriteParityFromHarness(state, config);
      } else {
        await restoreBaselineSnapshot(state);
      }
    },

    // ---- Post-retest: harness verification + parity + new-candidate audit routing ----
    async afterRetestMerge(ctx, state, config, { newCandidatesFromRetest, emitStateMetrics: emitMetrics, buildDecision }) {
      const retestCandidateIds = (state._retestQueue || []).map((c) => c.proposalId);
      const retestCandidates = state.candidates.filter(
        (c) => retestCandidateIds.includes(c.proposalId) && c.status !== 'rejected',
      );

      const candidatesToVerify = newCandidatesFromRetest > 0
        ? state.candidates.filter(
          (c) => (retestCandidateIds.includes(c.proposalId) || c.cycleIndex === state.cycleIndex)
            && c.status !== 'rejected',
        )
        : retestCandidates;

      if (candidatesToVerify.length > 0) {
        const savedCycleIndexes = candidatesToVerify.map((c) => c.cycleIndex);
        candidatesToVerify.forEach((c) => { c.cycleIndex = state.cycleIndex; });
        await harnessVerifyCandidates(state, config);
        candidatesToVerify.forEach((c, i) => { c.cycleIndex = savedCycleIndexes[i]; });
      } else {
        await restoreBaselineSnapshot(state);
      }

      await verifyRewriteParityFromHarness(state, config);

      state._retestQueue = [];

      // Route new candidates through auditor before continuing
      if (newCandidatesFromRetest > 0) {
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'audit';
        ctx.setState(state);
        emitMetrics(ctx, state);
        return buildDecision(ctx, state, config);
      }

      return null;
    },

    // ---- Shutdown: Docker teardown ----
    async shutdown(ctx, state) {
      try {
        await teardown(ctx.roomId || 'default');
      } catch {
        // Best-effort teardown
      }
      if (state?.harnessState?.snapshotPath) {
        try {
          const fs = await import('node:fs');
          await fs.promises.unlink(state.harnessState.snapshotPath);
        } catch {
          // Best-effort
        }
      }
    },
  });
}
