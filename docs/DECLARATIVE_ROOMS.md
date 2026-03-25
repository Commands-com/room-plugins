# Declarative Room Definitions

Declarative rooms replace imperative plugin boilerplate with a three-layer model:

| Layer | File | Responsibility |
|---|---|---|
| **Definition** | `room.yaml` | Room logistics: metadata, roles, limits, phases, dispatch, dashboard, report |
| **Engine** | `index.js` → `export const engine` | Domain semantics: strategy types, plan shape comparison, prompt builders, winner rendering |
| **Harness** | `index.js` → `export const harness` | Environment interaction: connect, disconnect, compatibility checks, config normalization |

The host provides a **family runtime** (e.g., `empirical_search`) that orchestrates the engine and harness according to the definition. Plugin authors write domain logic; the runtime handles state machines, dispatch, frontier management, and convergence detection.

## When to Use Declarative vs Classic

| Use declarative when... | Use classic when... |
|---|---|
| Your room follows an established family pattern (empirical search, etc.) | Your room has a unique orchestration model |
| You want the host to manage phase transitions and dispatch | You need full control over every decision |
| You're building a variant of an existing optimizer (SQL, FFT, etc.) | You're building something fundamentally different |

Both formats coexist. Classic `manifest.json + index.js` plugins continue working unchanged.

## File Layout

```
room-plugins/
  my-optimizer/
    room.yaml              # Declarative definition (canonical)
    manifest.json          # Generated-equivalent for classic compat
    index.js               # Exports engine + harness (declarative) AND manifest + createPlugin (classic)
    lib/
      engine.js            # Domain-specific engine hooks
      harness.js           # Environment interaction
      planning.js          # Prompt target builders
      constants.js         # Strategy types, thresholds, defaults
      config.js            # Config normalization, compatibility checks
      plugin.js            # Classic plugin implementation (backward compat)
    lib-deps.txt           # Shared library dependencies (one per line)
    package.json
    test/
```

## `room.yaml` Reference

### Required Structure

```yaml
apiVersion: room/v1
kind: declarative_room

metadata:
  id: my_optimizer
  orchestratorType: my_optimizer
  name: My Optimizer
  description: One-line description.
  family: empirical_search
```

`apiVersion` must be `room/v1`. `kind` must be `declarative_room`. `metadata.family` selects the family runtime.

### Top-Level Keys

All keys are validated. Unknown keys are rejected at every nesting level.

| Key | Required | Description |
|---|---|---|
| `apiVersion` | yes | Must be `room/v1` |
| `kind` | yes | Must be `declarative_room` |
| `metadata` | yes | id, orchestratorType, name, description, family |
| `display` | no | UI labels, default roster, activity messages |
| `objective` | no | Objective field config (required, placeholder) |
| `roles` | yes | required, optional, forbidden, minCount |
| `limits` | no | maxCycles, maxTurns, timeouts, turnFloor |
| `roomConfig` | no | User-facing config fields rendered in create UI |
| `supportsQuorum` | no | Boolean |
| `endpointConstraints` | no | requiresLocalParticipant, perRole |
| `lanes` | no | Lane definitions mapping roles to dispatch groups |
| `familyConfig` | no | Family-specific tuning (strategy types, plateau, etc.) |
| `configSchema` | no | Numeric-only orchestrator config schema |
| `setup` | no | Compatibility gate configuration |
| `phases` | yes | State machine: initial phase + phase states |
| `prompts` | no | Prompt definitions with context bindings |
| `dashboard` | no | Dashboard panel definitions |
| `report` | no | Report layout |
| `cli` | no | Command/skill metadata for host-generated CLI integrations |

### `display`

```yaml
display:
  typeLabel: My Optimizer
  typeTag: SQL
  cycleNoun: Cycle
  reportTitle: Optimization Report
  defaultAddRole: explorer
  defaultRoster:
    - role: explorer
      displayName: Schema Analyst
    - role: builder
      displayName: Query Architect
  activityMessages:
    idle: Waiting...
    discovery: Analyzing schema
    fanOut: Running benchmarks
    synthesis: Voting on results
  phaseActivityMessages:
    baseline: Running baseline measurements
    planning: Choosing next candidate set
    cycle: Workers testing candidate changes
    audit: Auditing the leading candidate
```

