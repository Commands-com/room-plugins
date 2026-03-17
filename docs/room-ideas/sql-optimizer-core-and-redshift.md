# SQL Optimizer — Shared Core Extraction & Redshift Room Spec

## Overview

The postgres-query-optimizer room has proven the core optimization loop works:
baseline → propose → benchmark → audit → refine. This spec covers two things:

1. **Extracting a shared core library** from the Postgres room so future engine
   rooms (Redshift, MySQL, BigQuery, Snowflake) don't duplicate orchestration logic.
2. **Building the redshift-query-optimizer room** as the second engine, using
   that shared core.

## Architecture Principle

**Separate rooms, shared core.** Not one monolithic "SQL Query Optimizer" room.

Why separate rooms:
- "Frontier," "verified," "parity," and "best result" mean different things per engine
- Postgres/MySQL/SQLite = local harness, real benchmarks, indexes + rewrites
- Redshift/BigQuery/Snowflake = direct connection, rewrite-heavy, cost/planner signals
- Forcing these into one ranking model compromises both
- Each room can evolve its audit dimensions, strategy types, and scoring independently

Why shared core:
- Candidate lifecycle, frontier ranking, cycle progression are engine-agnostic
- Envelope parsing (JSON extraction from LLM responses) is identical
- Report emission (tables, code blocks, progress) is structural, not domain-specific
- Planning scaffolding (prompt building, mutation hints, role assignment) is reusable
- Bug fixes and improvements apply everywhere

---

## Part 1: Shared Core Extraction

### Source

Extract from `room-plugins/postgres-query-optimizer/lib/` into a new package:

```
room-plugins/sql-optimizer-core/
  package.json
  lib/
    candidates.js    — candidate lifecycle, frontier ranking, improvement tracking
    envelope.js      — extractJson, parseWorkerEnvelope, normalizer routing
    phases.js        — phase management, state creation, partial phase derivation
    report.js        — metric emission, table row building, winner block formatting
    planning.js      — prompt scaffolding, mutation hint generation, target building
    constants.js     — shared constants (phase names, confidence thresholds)
    utils.js         — safeTrim, clampInt, optionalFiniteNumber, etc.
  index.js           — re-exports
```

### What stays engine-specific

Each engine room keeps:
- `lib/harness.js` — entirely engine-specific (Docker vs direct connection)
- `lib/config.js` — engine-specific config normalization and compatibility checks
- `lib/plugin.js` — orchestration wiring (imports core + harness, connects them)
- `manifest.json` — engine-specific config schema, dashboard panels, display labels
- `assets/` — demo data, if applicable

### Parameterization points

The shared core needs these engine-provided hooks:

```javascript
// Engine provides to core:
{
  strategyTypes: ['index', 'rewrite'],        // or ['rewrite', 'sort_key', 'dist_key']
  scoringFn: (candidate) => number,            // engine-specific ranking score
  auditDimensions: [...],                      // risk categories
  explainParser: (output) => planShape,         // engine-specific EXPLAIN format
  formatSpeedup: (candidate) => string,         // "99.9% faster" vs "80% less slot-time"
}
```

### Extraction order

1. Move utils.js, constants.js (engine-agnostic parts only)
2. Move phases.js (no engine dependencies)
3. Move envelope.js (parameterize normalizer selection)
4. Move candidates.js (parameterize scoring/ranking, pass strategyTypes)
5. Move report.js (parameterize winner block format, metric labels)
6. Move planning.js (parameterize prompt sections, audit dimensions)
7. Update postgres-query-optimizer to import from core
8. Verify all tests still pass

---

## Part 2: Redshift Query Optimizer Room

### Why Redshift next

- Real use case: large data dashboards already running on Redshift
- Tests the "direct connection, rewrite-only" family of engines
- Simpler than Postgres (no Docker harness, no index creation, no snapshot management)
- Validates that the shared core actually works for a different engine

### Key differences from Postgres

| Dimension | Postgres | Redshift |
|---|---|---|
| Connection | Docker harness container | Direct connection to cluster |
| Data | Pull from source into harness | Already in Redshift |
| Strategies | index + rewrite | rewrite + sort key + dist key recommendations |
| Benchmarking | EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) | EXPLAIN + SVL_QUERY_SUMMARY / STL_QUERY / query elapsed time |
| Isolation | Snapshot restore between candidates | No mutation — rewrites don't change state |
| Plan format | JSON with node tree | Text-based, steps with labels |
| Cost model | Execution time (ms) | Execution time + scan/join/dist step costs |
| Parity check | EXCEPT ALL between original and rewrite | Same approach, works in Redshift |
| Cleanup | Container + volume teardown | Nothing to clean up |
| Demo mode | Bundled schema + data in Docker | Not applicable (needs real cluster) |

### Strategy types

```
rewrite     — CTE restructuring, JOIN reordering, subquery elimination,
              predicate pushdown, APPROXIMATE COUNT DISTINCT, window function optimization
sort_key    — recommend SORTKEY changes (compound vs interleaved)
dist_key    — recommend DISTKEY/DISTSTYLE changes (KEY, ALL, EVEN, AUTO)
```

Sort key and dist key changes are **recommendations only** — they require table rebuilds
and can't be tested in-place. The room proposes them with rationale but can't benchmark
them. Rewrites are the primary benchmarkable strategy.

### Harness: `lib/harness.js`

No Docker. Direct connection to the Redshift cluster.

