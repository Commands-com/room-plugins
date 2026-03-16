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

- **Result parity** (for rewrites) is a hard correctness gate — see Section 9.3
  for edge cases and known v1 limitations.
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
  docker run postgres:${postgresVersion}-alpine (pinned GUCs for benchmarking)
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

**`pg_dump` dependency**: The `pg_dump` command for `introspect` mode is
executed on the host/plugin side, **not** inside the harness container. The
plugin runs `pg_dump --schema-only` against the source `dbUrl` from the host
environment, captures the DDL output, and pipes it into the isolated harness
container via `docker exec -i <container> psql -f -`. This keeps the harness
container fully network-isolated at all times (see Section 9.1).

If `pg_dump` is not available on the host (e.g., lightweight CI or Node.js
Docker environments), the plugin falls back to running `pg_dump` inside a
**separate ephemeral utility container**:
```
docker run --rm --add-host=host.docker.internal:host-gateway \
  postgres:${postgresVersion}-alpine \
  pg_dump --schema-only -h <source_host> ...
```
The utility container has network access but is discarded immediately after
capturing the schema output. The harness container itself never needs
external network access.

**`localhost` URL handling**: When the user's `dbUrl` points at `localhost`
or `127.0.0.1`, the plugin rewrites the hostname to `host.docker.internal`
before passing it to the utility container (since `localhost` inside a
container refers to the container itself, not the host machine). The
`--add-host=host.docker.internal:host-gateway` flag ensures this resolves
correctly on Linux; on macOS/Windows Docker Desktop, `host.docker.internal`
is available by default. If hostname rewriting fails (e.g., non-standard
Docker setups), PREFLIGHT fails with an error asking the user to either
install `pg_dump` on the host or provide a non-localhost `dbUrl`.

**Version compatibility**: The `postgresVersion` config (default `16`) is
used for both the harness container and any utility containers.

When using `schemaSource = 'introspect'`, the plugin detects the source
database's major version during PREFLIGHT (via `SHOW server_version`) and
applies the following logic:
- **Auto-match (default behavior)**: If the user has not explicitly set
  `postgresVersion`, the plugin overrides the default and uses the detected
  source major version instead. This ensures planner behavior in the harness
  matches production.
- **Explicit mismatch warning**: If the user explicitly sets
  `postgresVersion` to a value different from the detected source version
  (higher or lower), the plugin warns: "Harness is Postgres {X} but source
  is Postgres {Y} — query planner behavior may differ." The room proceeds
  but the final report includes a prominent note: "⚠ Benchmarked on
  Postgres {X}; production runs Postgres {Y}. Plan choices and timing may
  not transfer exactly."
- **`pg_dump` floor**: Regardless of the above, `pg_dump` version must be
  >= the source major version. If the resolved `postgresVersion` is lower
  than the source (only possible with an explicit user override), PREFLIGHT
  fails with an error explaining that `pg_dump` {X} cannot dump a Postgres
  {Y} source.

For `schemaSource = 'dump'` or `'migrations'` (no source DB to detect),
`postgresVersion` is used as-is with no compatibility check.

### 1.4 Data Population

Data population is required for benchmarks to mean anything, but realistic
synthetic data generation is genuinely hard — arguably the hardest single
problem in this room. Getting distributions wrong means the planner makes
different choices than it would in production, which means the room optimizes
for the wrong thing.

**v1 strategy: don't try to be clever.** Support four tiers, in order of
reliability:

**Tier 0 — Demo mode (zero setup)**:
If the user sets `demoMode: true`, the room uses a bundled sample scenario:
schema, data, and a known-slow query that ship with the plugin under
`assets/demo/`. One click, no database needed — just Docker.

Demo mode overrides only the data/schema/query inputs (`schemaSource`,
`schemaPath`, `dbUrl`, `slowQuery`, `seedDataPath`, `seedFromSource`,
`schemaFilter`). Everything else still works normally — `outputDir`,
`postgresVersion`, `scaleFactor`, and all orchestrator tuning knobs
(`plannedCandidatesPerCycle`, `benchmarkTrials`, etc.) are honored as
configured. This lets users experiment with the tuning knobs against a
known scenario before pointing the room at their own database.

The demo scenario should be:
- **Schema**: a small e-commerce model — `users`, `orders`, `order_items`,
  `products`, `categories`. 5-6 tables with realistic FK relationships,
  a few existing indexes on PKs only.
- **Data**: bundled as a `pg_dump --data-only` compressed file (~5-10MB).
  ~500K orders, ~50K users, ~2M order_items. Zipfian user-to-order
  distribution, time-series `created_at`, weighted `status` enum.
  Pre-generated and committed to the repo — no runtime generation.
- **Slow query**: a multi-join analytics query that's genuinely slow
  without indexes, e.g.:
  ```sql
  SELECT u.email, COUNT(o.id) AS order_count, SUM(oi.quantity * oi.unit_price) AS total_spent
  FROM users u
  JOIN orders o ON o.user_id = u.id
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.created_at > '2025-01-01'
    AND o.status = 'completed'
  GROUP BY u.email
  ORDER BY total_spent DESC
  LIMIT 50;
  ```