### `roles`

```yaml
roles:
  required: [explorer, builder, auditor]
  optional: []
  forbidden: [implementer, reviewer, worker]
  minCount:
    explorer: 1
    builder: 1
    auditor: 1
```

### `limits`

Numeric limits use `{ default, min, max }` objects. String limits are bare values.

```yaml
limits:
  maxCycles: { default: 4, min: 1, max: 10 }
  maxTurns: { default: 60, min: 4, max: 500 }
  maxDurationMs: { default: 3600000, min: 60000, max: 14400000 }
  maxFailures: { default: 5, min: 1, max: 20 }
  agentTimeoutMs: { default: 1800000, min: 10000, max: 3600000 }
  pluginHookTimeoutMs: { default: 120000, min: 5000, max: 600000 }
  llmTimeoutMs: { default: 60000, min: 10000, max: 300000 }
  turnFloorRole: explorer
  turnFloorFormula: "1 + N"
```

### `roomConfig`

User-facing fields rendered in the room creation UI.

```yaml
roomConfig:
  fields:
    - key: dbUrl
      type: string
      label: Database URL
      required: true
      placeholder: "postgres://user:pass@host:5432/db"
      helpText: Connection string for the target database.
    - key: slowQuery
      type: text
      label: Target Query
      required: true
      multiline: true
      rows: 8
    - key: schemaFilter
      type: string[]
      label: Include Tables
      required: false
    - key: outputDir
      type: directory
      label: Output Directory
      required: false
```

Supported field types: `string`, `text`, `integer`, `number`, `boolean`, `select`, `string[]`, `directory`.

Type mapping to manifest: `text` becomes `string` with `multiline: true`. `string[]` becomes `string_array`. `helpText` becomes `description`.

### `lanes`

Lanes group roles for dispatch targeting.

```yaml
lanes:
  explorer:
    fromRoles: [explorer]
  builder:
    fromRoles: [builder]
  auditor:
    fromRoles: [auditor]
```

### `phases`

The phase state machine drives room progression. Each phase has a dispatch target, prompt, and completion conditions.

```yaml
phases:
  initial: preflight
  states:
    - id: preflight
      dispatch: none
      onComplete:
        next: baseline

    - id: baseline
      dispatch: builder
      prompt: baseline
      onComplete:
        next: planning

    - id: planning
      dispatch:
        lane: explorer
        mode: all
      prompt: planning
      onComplete:
        when:
          - if: hasMeasuredPromotions
            next: cycle
          - if: hasAdvisoryOnlyPromotions
            next: audit
          - if: noCandidatesProduced
            next: complete
          - else: frontier_refine

    - id: cycle
      dispatch:
        lane: builder
        mode: count
        count: 4
        selection: round_robin
      prompt: cycle
      onComplete:
        when:
          - if: builtNewCandidates
            next: audit
          - if: schemaRepairNeeded
            next: schema_repair
          - if: needsRetest
            next: frontier_refine
          - if: stopReasonPresent
            next: synthesis
          - else: planning

    - id: synthesis
      dispatch:
        lane: explorer
        mode: all
      prompt: synthesis
      emitPhase: synthesis
      onComplete:
        next: complete

    - id: complete
      dispatch: none
```

#### Dispatch

Dispatch can be a string shorthand or an object:

| Form | Meaning |
|---|---|
| `dispatch: builder` | All participants in the `builder` lane |
| `dispatch: none` | No fan-out (phase handled internally) |
| `dispatch: { lane: builder, mode: all }` | Explicit: all builders |
| `dispatch: { lane: builder, mode: count, count: 4, selection: round_robin }` | 4 builders, rotating |

Dispatch properties:

