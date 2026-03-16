# Postgres Query Optimizer — Room Spec

Empirical SQL performance tuning room. Takes a slow query, stands up an isolated
Postgres instance with realistic data, then runs a multi-agent search loop:
explore rewrites/indexes, benchmark with EXPLAIN ANALYZE, audit for operational
risk, refine until convergence.

## Why This Room

Every backend engineer has slow queries. The optimization loop maps almost 1:1
to the proven fft-autotune pattern:

| FFT Autotune | Postgres Query Optimizer |
|---|---|
| FFT kernel variant | Query rewrite or index strategy |
| Compile + validate correctness | Apply change + verify result parity |
| Benchmark (median ns, p95 ns) | EXPLAIN ANALYZE (execution time, planning time, rows, IO) |
| Bucket (FFT size) | Bucket (query variant or workload scenario) |
| Frontier (best per bucket) | Frontier (best strategy per optimization type) |
| Deterministic C harness | Docker Postgres harness with controlled data |

The validation story has two parts with very different confidence levels:

- **Result parity** (for rewrites) is a hard correctness gate — zero ambiguity.
- **EXPLAIN ANALYZE timing** is NOT deterministic the way FFT cycle-counting is.
  Even in Docker with pinned GUCs, execution times vary by 10-30% across runs due
  to OS scheduling, buffer cache state, and background Postgres processes. The room
  must treat timing as noisy and design around it: high trial counts, CV%
  thresholds, and plan-shape comparison (did the planner switch from Seq Scan to
  Index Scan?) as the primary signal, with wall-clock speedup as secondary
  confirmation. A 2x speedup is real; a 15% speedup might be noise.

---

## 1. Docker Harness

The harness is the equivalent of fft-autotune's `lib/scaffold.js`. Without it,
benchmarks are meaningless — you can't measure on production, dev databases have
toy data, and shared instances have unpredictable cache/load.

### 1.1 Container Lifecycle

```
preflight
  docker run postgres:16-alpine (pinned GUCs for benchmarking)
    load schema (DDL dump, migrations dir, or live introspection)
    populate data (user seed, sampled from source, or naive synthetic fallback)
    CHECKPOINT
    warm cache (run target query N times)
    pg_dump snapshot → /harness/baseline.sql

optimization cycles
  [before each candidate]
    restore from snapshot (pg_restore or re-apply baseline.sql)
  [apply candidate]
    CREATE INDEX / rewritten SQL
  [benchmark]
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) × warmup + trials
  [record]
    extract timing, rows, buffers, plan nodes

teardown
  extract winners (DDL + SQL)
  docker rm -f
```

### 1.2 Postgres Configuration for Benchmarking

The container must use pinned GUCs so measurements are reproducible:

```
shared_buffers = 256MB
work_mem = 64MB
effective_cache_size = 512MB
random_page_cost = 1.1
synchronous_commit = off
max_parallel_workers_per_gather = 0   # disable parallel for deterministic plans
jit = off                              # avoid JIT variance
statement_timeout = 30000              # 30s safety net
```

Parallel workers and JIT are disabled by default because they introduce
non-determinism. The room can optionally re-enable them as a separate
"production-realistic" benchmark pass after the search converges.

### 1.3 Schema Loading

Accept one of three sources (configured via `schemaSource`):

| Source | Input | How |
|---|---|---|
| `dump` | Path to `pg_dump --schema-only` output | `psql -f schema.sql` |
| `migrations` | Path to migrations directory | Run in order (detect Prisma, Knex, raw SQL) |
| `introspect` | Live `dbUrl` | `pg_dump --schema-only` from source DB, apply to container |

The `introspect` path is the lowest-friction option: user provides their existing
connection string, the harness pulls schema metadata (no data), and spins up an
isolated copy. The source database is never modified.

### 1.4 Data Population

Data population is required for benchmarks to mean anything, but realistic
synthetic data generation is genuinely hard — arguably the hardest single
problem in this room. Getting distributions wrong means the planner makes
different choices than it would in production, which means the room optimizes
for the wrong thing.

**v1 strategy: don't try to be clever.** Support three tiers, in order of
reliability:

**Tier 1 — User-provided seed (most reliable)**:
If the user provides `seedDataPath`, load it directly. This is the
recommended path for serious use. A `pg_dump --data-only` from a staging
database, or a hand-written seed script, gives realistic distributions
without the room having to guess.

