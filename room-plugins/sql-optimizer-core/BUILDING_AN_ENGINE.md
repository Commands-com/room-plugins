# Building a SQL Optimizer Engine

This guide explains how to create a new SQL optimizer room plugin (e.g., MySQL, BigQuery) using `sql-optimizer-core`.

## Architecture Overview

A room plugin implements two interfaces:

1. **Plugin hooks** — passed to `createBasePlugin(hooks)`. Controls infrastructure lifecycle (startup, shutdown) and engine-specific behavior at key state machine points.
2. **Engine object** — returned by `hooks.createEngine()`. Provides database-specific functions consumed by the shared core (plan comparison, result normalization, prompt building, metrics rendering).

The shared core owns the orchestrator state machine (baseline → planning → cycle → audit → retest → synthesis → complete). Your plugin provides the hooks that inject engine-specific behavior at each stage.

## Directory Structure

```
room-plugins/
  sql-optimizer-core/           # Shared library (do not modify)
  your-engine-optimizer/
    lib/
      plugin.js                 # Plugin hooks → createBasePlugin(hooks)
      engine.js                 # Engine object → createYourEngine()
      harness.js                # Database connection, benchmarking
      planning.js               # Prompt builders (target builders)
      config.js                 # Room config normalization
      constants.js              # Engine-specific defaults and constants
    assets/                     # Demo data (optional)
    test/
    room.yaml                   # Declarative room definition
    manifest.json               # Generated from room.yaml
    index.js                    # Entry point
    lib-deps.txt                # Contains: sql-optimizer-core
    package.json
```

## Interface 1: Plugin Hooks

```js
import { createBasePlugin } from '../../sql-optimizer-core/index.js';

export function createPlugin() {
  return createBasePlugin({
    // ── Required ──────────────────────────────────────────────

    createEngine,          // () => engine object (see Interface 2)

    getConfig,             // (ctx) => merged config object

    engineInitialState: {  // Engine-specific state fields.
      // IMPORTANT: Keys must NOT collide with core state keys:
      // phase, candidates, baselines, cycleIndex, frontierIds, etc.
      // createBasePlugin will throw if a collision is detected.
      myConnection: null,
      myMetadata: null,
    },

    onRoomStart,           // async (ctx, helpers) => decision
    // helpers: { state, config, engine, emitStateMetrics, buildDecision, setPhase, PHASES }
    // Must:
    //   1. Set up infrastructure (connect, load schema, etc.)
    //   2. Mutate `state` with engine state (connection info, metadata)
    //   3. On success: call setPhase(state, PHASES.BASELINE), set state.pendingFanOut = 'baseline',
    //      call ctx.setState(state), emitStateMetrics(ctx, state), return buildDecision(ctx, state, config)
    //   4. On failure: call setPhase(state, PHASES.COMPLETE), ctx.setState(state),
    //      return { type: 'stop', reason: 'your_error' }

    shutdown,              // async (ctx, state) => void
    // Clean up resources (Docker containers, connections, temp files)

    // ── Optional ──────────────────────────────────────────────

    beforeFinishSearchCycle,   // (state) => void
    // Called at the start of each cycle finish. Use for materializing
    // advisory proposals or other pre-stop bookkeeping.

    filterRetestCandidates,    // (candidates) => candidates
    // Filter which candidates enter the retest queue.
    // Example: Redshift filters to only measured strategy types.

    beforePromoteProposals,    // (state, config) => void
    // Called before selectActivePromotedProposals in the planning phase.
    // Use to materialize advisory proposals or pre-filter the backlog.
    // The base handles promotion after this returns.

    filterPromotedProposals,   // (proposals) => proposals
    // Filter promoted proposals after selection. Return only the proposals
    // that should enter the benchmark cycle. If this returns empty but
    // advisory candidates exist, the base routes to audit automatically.

    afterCycleMerge,           // async (ctx, state, config, { builtNewCandidates, responses }) => void
    // Called after cycle artifacts are merged, before audit routing.
    // Use for harness verification, parity checks, snapshot restore.

    afterRetestMerge,          // async (ctx, state, config, { responses, newCandidatesFromRetest, emitStateMetrics, buildDecision }) => decision | null
    // Called after retest results are merged. Return a decision to override
    // default routing (e.g., route new candidates to audit), or null.

    onSynthesisComplete,       // (ctx, state, responses) => void
    // Called when synthesis fan-out completes. Use to merge votes.
    // Only called if engine.targetBuilders.synthesis exists.
  });
}
```