- **Expected outcome**: the room should find a composite index on
  `orders(user_id, created_at, status)` or similar, achieving >10x
  speedup. This validates the full pipeline end-to-end.

Demo mode serves three purposes:
1. **First-run experience** — users can see the room work before
   configuring their own database. Reduces time-to-value from "set up
   Docker + provide connection string + provide seed data" to "click start."
2. **Development and testing** — plugin developers can run the full cycle
   without an external database. CI can validate the pipeline end-to-end.
3. **Sales/showcase** — demonstrates the room's value with a concrete,
   reproducible result.

The demo data is Tier 1 quality (pre-generated with realistic distributions)
so the room's full benchmark pipeline works correctly — it's not a
simplified codepath. The only difference is that the schema, data, and
query are bundled instead of user-provided.

**Tier 1 — User-provided seed (most reliable)**:
If the user provides `seedDataPath`, load it directly. This is the
recommended path for serious use. A `pg_dump --data-only` from a staging
database, or a hand-written seed script, gives realistic distributions
without the room having to guess.

**Tier 2 — Sampled from source (requires access, caveats apply)**:
If the user provides `seedFromSource: true` plus a live `dbUrl`, sample
real rows from the source database and insert them into the pre-loaded
schema in the harness container.

**Reliability scope**: Tier 2 preserves per-column value distributions
(skew, cardinality, NULLs) which makes it reliable for **single-table
access path decisions** — the planner will see realistic selectivity
estimates and choose index scans vs seq scans correctly. However, Tier 2
samples each table independently, which **breaks cross-table relationship
structure**. Child rows may reference parent IDs that weren't sampled,
and join cardinality estimates can diverge significantly from production.
This means Tier 2 is **less reliable for multi-join rewrite strategies**
where the planner's join order decisions depend on accurate cross-table
cardinality estimates.

For multi-join optimization, Tier 1 (a real data dump from staging) is
strongly preferred. The report flags when Tier 2 was used with a
multi-join query and advises verifying rewrite candidates against
production-representative data before deploying.

**Mechanism**: The plugin uses `COPY (SELECT ... TABLESAMPLE ... LIMIT ...)
TO STDOUT` to stream sampled rows from the source database, then pipes them
into the harness container via `psql \copy ... FROM STDIN`. This avoids
cross-database query issues (plain Postgres cannot query across databases
without FDW/dblink). Note: `pg_dump` does not support per-table row limits,
so `COPY` with a subquery is the correct streaming approach.

**Sampling strategy**: The plugin uses a two-path approach per table to
honor the `scaleFactor` semantics:

1. **Estimate table cardinality** via a read-only stats lookup:
   ```sql
   SELECT reltuples FROM pg_class
   WHERE relname = '{table}'
     AND relnamespace = '{schema}'::regnamespace;
   ```
   This filters by schema to avoid ambiguity when multiple schemas contain
   tables with the same name. If `reltuples` is `0` or `-1` (table has never
   been analyzed or stats are stale), the plugin does **not** run `ANALYZE`
   on the source — that would be a write to the source database, which
   violates the read-only promise and may require unexpected privileges.
   Instead, the plugin falls back to a counting query with a timeout:
   ```sql
   SELECT count(*) FROM {schema}.{table};  -- with statement_timeout = '5s'
   ```
   If the count times out (table is very large), the plugin assumes the
   table exceeds `scaleFactor` and proceeds with `TABLESAMPLE`. If the
   count succeeds, it uses the exact count. If both stats and count fail
   (e.g., truly empty table or permission issue), the plugin defaults to
   a full copy attempt.
2. **If estimated rows <= `scaleFactor`**: full copy — `COPY (SELECT * FROM
   {schema}.{table}) TO STDOUT`. Small tables are copied entirely to preserve
   realistic distributions and FK relationships.
3. **If estimated rows > `scaleFactor`**: sampled copy using Postgres' native
   `TABLESAMPLE` for efficiency:
   ```sql
   COPY (SELECT * FROM {table} TABLESAMPLE BERNOULLI ({pct})
         LIMIT {scaleFactor}) TO STDOUT;
   ```
   The `{pct}` is calculated as `min(100, scaleFactor / reltuples * 120)` —
   oversampling by ~20% to account for BERNOULLI's statistical variance,
   with the `LIMIT` providing an exact cap. If the sample undershoots
   (returns fewer rows than `scaleFactor`), the plugin retries once with a
   doubled percentage before accepting the result.
4. **Load into harness**: `\copy {table} FROM STDIN` (piped from step 2 or 3).

Avoid `ORDER BY random() LIMIT N` as it requires a full table scan and
sort on the source database, which can cause significant CPU/memory
pressure on large production tables.