**Tier 2 — Sampled from source (reliable, requires access)**:
If the user provides `seedFromSource: true` plus a live `dbUrl`, sample
real rows with configurable limits per table:
```sql
-- for each table:
CREATE TABLE harness.{table} AS
  SELECT * FROM source.{table}
  ORDER BY random()
  LIMIT {scaleFactor};
```
This preserves real distributions but limits volume. Requires the source
DB to be accessible from the harness environment.

**Tier 3 — Naive synthetic (v1 fallback)**:
If no seed and no source access, generate data using `generate_series` with
uniform random values, correct FK relationships, and NOT NULL constraints
satisfied. This is good enough for index-vs-no-index comparisons (where plan
shape changes are dramatic) but unreliable for subtle rewrite optimizations
that depend on cardinality estimates.

The room should be transparent about this: if using Tier 3, the report
includes a warning that results may not reflect production behavior due to
synthetic data distributions.

**v2 — Agent-generated distributions (aspirational)**:
Have the explorer analyze the schema and propose realistic distributions
(zipfian FKs, time-series timestamps, weighted enums). This is valuable
but deferred because:
- getting distributions wrong is worse than uniform (misleading plans)
- validating that generated distributions are "realistic" requires
  domain knowledge the room doesn't have
- the effort is better spent on Tier 1/2 support first

The key insight remains true: **query plans change dramatically based on data
distribution.** The v1 answer is to be honest about it, support the reliable
paths first, and warn loudly when falling back to naive generation.

### 1.5 Snapshot and Restore

Between candidates, the harness must restore to a clean state efficiently:

- **Option A** (fast, preferred): filesystem-level snapshot of the Postgres data
  directory. `docker cp` or volume snapshot, then restart.
- **Option B** (portable): `pg_dump` after data load, `pg_restore` between
  candidates. Slower but works on all Docker setups.
- **Option C** (lightweight): for index-only candidates, just `DROP INDEX` and
  `ANALYZE` instead of full restore. Since v1 only supports index and rewrite
  strategies, and rewrites don't modify schema, this covers most cases.

The plugin tracks what each candidate changed so it can choose the lightest
restore strategy. In v1, Option C is the common path — full restore is only
needed if something unexpected happens.

### 1.6 Benchmark Protocol

For each candidate, after applying the change:

```sql
-- warmup (discard results)
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <query>;  -- repeat warmupRuns times

-- measurement
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <query>;  -- repeat benchmarkTrials times
```

Extract from each trial:
- `Execution Time` (ms)
- `Planning Time` (ms)
- `Shared Hit Blocks`, `Shared Read Blocks` (buffer IO)
- Top-level node type (Seq Scan, Index Scan, Hash Join, etc.)
- Total rows processed

Compute:
- Median execution time
- p95 execution time
- CV% (coefficient of variation) — if >20%, flag measurement as unstable
- Speedup vs baseline: `(baseline_median - candidate_median) / baseline_median * 100`
- **Plan shape change** (primary signal): did the planner switch node types?
  e.g., Seq Scan → Index Scan, Hash Join → Nested Loop. This is more reliable
  than timing for marginal improvements.

**Noise handling**: EXPLAIN ANALYZE timing is inherently noisy (10-30% variance
even in Docker). The room treats plan shape as the primary ranking signal and
timing as confirmation. Specifically:
- A plan shape change + >2x speedup = high confidence, promote immediately
- A plan shape change + <2x speedup = medium confidence, retest once
- No plan shape change + any speedup = low confidence, likely noise unless
  the improvement is >5x (which can happen with better join order on same
  node types)
- CV% > 20% on any measurement = discard and retest with more trials

---

## 2. Roles

### 2.1 Explorer (Schema Analyst)

**When**: ANALYSIS phase each cycle.

**Job**: Examine the schema, the slow query, and results from prior cycles. Propose
2-4 optimization strategies.

**Strategy types (v1)**:
- `index` — single-column, composite, partial, covering, expression indexes
- `rewrite` — JOIN reordering, subquery elimination, CTE refactoring, window functions

**Deferred to v2**:
- `schema` — denormalization, materialized views, partitioning
- `config` — GUC tuning suggestions