| Property | Values | Default |
|---|---|---|
| `lane` | Lane name or `none` | — |
| `mode` | `all`, `count`, `single` | `all` |
| `count` | Integer (when mode is `count`) | — |
| `selection` | `round_robin`, `first`, `leader`, `random` | `round_robin` |

#### Conditional Transitions (`onComplete.when`)

Each condition tests a predicate. The first matching condition determines the next phase. Use `else` as a fallback.

```yaml
onComplete:
  when:
    - if: builtNewCandidates
      next: audit
    - if: stopReasonPresent
      next: synthesis
    - else: planning
```

### `prompts`

Prompt definitions bind context from room config and state.

```yaml
prompts:
  baseline:
    contextBindings:
      - config.dbUrl
      - config.slowQuery
  planning:
    contextBindings:
      - config.slowQuery
      - state.baselines
      - state.tableMetadata
  cycle:
    contextBindings:
      - config.slowQuery
      - state.currentPlan
      - state.frontier
```

Context binding namespaces:

| Prefix | Resolves against | Validated against |
|---|---|---|
| `config.*` | `roomConfig` field keys | roomConfig field definitions |
| `state.*` | Plugin state | Family's `allowedStateBindings` |
| `familyConfig.*` | Family config | Family's `allowedFamilyConfigKeys` |

### `familyConfig`

Family-specific tuning. Keys are validated against the family schema.

```yaml
familyConfig:
  strategyTypes: [rewrite, sort_dist]
  measuredStrategyTypes: [rewrite]
  plannedCandidatesPerCycle: 4
  promoteTopK: 2
  maxRetestCandidates: 2
  plateauCycles: 2
  targetImprovementPct: 20
  supportsSchemaRepair: true
  supportsBaselineRetest: true
```

### `configSchema`

Numeric-only knobs exposed to room creators.

```yaml
configSchema:
  plannedCandidatesPerCycle: { type: integer, min: 1, max: 10, default: 4 }
  warmupRuns: { type: integer, min: 1, max: 20, default: 2 }
  benchmarkTrials: { type: integer, min: 3, max: 50, default: 5 }
```

### `setup`

Compatibility gate shown before room creation.

```yaml
setup:
  compatibilityGate:
    enabled: true
    title: Optimizer Preflight
    description: Verify connectivity and query validity.
    checkLabel: Verify Connection
    fixLabel: Setup Workspace
    allowMakeCompatible: true
```

### `dashboard` and `report`

Same panel types as classic plugins. See [DASHBOARD_GUIDE.md](./DASHBOARD_GUIDE.md) for panel types and metrics shapes.

```yaml
dashboard:
  panels:
    - type: phase
      key: currentPhase
      label: Phase
      phases: [preflight, baseline, planning, cycle, audit, synthesis, complete]
    - type: counter-group
      key: candidateSummary
      label: Strategies
      counters:
        - { key: proposed, label: Proposed, color: gray }
        - { key: promoted, label: Promoted, color: blue }
    - type: table
      key: frontier
      label: Frontier
      columns:
        - { key: proposalId, label: Proposal, width: 180 }
        - { key: medianMs, label: "Time (ms)", width: 100 }
      sortable: true

report:
  summaryMetrics: [bestImprovementPct, candidateSummary]
  table:
    metricKey: candidates
    columns:
      - { key: strategyType, label: Type, width: 120 }
      - { key: speedupPct, label: "Speedup %", width: 100 }
  codeBlocks:
    - { metricKey: solutions, label: Solutions, language: sql }
```

### `cli`

Declarative rooms may expose command/skill metadata directly from `room.yaml`.
This lets the host generate command entry points and related skill integrations
for the room.

```yaml
cli:
  command: postgres-query-optimize
  description: Optimize PostgreSQL queries with empirical benchmarking
  positionalArgs:
    - name: connection-string
      type: string
      mapTo: roomConfig.dbUrl
  startParams:
    - name: schema-source
      type: enum
      choices: [introspect, dump, migrations]
      default: introspect
      mapTo: roomConfig.schemaSource
  statusFields:
    - key: currentPhase
      label: Phase
      format: text
      extract: active
  skill:
    name: postgres-query-optimize
    description: Optimize slow SQL queries using multi-agent benchmarking
    defaultObjective: Analyze and optimize the provided queries for maximum performance
    contextGathering:
      requiredInputs: [connection-string]
```