**Foreign key consistency**: Independent random sampling across tables
will produce FK violations when child rows reference parent IDs not in
the sample. The harness handles this by disabling FK checks during the
data load phase:
```sql
SET session_replication_role = 'replica';
-- load all sampled data...
SET session_replication_role = 'DEFAULT';
```
This is acceptable for index-path benchmarking (single-table access
decisions), but **materially affects join cardinality estimates**. When
sampled child rows reference unsampled parent IDs, joins produce fewer
matches than production, which can cause the planner to choose different
join strategies (e.g., picking a hash join over a nested loop because the
estimated result set is smaller). The report flags this clearly when
Tier 2 is used with multi-table queries — see the reliability scope
note above.

**`scaleFactor` semantics for Tier 2**: The `scaleFactor` value is used
as a per-table row LIMIT. Small tables (fewer rows than `scaleFactor`)
get all their rows; large tables are capped. Tier 1 ignores
`scaleFactor` (seed data is what it is). Tier 3 uses it as a per-table
generation target.

**Required permissions**: The source `dbUrl` must have `SELECT` access
on the sampled tables/columns. Since the mechanism uses
`COPY (SELECT ...) TO STDOUT` (a query-based copy, not server-side file
access), no additional roles beyond normal `SELECT` privileges are needed.
Optionally, `pg_read_all_data` or equivalent can be granted for convenience
when blanket read access across all tables is desired. The source database
is never modified.

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

Between candidates, the harness must restore to a clean state efficiently.

**v1 restore strategies** (in order of preference):

- **Option A** (fast, preferred): Stop the Postgres server inside the container,
  take a filesystem-level snapshot of PGDATA (via `docker cp` of the stopped
  data directory, or `docker commit`), then restart. **Critical**: the server
  must be stopped cleanly (`pg_ctl stop -m fast`) before copying PGDATA —
  snapshotting a live data directory risks corruption. Alternatively, use
  `pg_basebackup` while the server is running.
- **Option B** (portable): `pg_dump` after data load, `pg_restore` between
  candidates. Slower but works on all Docker setups and is always safe.
- **Option C** (lightweight): for index-only candidates, `DROP INDEX` and
  `ANALYZE` instead of full restore. Since v1 only supports index and rewrite
  strategies, and rewrites don't modify schema, this covers most cases.

**Cache-state policy**: To ensure fair comparison between candidates, the
harness applies a consistent cache policy:
- After restore (Options A/B) or rollback (Option C), run
  `SELECT pg_stat_reset();` and `DISCARD ALL;` to reset session state.
- Execute the standard warmup runs (configured via `warmupRuns`) before
  measurement to bring buffer cache to a consistent state.
- Re-run the baseline measurement every N cycles (default: every 2 cycles)
  to detect drift from buffer cache warming or other environmental changes.
  If baseline drift exceeds 15%, flag measurements as potentially biased.

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
- **Full plan node tree** — extract the set of all node types in the execution
  plan (not just the top-level node, which is often a generic `Limit`, `Sort`,
  or `Aggregate` that stays constant even when underlying access changes
  dramatically). Specifically extract:
  - `planNodeSet`: set of all node types in the plan tree
  - `leafAccessNodes`: leaf-level access nodes (`Seq Scan`, `Index Scan`,
    `Index Only Scan`, `Bitmap Heap Scan`, etc.) — these are the primary
    signal for plan shape changes
  - `planStructureHash`: a hash of the full plan tree structure for quick
    comparison
- Total rows processed

Compute:
- Median execution time
- p95 execution time
- CV% (coefficient of variation) — if >20%, flag measurement as unstable
- Speedup vs baseline: `(baseline_median - candidate_median) / baseline_median * 100`
- **Plan shape change** (primary signal): did the planner change its strategy?
  `planShapeChanged` is determined by comparing multiple plan features, with
  strategy-specific logic:
  - **For `index` candidates**: compare `leafAccessNodes` (e.g., Seq Scan →
    Index Scan). Access-path changes are the primary signal since indexes
    affect scan methods.
  - **For `rewrite` candidates**: compare `planNodeSet` or `planStructureHash`,
    which capture changes to join strategies (Hash Join → Nested Loop),
    aggregation methods, and intermediate nodes — not just leaf scans. A
    rewrite that changes the join strategy while leaving leaf scans unchanged
    is still a material plan shape change.
  - In both cases, comparing only the top-level node is insufficient — a plan
    can change from `Seq Scan` to `Index Scan` under a `Sort` node while the
    top-level node remains `Sort`.

**Noise handling**: EXPLAIN ANALYZE timing is inherently noisy (10-30% variance
even in Docker). Plan shape change is used as a **confidence signal for
measurement quality**, not as a ranking tiebreaker:
- A plan shape change + >2x speedup = high confidence, accept measurement
- A plan shape change + <2x speedup = medium confidence, retest once to confirm
- No plan shape change + >5x speedup = accept (real wins from better join order
  or parameter estimation can happen within the same node types)
- No plan shape change + <5x speedup = low confidence, retest once — if the
  retest confirms the improvement (within 20% of original measurement), accept;
  otherwise discard as noise
- CV% > 20% on any measurement = discard and retest with more trials