## Interface 2: Engine Object

Returned by `hooks.createEngine()`. All properties are optional with sensible defaults, but a useful engine should implement most of them.

```js
export function createYourEngine() {
  return {
    // ── Strategy types ────────────────────────────────────────
    strategyTypes: ['index', 'rewrite'],     // All strategy types this engine supports
    // Optional: measuredStrategyTypes: ['rewrite']  // Subset that enters the benchmark loop
    defaultStrategyType: 'index',            // Fallback when type cannot be detected

    // ── Risk categories ───────────────────────────────────────
    riskCategories: ['lock_contention', 'storage_overhead', ...],

    // ── Confidence thresholds (optional) ──────────────────────
    // Override core defaults for engines with different measurement characteristics.
    // confidenceThresholds: {
    //   CV_DISCARD_THRESHOLD: 25,           // Higher for shared clusters
    //   HIGH_SPEEDUP_WITH_PLAN_CHANGE: 2.0, // 2x speedup = high confidence
    //   ACCEPT_WITHOUT_PLAN_CHANGE: 5.0,    // 5x speedup needed without plan change
    //   BASELINE_DRIFT_THRESHOLD: 20,
    //   RETEST_CONFIRMATION_TOLERANCE: 25,
    //   computeRobustCV: (baselines) => number | undefined,  // Optional robust CV
    // },

    // ── Plan shape comparison ─────────────────────────────────
    determinePlanShapeChanged(candidate) {},
    // candidate: { baseline: {...}, result: {...}, strategyType }
    // Return true if the query plan fundamentally changed (e.g., Seq Scan → Index Scan).
    // Used by confidence gating to determine threshold.

    // ── Strategy type detection ───────────────────────────────
    detectStrategyTypeFromSQL(sql) {},
    // Return the strategy type for a given SQL string.
    // Example: /CREATE\s+INDEX/i → 'index', otherwise 'rewrite'

    // ── Builder result normalization ──────────────────────────
    extendBuilderResult(normalized, raw) {},
    // Add engine-specific fields to the normalized builder result.
    // normalized: { baseline: {...}, candidate: {...} }
    // raw: the raw parsed JSON from the builder response
    // Mutate and return normalized.

    // ── Rendering ─────────────────────────────────────────────
    buildWinnerBlock(candidate, label) {},
    // Return a multi-line string rendering a candidate for the Solutions panel.
    // Use buildWinnerBlockHeader(candidate, label) from core for the common prefix.

    buildEngineBaselineRows(state) {},
    // Return [{metric, value}] rows for the baseline metrics table.
    // Use buildCommonBaselineRows(state.baselines) from core for median/p95/CV%.

    buildEngineMetrics(state, config) {},
    // Return an object with additional dashboard metrics (winnerQueries, etc.)
    // Merged into the emitted metrics via Object.assign.

    // ── Prompt target builders ────────────────────────────────
    targetBuilders: {
      baseline: (ctx, state, config) => targets,   // Builder prompt for baseline measurement
      planning: (ctx, state, config) => targets,    // Explorer prompt for proposal generation
      cycle:    (ctx, state, config) => targets,    // Builder prompt for benchmarking proposals
      audit:    (ctx, state, config) => targets,    // Auditor prompt for risk review
      retest:   (ctx, state, config) => targets,    // Builder prompt for retest measurement
      // Optional:
      // synthesis: (ctx, state, config) => targets, // All-agent prompt for final ranking
    },
    // Each returns an array of { agentId, message } targeting specific participants.
    // The state machine routes to synthesis before stopping only if targetBuilders.synthesis exists.
  };
}
```

## Context Object (`ctx`)

Every hook receives `ctx` with these properties:

