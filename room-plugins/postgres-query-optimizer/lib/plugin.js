import { buildCompatibilityReport, getConfig } from './config.js';
import { assignLanes } from './envelope.js';
import { PHASES } from './constants.js';
import {
  chooseStopReason,
  evaluateImprovement,
  mergeCycleArtifacts,
  mergeRetestResults,
  recomputeFrontier,
  selectRetestCandidates,
} from './candidates.js';
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
import { createInitialState, derivePartialPhase, advancePhase, setPhase } from './phases.js';
import {
  buildPendingDecision,
  enqueueProposals,
  selectActivePromotedProposals,
} from './planning.js';
import { emitStateMetrics } from './report.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Restore the harness database to its baseline snapshot state.
 * This ensures a clean state between benchmark cycles and before parity checks.
 * Returns true if restore succeeded or was unnecessary.
 */
async function restoreBaselineSnapshot(state) {
  const containerNameStr = state.harnessState?.containerName;
  const snapshotPath = state.harnessState?.snapshotPath;
  if (!containerNameStr || !snapshotPath) return false;

  const result = await restoreSnapshot(containerNameStr, snapshotPath);
  return result.ok;
}

/**
 * Harness-verified parity check for rewrite candidates.
 * Runs checkParity() in the Docker container for each rewrite candidate
 * that claims parity, overriding self-reported values with ground truth.
 */
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

/**
 * Re-benchmark each new candidate from a clean harness snapshot.
 * This eliminates cross-contamination between proposals that were tested
 * sequentially in a single builder session without proper rollback.
 *
 * For each candidate: restore snapshot → apply SQL → ANALYZE → benchmark → record.
 * Final restore ensures clean state for subsequent operations.
 */
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

      // Flag candidates when baseline plan divergence was detected —
      // the harness speedup may not reflect production behavior.
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

const BUILDER_RESPONSE_LANES = new Set(['builder']);
const SCHEMA_REPAIR_SIGNAL_PATTERNS = [
  /"proposalId"\s*:/,
  /"baseline"\s*:/,
  /"candidate"\s*:/,
  /"medianMs"\s*:/,
  /"speedupPct"\s*:/,
];
const MAX_REPAIR_RESPONSE_LEN = 512 * 1024;

function collectSchemaRepairBuilderResponses(state, ctx, responses) {
  return (Array.isArray(responses) ? responses : [])
    .filter((r) => BUILDER_RESPONSE_LANES.has(state.lanesByAgentId[r.agentId] || 'builder'))
    .map((r) => {
      const participant = (ctx.participants || []).find((p) => p.agentId === r.agentId);
      const raw = typeof r.response === 'string' ? r.response : '';
      return {
        agentId: r.agentId,
        displayName: participant?.displayName || r.agentId,
        response: raw.length > MAX_REPAIR_RESPONSE_LEN ? raw.slice(0, MAX_REPAIR_RESPONSE_LEN) : raw,
      };
    })
    .filter((entry) => {
      const text = entry.response.trim();
      return text.length > 0 && SCHEMA_REPAIR_SIGNAL_PATTERNS.some((p) => p.test(text));
    });
}

