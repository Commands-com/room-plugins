import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_GUCS, DEFAULTS, LEAF_ACCESS_NODE_TYPES } from './constants.js';
import { containerName, networkName, sanitizeSQL } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets', 'demo');

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

export function checkDockerAvailability() {
  try {
    execSync('docker info', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message || 'Docker is not available' };
  }
}

// ---------------------------------------------------------------------------
// Network management
// ---------------------------------------------------------------------------

export function createNetwork(roomId) {
  const name = networkName(roomId);
  try {
    execSync(`docker network create --internal ${name}`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
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

export function startContainer(roomId, config) {
  const containerNameStr = containerName(roomId);
  const netName = networkName(roomId);
  const image = `postgres:${config.postgresVersion || DEFAULTS.postgresVersion}-alpine`;

  // Remove existing container if present
  try {
    execSync(`docker rm -f ${containerNameStr}`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch {
    // container didn't exist — fine
  }

  const gucFlags = BENCHMARK_GUCS.map((guc) => `-c ${guc}`).join(' ');

  const cmd = [
    'docker run -d',
    `--name ${containerNameStr}`,
    `--network ${netName}`,
    '-p 0:5432',
    `--memory ${config.containerMemory || DEFAULTS.containerMemory}`,
    `--cpus ${config.containerCpus || DEFAULTS.containerCpus}`,
    '-e POSTGRES_USER=harness',
    '-e POSTGRES_PASSWORD=harness',
    '-e POSTGRES_DB=harness',
    image,
    gucFlags,
  ].join(' ');

  const containerId = execSync(cmd, {
    encoding: 'utf-8',
    timeout: 30000,
    stdio: 'pipe',
  }).trim();

  const port = getContainerPort(containerNameStr);

  return { containerId, containerNameStr, port };
}

// ---------------------------------------------------------------------------
// Readiness polling
// ---------------------------------------------------------------------------

export function waitForReady(containerNameStr, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(
        `docker exec ${containerNameStr} pg_isready -U harness`,
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' },
      );
      return true;
    } catch {
      // not ready yet — sleep briefly and retry
      execSync('sleep 0.5', { timeout: 2000 });
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Port & connection helpers
// ---------------------------------------------------------------------------

export function getContainerPort(containerNameStr) {
  try {
    const output = execSync(`docker port ${containerNameStr} 5432`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
    // Output looks like "0.0.0.0:32768" or ":::32768" — grab the last part
    const match = output.match(/:(\d+)\s*$/);
    return match ? match[1] : output;
  } catch (err) {
    throw new Error(`Failed to get port for ${containerNameStr}: ${err.message}`);
  }
}

export function getConnectionString(containerNameStr) {
  const port = getContainerPort(containerNameStr);
  return `postgres://harness:harness@localhost:${port}/harness`;
}

// ---------------------------------------------------------------------------
// SQL execution
// ---------------------------------------------------------------------------

export function execSQL(containerNameStr, sql, timeoutMs = 30000) {
  const escaped = sanitizeSQL(sql).replace(/"/g, '\\"');
  const cmd = `docker exec -i ${containerNameStr} psql -U harness -d harness -c "${escaped}"`;
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`SQL execution failed: ${err.stderr || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

export function loadSchema(containerNameStr, config) {
  try {
    switch (config.schemaSource) {
      case 'dump': {
        const schemaSql = fs.readFileSync(config.schemaPath, 'utf-8');
        execSync(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          { input: schemaSql, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { ok: true, message: 'Schema loaded from dump file' };
      }
      case 'demo': {
        const demoSchema = fs.readFileSync(path.join(ASSETS_DIR, 'schema.sql'), 'utf-8');
        execSync(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          { input: demoSchema, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { ok: true, message: 'Demo schema loaded' };
      }
      case 'introspect': {
        const dump = execSync(
          `pg_dump --schema-only "${config.dbUrl}"`,
          { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        execSync(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          { input: dump, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { ok: true, message: 'Schema introspected and loaded' };
      }
      case 'migrations': {
        const migrationDir = config.schemaPath;
        const files = fs.readdirSync(migrationDir)
          .filter((f) => f.endsWith('.sql'))
          .sort();
        for (const file of files) {
          const sql = fs.readFileSync(path.join(migrationDir, file), 'utf-8');
          execSync(
            `docker exec -i ${containerNameStr} psql -U harness -d harness`,
            { input: sql, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
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
// Data loading
// ---------------------------------------------------------------------------

export function loadData(containerNameStr, config) {
  try {
    // Demo mode — check for compressed or plain data file
    const gzPath = path.join(ASSETS_DIR, 'data.sql.gz');
    const plainPath = path.join(ASSETS_DIR, 'data.sql');

    if (config.schemaSource === 'demo') {
      if (fs.existsSync(gzPath)) {
        execSync(
          `gunzip -c "${gzPath}" | docker exec -i ${containerNameStr} psql -U harness -d harness`,
          { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' },
        );
        return { ok: true, message: 'Demo data loaded (gzipped)', tier: 'demo' };
      }
      if (fs.existsSync(plainPath)) {
        const data = fs.readFileSync(plainPath, 'utf-8');
        execSync(
          `docker exec -i ${containerNameStr} psql -U harness -d harness`,
          { input: data, encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { ok: true, message: 'Demo data loaded', tier: 'demo' };
      }
      return { ok: true, message: 'No demo data file found — skipping', tier: 'demo' };
    }

    // Seed data path provided
    if (config.seedDataPath) {
      const seed = fs.readFileSync(config.seedDataPath, 'utf-8');
      execSync(
        `docker exec -i ${containerNameStr} psql -U harness -d harness`,
        { input: seed, encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return { ok: true, message: 'Seed data loaded', tier: 'seed' };
    }

    // Tier 3 synthetic — not implemented in v1
    return { ok: true, message: 'No data source configured — skipping', tier: 'none' };
  } catch (err) {
    return { ok: false, message: `Data loading failed: ${err.message}`, tier: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export function createSnapshot(containerNameStr, outputDir) {
  const snapshotPath = path.join(outputDir, `${containerNameStr}-snapshot.dump`);
  try {
    const dump = execSync(
      `docker exec ${containerNameStr} pg_dump -U harness -Fc harness`,
      { encoding: 'buffer', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(snapshotPath, dump);
    return snapshotPath;
  } catch (err) {
    throw new Error(`Snapshot creation failed: ${err.message}`);
  }
}

export function restoreSnapshot(containerNameStr, snapshotPath) {
  try {
    // Drop and recreate the database
    execSync(
      `docker exec ${containerNameStr} dropdb -U harness --if-exists harness`,
      { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' },
    );
    execSync(
      `docker exec ${containerNameStr} createdb -U harness harness`,
      { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' },
    );

    // Restore from snapshot
    const data = fs.readFileSync(snapshotPath);
    execSync(
      `docker exec -i ${containerNameStr} pg_restore -U harness -d harness`,
      { input: data, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] },
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

export function runBenchmark(containerNameStr, query, config) {
  const warmupRuns = config.warmupRuns ?? DEFAULTS.warmupRuns;
  const trials = config.benchmarkTrials ?? DEFAULTS.benchmarkTrials;
  const cleanQuery = sanitizeSQL(query);
  const explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${cleanQuery}`;

  // Warmup runs — discard results
  for (let i = 0; i < warmupRuns; i++) {
    try {
      execSync(
        `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
        { input: explainQuery, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
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
      const output = execSync(
        `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
        { input: explainQuery, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
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

export function checkParity(containerNameStr, originalQuery, rewrittenQuery) {
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
    const result = execSync(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
      { input: paritySQL, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
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

export function getIndexSize(containerNameStr, indexName) {
  const sql = `SELECT pg_relation_size('${indexName}')`;
  try {
    const result = execSync(
      `docker exec -i ${containerNameStr} psql -U harness -d harness -t -A`,
      { input: sql, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(roomId) {
  const cName = containerName(roomId);
  const nName = networkName(roomId);
  try {
    execSync(`docker rm -f ${cName}`, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
  } catch {
    // container may not exist
  }
  try {
    execSync(`docker network rm ${nName}`, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
  } catch {
    // network may not exist
  }
}

// ---------------------------------------------------------------------------
// Demo asset loader
// ---------------------------------------------------------------------------

export function loadDemoAssets() {
  const schemaSQL = fs.readFileSync(path.join(ASSETS_DIR, 'schema.sql'), 'utf-8');
  const querySQL = fs.readFileSync(path.join(ASSETS_DIR, 'query.sql'), 'utf-8');

  const gzPath = path.join(ASSETS_DIR, 'data.sql.gz');
  const plainPath = path.join(ASSETS_DIR, 'data.sql');
  const dataPath = fs.existsSync(gzPath) ? gzPath : fs.existsSync(plainPath) ? plainPath : null;

  return { schemaSQL, querySQL, dataPath };
}