Schema changes are substantially harder to validate (data migration, multi-step
apply/rollback) and config changes can't be meaningfully benchmarked in an
isolated container — production GUC tuning depends on real workload concurrency,
memory pressure, and connection count. Including them in v1 would muddy the
benchmark story. The explorer may still *mention* config or schema ideas in its
analysis, but they go into the report as advisory notes, not into the benchmark
pipeline.

**Output contract**:
```json
{
  "summary": "Analysis of query bottleneck...",
  "candidateProposals": [
    {
      "proposalId": "idx_orders_user_created",
      "strategyType": "index",
      "applySQL": "CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders(user_id, created_at);",
      "rollbackSQL": "DROP INDEX IF EXISTS idx_orders_user_created;",
      "targetQuery": null,
      "notes": "Covers the WHERE + ORDER BY pattern",
      "expectedImpact": "high"
    }
  ]
}
```

**Cycle feedback**: after cycle 1+, the explorer receives:
- Prior candidates with their measured speedup
- Frontier winners so far
- Failure reasons for rejected candidates
- Audit findings from the DBA auditor
- Explicit guidance: "the hash join on orders is the bottleneck, not the
  sequential scan on users — focus index strategies there"

### 2.2 Builder (Query Architect)

**When**: BASELINE and CODEGEN phases.

**Job**: Execute strategies against the Docker Postgres instance. Measure
performance. Verify correctness.

**Baseline protocol**:
1. Connect to harness container
2. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the target query
3. Run it `warmupRuns + benchmarkTrials` times
4. Report baseline execution time, plan shape, buffer stats

**Candidate protocol** (for each promoted proposal):
1. Apply `applySQL` (create index, or use rewritten query)
2. Run `ANALYZE` on affected tables
3. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with same benchmark protocol
4. **If rewrite strategy**: verify result parity — `(original EXCEPT rewritten)
   UNION ALL (rewritten EXCEPT original)` must return zero rows
5. **If index-only strategy**: skip parity check (same query, plan changes only)
6. Record timing and plan metadata
7. Execute `rollbackSQL` to restore state

**Output contract**:
```json
{
  "proposalId": "idx_orders_user_created",
  "baseline": {
    "medianMs": 847.3,
    "p95Ms": 1203.1,
    "planTopNode": "Seq Scan",
    "sharedHitBlocks": 12847,
    "sharedReadBlocks": 45231
  },
  "candidate": {
    "medianMs": 12.4,
    "p95Ms": 18.7,
    "cvPct": 8.2,
    "planTopNode": "Index Scan",
    "sharedHitBlocks": 847,
    "sharedReadBlocks": 23
  },
  "resultParity": true,
  "speedupPct": 98.5,
  "indexSizeBytes": 8388608,
  "applySQL": "CREATE INDEX ...",
  "explainJSON": { ... }
}
```

### 2.3 Auditor (DBA Auditor)

**When**: STATIC_AUDIT phase after each benchmark round.

**Job**: Review proposed changes for operational risk that benchmarks can't catch.

**Risk dimensions**:
| Risk | What to check | Severity |
|---|---|---|
| Lock contention | `CREATE INDEX` without `CONCURRENTLY` on hot table | High |
| Storage overhead | Index size vs table size ratio | Medium |
| Write amplification | Index on frequently-updated column | Medium |
| Query plan instability | Plan depends on statistics that shift with data growth | Low |
| Migration complexity | Requires downtime or multi-step deploy | Context |

**Output contract**:
```json
{
  "proposalId": "idx_orders_user_created",
  "riskScore": 3,
  "findings": [
    {
      "severity": "medium",
      "category": "write_amplification",
      "detail": "orders table has ~500 inserts/sec; this composite index adds ~15% write overhead",
      "recommendation": "Acceptable for read-heavy workload. Monitor pg_stat_user_indexes after deploy."
    }
  ],
  "approved": true,
  "deployNotes": "Safe to apply with CREATE INDEX CONCURRENTLY during low-traffic window."
}
```

**Blocking vs non-blocking**: Auditor findings with `riskScore > maxRiskScore`
(default 7) block the candidate from the frontier. Findings at or below the
threshold are preserved as warnings in the report but don't prevent promotion.

---

## 3. Phase State Machine