The field-level schema for `cli` matches the classic-plugin `manifest.json`
contract in [`CONTRACT.md`](./CONTRACT.md).

### `handoff`

Declarative rooms may also declare pipeline handoff contracts so control-room
style workflows can validate stage compatibility.

```yaml
handoff:
  inputs:
    - contract: spec_bundle.v1
      required: false
      multiple: false
  outputs:
    - contract: implementation_bundle.v1
      default: true
  defaultApprovalMode: auto
```

The field-level schema for `handoff` matches the classic-plugin
`manifest.json` contract in [`CONTRACT.md`](./CONTRACT.md). Contract IDs must
exist in the host's known handoff-contract registry.

## Family: `empirical_search`

The `empirical_search` family runtime handles rooms that iteratively explore a search space, benchmark candidates, and converge on winners. Used by FFT autotune, Postgres query optimizer, and Redshift query optimizer.

### Available Predicates

| Predicate | True when... |
|---|---|
| `builtNewCandidates` | Cycle produced new candidates (`_newCandidateCount > 0`) |
| `schemaRepairNeeded` | Builder responses indicate schema errors + `supportsSchemaRepair` enabled |
| `hasMeasuredPromotions` | Promoted proposals include measured strategy types |
| `hasAdvisoryOnlyPromotions` | All promoted proposals are advisory (unmeasured) |
| `stopReasonPresent` | Convergence detected (`_stopReason` set) |
| `needsRetest` | Retest queue has items or baseline needs retest |
| `plateauReached` | No improvement for `plateauCycles` consecutive cycles |
| `noCandidatesProduced` | No active proposals and no backlog |

### Available State Bindings

For use in `prompts.*.contextBindings`:

- `state.baselines` — Baseline measurements
- `state.tableMetadata` — Schema/table information
- `state.candidates` — All candidate records
- `state.promotions` — Promoted proposals for current cycle
- `state.currentPlan` — Current cycle plan
- `state.frontier` — Best candidates ranked by performance
- `state.cycleHistory` — Per-cycle summary
- `state.stopReason` — Why convergence was detected
- `state.lastFailureReason` — Last error context

### Allowed `familyConfig` Keys

`strategyTypes`, `measuredStrategyTypes`, `promoteTopK`, `plannedCandidatesPerCycle`, `maxRetestCandidates`, `plateauCycles`, `targetImprovementPct`, `supportsSchemaRepair`, `supportsBaselineRetest`

### Engine Interface

The engine object exported from `index.js` must implement:

```js
export const engine = {
  strategyTypes: ['rewrite', 'index'],        // All strategy types
  measuredStrategyTypes: ['rewrite'],          // Types that get benchmarked
  defaultStrategyType: 'rewrite',
  riskCategories: { ... },
  confidenceThresholds: { ... },

  // Domain-specific hooks
  determinePlanShapeChanged(candidate),        // Boolean: did the plan change shape?
  detectStrategyTypeFromSQL(sql),              // Classify SQL into strategy type
  extendBuilderResult(normalized, raw),        // Add domain fields to builder result
  buildWinnerBlock(candidate, label),          // Render winner as code block text
  buildEngineBaselineRows(state),              // Baseline rows for dashboard table
  buildEngineMetrics(state, config),           // Extra dashboard metrics

  // Prompt target builders (one per prompt key)
  targetBuilders: {
    baseline: (ctx, state, config) => targets,
    planning: (ctx, state, config) => targets,
    cycle: (ctx, state, config) => targets,
    audit: (ctx, state, config) => targets,
    retest: (ctx, state, config) => targets,
    synthesis: (ctx, state, config) => targets,
  },
};
```