```js
{
  roomId: string,                    // Unique room identifier
  participants: [                    // Agent participants
    { agentId, displayName, role },  // role: 'explorer' | 'builder' | 'auditor'
  ],
  limits: { maxCycles, maxTurns },   // Room limits
  roomConfig: { ... },               // Raw room configuration
  orchestratorConfig: { ... },       // Orchestrator tuning parameters

  getState(): object | null,         // Get current state (deep copy)
  setState(state): void,             // Persist state (deep copy)
  setCycle(n): void,                 // Update cycle counter
  emitMetrics(metrics): void,        // Emit dashboard metrics
}
```

## Decision Return Types

Hooks that return decisions use one of:

```js
{ type: 'fan_out', targets: [{ agentId, message }] }  // Send prompts to agents
{ type: 'stop', reason: 'string' }                     // Stop the room
{ type: 'pause', reason: 'string' }                    // Pause the room
null                                                    // No decision (continue default flow)
```

## State Mutation Protocol

| Hook | Mutate state? | Call ctx.setState? | Call emitStateMetrics? | Return decision? |
|------|---------------|-------------------|----------------------|-----------------|
| `onRoomStart` | Yes | Yes | Yes | Yes (required) |
| `beforeFinishSearchCycle` | Yes | No (base does it) | No | No (void) |
| `filterRetestCandidates` | No | No | No | No (return array) |
| `beforePromoteProposals` | Yes | No (base does it) | No | No (void) |
| `filterPromotedProposals` | No | No | No | No (return array) |
| `afterCycleMerge` | Yes | No (base does it) | No | No (void) |
| `afterRetestMerge` | Yes | Only if returning decision | Only if returning decision | Optional |
| `onSynthesisComplete` | Yes | No (base does it) | No | No (void) |
| `shutdown` | No | No | No | No (void) |

## Minimal Skeleton

```js
// lib/plugin.js
import { createBasePlugin } from '../../sql-optimizer-core/index.js';
import { createMyEngine } from './engine.js';
import { getConfig, buildCompatibilityReport } from './config.js';

export function createPlugin() {
  return createBasePlugin({
    createEngine: createMyEngine,
    getConfig,
    engineInitialState: { connectionInfo: null },

    async onRoomStart(ctx, { state, config, emitStateMetrics, buildDecision, setPhase, PHASES }) {
      // 1. Check compatibility
      const report = await buildCompatibilityReport(config);
      if (!report.compatible) {
        setPhase(state, PHASES.COMPLETE);
        ctx.setState(state);
        emitStateMetrics(ctx, state);
        return { type: 'stop', reason: 'global_preflight_failed' };
      }

      // 2. Connect and gather metadata
      // state.connectionInfo = await connect(config.dbUrl);

      // 3. Transition to baseline
      setPhase(state, PHASES.BASELINE);
      state.pendingFanOut = 'baseline';
      state.proposalBacklog = [];
      ctx.setCycle(0);
      ctx.setState(state);
      emitStateMetrics(ctx, state);
      return buildDecision(ctx, state, config);
    },

    async shutdown(_ctx, _state) {
      // Clean up connections, containers, etc.
    },
  });
}
```

## Core Imports

Useful utilities available from `sql-optimizer-core/index.js`:

```js
// Utilities
safeTrim, clampInt, optionalFiniteNumber, normalizeStringArray,
isReadOnlyQuery, sanitizeSQL, extractQueryTableRefs, buildOrchestratorConfig

// Constants
PHASES, PHASE_ORDER, CONFIDENCE_THRESHOLDS

// State management
setPhase, advancePhase, createInitialState

// Candidates & frontier
isConfidentMeasurement, recomputeFrontier, evaluateImprovement,
chooseStopReason, selectRetestCandidates, findCandidateById

// Reporting helpers
buildCommonBaselineRows, buildWinnerBlockHeader, buildAuditSummaryLines,
emitStateMetrics

// Planning helpers
buildRecentFailureDiagnostics, buildFrontierSummary, buildDataWarningsSection

// Plugin factory
createBasePlugin, collectSchemaRepairBuilderResponses
```

## Reference Implementations

- **Postgres** (`postgres-query-optimizer`): Docker harness, index + rewrite strategies, harness-verified parity checks
- **Redshift** (`redshift-query-optimizer`): Live cluster connection, rewrite + advisory sort_dist strategies, synthesis voting