```
PREFLIGHT
  check Docker availability
  validate config (dbUrl or schemaSource, slowQuery)
  spin up container, load schema, load data (Tier 1/2/3), warm cache
    ↓
BASELINE
  fan_out → builder: measure target query baseline
  extract: medianMs, p95Ms, planTopNode, bufferStats
  store in state.baselines
    ↓
ANALYSIS
  fan_out → explorer: analyze schema + query + prior cycle results
  extract: candidateProposals[]
  dedupe, add to proposalBacklog
  select topK → activePromotedProposals
    ↓
CODEGEN
  fan_out → builder: apply + benchmark each promoted proposal
  extract: timing, parity check, plan metadata
  create candidate records in state.candidates
    ↓
STATIC_AUDIT
  fan_out → auditor: review benchmarked candidates for risk
  extract: riskScore, findings, approved
  update candidate records with audit results
    ↓
FRONTIER_REFINE
  recomputeFrontier():
    - filter: riskScore <= maxRiskScore (and resultParity === true for rewrites)
    - rank by: planShapeChanged desc, then speedupPct desc, then cvPct asc,
      then riskScore asc, then indexSizeBytes asc
    - promote best per strategyType bucket (index, rewrite) to frontier
  check stop conditions
    ↓ stop? → COMPLETE
    ↓ continue? → increment cycleIndex → ANALYSIS
```

### Stop Conditions

| Condition | Trigger | Stop Reason |
|---|---|---|
| Cycle limit | `cycleIndex >= maxCycles` | `cycle_limit` |
| Convergence | `bestImprovementPct >= targetImprovementPct` and no improvement in last `plateauCycles` cycles | `convergence` |
| Plateau | No candidate improved over frontier for `plateauCycles` consecutive cycles | `plateau` |
| Benchmark instability | Baseline CV% > 25% | `benchmark_unstable` |
| Target met | Best speedup exceeds `targetImprovementPct` and auditor approved | `target_met` |

---

## 4. Frontier and Candidates

### 4.1 Candidate Lifecycle

```
proposed → promoted → benchmarked → audited → frontier | rejected
```

Each candidate tracks:
```js
{
  candidateId: 'c_001',
  proposalId: 'idx_orders_user_created',
  strategyType: 'index',          // index | rewrite
  cycleIndex: 0,
  applySQL: 'CREATE INDEX ...',
  rollbackSQL: 'DROP INDEX ...',
  targetQuery: null,               // null = optimize original, or rewritten SQL

  // benchmarking
  baseline: { medianMs, p95Ms, planTopNode, sharedHitBlocks, sharedReadBlocks },
  result: { medianMs, p95Ms, cvPct, planTopNode, sharedHitBlocks, sharedReadBlocks },
  resultParity: true,              // always true for index; checked for rewrite
  parityChecked: false,            // true only for rewrite strategies
  speedupPct: 98.5,
  planShapeChanged: true,          // primary signal: did planner switch node types?
  indexSizeBytes: 8388608,
  explainJSON: { ... },

  // audit
  riskScore: 3,
  auditFindings: [...],
  approved: true,
  deployNotes: '...',

  // status
  status: 'frontier',             // proposed | promoted | benchmarked | audited | frontier | rejected
  rejectedReason: null,
  owner: 'agent_builder_1',
}
```

### 4.2 Frontier Buckets

Strategies compete within buckets, not globally. A rewrite that gets 50% speedup
doesn't eliminate an index that gets 40% — they're complementary.

Buckets by `strategyType` (v1):
- `index` — best index-only solution
- `rewrite` — best query rewrite

Each bucket tracks its own winner independently. The report presents both
winners side-by-side with deployment guidance for each.

**Combined candidate pass (v2)**: After the search converges, if there are
frontier winners in both buckets, a synthesis pass tests them together. An
index + rewrite combined might be faster than either alone, or they might
conflict. This is deferred from v1 because it adds a new phase type (synthesis)
and complicates the state machine. The v1 report can note "these two strategies
are likely complementary — test them together manually."

### 4.3 Frontier Ranking

Within each bucket, rank by:
1. `planShapeChanged` (true first — plan changes are the primary signal)
2. `speedupPct` descending (but only trusted when CV% is reasonable)
3. `cvPct` ascending (prefer stable measurements)
4. `riskScore` ascending (prefer lower operational risk)
5. `indexSizeBytes` ascending (prefer smaller storage footprint)