function finishSearchCycle(ctx, state, config) {
  // Check if retests are needed before ranking
  const needsBaselineRetest = state._baselineNeedsRetest && !state.baselines?.retested;
  const retestCandidates = selectRetestCandidates(state, config);

  if (needsBaselineRetest || retestCandidates.length > 0) {
    state._retestQueue = retestCandidates;
    state.pendingFanOut = 'retest';
    setPhase(state, PHASES.FRONTIER_REFINE);
    ctx.setState(state);
    emitStateMetrics(ctx, state);
    return buildPendingDecision(ctx, state, config);
  }

  recomputeFrontier(state, config);
  evaluateImprovement(state);

  const stopReason = chooseStopReason(state, config, ctx.limits);
  if (stopReason) {
    setPhase(state, PHASES.COMPLETE);
    state.pendingFanOut = null;
    ctx.setState(state);
    emitStateMetrics(ctx, state);
    return { type: 'stop', reason: stopReason };
  }

  if (state.proposalBacklog.length === 0) {
    // Planning phase will generate new proposals
  }

  state.cycleIndex += 1;
  ctx.setCycle(state.cycleIndex);
  setPhase(state, PHASES.ANALYSIS);
  state.pendingFanOut = 'planning';
  ctx.setState(state);
  emitStateMetrics(ctx, state);
  return buildPendingDecision(ctx, state, config);
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createPlugin() {
  function init(ctx) {
    const state = createInitialState(ctx);
    const { lanesByAgentId, workersByLane } = assignLanes(ctx.participants || []);
    state.lanesByAgentId = lanesByAgentId;
    state.workersByLane = workersByLane;
    state.workerCount = Object.keys(lanesByAgentId).length;
    ctx.setState(state);
    emitStateMetrics(ctx, state);
  }

  async function onRoomStart(ctx) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);

    const _progressStart = Date.now();
    const _progressLines = [];
    function emitProgress(msg) {
      const elapsed = ((Date.now() - _progressStart) / 1000).toFixed(1);
      _progressLines.push(`[${elapsed}s] ${msg}`);
      ctx.emitMetrics({ preflightStatus: { type: 'text', value: _progressLines.join('\n') } });
    }

    // ---- Preflight: compatibility check ----
    emitProgress('Checking compatibility...');
    const report = await buildCompatibilityReport(config);
    if (!report.compatible) {
      emitProgress('Compatibility check failed');
      setPhase(state, PHASES.COMPLETE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return { type: 'stop', reason: 'global_preflight_failed' };
    }

    // ---- Preflight: Docker harness setup ----
    try {
      const roomId = ctx.roomId || 'default';

      // Clean up ALL leftover pqo containers/networks from any prior room
      emitProgress('Cleaning up prior harness (if any)...');
      await teardownAll();

      // Docker check
      emitProgress('Checking Docker availability...');
      const docker = await checkDockerAvailability();
      if (!docker.ok) {
        emitProgress('Docker not available');
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'docker_unavailable' };
      }

      // Determine demo mode and load demo assets
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
          emitStateMetrics(ctx, state);
          return { type: 'stop', reason: `demo_asset_load_failed: ${err.message}` };
        }
      }

      // Detect source version and auto-match BEFORE starting container (introspect mode)
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

      // Create network + start container
      emitProgress(`Starting Postgres ${config.postgresVersion} container...`);
      await createNetwork(roomId);
      const { containerId, containerNameStr, port } = await startContainer(roomId, config);

      // Wait for Postgres to be ready
      emitProgress('Waiting for Postgres to be ready...');
      const ready = await waitForReady(containerNameStr);
      if (!ready) {
        await teardown(roomId);
        emitProgress('Container failed to start');
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'container_start_failed' };
      }

      // Load schema
      emitProgress(`Loading schema (${config.schemaSource})...`);
      const schemaResult = await loadSchema(containerNameStr, config);
      if (!schemaResult.ok) {
        await teardown(roomId);
        emitProgress(`Schema load failed: ${schemaResult.message}`);
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'schema_load_failed' };
      }
      emitProgress(`Schema loaded: ${schemaResult.message}`);

      // Load data.
      // When seeding from source: pull full tables (no sampling) so the
      // harness has production-scale data and the planner makes the same
      // cost decisions. Sampling causes plan divergence that leads to
      // misleading benchmark results (e.g. an index that helps at 500K
      // rows but not at 2.8M). For tables over 10M rows, fall back to
      // the configured scaleFactor to keep load times reasonable.
      const FULL_PULL_THRESHOLD = 10_000_000;
      let dataResult = null;
      let snapshotPath = null;

      if (config.seedFromSource && config.dbUrl) {
        // Set scale very high so loadData does full COPY (no TABLESAMPLE/LIMIT)
        // for tables under the threshold. Tables over the threshold will
        // still be capped by estimatedRows > scaleFactor logic in loadData.
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
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: `data_load_failed: ${dataResult.message}` };
      }
      if (dataResult.tier === 'none' || dataResult.tier === 'error') {
        await teardown(roomId);
        emitProgress('No data source configured');
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'no_data_source: No data source configured — provide seedDataPath, seedFromSource, or use demo mode' };
      }
      emitProgress(`Data loaded: ${dataResult.message}`);

      // Record data tier and warnings
      state.dataTier = dataResult.tier === 'demo' ? 0
        : dataResult.tier === 'seed' ? 1
        : dataResult.tier === 'sampled' ? 2
        : 3;
      if (dataResult.warnings) {
        state.dataWarnings = dataResult.warnings;
      }
      // Show actual rows loaded, not the scaleFactor ceiling
      state.totalRowsLoaded = dataResult.totalRowsLoaded || null;

      // Create snapshot
      emitProgress('Creating baseline snapshot...');
      try {
        const outputDir = config.outputDir || '.commands/postgres-tuner';
        snapshotPath = await createSnapshot(containerNameStr, outputDir);
      } catch {
        // Snapshot failure is non-fatal
      }

      // Get connection string for builder prompts
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
      emitStateMetrics(ctx, state);
      return { type: 'stop', reason: `harness_error: ${err.message}` };
    }

    // ---- Transition to BASELINE ----
    setPhase(state, PHASES.BASELINE);
    state.pendingFanOut = 'baseline';
    state.proposalBacklog = [];
    ctx.setCycle(0);
    ctx.setState(state);
    emitStateMetrics(ctx, state);
    return buildPendingDecision(ctx, state, config);
  }

  function onTurnResult() {
    return null;
  }

  async function onFanOutComplete(ctx, responses) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);

    // ---- BASELINE fan-out complete ----
    if (state.pendingFanOut === 'baseline') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      state.cycleIndex = 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.ANALYSIS);
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    // ---- ANALYSIS/PLANNING fan-out complete ----
    if (state.pendingFanOut === 'planning') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);

      selectActivePromotedProposals(state, config);
      if (state.activePromotedProposals.length === 0) {
        state.plateauCount += 1;
        recomputeFrontier(state, config);

        const stopReason = chooseStopReason(state, config, ctx.limits);
        if (stopReason) {
          setPhase(state, PHASES.COMPLETE);
          state.pendingFanOut = null;
          ctx.setState(state);
          emitStateMetrics(ctx, state);
          return { type: 'stop', reason: stopReason };
        }

        state.cycleIndex += 1;
        ctx.setCycle(state.cycleIndex);
        setPhase(state, PHASES.ANALYSIS);
        state.pendingFanOut = 'planning';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      setPhase(state, PHASES.CODEGEN);
      state.pendingFanOut = 'cycle';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    // ---- CODEGEN/CYCLE fan-out complete ----
    if (state.pendingFanOut === 'cycle') {
      const candidateCountBefore = state.candidates.length;
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      enqueueProposals(state, proposals, config);
      const builtNewCandidates = state.candidates.length > candidateCountBefore;

      if (builtNewCandidates) {
        await harnessVerifyCandidates(state, config);
      } else {
        await restoreBaselineSnapshot(state);
      }

      if (builtNewCandidates) {
        await verifyRewriteParityFromHarness(state, config);
      }

      if (builtNewCandidates) {
        state.schemaRepairBuilderResponses = [];
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'audit';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      const schemaRepairResponses = collectSchemaRepairBuilderResponses(state, ctx, responses);
      if (schemaRepairResponses.length > 0) {
        state.schemaRepairBuilderResponses = schemaRepairResponses;
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'schema_repair';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      return finishSearchCycle(ctx, state, config);
    }

    // ---- AUDIT fan-out complete ----
    if (state.pendingFanOut === 'audit') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- SCHEMA REPAIR fan-out complete ----
    if (state.pendingFanOut === 'schema_repair') {
      const { proposals } = mergeCycleArtifacts(state, responses, config);
      state.schemaRepairBuilderResponses = [];
      enqueueProposals(state, proposals, config);
      return finishSearchCycle(ctx, state, config);
    }

    // ---- RETEST fan-out complete ----
    if (state.pendingFanOut === 'retest') {
      const candidateCountBefore = state.candidates.length;
      mergeRetestResults(state, responses, config);
      const newCandidatesFromRetest = state.candidates.length - candidateCountBefore;

      const retestCandidateIds = (state._retestQueue || []).map((c) => c.proposalId);
      const retestCandidates = state.candidates.filter(
        (c) => retestCandidateIds.includes(c.proposalId) && c.status !== 'rejected',
      );

      // Harness-verify both retested and newly proposed candidates
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

      // If builder proposed new candidates during retest, route them through
      // the auditor before continuing — don't skip the audit phase.
      if (newCandidatesFromRetest > 0) {
        setPhase(state, PHASES.STATIC_AUDIT);
        state.pendingFanOut = 'audit';
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return buildPendingDecision(ctx, state, config);
      }

      recomputeFrontier(state, config);
      evaluateImprovement(state);

      const stopReason = chooseStopReason(state, config, ctx.limits);
      if (stopReason) {
        setPhase(state, PHASES.COMPLETE);
        state.pendingFanOut = null;
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: stopReason };
      }

      state.cycleIndex += 1;
      ctx.setCycle(state.cycleIndex);
      setPhase(state, PHASES.ANALYSIS);
      state.pendingFanOut = 'planning';
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildPendingDecision(ctx, state, config);
    }

    return null;
  }

  function onEvent(ctx, event) {
    if (event?.type === 'fan_out_partial') {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.pendingFanOut !== 'cycle') return null;
      const config = getConfig(ctx);
      const nextPhase = derivePartialPhase(state, event, config);
      if (!nextPhase) return null;
      const previousPhase = state.phase;
      advancePhase(state, nextPhase);
      if (state.phase !== previousPhase) {
        ctx.setState(state);
        emitStateMetrics(ctx, state);
      }
      return null;
    }

    if (event?.type === 'participant_disconnected') {
      const state = ctx.getState() || createInitialState(ctx);
      setPhase(state, PHASES.FRONTIER_REFINE);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return {
        type: 'pause',
        reason: `participant disconnected: ${event.agentId}`,
      };
    }

    if (event?.type === 'user_edit_state') {
      const state = ctx.getState() || createInitialState(ctx);
      if (event.edits && typeof event.edits === 'object') {
        if (Array.isArray(event.edits.activePromotedProposals)) {
          state.activePromotedProposals = event.edits.activePromotedProposals;
        }
        if (Array.isArray(event.edits.proposalBacklog)) {
          state.proposalBacklog = event.edits.proposalBacklog;
        }
      }
      ctx.setState(state);
      emitStateMetrics(ctx, state);
    }

    return null;
  }

  function onResume(ctx) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);
    return buildPendingDecision(ctx, state, config);
  }

  function refreshPendingDecision(ctx, pendingDecision) {
    const state = ctx.getState() || createInitialState(ctx);
    const config = getConfig(ctx);
    return buildPendingDecision(ctx, state, config) || pendingDecision;
  }

  async function shutdown(ctx) {
    const state = ctx.getState();
    try {
      await teardown(ctx.roomId || 'default');
    } catch {
      // Best-effort teardown
    }
    // Clean up snapshot file
    if (state?.harnessState?.snapshotPath) {
      try {
        const fs = await import('node:fs');
        await fs.promises.unlink(state.harnessState.snapshotPath);
      } catch {
        // Best-effort
      }
    }
  }

  return {
    init,
    onRoomStart,
    onTurnResult,
    onFanOutComplete,
    onEvent,
    onResume,
    refreshPendingDecision,
    shutdown,
  };
}