Plan shape is not used in frontier ranking. The ranking sorts by speedup,
stability, risk, and cost. Plan shape determines whether we trust the
speedup number enough to rank it at all.

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
      "applySQL": "CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);",
      "rollbackSQL": "DROP INDEX IF EXISTS idx_orders_user_created;",
      "deploySQL": "CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders(user_id, created_at);",
      "targetQuery": null,
      "notes": "Covers the WHERE + ORDER BY pattern",
      "expectedImpact": "high"
    }
  ]
}
```

**`applySQL` vs `deploySQL`**: `applySQL` is used inside the isolated Docker
harness for benchmarking — it uses plain `CREATE INDEX` (faster, transactional,
no concurrent workload to protect). `deploySQL` is the production-safe version
that uses `CREATE INDEX CONCURRENTLY` and is included in the final report.
The auditor flags any `deploySQL` that is missing `CONCURRENTLY` on tables
expected to have concurrent writes.

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
4. **If rewrite strategy**: verify result parity — `(original EXCEPT ALL rewritten)
   UNION ALL (rewritten EXCEPT ALL original)` must return zero rows (uses
   `EXCEPT ALL` to detect duplicate-count differences; see Section 9.3)
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
    "leafAccessNodes": ["Seq Scan"],
    "planNodeSet": ["Sort", "Seq Scan"],
    "planStructureHash": "a1b2c3...",
    "sharedHitBlocks": 12847,
    "sharedReadBlocks": 45231
  },
  "candidate": {
    "medianMs": 12.4,
    "p95Ms": 18.7,
    "cvPct": 8.2,
    "leafAccessNodes": ["Index Scan"],
    "planNodeSet": ["Sort", "Index Scan"],
    "planStructureHash": "d4e5f6...",
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
| Risk | What to check | Source | Severity |
|---|---|---|---|
| Lock contention | `CREATE INDEX` without `CONCURRENTLY` on hot table | Static analysis (always available) | High |
| Storage overhead | Index size vs table size ratio | Harness benchmark (always available) | Medium |
| Write amplification | Index on frequently-updated column | Production telemetry (when available) or heuristic | Medium |
| Query plan instability | Plan depends on statistics that shift with data growth | Heuristic (always available) | Low |
| Migration complexity | Requires downtime or multi-step deploy | Static analysis (always available) | Context |

**Production telemetry (optional)**: The auditor can provide higher-confidence
risk assessments when optional production telemetry is available. The room
config accepts an optional `productionStats` object:

```json
{
  "productionStats": {
    "type": "object",
    "label": "Production Telemetry (Optional)",
    "description": "Optional pg_stat_* snapshots for higher-confidence risk assessment",
    "properties": {
      "pgStatUserTables": "Path to pg_stat_user_tables export (CSV/JSON)",
      "pgStatUserIndexes": "Path to pg_stat_user_indexes export (CSV/JSON)",
      "relationSizes": "Path to relation size data (pg_total_relation_size output)",
      "dmlRates": "Approximate DML rates per table (e.g., {\"orders\": {\"inserts_per_sec\": 500}})"
    }
  }
}
```

When production telemetry is **available**, the auditor can cite concrete
facts (e.g., "orders table has ~500 inserts/sec; this composite index adds
~15% write overhead"). When telemetry is **unavailable**, the auditor must
downgrade those findings to **heuristic/advisory** and clearly label them:
"[Heuristic — no production telemetry] Write amplification risk is estimated
as medium based on schema analysis; actual impact depends on DML rates."

**Output contract**:
```json
{
  "proposalId": "idx_orders_user_created",
  "riskScore": 3,
  "telemetryAvailable": false,
  "findings": [
    {
      "severity": "medium",
      "category": "write_amplification",
      "confidence": "heuristic",
      "detail": "[Heuristic] orders table likely receives frequent inserts; this composite index adds write overhead",
      "recommendation": "Monitor pg_stat_user_indexes after deploy. Provide production DML rates for a more precise estimate."
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
PREFLIGHT (plugin-internal, no agent fan-out)
  check Docker availability
  validate config (conditional requirements: dbUrl, schemaPath, slowQuery)
  validate slowQuery is read-only (SELECT / WITH ... SELECT)
  reject slowQuery if it contains truly volatile functions (see Section 9.3)
  detect source DB version and auto-match or warn on mismatch (if introspect mode)
  spin up container, load schema, load data (Tier 1/2/3), warm cache
    ↓
BASELINE
  fan_out → builder: measure target query baseline
  extract: medianMs, p95Ms, leafAccessNodes, planStructureHash, bufferStats
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
    - filter: riskScore <= maxRiskScore, resultParity === true for rewrites,
      measurement accepted (passed confidence check — see noise handling)
    - rank by: speedupPct desc, then cvPct asc, then riskScore asc,
      then indexSizeBytes asc
    - promote single best per strategyType bucket (index, rewrite) to frontier
  check stop conditions
    ↓ stop? → COMPLETE
    ↓ continue? → increment cycleIndex → ANALYSIS
```

### Stop Conditions

Evaluated in precedence order (first match wins):

| # | Condition | Trigger | Stop Reason |
|---|---|---|---|
| 1 | Benchmark instability | Baseline CV% > 25% after doubling `benchmarkTrials` (up to max) | `benchmark_unstable` |
| 2 | Cycle limit | `cycleIndex >= maxCycles` | `cycle_limit` |
| 3 | Target met + plateau | No improvement in last `plateauCycles` cycles AND best speedup exceeds `targetImprovementPct` AND auditor approved | `target_met` |
| 4 | Plateau | No improvement in last `plateauCycles` cycles (catch-all for any plateau not matched by #3) | `plateau` |

**Notes**:
- `benchmark_unstable` is checked first. Before hard-stopping, the harness
  attempts recovery by doubling `benchmarkTrials` (up to the configured max).
  If still unstable after retry, the room stops but includes baseline plan
  analysis in the report — plan shape analysis can still suggest useful indexes
  even without reliable timing.
- `target_met` and `plateau` both require the search to have plateaued (no
  improvement for `plateauCycles` consecutive cycles). They differ in outcome:
  `target_met` fires when the plateau is reached AND the target was met AND
  auditor approved (a successful outcome); `plateau` is the catch-all that
  fires for any other plateau (target not met, or target met but auditor
  rejected the winning candidate). `target_met` is checked first so it takes
  precedence — if it doesn't match, `plateau` catches the remaining cases.
- Neither `target_met` nor `plateau` fires before the search has plateaued.
  This prevents premature stopping: a basic index on a missing column often
  exceeds the default 20% target on the first cycle, but the room continues
  exploring to discover better candidates in other buckets (e.g., a rewrite
  alternative) before stopping.
- The previous `convergence` stop reason has been removed as it was redundant
  with `target_met` + `plateau`.

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
  baseline: { medianMs, p95Ms, leafAccessNodes, planNodeSet, planStructureHash, sharedHitBlocks, sharedReadBlocks },
  result: { medianMs, p95Ms, cvPct, leafAccessNodes, planNodeSet, planStructureHash, sharedHitBlocks, sharedReadBlocks },
  resultParity: true,              // always true for index; checked for rewrite
  parityChecked: false,            // true only for rewrite strategies
  speedupPct: 98.5,
  planShapeChanged: true,          // confidence signal: determines whether measurement is trusted
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

Each bucket tracks exactly **one winner** — the single best candidate per
`strategyType`. The frontier may additionally retain a ranked list of
runner-up candidates per bucket for the report, but **only the single winner
per bucket is presented as a recommendation**. The report presents bucket
winners side-by-side with deployment guidance for each.

**Important v1 constraint**: Because v1 does not benchmark combinations,
the report **must not** emit SQL that applies multiple frontier strategies
together or imply that they were tested in combination. Each bucket winner
is presented independently with its own measured speedup. If winners exist
in both buckets, the report includes an advisory note: "These strategies
were benchmarked independently — test them together manually before
deploying both, as they may interact."

**Combined candidate pass (v2)**: After the search converges, if there are
frontier winners in both buckets, a synthesis pass tests them together. An
index + rewrite combined might be faster than either alone, or they might
conflict. This is deferred from v1 because it adds a new phase type (synthesis)
and complicates the state machine.

### 4.3 Frontier Ranking

Only candidates that passed the confidence check (see Section 1.6 noise
handling) are eligible for ranking. `planShapeChanged` is used upstream as
a gate to determine whether a measurement is trusted enough to enter
ranking — it is not a ranking key itself.

Within each bucket, rank by:
1. `speedupPct` descending
2. `cvPct` ascending (prefer stable measurements)
3. `riskScore` ascending (prefer lower operational risk)
4. `indexSizeBytes` ascending (prefer smaller storage footprint)

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
  "demoMode": {
    "type": "boolean",
    "label": "Demo Mode",
    "default": false,
    "description": "Use bundled e-commerce schema, data, and slow query. No database needed. Overrides schema/data/query inputs; outputDir, postgresVersion, and tuning knobs still apply."
  },
  "schemaSource": {
    "type": "enum",
    "label": "Schema Source",
    "options": ["introspect", "dump", "migrations"],
    "default": "introspect",
    "description": "How to load the database schema into the benchmark container. Ignored in demo mode."
  },
  "dbUrl": {
    "type": "string",
    "label": "Postgres URL",
    "required": false,
    "placeholder": "postgres://user:pass@localhost:5432/mydb",
    "description": "Source database connection. Required when schemaSource = 'introspect' or seedFromSource = true. Read-only, never modified."
  },
  "slowQuery": {
    "type": "string",
    "label": "Target Query",
    "required": true,
    "placeholder": "SELECT o.*, u.email FROM orders o JOIN users u ON ...",
    "description": "The SQL query to optimize. Must be a fully executable SQL statement with concrete values (no $1 placeholders). v1 is scoped to read-only queries only (SELECT / WITH ... SELECT). If you have a parameterized query, substitute representative values."
  },
  "schemaPath": {
    "type": "string",
    "label": "Schema/Migrations Path",
    "required": false,
    "placeholder": "./db/schema.sql or ./prisma/migrations",
    "description": "Required when schemaSource is 'dump' or 'migrations'. Ignored for 'introspect'."
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
- **Frontier**: 2 winners across 2 buckets (1 runner-up listed)
- **Candidates Tested**: 14 proposed, 8 benchmarked, 2 winners, 2 rejected
- **Cycles Completed**: 4 of 4

### 6.2 Frontier Table

Each bucket has exactly one winner. Runner-ups are listed for context but
were not tested in combination with the winner.

| Strategy | Type | Baseline (ms) | Optimized (ms) | Speedup | Risk | Status |
|---|---|---|---|---|---|---|
| Composite index on (user_id, created_at) | index | 847.3 | 12.4 | 98.5% | 3/10 | Winner |
| Rewrite: CTE → lateral join | rewrite | 847.3 | 234.1 | 72.4% | 2/10 | Winner |
| Partial index WHERE status='active' | index | 847.3 | 45.8 | 94.6% | 4/10 | Runner-up |

### 6.3 Code Blocks

**Index Bucket Winner**:
```sql
-- Index: idx_orders_user_created
-- Deploy with:
CREATE INDEX CONCURRENTLY idx_orders_user_created
  ON orders (user_id, created_at DESC);

-- Speedup: 98.5% (847ms → 12ms) — benchmarked independently
-- Risk: 3/10 — write overhead estimated heuristically (no production telemetry)
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
| `Dockerfile.harness` | Pinned Postgres image (`postgres:${postgresVersion}-alpine`) with benchmark GUCs baked in | 30 |
| `harness/benchmark.sh` | Shell script the builder agent executes inside/against the container for warmup + trials | 60 |
| `assets/demo/schema.sql` | Demo e-commerce schema (users, orders, order_items, products, categories) | ~80 |
| `assets/demo/data.sql.gz` | Demo data dump (~500K orders, ~50K users, ~2M order_items, realistic distributions) | binary |
| `assets/demo/query.sql` | Demo slow query (multi-join analytics, genuinely slow without indexes) | ~15 |
| `test/harness.test.js` | Container lifecycle tests (requires Docker) | 150 |
| `test/demo.test.js` | Demo mode end-to-end test: spin up, run one cycle, verify a frontier candidate exists | 80 |
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

- Add `demoMode`, `schemaSource`, `schemaPath`, `seedDataPath`, `seedFromSource`,
  `scaleFactor`, `postgresVersion`, `productionStats` to `roomConfigSchema`
- Make `dbUrl` conditionally required (only when `schemaSource = 'introspect'`
  or `seedFromSource = true`)
- Make `schemaPath` conditionally required (only when `schemaSource = 'dump'`
  or `schemaSource = 'migrations'`)
- Add `warmupRuns`, `benchmarkTrials`, `plateauCycles` to `configSchema`
- Update `setup.compatibilityDescription` to mention Docker requirement
- **Remove** `execute_validate` and `explain_analyze` from dashboard phases —
  the canonical v1 phase graph is: PREFLIGHT → BASELINE → ANALYSIS → CODEGEN →
  STATIC_AUDIT → FRONTIER_REFINE → COMPLETE. The work those phases described
  is handled within CODEGEN (the builder runs benchmarks and parity checks
  as part of CODEGEN). Keeping them in the manifest as unused phases creates
  confusion.
- Remove or document the existing `dryRun` field in `roomConfigSchema` — if
  retained, define it as a mode that skips Docker and performs static analysis
  only; otherwise remove it.
- Align dashboard candidate status counters with the spec's candidate lifecycle:
  `proposed → promoted → benchmarked → audited → frontier | rejected`

---

## 8. Implementation Order

### Phase 1: Harness + Demo (make benchmarks real)

1. `assets/demo/` — generate the e-commerce schema, data dump, and slow query
2. `Dockerfile.harness` + `harness/benchmark.sh`
3. `lib/harness.js` — container up/down, schema load, snapshot/restore, demo mode
4. `lib/config.js` — Docker availability check, schema source validation, demo detection
5. Test: demo mode end-to-end — spin up container with bundled data, run
   EXPLAIN ANALYZE, verify baseline timing, tear down

Build the demo scenario first. It becomes the test fixture for everything
else — every harness change can be validated against the demo without
needing an external database. The demo data is also the fastest way to
prove the full pipeline works end-to-end before investing in Tier 1/2/3
support.

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
**plugin** (not the agent) manages the full Docker lifecycle — the builder
agent receives only a connection string to an already-running container and
never has Docker socket access.

**Security and network topology**: The plugin enforces resource limits on the
container (`--memory=512m`, `--cpus=2`). For network isolation, the plugin
creates a dedicated internal Docker network:

```
docker network create --internal pg-harness-net
docker run --network=pg-harness-net ...
```

The `--internal` flag blocks all egress to the internet while allowing the
builder to connect to the container via the Docker bridge. During PREFLIGHT,
if `introspect` mode or Tier 2 sampling requires access to the source `dbUrl`,
the plugin performs all external data fetching (schema dump, data sampling)
from the host/plugin side and pipes results into the container — the container
itself never needs external network access. After data loading completes, the
container runs on the isolated internal network for the remainder of the
session. This prevents data exfiltration while preserving builder connectivity.

Alternative considered: plugin executes SQL via a harness script, builder only
proposes. Rejected because the builder needs to iterate (check plan shape,
adjust, retry) and a prompt-response-prompt loop is too slow.

### 9.2 Single Query Focus (v1)

v1 optimizes a single slow query. The query must be:
- **Fully executable**: concrete literal values, no `$1` placeholders or
  prepared statement parameters. If the user has a parameterized query, they
  should substitute representative values that exercise the problematic plan.
- **Read-only**: `SELECT` or `WITH ... SELECT` only. `EXPLAIN ANALYZE`
  executes the statement, so DML queries (`INSERT`, `UPDATE`, `DELETE`) would
  modify harness data during benchmarking. v1 validates this at PREFLIGHT
  and rejects non-SELECT queries.

**v2 — parameterized query support**: Accept query templates with
representative parameter sets to test plan quality across different
selectivities (e.g., high-cardinality vs low-cardinality filter values).
Define whether benchmarking uses literal SQL or `PREPARE`/`EXECUTE` to
test generic-vs-custom plan behavior.

Future versions could also accept a workload file (multiple queries with
frequency weights) and optimize across the workload, checking that improving
one query doesn't regress others.

### 9.3 Result Parity — Two Distinct Cases

Parity validation is split by strategy type because they have fundamentally
different correctness properties:

**Rewrite strategies — hard parity gate**:
If a rewritten query returns different results from the original, the candidate
is rejected immediately regardless of speedup. This is non-negotiable.

The parity check uses multi-set comparison: `(original EXCEPT ALL rewritten)
UNION ALL (rewritten EXCEPT ALL original)` must return zero rows. Using
`EXCEPT ALL` (not `EXCEPT`) is critical — plain `EXCEPT` uses set semantics
and will miss duplicate-count regressions (e.g., original returns `[A, A]`
but rewrite returns `[A]` would falsely pass with `EXCEPT`).

**Volatile function handling**: Postgres distinguishes between
transaction-stable and truly volatile functions:
- **Transaction-stable** (`STABLE`/`IMMUTABLE`): `NOW()`, `CURRENT_TIMESTAMP`,
  `current_user` — these return the same value within a transaction. Running
  both queries in the same transaction is sufficient to freeze these.
- **Truly volatile** (`VOLATILE`): `CLOCK_TIMESTAMP()`, `random()`,
  `nextval()`, `uuid_generate_v4()` — these return different values on every
  call, even within the same transaction. A shared transaction snapshot does
  **not** freeze these.

For v1, the **plugin** detects volatile functions during PREFLIGHT (which is
plugin-internal, no agent fan-out) and **rejects** queries containing them —
automatic normalization (e.g., replacing `random()` with a literal) would
change query semantics and make benchmarks misleading.

**Detection strategy (two-pass)**:
1. **Best-effort regex pass (pre-schema-load)**: Before the harness is up,
   the plugin scans the SQL for a built-in blocklist of known volatile
   functions (`random()`, `clock_timestamp()`, `nextval()`, `txid_current()`,
   `uuid_generate_v4()`, `gen_random_uuid()`, `setseed()`, `pg_sleep()`).
   This catches common cases immediately with no DB connection. This pass is
   documented as **best-effort** — it cannot catch user-defined volatile
   functions or aliased calls.
2. **Catalog-verified pass (post-schema-load)**: After the schema is loaded
   into the harness container, the plugin runs the query through
   `EXPLAIN VERBOSE` (or parses `pg_proc.provolatile` for each function
   referenced in the plan) to identify any remaining `VOLATILE`-classified
   functions that the regex missed, including user-defined functions. If any
   are found, PREFLIGHT fails with a specific error naming the volatile
   function(s).

**On detection**:
- PREFLIGHT fails with a clear error asking the user to provide a literalized
  test variant with volatile calls replaced by concrete values.
- The user may provide an explicit literalized `slowQuery` (e.g., replacing
  `clock_timestamp()` with a fixed timestamp). The room benchmarks what the
  user provides without attempting automatic rewriting.

Transaction-stable functions (`NOW()`, `CURRENT_TIMESTAMP`, `current_user`)
are safe and handled automatically: both the original and rewritten queries
are executed within the **same statement or single-snapshot transaction** to
freeze their values. Note: Postgres `STABLE` functions are only guaranteed
to return the same value within a single statement, not across separate
statements in the same transaction. The parity check handles this by wrapping
the original and rewritten queries in a single `SELECT` expression (via the
`EXCEPT ALL` comparison), ensuring both sides see the same snapshot and
`STABLE` function results.

**Order-sensitive comparison**: The `EXCEPT ALL` check is unordered and does
not validate row ordering. This is a **known v1 limitation**: if the original
query includes `ORDER BY`, a rewrite that returns the correct rows in a
different order will pass parity. For queries with `ORDER BY ... LIMIT/OFFSET`,
incorrect ordering can change which rows are returned, which `EXCEPT ALL` will
catch (different rows). For queries with `ORDER BY` but no `LIMIT`, ordering
differences are not detected in v1. The report flags when a parity-checked
rewrite involves an `ORDER BY` clause and advises manual verification of
ordering semantics. A v2 enhancement could add row-number-based positional
comparison for order-sensitive queries.

The builder must run this check and report the result. The plugin verifies
the check was performed (not just claimed).

Additional edge cases the builder must handle:
- NULL handling (EXCEPT ALL treats NULLs as equal, which is correct here)
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

- **Demo mode**: bundled e-commerce schema + data + slow query, one click,
  no database needed — just Docker. Uses the same full pipeline (not a
  simplified codepath). Serves as first-run experience, dev/CI testing,
  and showcase.
- **Query scope**: read-only `SELECT` / `WITH ... SELECT` only, with concrete
  literal values (no parameterized queries)
- Strategy types: `index` and `rewrite` only
- Data population: Tier 1 (user seed) and Tier 2 (sampled from source via
  client-side COPY + TABLESAMPLE), with Tier 3 (naive synthetic) as fallback
  with explicit warnings
- Parity: hard gate for rewrites using `EXCEPT ALL` (multi-set comparison),
  transaction-stable expressions (`NOW()` etc.) frozen via shared transaction;
  queries with truly volatile functions (`random()`, `CLOCK_TIMESTAMP()` etc.)
  rejected at PREFLIGHT unless user provides literalized variant;
  order-sensitive comparison is a known limitation (see Section 9.3)
- Frontier: single winner per bucket, no combined pass; report must not
  recommend untested combinations
- Benchmarking: plan shape change as confidence gate (determines whether a
  timing measurement is trusted), speedup as ranking signal, CV% thresholds
  for noise rejection, periodic baseline re-measurement
- Data population: Tier 2 is reliable for single-table index decisions but
  degrades for multi-join rewrites due to independent per-table sampling;
  report flags this when applicable. Source DB is strictly read-only (no
  ANALYZE or writes).
- Auditor risk findings labeled as heuristic/advisory when production telemetry
  is unavailable
- Config/schema strategies: advisory notes in report, not benchmarked

### v2 (defer)

- Strategy types: `schema` (materialized views, partitioning, denormalization)
- Combined candidate synthesis pass (test frontier winners from multiple buckets together)
- Agent-generated data distributions (Tier 4)
- Parameterized query support (query templates + representative parameter sets,
  `PREPARE`/`EXECUTE` benchmarking, generic-vs-custom plan testing)
- Order-sensitive parity comparison for queries with `ORDER BY`
- Multi-query workload optimization (regression checking across query set)
- Config tuning (requires production-like concurrency to be meaningful)
- Parallel workers / JIT benchmark pass (production-realistic mode)

---

## 11. Example Sessions

### 11.1 Demo Mode (zero config)

**Input**: `demoMode: true`

Everything else is automatic — the room loads the bundled e-commerce schema,
500K-row data dump, and the demo slow query. The user clicks start and
watches the room work. Expected outcome: composite index on
`orders(user_id, created_at, status)` or similar, >10x speedup.

### 11.2 Real Database (Tier 1 seed)

**Input**:
- `dbUrl`: `postgres://app:secret@localhost:5432/myapp`
- `slowQuery`: `SELECT o.id, o.total, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.created_at > NOW() - INTERVAL '30 days' AND o.status = 'completed' ORDER BY o.created_at DESC LIMIT 100`
- `schemaSource`: `introspect`
- `seedDataPath`: `./db/staging-dump.sql`

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

**Cycle 3 — Continued exploration**:
- Explorer proposes expression index variant and alternative rewrite
- No candidate improved over covering index (98.7%) or lateral join rewrite (72.4%)
- Plateau count: 1 of 2 — keep exploring

**Cycle 4 — Convergence**:
- Explorer proposes further refinements
- Still no improvement over frontier winners
- Plateau count: 2 of 2 — plateau reached with `plateauCycles: 2`
- Target 20% met (98.7% >> 20%), auditor approved, and search has plateaued
- Stop reason: `target_met`

**Report**:
- Index bucket winner: covering index on orders(user_id, created_at DESC) INCLUDE (status, total)
  - Speedup: 98.7% (847ms → 11ms), plan: Index Only Scan
  - Deploy: `CREATE INDEX CONCURRENTLY`, ~12MB storage, monitor write overhead
- Rewrite bucket winner: lateral join rewrite
  - Speedup: 72.4% (847ms → 234ms), parity verified
  - Deploy: swap query in application code, no schema changes needed
- Advisory: "Winners in both buckets were benchmarked independently — test the covering index + rewrite combination together manually before deploying both, as they may interact."