Timing ties are expected and common. When two candidates have speedups within
each other's noise band (e.g., 94% vs 96% with CV% of 12%), prefer the one with
lower risk score or smaller storage footprint rather than chasing the timing
difference.

### 4.4 Proposal Evolution

After cycle 1, the explorer receives feedback and the plugin generates
mutation hints:

- **Winner refinement**: "The composite index on (user_id, created_at) gave 85%
  speedup. Try adding `status` as a covering column, or try a partial index
  WHERE status = 'active'."
- **Failure recovery**: "The hash join rewrite failed result parity because of
  NULL handling in the LEFT JOIN. Try COALESCE or a different join strategy."
- **Unexplored territory**: "No rewrite candidates yet — all proposals so far
  are index strategies. Try restructuring the JOIN or replacing the correlated
  subquery with a lateral join."

---

## 5. Configuration

### 5.1 Room Config (user-facing setup)

```json
{
  "schemaSource": {
    "type": "enum",
    "label": "Schema Source",
    "options": ["introspect", "dump", "migrations"],
    "default": "introspect",
    "description": "How to load the database schema into the benchmark container"
  },
  "dbUrl": {
    "type": "string",
    "label": "Postgres URL",
    "required": true,
    "placeholder": "postgres://user:pass@localhost:5432/mydb",
    "description": "Source database for schema introspection (read-only, never modified)"
  },
  "slowQuery": {
    "type": "string",
    "label": "Target Query",
    "required": true,
    "placeholder": "SELECT o.*, u.email FROM orders o JOIN users u ON ...",
    "description": "The SQL query to optimize"
  },
  "schemaPath": {
    "type": "string",
    "label": "Schema/Migrations Path",
    "placeholder": "./db/schema.sql or ./prisma/migrations",
    "description": "Required when schemaSource is 'dump' or 'migrations'"
  },
  "seedDataPath": {
    "type": "string",
    "label": "Data Seed Script",
    "placeholder": "./db/seed.sql",
    "description": "SQL script or pg_dump to load data (Tier 1 — recommended)"
  },
  "seedFromSource": {
    "type": "boolean",
    "label": "Sample From Source DB",
    "default": false,
    "description": "Sample real rows from dbUrl instead of synthetic generation (Tier 2)"
  },
  "scaleFactor": {
    "type": "integer",
    "label": "Rows Per Table",
    "default": 100000,
    "min": 1000,
    "max": 1000000,
    "description": "Row limit when sampling from source or generating synthetic data"
  },
  "schemaFilter": {
    "type": "string_array",
    "label": "Include Tables",
    "maxItems": 20,
    "default": [],
    "description": "Limit analysis to these tables (empty = all tables referenced by query)"
  },
  "postgresVersion": {
    "type": "enum",
    "label": "Postgres Version",
    "options": ["14", "15", "16", "17"],
    "default": "16"
  },
  "outputDir": {
    "type": "directory",
    "label": "Output Directory",
    "default": ".commands/postgres-tuner"
  }
}
```

### 5.2 Orchestrator Config (tuning knobs)

```json
{
  "plannedCandidatesPerCycle": { "type": "integer", "min": 1, "max": 10, "default": 4 },
  "promoteTopK": { "type": "integer", "min": 1, "max": 5, "default": 2 },
  "maxRetestCandidates": { "type": "integer", "min": 1, "max": 3, "default": 1 },
  "maxRiskScore": { "type": "integer", "min": 0, "max": 10, "default": 7 },
  "targetImprovementPct": { "type": "number", "min": 0, "max": 1000, "default": 20 },
  "warmupRuns": { "type": "integer", "min": 1, "max": 20, "default": 3 },
  "benchmarkTrials": { "type": "integer", "min": 3, "max": 50, "default": 10 },
  "plateauCycles": { "type": "integer", "min": 1, "max": 5, "default": 2 }
}
```

### 5.3 Limits

```json
{
  "maxCycles": { "default": 4, "min": 1, "max": 10 },
  "maxTurns": { "default": 60, "min": 4, "max": 500 },
  "maxDurationMs": { "default": 3600000, "min": 60000, "max": 14400000 },
  "maxFailures": { "default": 5, "min": 1, "max": 20 },
  "agentTimeoutMs": { "default": 300000, "min": 10000, "max": 1800000 },
  "pluginHookTimeoutMs": { "default": 60000, "min": 5000, "max": 300000 },
  "llmTimeoutMs": { "default": 60000, "min": 10000, "max": 300000 }
}
```