### Harness Interface

The harness object provides environment interaction:

```js
export const harness = {
  connect,                      // Connect to target system
  disconnect,                   // Disconnect
  getClusterInfo,               // Fetch system metadata
  getTableMetadata,             // Fetch schema information
  checkCompatibility,           // Preflight compatibility check
  makeCompatible,               // Auto-fix compatibility issues
  buildCompatibilityReport,     // Format compatibility report
  getConfig,                    // Normalize room config
};
```

## `index.js` Dual Export

Declarative rooms export both formats for backward compatibility:

```js
// Declarative exports — used when room.yaml is present
export const engine = createMyEngine();
export const harness = { connect, disconnect, checkCompatibility, ... };

// Classic exports — backward compatibility when loaded via manifest.json
export default { manifest, createPlugin, checkCompatibility, makeCompatible };
export { manifest, createPlugin, checkCompatibility, makeCompatible };
```

The host detects `room.yaml` and uses the declarative path. Without `room.yaml`, the classic path loads `manifest.json + index.js` as before.

## Shared Libraries (`lib-deps.txt`)

Plugins can depend on shared libraries (directories without `manifest.json`) that live alongside plugins in `room-plugins/`.

Create a `lib-deps.txt` file listing one dependency per line:

```
sql-optimizer-core
```

The install script syncs these libraries to the destination alongside plugins. The plugin registry skips directories that have neither `room.yaml` nor `manifest.json`.

Import shared libraries using relative paths:

```js
import { safeTrim, findCandidateById } from '../../sql-optimizer-core/index.js';
```

## Lifecycle: Discovery, Validation, Activation

| Phase | When | What happens |
|---|---|---|
| **Discovery** | App startup | Reads `room.yaml` only. No code imported. Builds manifest, registers deferred descriptor. |
| **Validation** | Discovery time | Fail-closed schema validation. Unknown keys rejected at every nesting level. Predicates validated against family. Context bindings validated against config/state/familyConfig registries. |
| **Activation** | First `resolvePlugin()` call | Imports `index.js`, resolves shared libraries, creates family runtime, compiles full descriptor. |

This split means untrusted plugin code is never imported until a room actually uses that type.

## Validation Rules

The schema validator is fail-closed:

- Unknown keys rejected at every nesting level (top-level, metadata, display, roles, limits, roomConfig fields, lanes, phases, dispatch, onComplete conditions, prompts, dashboard, report, setup, configSchema)
- Phase `onComplete.when` predicates must exist in the family's `allowedPredicates`
- Phase `onComplete.when` next targets must reference valid phase IDs
- Prompt `contextBindings` validated: `config.*` against roomConfig keys, `state.*` against family's `allowedStateBindings`, `familyConfig.*` against family's `allowedFamilyConfigKeys`
- `familyConfig` keys validated against family's `allowedFamilyConfigKeys`
- A typo like `state.frontierr` fails at discovery time, not at runtime

## Migrating a Classic Plugin

1. Create `room.yaml` with your room's metadata, roles, limits, phases, and dashboard
2. Add `metadata.family` to select a family runtime
3. Refactor `index.js` to export `engine` and `harness` named exports
4. Move domain logic into engine hooks (strategy detection, plan shape, prompt builders, etc.)
5. Move environment interaction into harness (connect, compatibility, config)
6. Keep the classic `default` export for backward compatibility
7. Add tests for `room.yaml` validation (see `test/declarative.test.js` in redshift-query-optimizer)
8. Reinstall: `./scripts/install-room-plugins.sh --plugin my-room`

## Reference Implementation

See `room-plugins/redshift-query-optimizer/` for a complete declarative room:

- `room.yaml` — 350 lines, 9 phases, conditional transitions, 11 dashboard panels
- `lib/engine.js` — Redshift-specific plan shape, winner rendering, prompt builders
- `lib/harness.js` — Redshift connection, cluster metadata
- `index.js` — Dual export (declarative + classic)
- `test/declarative.test.js` — 23 validation and compilation tests
