import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_GUCS, DEFAULTS, LEAF_ACCESS_NODE_TYPES } from './constants.js';
import { containerName, extractQueryTableRefs, networkName, quoteIdent, rewriteLocalhostForDocker, sanitizeSQL } from './utils.js';

const execAsync = promisify(execCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets', 'demo');

// ---------------------------------------------------------------------------
// Helper for exec calls that need to pipe data via stdin
// ---------------------------------------------------------------------------

function execWithInput(cmd, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execCb(cmd, { ...options, encoding: options.encoding || 'utf-8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

export async function checkDockerAvailability() {
  try {
    await execAsync('docker info', { encoding: 'utf-8', timeout: 10000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message || 'Docker is not available' };
  }
}

// ---------------------------------------------------------------------------
// Source database version detection
// ---------------------------------------------------------------------------

export async function detectSourceVersion(dbUrl, fallbackPgVersion) {
  if (!dbUrl) return { ok: false, version: null, message: 'No dbUrl provided' };

  const pgVersion = fallbackPgVersion || DEFAULTS.postgresVersion;
  const dockerDbUrl = rewriteLocalhostForDocker(dbUrl);

  // Try host psql first
  try {
    await execAsync('which psql', { encoding: 'utf-8', timeout: 5000 });
    const { stdout } = await execAsync(
      `psql "${dbUrl}" -t -A -c "SHOW server_version;"`,
      { encoding: 'utf-8', timeout: 10000 },
    );
    const versionOutput = stdout.trim();
    const major = versionOutput.split('.')[0];
    if (major) return { ok: true, version: major, message: `Detected source v${major} via host psql` };
  } catch {
    // Host psql not available — fall through
  }

  // Fallback: Docker utility container
  try {
    const { stdout } = await execAsync(
      `docker run --rm --add-host=host.docker.internal:host-gateway postgres:${pgVersion}-alpine psql "${dockerDbUrl}" -t -A -c "SHOW server_version;"`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const versionOutput = stdout.trim();
    const major = versionOutput.split('.')[0];
    if (major) return { ok: true, version: major, message: `Detected source v${major} via Docker utility container` };
  } catch {
    // Docker fallback also failed
  }

  return { ok: false, version: null, message: 'Could not detect source database version via host psql or Docker utility container' };
}

// ---------------------------------------------------------------------------
// Source plan capture — EXPLAIN (no ANALYZE) against the live source DB
// ---------------------------------------------------------------------------

/**
 * Run EXPLAIN (FORMAT JSON) against the source database to capture the
 * production query plan. This is read-only (no ANALYZE) so it's safe and
 * fast. Returns plan shape metadata for comparison with the harness plan.
 */
export async function captureSourcePlan(dbUrl, query) {
  if (!dbUrl || !query) return null;

  const cleanQuery = sanitizeSQL(query);
  const explainSQL = `EXPLAIN (FORMAT JSON) ${cleanQuery}`;

  // Try host psql first
  try {
    await execAsync('which psql', { encoding: 'utf-8', timeout: 5000 });
    const { stdout } = await execWithInput(
      `psql "${dbUrl}" -t -A`,
      explainSQL,
      { encoding: 'utf-8', timeout: 30000 },
    );
    const plan = extractPlanFromExplainOutput(stdout);
    if (plan) return extractPlanShape(plan);
  } catch {
    // Host psql not available — fall through
  }

  return null;
}

/**
 * Run EXPLAIN (FORMAT JSON) against the harness container to capture the
 * harness query plan. Returns the same plan shape metadata for comparison
 * with the source plan.
 */
export async function captureHarnessPlan(containerNameStr, query) {
  if (!containerNameStr || !query) return null;

  const cleanQuery = sanitizeSQL(query);
  const explainSQL = `EXPLAIN (FORMAT JSON) ${cleanQuery}`;

  try {
    const { stdout } = await execWithInput(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
      explainSQL,
      { encoding: 'utf-8', timeout: 30000 },
    );
    const plan = extractPlanFromExplainOutput(stdout);
    if (plan) return extractPlanShape(plan);
  } catch {
    // ignore
  }

  return null;
}

// The harness disables parallel workers (max_parallel_workers_per_gather=0)
// for deterministic benchmarks, so parallelism artifacts will always differ
// between source and harness. We normalize these away before comparing so
// the comparison focuses on the actual access strategy (join types, scan types).
const PARALLELISM_WRAPPER_NODES = new Set([
  'Gather', 'Gather Merge',
]);

// "Parallel Bitmap Heap Scan" → "Bitmap Heap Scan", etc.
function normalizeNodeType(nodeType) {
  if (typeof nodeType === 'string' && nodeType.startsWith('Parallel ')) {
    return nodeType.slice('Parallel '.length);
  }
  return nodeType;
}

function normalizeParallelism(planNode) {
  if (!planNode) return planNode;

  // Unwrap Gather/Gather Merge wrappers (single child → promote child)
  if (PARALLELISM_WRAPPER_NODES.has(planNode['Node Type'])
    && planNode.Plans?.length === 1) {
    return normalizeParallelism(planNode.Plans[0]);
  }

  // Normalize "Parallel X" → "X" on the node type
  const normalized = {
    ...planNode,
    'Node Type': normalizeNodeType(planNode['Node Type']),
  };

  // Recurse into children
  if (normalized.Plans && Array.isArray(normalized.Plans)) {
    normalized.Plans = normalized.Plans.map(normalizeParallelism);
  }

  // Collapse partial+final aggregate pairs left over from parallel plans.
  // Pattern: Aggregate(Aggregate(X)) → Aggregate(X)
  // After stripping Gather, the two-phase aggregate (partial per worker →
  // final after gather) leaves two consecutive same-type nodes.
  if (normalized.Plans?.length === 1
    && normalized['Node Type'] === normalized.Plans[0]['Node Type']) {
    normalized.Plans = normalized.Plans[0].Plans || [];
  }

  return normalized;
}

function extractPlanShape(plan) {
  const rawRoot = plan?.[0]?.Plan || plan?.[0] || {};
  // Normalize parallelism so source vs harness comparison is fair
  const rootPlan = normalizeParallelism(rawRoot);
  const allNodes = extractPlanNodes(rootPlan);
  const leafAccessNodes = allNodes.filter((n) => LEAF_ACCESS_NODE_TYPES.includes(n));
  return {
    planNodeSet: [...new Set(allNodes)],
    leafAccessNodes,
    planStructureHash: simpleStringHash(planStructureString(rootPlan)),
    planStructureString: planStructureString(rootPlan),
  };
}

/**
 * Compare two plan shapes and return a divergence summary, or null if they match.
 * Both shapes have already been normalized (parallelism stripped).
 *
 * Compares the full tree structure hash — different join ordering, different
 * nesting, or different access patterns at different scales all count as
 * divergence and trigger scale-up.
 */
export function comparePlanShapes(sourcePlan, harnessPlan) {
  if (!sourcePlan || !harnessPlan) return null;

  if (sourcePlan.planStructureHash === harnessPlan.planStructureHash) {
    return null; // Plans match
  }

  // Find specific node-level differences for diagnostic messages
  const sourceNodes = new Set(sourcePlan.planNodeSet || []);
  const harnessNodes = new Set(harnessPlan.planNodeSet || []);
  const onlyInSource = [...sourceNodes].filter((n) => !harnessNodes.has(n));
  const onlyInHarness = [...harnessNodes].filter((n) => !sourceNodes.has(n));

  const nodeDiff = onlyInSource.length > 0 || onlyInHarness.length > 0
    ? `source: [${onlyInSource.join(', ')}], harness: [${onlyInHarness.join(', ')}]`
    : `same node types but different structure`;

  return {
    diverged: true,
    sourceHash: sourcePlan.planStructureHash,
    harnessHash: harnessPlan.planStructureHash,
    sourceStructure: sourcePlan.planStructureString || '',
    harnessStructure: harnessPlan.planStructureString || '',
    onlyInSource,
    onlyInHarness,
    message: `Plan divergence (${nodeDiff}). Speedup measurements may not transfer to production.`,
  };
}

// ---------------------------------------------------------------------------
// Network management
// ---------------------------------------------------------------------------

export async function createNetwork(roomId) {
  const name = networkName(roomId);
  try {
    await execAsync(`docker network create --internal ${name}`, {
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (err) {
    if (!err.message?.includes('already exists')) {
      throw err;
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

export async function startContainer(roomId, config) {
  const containerNameStr = containerName(roomId);
  const netName = networkName(roomId);
  const image = `postgres:${config.postgresVersion || DEFAULTS.postgresVersion}-alpine`;

  // Remove existing container if present
  try {
    await execAsync(`docker rm -f ${containerNameStr}`, {
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch {
    // container didn't exist — fine
  }

  const gucFlags = BENCHMARK_GUCS.map((guc) => `-c ${guc}`).join(' ');

  // Start on the default bridge network so -p port publishing works.
  // The --internal network blocks port publishing, so we only use it
  // for inter-container isolation if needed later. The container has no
  // services that would reach the internet on their own.
  const cmd = [
    'docker run -d --rm',
    `--name ${containerNameStr}`,
    '-p 0:5432',
    `--memory ${config.containerMemory || DEFAULTS.containerMemory}`,
    `--cpus ${config.containerCpus || DEFAULTS.containerCpus}`,
    '-e POSTGRES_USER=harness',
    '-e POSTGRES_PASSWORD=harness',
    '-e POSTGRES_DB=harness',
    image,
    gucFlags,
  ].join(' ');

  const { stdout } = await execAsync(cmd, {
    encoding: 'utf-8',
    timeout: 30000,
  });
  const containerId = stdout.trim();

  // Port may not be available immediately — retry briefly
  let port;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      port = await getContainerPort(containerNameStr);
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!port) {
    port = await getContainerPort(containerNameStr);
  }

  return { containerId, containerNameStr, port };
}

// ---------------------------------------------------------------------------
// Readiness polling
// ---------------------------------------------------------------------------

export async function waitForReady(containerNameStr, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await execAsync(
        `docker exec ${containerNameStr} pg_isready -U harness`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      return true;
    } catch {
      // not ready yet — sleep briefly and retry
      await sleep(500);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Port & connection helpers
// ---------------------------------------------------------------------------

export async function getContainerPort(containerNameStr) {
  try {
    const { stdout } = await execAsync(`docker port ${containerNameStr} 5432`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const output = stdout.trim();
    // Output looks like "0.0.0.0:32768" or ":::32768" — grab the last part
    const match = output.match(/:(\d+)\s*$/);
    return match ? match[1] : output;
  } catch (err) {
    throw new Error(`Failed to get port for ${containerNameStr}: ${err.message}`);
  }
}

export async function getConnectionString(containerNameStr) {
  const port = await getContainerPort(containerNameStr);
  return `postgres://harness:harness@localhost:${port}/harness`;
}

// ---------------------------------------------------------------------------
// SQL execution
// ---------------------------------------------------------------------------

export async function execSQL(containerNameStr, sql, timeoutMs = 30000) {
  const escaped = sanitizeSQL(sql).replace(/"/g, '\\"');
  const cmd = `docker exec -i ${containerNameStr} psql -U harness -d harness -c "${escaped}"`;
  try {
    const { stdout } = await execAsync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err) {
    throw new Error(`SQL execution failed: ${err.stderr || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

export async function loadSchema(containerNameStr, config) {
  try {
    switch (config.schemaSource) {
      case 'dump': {
        const schemaSql = await fs.promises.readFile(config.schemaPath, 'utf-8');
        await execWithInput(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          schemaSql,
          { encoding: 'utf-8', timeout: 60000 },
        );
        return { ok: true, message: 'Schema loaded from dump file' };
      }
      case 'demo': {
        const demoSchema = await fs.promises.readFile(path.join(ASSETS_DIR, 'schema.sql'), 'utf-8');
        await execWithInput(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          demoSchema,
          { encoding: 'utf-8', timeout: 60000 },
        );
        return { ok: true, message: 'Demo schema loaded' };
      }
      case 'introspect': {
        // Source version should already be detected and stored in config._detectedSourceVersion
        // by onRoomStart() before startContainer(). Use it to pick the right pg_dump version.
        const resolvedVersion = config._detectedSourceVersion || config.postgresVersion || DEFAULTS.postgresVersion;

        // Try host pg_dump first, then fall back to Docker utility container
        let dump;
        try {
          // Check if pg_dump is available on the host
          await execAsync('which pg_dump', { encoding: 'utf-8', timeout: 5000 });

          // Check host pg_dump version floor — must be >= source version
          try {
            const { stdout: pgDumpVersionOut } = await execAsync('pg_dump --version', { encoding: 'utf-8', timeout: 5000 });
            const pgDumpVersion = pgDumpVersionOut.trim();
            const pgDumpMajor = pgDumpVersion.match(/(\d+)\./)?.[1];
            if (pgDumpMajor && Number(pgDumpMajor) < Number(resolvedVersion)) {
              throw new Error(`Host pg_dump v${pgDumpMajor} is older than source v${resolvedVersion} — using Docker fallback`);
            }
          } catch (vErr) {
            if (vErr.message.includes('older than')) throw vErr;
            // Could not determine version — try anyway
          }

          const { stdout: dumpOut } = await execAsync(
            `pg_dump --schema-only "${config.dbUrl}"`,
            { encoding: 'utf-8', timeout: 60000 },
          );
          dump = dumpOut;
        } catch {
          // Fallback: use ephemeral Docker utility container with pg_dump
          const dockerDbUrl = rewriteLocalhostForDocker(config.dbUrl);
          try {
            const { stdout: dumpOut } = await execAsync(
              `docker run --rm --add-host=host.docker.internal:host-gateway postgres:${resolvedVersion}-alpine pg_dump --schema-only "${dockerDbUrl}"`,
              { encoding: 'utf-8', timeout: 60000 },
            );
            dump = dumpOut;
          } catch (dockerErr) {
            throw new Error(`pg_dump failed on both host and Docker fallback: ${dockerErr.message}`);
          }
        }
        await execWithInput(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          dump,
          { encoding: 'utf-8', timeout: 60000 },
        );
        return { ok: true, message: `Schema introspected and loaded (v${resolvedVersion})` };
      }
      case 'migrations': {
        const migrationDir = config.schemaPath;
        const files = (await fs.promises.readdir(migrationDir))
          .filter((f) => f.endsWith('.sql'))
          .sort();
        for (const file of files) {
          const sql = await fs.promises.readFile(path.join(migrationDir, file), 'utf-8');
          await execWithInput(
            `docker exec -i ${containerNameStr} psql -U harness -d harness`,
            sql,
            { encoding: 'utf-8', timeout: 60000 },
          );
        }
        return { ok: true, message: `Schema loaded from ${files.length} migration file(s)` };
      }
      default:
        return { ok: false, message: `Unknown schemaSource: ${config.schemaSource}` };
    }
  } catch (err) {
    return { ok: false, message: `Schema loading failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Post-load row count validation
// ---------------------------------------------------------------------------

/**
 * Validate that tables actually contain rows after a bulk load.
 * Runs ANALYZE first for accurate pg_class.reltuples, then queries counts.
 * Returns a map of tableName → rowCount.
 */
async function validateLoadedRowCounts(containerNameStr, tableNames) {
  if (!tableNames || tableNames.length === 0) return {};

  // Run ANALYZE to update statistics
  try {
    await execAsync(
      `docker exec ${containerNameStr} psql -U harness -d harness -c "ANALYZE;"`,
      { encoding: 'utf-8', timeout: 60000 },
    );
  } catch { /* best effort */ }

  // Query reltuples from pg_class (fast, accurate after ANALYZE)
  try {
    const { stdout } = await execAsync(
      `docker exec ${containerNameStr} psql -U harness -d harness -t -A -c "SELECT n.nspname || '.' || c.relname, GREATEST(c.reltuples::bigint, 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema');"`,
      { encoding: 'utf-8', timeout: 30000 },
    );
    const output = stdout.trim();
    const counts = {};
    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length >= 2) {
        counts[parts[0]] = parseInt(parts[1], 10) || 0;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export async function loadData(containerNameStr, config, { onProgress } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  try {
    // Demo mode — check for compressed or plain data file
    const gzPath = path.join(ASSETS_DIR, 'data.sql.gz');
    const plainPath = path.join(ASSETS_DIR, 'data.sql');

    if (config.schemaSource === 'demo') {
      if (await fs.promises.stat(gzPath).then((stat) => stat.isFile()).catch(() => false)) {
        await execAsync(
          `gunzip -c "${gzPath}" | docker exec -i ${containerNameStr} psql -v ON_ERROR_STOP=1 -U harness -d harness`,
          { encoding: 'utf-8', timeout: 120000 },
        );
        return { ok: true, message: 'Demo data loaded (gzipped)', tier: 'demo' };
      }
      if (await fs.promises.stat(plainPath).then((stat) => stat.isFile()).catch(() => false)) {
        const data = await fs.promises.readFile(plainPath, 'utf-8');
        await execWithInput(
          `docker exec -i ${containerNameStr} psql -v ON_ERROR_STOP=1 -U harness -d harness`,
          data,
          { encoding: 'utf-8', timeout: 120000 },
        );
        return { ok: true, message: 'Demo data loaded', tier: 'demo' };
      }
      return { ok: false, message: 'Demo data file not found — expected assets/demo/data.sql.gz or assets/demo/data.sql', tier: 'error' };
    }

    // Seed data path provided
    if (config.seedDataPath) {
      const seed = await fs.promises.readFile(config.seedDataPath, 'utf-8');
      await execWithInput(
        `docker exec -i ${containerNameStr} psql -v ON_ERROR_STOP=1 -U harness -d harness`,
        seed,
        { encoding: 'utf-8', timeout: 120000 },
      );
      return { ok: true, message: 'Seed data loaded', tier: 'seed' };
    }

    // Tier 2: seedFromSource — sample rows from the source database
    if (config.seedFromSource && config.dbUrl) {
      const scaleFactor = config.scaleFactor || DEFAULTS.scaleFactor;
      const dockerDbUrl = rewriteLocalhostForDocker(config.dbUrl);
      const pgVersion = config.postgresVersion || DEFAULTS.postgresVersion;
      const dockerPsql = `docker run --rm --add-host=host.docker.internal:host-gateway postgres:${pgVersion}-alpine psql "${dockerDbUrl}"`;

      // Discover user tables with estimated row counts from pg_class.
      // Per spec: if reltuples is 0 or -1 (stale/never-analyzed stats), fall back
      // to a counting query with a 5s timeout to avoid full-copying large tables.
      let tableInfo;
      try {
        const { stdout } = await execAsync(
          `${dockerPsql} -t -A -c "SELECT n.nspname || '.' || c.relname || '|' || GREATEST(c.reltuples::bigint, 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema');"`,
          { encoding: 'utf-8', timeout: 30000 },
        );
        const tableListOutput = stdout.trim();
        tableInfo = tableListOutput.split('\n').filter(Boolean).map((line) => {
          const [name, rowCountStr] = line.split('|');
          return { name, estimatedRows: parseInt(rowCountStr, 10) || 0 };
        });
      } catch (err) {
        return { ok: false, message: `Tier 2 sampling failed — could not list source tables: ${err.message}`, tier: 'error' };
      }

      // Fallback for stale stats: when reltuples is 0 (never analyzed or empty),
      // run a bounded COUNT with statement_timeout to get a real estimate.
      // This prevents accidentally full-copying a large table that just has stale stats.
      for (const table of tableInfo) {
        if (table.estimatedRows > 0) continue;
        try {
          const { stdout } = await execAsync(
            `${dockerPsql} -t -A -c "SET statement_timeout = '5s'; SELECT COUNT(*) FROM (SELECT 1 FROM ${quoteIdent(table.name)} LIMIT ${scaleFactor + 1}) AS __est;"`,
            { encoding: 'utf-8', timeout: 10000 },
          );
          table.estimatedRows = parseInt(stdout.trim(), 10) || 0;
        } catch {
          // Count timed out — table likely has > scaleFactor rows, treat as large
          table.estimatedRows = scaleFactor + 1;
        }
      }

      if (tableInfo.length === 0) {
        return { ok: false, message: 'Tier 2 sampling failed — no user tables found in source database', tier: 'error' };
      }

      // Derive query-relevant tables from the slow query.
      const slowQuery = config.slowQuery || '';
      const queryTableRefs = extractQueryTableRefs(slowQuery);

      // Filter tables: use explicit schemaFilter if set, otherwise auto-derive
      // from the query's table references to avoid sampling irrelevant tables.
      let filteredTables;
      if (config.schemaFilter && config.schemaFilter.length > 0) {
        filteredTables = tableInfo.filter((t) => config.schemaFilter.some((f) => t.name.endsWith(`.${f}`) || t.name === f));
      } else if (queryTableRefs.length > 0) {
        filteredTables = tableInfo.filter((t) => {
          const unqualified = t.name.includes('.') ? t.name.split('.').pop() : t.name;
          return queryTableRefs.some((ref) => unqualified === ref || t.name === ref);
        });
        // Fall back to all tables if query parsing found no matches
        if (filteredTables.length === 0) filteredTables = tableInfo;
      } else {
        filteredTables = tableInfo;
      }

      const queryRelevantTables = new Set();
      for (const ref of queryTableRefs) {
        for (const t of filteredTables) {
          const unqualified = t.name.includes('.') ? t.name.split('.').pop() : t.name;
          if (unqualified === ref || t.name === ref) {
            queryRelevantTables.add(t.name);
          }
        }
      }

      // Export each table from the source and stream directly into a temp file,
      // then pipe the file into the harness. This avoids holding all COPY data in
      // Node.js memory (which can exceed V8's ~512MB string limit for large DBs).
      const tmpFile = path.join(os.tmpdir(), `pqo-load-${Date.now()}.sql`);
      const writeStream = fs.createWriteStream(tmpFile);
      writeStream.write("SET session_replication_role = 'replica';\n");

      let sampledCount = 0;
      const failedTables = [];
      // maxBuffer for COPY exports — individual table export can be 50-100MB
      const copyMaxBuffer = 500 * 1024 * 1024;

      progress(`Sampling ${filteredTables.length} table(s)...`);
      for (let ti = 0; ti < filteredTables.length; ti++) {
        const table = filteredTables[ti];
        const quoted = quoteIdent(table.name);
        const shortName = table.name.includes('.') ? table.name.split('.').pop() : table.name;
        const estLabel = table.estimatedRows > 0 ? ` (~${table.estimatedRows.toLocaleString()} rows)` : '';
        progress(`[${ti + 1}/${filteredTables.length}] Exporting ${shortName}${estLabel}...`);
        try {
          let copyCmd;
          if (table.estimatedRows <= scaleFactor) {
            copyCmd = `COPY ${quoted} TO STDOUT`;
          } else {
            const samplePct = Math.min(100, Math.max(0.01, (scaleFactor * 1.5 / table.estimatedRows) * 100));
            copyCmd = `COPY (SELECT * FROM ${quoted} TABLESAMPLE SYSTEM(${samplePct.toFixed(4)}) LIMIT ${scaleFactor}) TO STDOUT`;
          }

          const { stdout: copyData } = await execAsync(
            `${dockerPsql} -c "${copyCmd}"`,
            { encoding: 'utf-8', timeout: 120000, maxBuffer: copyMaxBuffer },
          );

          // Retry: if TABLESAMPLE returned zero rows, fall back to plain LIMIT
          let finalData = copyData;
          if (!finalData.trim() && table.estimatedRows > scaleFactor) {
            progress(`[${ti + 1}/${filteredTables.length}] Retrying ${shortName} (TABLESAMPLE returned 0 rows)...`);
            const { stdout: retryOut } = await execAsync(
              `${dockerPsql} -c "COPY (SELECT * FROM ${quoted} LIMIT ${scaleFactor}) TO STDOUT"`,
              { encoding: 'utf-8', timeout: 120000, maxBuffer: copyMaxBuffer },
            );
            finalData = retryOut;
          }

          if (finalData.trim()) {
            const rowCount = finalData.trimEnd().split('\n').length;
            writeStream.write(`COPY ${quoted} FROM STDIN;\n`);
            writeStream.write(finalData.trimEnd());
            writeStream.write('\n\\.\n');
            sampledCount++;
            progress(`[${ti + 1}/${filteredTables.length}] ${shortName}: ${rowCount.toLocaleString()} rows exported`);
          } else {
            progress(`[${ti + 1}/${filteredTables.length}] ${shortName}: empty (skipped)`);
          }
        } catch {
          failedTables.push(table.name);
          progress(`[${ti + 1}/${filteredTables.length}] ${shortName}: export failed (skipped)`);
        }
      }
      progress(`Export complete: ${sampledCount} table(s) exported, loading into harness...`);

      writeStream.write("SET session_replication_role = 'origin';\n");
      writeStream.write('ANALYZE;\n');
      await new Promise((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      // Pipe the temp file into the harness psql session.
      // Do NOT use ON_ERROR_STOP — partial table loads are acceptable for non-critical tables.
      // Errors are detected via post-load row count validation below.
      if (sampledCount > 0) {
        try {
          await execAsync(
            `cat "${tmpFile}" | docker exec -i ${containerNameStr} psql -U harness -d harness`,
            { encoding: 'utf-8', timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
          );
        } catch (loadErr) {
          const errMsg = loadErr.stderr || loadErr.message || '';
          if (errMsg.includes('server closed the connection') || errMsg.includes('could not connect')) {
            fs.promises.unlink(tmpFile).catch(() => {});
            return { ok: false, message: `Tier 2 bulk load session failed: ${errMsg}`, tier: 'error' };
          }
        }
      }
      fs.promises.unlink(tmpFile).catch(() => {});

      // Post-load validation: verify actual row counts in the harness (not just export success)
      const allLoadedTableNames = filteredTables.map((t) => t.name);
      const actualRowCounts = await validateLoadedRowCounts(containerNameStr, allLoadedTableNames);
      const actualLoadedCount = Object.values(actualRowCounts).filter((count) => count > 0).length;

      // Check if query-relevant tables actually have rows (not just exported successfully)
      const relevantEmpty = [...queryRelevantTables].filter((t) => !actualRowCounts[t] || actualRowCounts[t] === 0);
      if (relevantEmpty.length > 0) {
        // Also check by unqualified name for tables with schema prefix mismatch
        const trulyEmpty = relevantEmpty.filter((t) => {
          const unqualified = t.includes('.') ? t.split('.').pop() : t;
          return !Object.entries(actualRowCounts).some(
            ([name, count]) => count > 0 && (name === t || name.endsWith(`.${unqualified}`)),
          );
        });
        if (trulyEmpty.length > 0) {
          return { ok: false, message: `Tier 2 sampling failed — query-relevant tables have zero rows after load: ${trulyEmpty.join(', ')}`, tier: 'error' };
        }
      }

      // Check export-phase failures for query-relevant and filtered tables
      const relevantFailed = failedTables.filter((t) => queryRelevantTables.has(t));
      if (relevantFailed.length > 0) {
        return { ok: false, message: `Tier 2 sampling failed — query-relevant tables could not be exported: ${relevantFailed.join(', ')}`, tier: 'error' };
      }

      if (config.schemaFilter && config.schemaFilter.length > 0) {
        const filterFailed = failedTables.filter((t) =>
          config.schemaFilter.some((f) => t.endsWith(`.${f}`) || t === f),
        );
        if (filterFailed.length > 0) {
          return { ok: false, message: `Tier 2 sampling failed — filtered tables could not be populated: ${filterFailed.join(', ')}`, tier: 'error' };
        }
      }

      if (actualLoadedCount === 0) {
        return { ok: false, message: 'Tier 2 sampling failed — no tables have rows after load (0 tables populated)', tier: 'error' };
      }

      const failNote = failedTables.length > 0 ? ` (${failedTables.length} non-critical table(s) skipped)` : '';
      const loadNote = actualLoadedCount !== sampledCount ? ` (${sampledCount} exported, ${actualLoadedCount} verified with rows)` : '';
      const maxTableRows = Math.max(0, ...filteredTables.map((t) => t.estimatedRows || 0));
      const totalRowsLoaded = Object.values(actualRowCounts).reduce((a, b) => a + b, 0);
      return { ok: true, message: `Tier 2: sampled data from ${actualLoadedCount}/${filteredTables.length} tables${failNote}${loadNote}`, tier: 'sampled', maxTableRows, totalRowsLoaded };
    }

    // Tier 3: synthetic fallback — generate naive INSERT data from schema
    return await loadSyntheticData(containerNameStr, config);
  } catch (err) {
    return { ok: false, message: `Data loading failed: ${err.message}`, tier: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Naive synthetic data generation
// ---------------------------------------------------------------------------

const SYNTHETIC_TYPE_GENERATORS = {
  integer: (i) => `${i}`,
  bigint: (i) => `${i}`,
  smallint: (i) => `${i % 32000}`,
  numeric: (i) => `${i}.${i % 100}`,
  real: (i) => `${i}.${i % 100}`,
  'double precision': (i) => `${i}.${i % 100}`,
  text: (i) => `'synth_${i}'`,
  'character varying': (i) => `'synth_${i}'`,
  varchar: (i) => `'synth_${i}'`,
  char: (i) => `'S'`,
  boolean: (i) => `${i % 2 === 0}`,
  date: (i) => `'2024-01-01'::date + ${i % 365}`,
  'timestamp without time zone': (i) => `'2024-01-01'::timestamp + interval '${i} seconds'`,
  'timestamp with time zone': (i) => `'2024-01-01'::timestamptz + interval '${i} seconds'`,
  uuid: (i) => `md5(${i}::text || 'synth')::uuid`,
  json: (i) => `'{"id": ${i}}'::json`,
  jsonb: (i) => `'{"id": ${i}}'::jsonb`,
};

function syntheticValueForType(typeName, rowIndex) {
  const lower = (typeName || '').toLowerCase().replace(/\(.*\)/, '').trim();
  const gen = SYNTHETIC_TYPE_GENERATORS[lower];
  if (gen) return gen(rowIndex);
  // Fallback: try text-like if contains 'char' or 'text'
  if (lower.includes('char') || lower.includes('text')) return `'synth_${rowIndex}'`;
  // Fallback: try numeric if contains 'int' or 'num'
  if (lower.includes('int') || lower.includes('num') || lower.includes('serial')) return `${rowIndex}`;
  return 'NULL';
}

/**
 * Topological sort for tables based on FK relationships.
 * Parents (referenced tables) come before children (referencing tables).
 * Tables in cycles are appended at the end.
 */
function topologicalSortTables(tables, fkRelations) {
  const graph = new Map();
  const inDegree = new Map();
  for (const t of tables) {
    graph.set(t, []);
    inDegree.set(t, 0);
  }
  for (const fk of fkRelations) {
    if (graph.has(fk.parentTable) && graph.has(fk.childTable) && fk.parentTable !== fk.childTable) {
      graph.get(fk.parentTable).push(fk.childTable);
      inDegree.set(fk.childTable, (inDegree.get(fk.childTable) || 0) + 1);
    }
  }
  const queue = tables.filter((t) => (inDegree.get(t) || 0) === 0);
  const sorted = [];
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);
    for (const child of (graph.get(node) || [])) {
      const newDeg = (inDegree.get(child) || 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }
  // Append any remaining tables (involved in FK cycles) at the end
  for (const t of tables) {
    if (!sorted.includes(t)) sorted.push(t);
  }
  return sorted;
}

async function loadSyntheticData(containerNameStr, config) {
  const scaleFactor = config.scaleFactor || DEFAULTS.scaleFactor;
  // Cap synthetic rows to prevent extremely long generation times
  const syntheticRows = Math.min(scaleFactor, 10000);

  // Introspect the schema in the harness container to find table columns and types
  let columns;
  try {
    const { stdout } = await execAsync(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A -c "SELECT table_schema || '.' || table_name || '|' || column_name || '|' || data_type || '|' || COALESCE(column_default, '') || '|' || is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position;"`,
      { encoding: 'utf-8', timeout: 30000 },
    );
    const colOutput = stdout.trim();
    columns = colOutput.split('\n').filter(Boolean).map((line) => {
      const [table, colName, dataType, colDefault, isNullable] = line.split('|');
      return { table, colName, dataType, colDefault: colDefault || '', isNullable };
    });
  } catch (err) {
    return { ok: false, message: `Tier 3 synthetic generation failed — could not introspect schema: ${err.message}`, tier: 'error' };
  }

  if (columns.length === 0) {
    return { ok: false, message: 'Tier 3 synthetic generation failed — no tables found in schema', tier: 'error' };
  }

  // Discover FK relationships for FK-consistent data generation
  let fkRelations = [];
  try {
    const { stdout } = await execAsync(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A -c "SELECT tc.table_schema || '.' || tc.table_name, kcu.column_name, ccu.table_schema || '.' || ccu.table_name, ccu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema WHERE tc.constraint_type = 'FOREIGN KEY';"`,
      { encoding: 'utf-8', timeout: 30000 },
    );
    const fkOutput = stdout.trim();
    if (fkOutput) {
      fkRelations = fkOutput.split('\n').filter(Boolean).map((line) => {
        const [childTable, childCol, parentTable, parentCol] = line.split('|');
        return { childTable, childCol, parentTable, parentCol };
      });
    }
  } catch {
    // FK discovery is best-effort — fall back to non-FK-aware generation
  }

  // Build FK lookup: "childTable.childCol" → { parentTable, parentCol }
  const fkLookup = new Map();
  for (const fk of fkRelations) {
    fkLookup.set(`${fk.childTable}.${fk.childCol}`, fk);
  }

  // Group columns by table
  const tableColumns = new Map();
  for (const col of columns) {
    if (!tableColumns.has(col.table)) tableColumns.set(col.table, []);
    tableColumns.get(col.table).push(col);
  }

  // Topologically sort tables so parents are populated before children
  const tableOrder = topologicalSortTables([...tableColumns.keys()], fkRelations);

  // Build synthetic INSERT statements.
  // Skip columns with serial/sequence defaults (auto-generated PKs).
  // For FK columns, generate values referencing the parent's PK range (1..syntheticRows).
  const insertSegments = [];
  insertSegments.push("SET session_replication_role = 'replica';");

  let generatedCount = 0;
  const hasFKRelations = fkRelations.length > 0;

  for (const tableName of tableOrder) {
    const cols = tableColumns.get(tableName);
    if (!cols) continue;

    // Filter out auto-generated columns (serial, nextval, generated always)
    const insertCols = cols.filter((c) => {
      const def = c.colDefault.toLowerCase();
      return !def.includes('nextval') && !def.includes('generated');
    });

    if (insertCols.length === 0) continue;

    const quotedTable = quoteIdent(tableName);
    const colNames = insertCols.map((c) => quoteIdent(c.colName)).join(', ');
    const batchSize = 100;

    for (let batch = 0; batch < syntheticRows; batch += batchSize) {
      const rows = [];
      const end = Math.min(batch + batchSize, syntheticRows);
      for (let i = batch; i < end; i++) {
        const values = insertCols.map((c) => {
          // Check if this column is a FK referencing another table
          const fk = fkLookup.get(`${tableName}.${c.colName}`);
          if (fk) {
            // Generate FK-consistent value: reference parent row IDs in range [1, syntheticRows]
            // Use modulo to wrap around if needed, +1 for 1-based IDs
            return `${(i % syntheticRows) + 1}`;
          }
          return syntheticValueForType(c.dataType, i + 1);
        });
        rows.push(`(${values.join(', ')})`);
      }
      insertSegments.push(`INSERT INTO ${quotedTable} (${colNames}) VALUES ${rows.join(', ')} ON CONFLICT DO NOTHING;`);
    }
    generatedCount++;
  }

  insertSegments.push("SET session_replication_role = 'origin';");
  insertSegments.push('ANALYZE;');

  if (generatedCount === 0) {
    return { ok: false, message: 'Tier 3 synthetic generation failed — could not generate data for any table', tier: 'error' };
  }

  // Execute in a single session.
  // Do NOT use ON_ERROR_STOP — partial failures (e.g., some ON CONFLICT skips) are expected.
  try {
    const script = insertSegments.join('\n');
    await execWithInput(
      `docker exec -i ${containerNameStr} psql -U harness -d harness`,
      script,
      { encoding: 'utf-8', timeout: 300000 },
    );
  } catch (err) {
    // Partial failures are expected with synthetic data — some unique constraints may fire
    const errMsg = err.stderr || err.message || '';
    if (errMsg.includes('server closed the connection') || errMsg.includes('could not connect')) {
      return { ok: false, message: `Tier 3 synthetic load session failed: ${errMsg}`, tier: 'error' };
    }
  }

  // Post-load validation: verify actual row counts
  const allTableNames = tableOrder.filter((t) => tableColumns.has(t));
  const actualRowCounts = await validateLoadedRowCounts(containerNameStr, allTableNames);
  const actualPopulated = Object.values(actualRowCounts).filter((count) => count > 0).length;

  if (actualPopulated === 0) {
    return { ok: false, message: 'Tier 3 synthetic generation failed — no tables have rows after load', tier: 'error' };
  }

  const fkNote = hasFKRelations
    ? `FK-consistent generation (${fkRelations.length} FK relationship(s) discovered). `
    : 'No FK relationships discovered — values are not referentially consistent. ';

  const warnings = [
    'Synthetic data does not reflect real data distributions',
    'Benchmark results are directional only — retest with production data before deploying',
  ];
  if (!hasFKRelations) {
    warnings.push('No FK relationships discovered — synthetic data may not satisfy join conditions');
  }

  return {
    ok: true,
    message: `Tier 3 (synthetic): ${actualPopulated}/${generatedCount} table(s) populated (~${syntheticRows} target rows each). ${fkNote}WARNING: Benchmark results should be treated as directional only.`,
    tier: 'synthetic',
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Truncate all user tables (for scale-up retry)
// ---------------------------------------------------------------------------

export async function truncateAllTables(containerNameStr) {
  const sql = `
    DO $$
    DECLARE r RECORD;
    BEGIN
      SET session_replication_role = 'replica';
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
      SET session_replication_role = 'origin';
    END $$;
  `;
  await execWithInput(
    `docker exec -i ${containerNameStr} psql -U harness -d harness`,
    sql,
    { encoding: 'utf-8', timeout: 30000 },
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function createSnapshot(containerNameStr, outputDir) {
  const snapshotPath = path.join(outputDir, `${containerNameStr}-snapshot.dump`);
  try {
    const { stdout: dump } = await execAsync(
      `docker exec ${containerNameStr} pg_dump -U harness -Fc harness`,
      { encoding: 'buffer', timeout: 120000 },
    );
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(snapshotPath, dump);
    return snapshotPath;
  } catch (err) {
    throw new Error(`Snapshot creation failed: ${err.message}`);
  }
}

export async function restoreSnapshot(containerNameStr, snapshotPath) {
  try {
    // Drop and recreate the database
    await execAsync(
      `docker exec ${containerNameStr} dropdb -U harness --if-exists harness`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    await execAsync(
      `docker exec ${containerNameStr} createdb -U harness harness`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    // Restore from snapshot
    const data = await fs.promises.readFile(snapshotPath);
    await execWithInput(
      `docker exec -i ${containerNameStr} pg_restore -U harness -d harness`,
      data,
      { encoding: null, timeout: 120000 },
    );
    return { ok: true, message: 'Snapshot restored' };
  } catch (err) {
    return { ok: false, message: `Snapshot restore failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Benchmark helpers
// ---------------------------------------------------------------------------

function extractPlanFromExplainOutput(output) {
  // psql outputs the JSON plan between lines — find the JSON array
  const lines = output.split('\n');
  let jsonStr = '';
  let capturing = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !capturing)) {
      capturing = true;
    }
    if (capturing) {
      jsonStr += trimmed;
      // Try to parse — if valid we're done
      try {
        const parsed = JSON.parse(jsonStr);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // keep accumulating
      }
    }
  }
  return null;
}

function extractPlanNodes(planNode, collected = []) {
  if (!planNode) return collected;
  if (planNode['Node Type']) {
    collected.push(planNode['Node Type']);
  }
  if (planNode.Plans && Array.isArray(planNode.Plans)) {
    for (const child of planNode.Plans) {
      extractPlanNodes(child, collected);
    }
  }
  return collected;
}

function computeMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeP95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeCV(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  return (stdDev / mean) * 100;
}

function simpleStringHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function planStructureString(planNode) {
  if (!planNode) return '';
  let result = planNode['Node Type'] || '?';
  if (planNode.Plans && Array.isArray(planNode.Plans)) {
    const children = planNode.Plans.map(planStructureString).join(',');
    result += `(${children})`;
  }
  return result;
}

function hashPlanStructure(plan) {
  const rootPlan = Array.isArray(plan) ? plan[0]?.Plan : plan?.Plan || plan;
  return simpleStringHash(planStructureString(rootPlan));
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

export async function runBenchmark(containerNameStr, query, config) {
  const warmupRuns = config.warmupRuns ?? DEFAULTS.warmupRuns;
  const trials = config.benchmarkTrials ?? DEFAULTS.benchmarkTrials;
  const cleanQuery = sanitizeSQL(query);
  const explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${cleanQuery}`;

  // Warmup runs — discard results
  for (let i = 0; i < warmupRuns; i++) {
    try {
      await execWithInput(
        `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
        explainQuery,
        { encoding: 'utf-8', timeout: 60000 },
      );
    } catch {
      // warmup failures are non-fatal
    }
  }

  // Benchmark trials
  const timings = [];
  let lastPlan = null;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;

  for (let i = 0; i < trials; i++) {
    try {
      const { stdout: output } = await execWithInput(
        `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
        explainQuery,
        { encoding: 'utf-8', timeout: 60000 },
      );

      const plan = extractPlanFromExplainOutput(output);
      if (plan && plan[0]) {
        lastPlan = plan;
        const root = plan[0].Plan || plan[0];
        const execTimeMs = root['Actual Total Time'] ?? root['Execution Time'] ?? 0;
        timings.push(execTimeMs);

        sharedHitBlocks = root['Shared Hit Blocks'] ?? sharedHitBlocks;
        sharedReadBlocks = root['Shared Read Blocks'] ?? sharedReadBlocks;
      }
    } catch {
      // trial failure — skip this data point
    }
  }

  if (timings.length === 0) {
    throw new Error('All benchmark trials failed — no timing data collected');
  }

  const rootPlan = lastPlan?.[0]?.Plan || lastPlan?.[0] || {};
  const allNodes = extractPlanNodes(rootPlan);
  const leafAccessNodes = allNodes.filter((n) => LEAF_ACCESS_NODE_TYPES.includes(n));

  return {
    medianMs: computeMedian(timings),
    p95Ms: computeP95(timings),
    cvPct: computeCV(timings),
    planNodes: allNodes,
    leafAccessNodes,
    planNodeSet: [...new Set(allNodes)],
    planStructureHash: hashPlanStructure(lastPlan),
    sharedHitBlocks,
    sharedReadBlocks,
    trials: timings,
  };
}

// ---------------------------------------------------------------------------
// Parity check
// ---------------------------------------------------------------------------

export async function checkParity(containerNameStr, originalQuery, rewrittenQuery) {
  const orig = sanitizeSQL(originalQuery);
  const rewritten = sanitizeSQL(rewrittenQuery);

  const paritySQL = `
    SELECT COUNT(*) AS diff_count FROM (
      (${orig} EXCEPT ALL ${rewritten})
      UNION ALL
      (${rewritten} EXCEPT ALL ${orig})
    ) AS __parity_check;
  `;

  try {
    const { stdout: result } = await execWithInput(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
      paritySQL,
      { encoding: 'utf-8', timeout: 30000 },
    );
    const count = parseInt(result.trim(), 10) || 0;
    return { ok: count === 0, differingRows: count };
  } catch (err) {
    return { ok: false, differingRows: -1, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Index size
// ---------------------------------------------------------------------------

export async function getIndexSize(containerNameStr, indexName) {
  const sql = `SELECT pg_relation_size('${indexName}')`;
  try {
    const { stdout: result } = await execWithInput(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
      sql,
      { encoding: 'utf-8', timeout: 10000 },
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function teardown(roomId) {
  const cName = containerName(roomId);
  const nName = networkName(roomId);
  try {
    await execAsync(`docker rm -f ${cName}`, { encoding: 'utf-8', timeout: 15000 });
  } catch {
    // container may not exist
  }
  try {
    await execAsync(`docker network rm ${nName}`, { encoding: 'utf-8', timeout: 15000 });
  } catch {
    // network may not exist
  }
}

/**
 * Remove ALL pqo-harness containers and pqo-net networks, regardless of
 * room ID. Prevents stale containers from accumulating across runs.
 */
export async function teardownAll() {
  try {
    const { stdout: containers } = await execAsync(
      'docker ps -aq --filter "name=pqo-harness-"',
      { encoding: 'utf-8', timeout: 10000 },
    );
    const ids = containers.trim().split('\n').filter(Boolean);
    if (ids.length > 0) {
      await execAsync(`docker rm -f ${ids.join(' ')}`, { encoding: 'utf-8', timeout: 30000 });
    }
  } catch {
    // ignore
  }
  try {
    const { stdout: networks } = await execAsync(
      'docker network ls -q --filter "name=pqo-net-"',
      { encoding: 'utf-8', timeout: 10000 },
    );
    const ids = networks.trim().split('\n').filter(Boolean);
    if (ids.length > 0) {
      await execAsync(`docker network rm ${ids.join(' ')}`, { encoding: 'utf-8', timeout: 15000 });
    }
  } catch {
    // ignore
  }
  // Prune dangling volumes left by prior containers (anonymous PG data volumes)
  try {
    await execAsync('docker volume prune -f', { encoding: 'utf-8', timeout: 30000 });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Demo asset loader
// ---------------------------------------------------------------------------

export async function loadDemoAssets() {
  const schemaSQL = await fs.promises.readFile(path.join(ASSETS_DIR, 'schema.sql'), 'utf-8');
  const querySQL = await fs.promises.readFile(path.join(ASSETS_DIR, 'query.sql'), 'utf-8');

  const gzPath = path.join(ASSETS_DIR, 'data.sql.gz');
  const plainPath = path.join(ASSETS_DIR, 'data.sql');
  const hasGz = await fs.promises.stat(gzPath).then((stat) => stat.isFile()).catch(() => false);
  const hasPlain = hasGz
    ? false
    : await fs.promises.stat(plainPath).then((stat) => stat.isFile()).catch(() => false);
  const dataPath = hasGz ? gzPath : hasPlain ? plainPath : null;

  return { schemaSQL, querySQL, dataPath };
}