---

## 6. Report Output

### 6.1 Summary Metrics

- **Best Speedup**: `98.5%` (847ms → 12ms)
- **Frontier Size**: 3 strategies across 2 buckets
- **Candidates Tested**: 14 proposed, 8 benchmarked, 3 frontier, 2 rejected
- **Cycles Completed**: 3 of 4

### 6.2 Frontier Table

| Strategy | Type | Baseline (ms) | Optimized (ms) | Speedup | Risk | Status |
|---|---|---|---|---|---|---|
| Composite index on (user_id, created_at) | index | 847.3 | 12.4 | 98.5% | 3/10 | Winner |
| Rewrite: CTE → lateral join | rewrite | 847.3 | 234.1 | 72.4% | 2/10 | Frontier |
| Partial index WHERE status='active' | index | 847.3 | 45.8 | 94.6% | 4/10 | Frontier |

### 6.3 Code Blocks

**Winner SQL** (applies all frontier index strategies):
```sql
-- Index: idx_orders_user_created
CREATE INDEX CONCURRENTLY idx_orders_user_created
  ON orders (user_id, created_at DESC);

-- Speedup: 98.5% (847ms → 12ms)
-- Risk: 3/10 — ~15% write overhead on orders inserts
-- Storage: ~8MB for 100K rows
```

**Optimized Query** (if rewrite strategies won):
```sql
-- Original: SELECT o.*, u.email FROM orders o JOIN users u ...
-- Rewritten:
SELECT o.id, o.amount, o.created_at, u.email
FROM orders o
JOIN LATERAL (
  SELECT email FROM users WHERE id = o.user_id LIMIT 1
) u ON true
WHERE o.created_at > NOW() - INTERVAL '30 days'
ORDER BY o.created_at DESC
LIMIT 100;

-- Speedup: 72.4% (847ms → 234ms)
```

### 6.4 Audit Summary