```javascript
export async function connect(config) {
  // Use pg client (Redshift is wire-compatible with Postgres)
  // Connection string from config.dbUrl
  // Returns a client handle
}

export async function runExplain(client, query) {
  // EXPLAIN <query> — returns text plan
  // Parse into step list with operation types, rows, cost, dist flags
}

export async function runBenchmark(client, query, config) {
  // Warmup runs (execute + discard)
  // Timed trials: execute, record wall-clock elapsed from query metadata
  // Pull from SVL_QUERY_SUMMARY or STL_QUERY for detailed step costs
  // Return: medianMs, p95Ms, cvPct, planSteps, scanTypes, joinTypes, distSteps
}

export async function checkParity(client, originalQuery, rewrittenQuery) {
  // Same EXCEPT ALL approach — works in Redshift
  // May need UNLOAD to S3 for very large result sets
}

export async function getTableMetadata(client, tableNames) {
  // SVV_TABLE_INFO: sort keys, dist keys, row counts, size
  // SVV_COLUMNS: column types, encoding
  // pg_stat_user_tables equivalent
  // Returns schema context for explorer prompts
}
```

### Benchmarking approach

Redshift doesn't have `EXPLAIN ANALYZE`. Two approaches:

**Option A: Wall-clock timing (simpler, start here)**
- Execute the query, measure elapsed time from `SVL_QUERY_SUMMARY`
- Multiple trials, compute median/p95/CV%
- Compare original vs rewrite

**Option B: Query plan cost comparison (richer)**
- `EXPLAIN` gives estimated costs per step
- Compare step-level costs: "eliminated a DS_BCAST_INNER redistribute step"
- Combine with wall-clock for both estimated and actual improvement

Start with Option A, add Option B for richer reporting.

### Config schema (roomConfigSchema)

```json
{
  "dbUrl": {
    "type": "string",
    "label": "Redshift URL",
    "required": true,
    "placeholder": "redshift://user:pass@cluster.region.redshift.amazonaws.com:5439/db"
  },
  "slowQuery": {
    "type": "string",
    "label": "Target Query",
    "required": true,
    "multiline": true,
    "rows": 8
  },
  "schemaFilter": {
    "type": "string_array",
    "label": "Include Tables",
    "maxItems": 20,
    "default": []
  },
  "warmupRuns": {
    "type": "string",
    "label": "Warmup Runs",
    "default": "2"
  },
  "benchmarkTrials": {
    "type": "string",
    "label": "Benchmark Trials",
    "default": "5"
  }
}
```

No demoMode, no schemaSource, no seedFromSource, no containerMemory, no postgresVersion.
Simpler config — just connection + query.

### Roles

Same three roles, different focus:

| Role | Postgres | Redshift |
|---|---|---|
| Explorer | Schema + plan analysis, missing indexes | Schema + dist/sort key analysis, redistribute steps, scan types |
| Builder | Create indexes, rewrite queries, benchmark | Rewrite queries, benchmark, recommend sort/dist key changes |
| Auditor | Lock contention, storage, write amplification | Query cost impact, WLM queue contention, COPY/maintenance window impact |

### Audit dimensions (Redshift-specific)

1. **Redistribute cost** — does the rewrite add or remove DS_DIST/DS_BCAST steps?
2. **Result set size** — does the rewrite change the amount of data scanned?
3. **WLM queue impact** — longer/shorter queries affect slot allocation
4. **Concurrency scaling** — will this rewrite trigger concurrency scaling?
5. **Maintenance window** — sort key/dist key changes require table rebuild

### Dashboard

Same structure as Postgres with engine-appropriate labels:

- Phase progression
- Baseline table (median ms, p95 ms, scan steps, redistribute steps)
- Candidate summary counters
- Frontier table
- All Attempts table
- Winner code blocks (rewritten SQL + sort/dist key recommendations)

### Phases

Same as Postgres minus the harness setup:

```
preflight    → verify connection, pull schema metadata
baseline     → benchmark original query
analysis     → explore schema, identify bottlenecks
codegen      → propose + benchmark rewrites
static_audit → auditor reviews candidates
frontier_refine → retest top candidates
complete     → final report
```

Preflight is simpler — just `SELECT 1` to verify connectivity + pull table metadata.
No Docker, no data loading, no snapshots.

### What's NOT needed

- Docker anything
- Data loading / sampling / full pull
- Snapshot creation / restore
- Container memory management
- Plan fidelity checking (same data = same planner decisions)
- Index size measurement
- Rollback SQL (rewrites don't mutate state)

### File structure

```
room-plugins/redshift-query-optimizer/
  package.json
  manifest.json
  index.js
  lib/
    harness.js       — Redshift connection, EXPLAIN, benchmark, parity
    config.js        — config normalization, compatibility check
    plugin.js        — orchestration (imports from sql-optimizer-core)
    planning.js      — Redshift-specific prompt sections
    constants.js     — strategy types, audit dimensions, defaults
  test/
    harness.test.js
    config.test.js
```

### Estimated effort

- Shared core extraction: 1 day (mostly moving + parameterizing)
- Redshift harness: 1 day (connection, EXPLAIN parsing, benchmarking)
- Redshift planning prompts: 0.5 day
- Redshift-specific config/manifest: 0.5 day
- Testing against real Redshift cluster: 1 day

Total: ~4 days, with a working Redshift optimizer tested against real dashboards.

---

## Build order

1. Finish Postgres room stabilization (current work)
2. Extract shared core into `sql-optimizer-core`
3. Update Postgres room to import from core, verify tests
4. Build Redshift room using core
5. Test against real Redshift dashboard queries
6. Later: MySQL, BigQuery, Snowflake as demand warrants
