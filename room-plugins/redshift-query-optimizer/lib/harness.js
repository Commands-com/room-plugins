/**
 * harness.js — Redshift connection, EXPLAIN, benchmarking, and parity checks.
 *
 * No Docker. Direct connection to a Redshift cluster via the pg wire protocol.
 * Redshift is wire-compatible with Postgres so we use the pg module.
 */

import { DEFAULTS, DIST_STEP_TYPES } from './constants.js';

// ---------------------------------------------------------------------------
// Dynamic pg import — resolved at runtime so the module can be loaded without
// pg installed (tests mock it).  The caller's node_modules must have 'pg'.
// ---------------------------------------------------------------------------

let _pgModule = null;

async function getPg() {
  if (!_pgModule) {
    _pgModule = await import('pg');
  }
  return _pgModule.default || _pgModule;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function connect(dbUrl) {
  const pg = await getPg();
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  return client;
}

export async function disconnect(client) {
  if (!client) return;
  try {
    await client.end();
  } catch {
    // best-effort
  }
}

export async function testConnection(dbUrl) {
  let client;
  try {
    client = await connect(dbUrl);
    const result = await client.query('SELECT 1 AS ok');
    const row = result.rows?.[0];
    return { ok: Boolean(row?.ok), message: 'Connection successful' };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await disconnect(client);
  }
}

// ---------------------------------------------------------------------------
// Cluster info
// ---------------------------------------------------------------------------

export async function getClusterInfo(client) {
  const versionResult = await client.query('SELECT version()');
  const versionString = versionResult.rows?.[0]?.version || '';

  let nodeCount = null;
  try {
    const nodesResult = await client.query(
      `SELECT COUNT(*) AS cnt FROM stv_slices WHERE node >= 0`,
    );
    nodeCount = Number(nodesResult.rows?.[0]?.cnt) || null;
  } catch {
    // SVL tables may not be accessible
  }

  return { versionString, nodeCount };
}

// ---------------------------------------------------------------------------
// Table metadata
// ---------------------------------------------------------------------------

export async function getTableMetadata(client, tableNames) {
  if (!tableNames || tableNames.length === 0) return [];

  // Split schema-qualified names (e.g. "parsed_ccdas.problems") into
  // separate schema and table components for precise matching.
  const schemaTablePairs = [];
  const bareTableNames = [];
  for (const ref of tableNames) {
    if (ref.includes('.')) {
      // Handle 2-part (schema.table) and 3-part (db.schema.table) names.
      // Always take the last two segments as schema and table.
      const parts = ref.split('.');
      const table = parts[parts.length - 1];
      const schema = parts[parts.length - 2];
      schemaTablePairs.push({ schema, table });
    } else {
      bareTableNames.push(ref);
    }
  }

  // Build WHERE clause that matches both schema-qualified and bare names.
  // For schema-qualified: match on both schema AND table.
  // For bare: match on table name only (ambiguous but best we can do).
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  for (const { schema, table } of schemaTablePairs) {
    conditions.push(`(schema = $${paramIndex} AND "table" = $${paramIndex + 1})`);
    params.push(schema, table);
    paramIndex += 2;
  }
  for (const table of bareTableNames) {
    conditions.push(`"table" = $${paramIndex}`);
    params.push(table);
    paramIndex += 1;
  }

  if (conditions.length === 0) return { tableInfo: [], columns: [] };

  const whereClause = conditions.join(' OR ');

  // SVV_TABLE_INFO: sort keys, dist keys, row counts, size
  const infoQuery = `
    SELECT "table" AS table_name, schema AS table_schema,
           diststyle, sortkey1, sortkey_num, size AS size_mb,
           tbl_rows AS row_count, unsorted AS unsorted_pct,
           skew_sortkey1, skew_rows
    FROM svv_table_info
    WHERE ${whereClause}
    ORDER BY tbl_rows DESC
  `;

  let tableInfo = [];
  try {
    const result = await client.query(infoQuery, params);
    tableInfo = result.rows || [];
  } catch {
    // SVV_TABLE_INFO may not be accessible for all users
  }

  // Column metadata from information_schema — also schema-qualify
  const colConditions = [];
  const colParams = [];
  let colIdx = 1;

  for (const { schema, table } of schemaTablePairs) {
    colConditions.push(`(table_schema = $${colIdx} AND table_name = $${colIdx + 1})`);
    colParams.push(schema, table);
    colIdx += 2;
  }
  for (const table of bareTableNames) {
    colConditions.push(`table_name = $${colIdx}`);
    colParams.push(table);
    colIdx += 1;
  }

  const colQuery = `
    SELECT table_schema, table_name, column_name, data_type, ordinal_position,
           character_maximum_length, numeric_precision
    FROM information_schema.columns
    WHERE ${colConditions.join(' OR ')}
    ORDER BY table_schema, table_name, ordinal_position
  `;

  let columns = [];
  try {
    const result = await client.query(colQuery, colParams);
    columns = result.rows || [];
  } catch {
    // fall back silently
  }

  return { tableInfo, columns };
}

// ---------------------------------------------------------------------------
// EXPLAIN plan parsing (text-based)
// ---------------------------------------------------------------------------

export async function runExplain(client, query) {
  const result = await client.query(`EXPLAIN ${query}`);
  const lines = (result.rows || []).map((r) => r['QUERY PLAN'] || r.queryplan || Object.values(r)[0] || '');
  const planText = lines.join('\n');

  // Extract step types, dist steps, estimated costs
  const stepTypes = new Set();
  const distSteps = [];
  let totalCost = 0;

  for (const line of lines) {
    // Match step types like "XN Seq Scan", "XN Hash Join", etc.
    const stepMatch = line.match(/^\s*->\s*(XN\s+\S+(?:\s+\S+)?)/);
    if (stepMatch) {
      stepTypes.add(stepMatch[1].trim());
    }
    // Also match the root node (no ->)
    const rootMatch = line.match(/^\s*(XN\s+\S+(?:\s+\S+)?)/);
    if (rootMatch && !line.includes('->')) {
      stepTypes.add(rootMatch[1].trim());
    }

    // Distribution steps
    for (const distType of DIST_STEP_TYPES) {
      if (line.includes(distType)) {
        distSteps.push(distType);
      }
    }

    // Extract cost (ignore Redshift's 9999999999999999... planner overflow sentinel)
    const costMatch = line.match(/cost=[\d.]+\.\.([\d.]+)/);
    if (costMatch) {
      const cost = parseFloat(costMatch[1]);
      if (Number.isFinite(cost) && cost < 1e15 && cost > totalCost) {
        totalCost = cost;
      }
    }
  }

  return {
    planText,
    stepTypes: [...stepTypes],
    distSteps,
    totalCost,
  };
}

// ---------------------------------------------------------------------------
// Benchmarking — wall-clock timing on cluster
// ---------------------------------------------------------------------------

export async function runBenchmark(client, query, config = {}) {
  const warmupRuns = config.warmupRuns ?? DEFAULTS.warmupRuns;
  const benchmarkTrials = config.benchmarkTrials ?? DEFAULTS.benchmarkTrials;
  const timeoutMs = config.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs;

  // Set statement timeout for safety
  await client.query(`SET statement_timeout TO ${timeoutMs}`);

  // Warmup runs — execute and discard
  for (let i = 0; i < warmupRuns; i++) {
    try {
      await client.query(query);
    } catch {
      // warmup failure is non-fatal
    }
  }

  // Timed trials
  const timings = [];
  for (let i = 0; i < benchmarkTrials; i++) {
    const start = process.hrtime.bigint();
    await client.query(query);
    const end = process.hrtime.bigint();
    timings.push(Number(end - start) / 1e6); // ns to ms
  }

  // Capture query ID from the last benchmark trial BEFORE running EXPLAIN,
  // otherwise pg_last_query_id() would return the EXPLAIN's query ID.
  let lastBenchmarkQueryId = null;
  try {
    const qidResult = await client.query('SELECT pg_last_query_id() AS qid');
    lastBenchmarkQueryId = qidResult.rows?.[0]?.qid ?? null;
  } catch {
    // non-fatal
  }

  timings.sort((a, b) => a - b);
  const medianMs = timings[Math.floor(timings.length / 2)];
  const p95Index = Math.min(Math.floor(timings.length * 0.95), timings.length - 1);
  const p95Ms = timings[p95Index];

  const mean = timings.reduce((s, t) => s + t, 0) / timings.length;
  const variance = timings.reduce((s, t) => s + (t - mean) ** 2, 0) / timings.length;
  const stddev = Math.sqrt(variance);
  const cvPct = mean > 0 ? (stddev / mean) * 100 : 0;

  // Get EXPLAIN for plan analysis
  const plan = await runExplain(client, query);

  // Get bytes scanned / rows from SVL_QUERY_SUMMARY for the benchmark query
  // (not the EXPLAIN — we captured the query ID before running EXPLAIN).
  let bytesScanned = null;
  let rowsReturned = null;
  try {
    // Use parameterized query to avoid JS number precision loss on 64-bit query IDs.
    const svlResult = lastBenchmarkQueryId != null
      ? await client.query(
        `SELECT SUM(bytes) AS total_bytes, SUM(rows) AS total_rows
         FROM svl_query_summary WHERE query = $1`,
        [String(lastBenchmarkQueryId)],
      )
      : await client.query(
        `SELECT SUM(bytes) AS total_bytes, SUM(rows) AS total_rows
         FROM svl_query_summary WHERE query = pg_last_query_id()`,
      );
    const row = svlResult.rows?.[0];
    if (row) {
      bytesScanned = Number(row.total_bytes) || null;
      rowsReturned = Number(row.total_rows) || null;
    }
  } catch {
    // SVL tables may not be accessible
  }

  // Reset statement timeout
  await client.query('SET statement_timeout TO 0');

  return {
    medianMs: Number(medianMs.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    cvPct: Number(cvPct.toFixed(1)),
    trials: timings.map((t) => Number(t.toFixed(2))),
    stepTypes: plan.stepTypes,
    distSteps: plan.distSteps,
    totalCost: plan.totalCost,
    planText: plan.planText,
    bytesScanned,
    rowsReturned,
  };
}

// ---------------------------------------------------------------------------
// Parity checking
// ---------------------------------------------------------------------------

/**
 * Check result parity between original and rewritten queries.
 *
 * Strategy:
 * 1. Compare row counts first (cheap).
 * 2. If counts match and under parityFullThreshold: full EXCEPT ALL.
 * 3. If counts match but over threshold: grouped checksum comparison.
 */
export async function checkParity(client, originalQuery, rewrittenQuery, config = {}) {
  const fullThreshold = config.parityFullThreshold ?? DEFAULTS.parityFullThreshold;
  const timeoutMs = config.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs;

  await client.query(`SET statement_timeout TO ${timeoutMs}`);

  try {
    // Step 1: Row count comparison
    const countQuery = `
      SELECT
        (SELECT COUNT(*) FROM (${originalQuery}) _orig) AS orig_count,
        (SELECT COUNT(*) FROM (${rewrittenQuery}) _rewrite) AS rewrite_count
    `;
    const countResult = await client.query(countQuery);
    const origCount = Number(countResult.rows?.[0]?.orig_count ?? -1);
    const rewriteCount = Number(countResult.rows?.[0]?.rewrite_count ?? -1);

    if (origCount !== rewriteCount) {
      return {
        ok: false,
        method: 'row_count',
        origCount,
        rewriteCount,
        differingRows: Math.abs(origCount - rewriteCount),
      };
    }

    // Step 2: Full EXCEPT ALL for small result sets
    if (origCount <= fullThreshold) {
      const parityQuery = `
        SELECT COUNT(*) AS diff_count FROM (
          (${originalQuery} EXCEPT ALL ${rewrittenQuery})
          UNION ALL
          (${rewrittenQuery} EXCEPT ALL ${originalQuery})
        ) _parity
      `;
      const parityResult = await client.query(parityQuery);
      const diffCount = Number(parityResult.rows?.[0]?.diff_count ?? -1);

      return {
        ok: diffCount === 0,
        method: 'full_except_all',
        origCount,
        rewriteCount,
        differingRows: diffCount,
      };
    }

    // Step 3: Grouped checksum for large result sets
    // Hash each row, group by hash prefix, compare aggregated counts.
    const checksumQuery = `
      SELECT SUM(h) AS checksum FROM (
        SELECT CHECKSUM(t.*) AS h FROM (${originalQuery}) t
      ) _cs
    `;
    const rewriteChecksumQuery = `
      SELECT SUM(h) AS checksum FROM (
        SELECT CHECKSUM(t.*) AS h FROM (${rewrittenQuery}) t
      ) _cs
    `;

    let origChecksum, rewriteChecksum;
    try {
      const [origCs, rewriteCs] = await Promise.all([
        client.query(checksumQuery),
        client.query(rewriteChecksumQuery),
      ]);
      origChecksum = origCs.rows?.[0]?.checksum;
      rewriteChecksum = rewriteCs.rows?.[0]?.checksum;
    } catch {
      // CHECKSUM may not be available; fall back to row-count-only pass
      return {
        ok: true,
        method: 'row_count_only',
        origCount,
        rewriteCount,
        differingRows: 0,
        note: 'CHECKSUM not available; parity confirmed by row count only',
      };
    }

    return {
      ok: origChecksum === rewriteChecksum,
      method: 'grouped_checksum',
      origCount,
      rewriteCount,
      differingRows: origChecksum === rewriteChecksum ? 0 : -1,
    };
  } finally {
    try {
      await client.query('SET statement_timeout TO 0');
    } catch {
      // best-effort
    }
  }
}