Per-winner deployment guidance from the DBA auditor:
- Lock risk assessment
- Storage impact
- Write amplification estimate
- Recommended deploy procedure (e.g., "CREATE INDEX CONCURRENTLY during
  low-traffic window, monitor pg_stat_user_indexes for 24h")

---

## 7. Files To Build

Current state: 472 lines across 4 lib files + manifest + index.js.
Target state: ~2500-3500 lines mirroring fft-autotune's module structure.

### 7.1 New Files

| File | Purpose | ~Lines |
|---|---|---|
| `lib/harness.js` | Docker container lifecycle, schema loading, data generation orchestration, snapshot/restore, benchmark execution | 400 |
| `lib/envelope.js` | Parse builder/explorer/auditor JSON responses, normalize field names, extract from prose/fences, handle truncation | 250 |
| `lib/candidates.js` | Candidate creation, frontier ranking, bucket management, stop condition evaluation, improvement tracking | 400 |
| `lib/phases.js` | Phase state tracking, partial fan-out advancement, dashboard metric emission | 80 |
| `lib/report.js` | Final report generation: frontier table, winner SQL blocks, audit summary, deployment guide | 150 |
| `lib/utils.js` | Safe string ops, SQL sanitization, connection string parsing, path validation | 80 |
| `Dockerfile.harness` | Pinned Postgres image with benchmark GUCs baked in | 30 |
| `harness/benchmark.sh` | Shell script the builder agent executes inside/against the container for warmup + trials | 60 |
| `test/harness.test.js` | Container lifecycle tests (requires Docker) | 150 |
| `test/envelope.test.js` | Response parsing tests | 100 |
| `test/candidates.test.js` | Frontier ranking and stop condition tests | 100 |

### 7.2 Files To Expand

| File | Current | Target | What's Missing |
|---|---|---|---|
| `lib/plugin.js` | 83 lines | ~350 | Fan-out routing for all phases, response merging, cycle feedback loop, harness lifecycle calls, event handling, disconnect recovery |
| `lib/planning.js` | 80 lines | ~600 | Rich prompts with cycle context, failure feedback, mutation hints. No combined-candidate pass in v1. Data generation prompts only for Tier 3 fallback. |
| `lib/config.js` | 66 lines | ~200 | Schema source validation, Docker availability check, harness config normalization, real connection test in checkCompatibility |
| `lib/constants.js` | 19 lines | ~100 | Strategy types, risk categories, plan node patterns, severity thresholds, benchmark defaults |

### 7.3 Manifest Changes

The current manifest is mostly correct. Changes needed:

- Add `schemaSource`, `schemaPath`, `seedDataPath`, `scaleFactor`,
  `postgresVersion` to `roomConfigSchema`
- Add `warmupRuns`, `benchmarkTrials`, `plateauCycles` to `configSchema`
- Update `setup.compatibilityDescription` to mention Docker requirement
- Add `execute_validate` and `explain_analyze` phases to dashboard
  (currently listed but not actually used in the lifecycle)

---

## 8. Implementation Order

### Phase 1: Harness (make benchmarks real)

1. `Dockerfile.harness` + `harness/benchmark.sh`
2. `lib/harness.js` — container up/down, schema load, snapshot/restore
3. `lib/config.js` — Docker availability check, schema source validation
4. Test: can spin up container, load a schema, run EXPLAIN ANALYZE, tear down

This is the foundation. Nothing else matters until benchmarks are real.

### Phase 2: Response Parsing (make agent output usable)

5. `lib/envelope.js` — extract structured JSON from agent prose
6. `lib/constants.js` — strategy types, risk categories, plan node patterns
7. `lib/utils.js` — SQL sanitization, connection string parsing

### Phase 3: Cycle Logic (make the search loop work)

8. `lib/candidates.js` — candidate lifecycle, frontier ranking, stop conditions
9. `lib/phases.js` — phase tracking, metric emission
10. `lib/plugin.js` — full fan-out routing, response merging, cycle feedback

### Phase 4: Rich Prompts (make agents effective)

11. `lib/planning.js` — cycle-aware prompts with feedback, mutation hints,
    Tier 3 data generation prompts
12. `lib/report.js` — final report with winner SQL, audit summary, deploy guide

### Phase 5: Polish

13. Schema repair recovery path (from fft-autotune pattern)
14. Partial fan-out phase advancement
15. Disconnect recovery
16. Tests for all modules

---

## 9. Key Design Decisions

### 9.1 Builder Executes SQL Directly

The builder agent connects to the Docker Postgres instance and runs SQL. This
means the builder needs the container's connection string in its prompt. The
plugin manages container lifecycle; the builder just runs queries.

Alternative considered: plugin executes SQL via a harness script, builder only
proposes. Rejected because the builder needs to iterate (check plan shape,
adjust, retry) and a prompt-response-prompt loop is too slow.

### 9.2 Single Query Focus (v1)

v1 optimizes a single slow query. Future versions could accept a workload file
(multiple queries with frequency weights) and optimize across the workload,
checking that improving one query doesn't regress others.

### 9.3 Result Parity — Two Distinct Cases

Parity validation is split by strategy type because they have fundamentally
different correctness properties:

**Rewrite strategies — hard parity gate**:
If a rewritten query returns different results from the original, the candidate
is rejected immediately regardless of speedup. This is non-negotiable.

The parity check is: `(original EXCEPT rewritten) UNION ALL (rewritten EXCEPT
original)` must return zero rows. The builder must run this check and report
the result. The plugin verifies the check was performed (not just claimed).

Edge cases the builder must handle:
- ORDER BY differences (use unordered comparison via EXCEPT)
- NULL handling (EXCEPT treats NULLs as equal, which is correct here)
- Floating point precision (unlikely in typical queries, but flag if present)

**Index-only strategies — no parity check needed**:
When the strategy only adds/removes indexes without changing the query text,
parity is guaranteed by the database engine. The same query with a different
plan returns the same results. Running a parity check here is wasted work
and adds noise to the cycle.

The candidate record tracks both `resultParity` (always true for index) and
`parityChecked` (true only for rewrites) so the report can distinguish
"verified correct" from "correct by construction."

### 9.4 Combined Candidate Pass (v2)

Deferred from v1. When the search converges with winners in both buckets
(e.g., an index winner and a rewrite winner), a synthesis pass could test them
combined. This is valuable but adds a new phase type and complicates the state
machine. For v1, the report notes when winners exist in multiple buckets and
suggests the user test the combination manually.

Why defer: the combined pass needs its own decision logic (which winners to
combine, how to apply them in what order, how to attribute the speedup), and
it introduces a phase that doesn't fit cleanly into the explore→build→audit
cycle. Better to get the core loop solid first.

### 9.5 Auditor Cannot Block Based on Performance

The auditor reviews operational risk only. It cannot reject a candidate because
"the speedup isn't big enough" — that's the frontier ranking's job. The auditor
answers: "if you deploy this, what could go wrong?"

### 9.6 No Production Database Writes

The plugin never writes to the user's source database. The `dbUrl` is used for
read-only schema introspection (when `schemaSource = introspect`). All
benchmarking happens inside the Docker container. The report output is DDL/SQL
that the user applies manually.

---

## 10. Scope — v1 vs v2

### v1 (build this)

- Strategy types: `index` and `rewrite` only
- Data population: Tier 1 (user seed) and Tier 2 (sampled from source), with
  Tier 3 (naive synthetic) as fallback with explicit warnings
- Parity: hard gate for rewrites, skip for index-only
- Frontier: independent winners per bucket, no combined pass
- Benchmarking: plan shape as primary signal, timing as secondary, CV%
  thresholds for noise rejection
- Config/schema strategies: advisory notes in report, not benchmarked

### v2 (defer)

- Strategy types: `schema` (materialized views, partitioning, denormalization)
- Combined candidate synthesis pass
- Agent-generated data distributions (Tier 4)
- Multi-query workload optimization (regression checking across query set)
- Config tuning (requires production-like concurrency to be meaningful)
- Parallel workers / JIT benchmark pass (production-realistic mode)

---

## 11. Example Session

**Input**:
- `dbUrl`: `postgres://app:secret@localhost:5432/myapp`
- `slowQuery`: `SELECT o.id, o.total, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.created_at > NOW() - INTERVAL '30 days' AND o.status = 'completed' ORDER BY o.created_at DESC LIMIT 100`
- `schemaSource`: `introspect`
- `scaleFactor`: 500000

**Cycle 0 — Preflight + Baseline**:
- Harness introspects schema: `orders` (12 columns, 3 indexes), `users` (8 columns, 1 index)
- User provided seed script (Tier 1): 500K orders, 50K users from staging dump
- Builder measures baseline: 847ms median (CV% 14%), Seq Scan on orders, 45K buffer reads

**Cycle 1 — First Search**:
- Explorer proposes: composite index (user_id, created_at), partial index (status='completed'), CTE rewrite, covering index
- Builder benchmarks top 2:
  - composite index → 12ms, plan changed Seq Scan → Index Scan, 98.5% speedup (high confidence)
  - partial index → 45ms, plan changed Seq Scan → Bitmap Index Scan, 94.6% speedup (high confidence)
- Auditor: composite index risk 3/10, partial index risk 2/10. Both approved.

**Cycle 2 — Refinement**:
- Explorer (with feedback): "composite index won at 98.5%. Try adding status as covering column. Also try rewrite strategies."
- Builder benchmarks:
  - covering index → 11ms, same plan shape as composite (Index Scan), 98.7% speedup
  - lateral join rewrite → 234ms, plan changed Hash Join → Nested Loop, 72.4% speedup, parity verified
- Covering index vs composite: both Index Scan, speedup within noise band (98.5% vs 98.7%, CV% 14%). Covering index wins on tiebreak: same risk, but index-only scan avoids heap fetches.
- Auditor: covering index risk 3/10, rewrite risk 1/10

**Cycle 3 — Convergence**:
- Plateau detected: no candidate improved over covering index (98.7%) — marginal refinements only
- Stop reason: `convergence` — target 20% met, plateau for 2 cycles

**Report**:
- Index bucket winner: covering index on orders(user_id, created_at DESC) INCLUDE (status, total)
  - Speedup: 98.7% (847ms → 11ms), plan: Index Only Scan
  - Deploy: `CREATE INDEX CONCURRENTLY`, ~12MB storage, monitor write overhead
- Rewrite bucket winner: lateral join rewrite
  - Speedup: 72.4% (847ms → 234ms), parity verified
  - Deploy: swap query in application code, no schema changes needed
- Note: "Winners in both buckets — consider testing the covering index + rewrite combination together for potential additional gains."
