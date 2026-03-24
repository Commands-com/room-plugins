#!/usr/bin/env node

/**
 * Room Author Development Harness
 *
 * Runs a room plugin end-to-end locally. Agent responses come from Ollama (live)
 * or recorded fixtures (replay). Not a product runtime — a developer tool for
 * testing engines and prompts.
 *
 * Usage:
 *   node scripts/dev-runner.js <plugin-dir> [options]
 *
 * Examples:
 *   # Live mode — Ollama answers for every agent
 *   node scripts/dev-runner.js room-plugins/postgres-query-optimizer \
 *     --config dev-config.json --model llama3.2
 *
 *   # Record a live run as fixtures
 *   node scripts/dev-runner.js room-plugins/postgres-query-optimizer \
 *     --config dev-config.json --record fixtures/pg-demo-1
 *
 *   # Replay recorded fixtures (no Ollama, deterministic)
 *   node scripts/dev-runner.js room-plugins/postgres-query-optimizer \
 *     --replay fixtures/pg-demo-1
 *
 * Replay mode supports both fan-out fixtures (000-*.json, 001-*.json, ...)
 * and invokeLLM fixtures (llm-000-*.json, llm-001-*.json, ...).
 *
 * Config file (JSON):
 *   {
 *     "objective": "Optimize the slow query",
 *     "roomConfig": { "demoMode": true },
 *     "orchestratorConfig": { "plannedCandidatesPerCycle": 2 }
 *   }
 *
 * Options:
 *   --live                 Use Ollama for agent responses (default)
 *   --replay <dir>         Replay recorded fixtures
 *   --record <dir>         Record live responses as fixtures
 *   --model <name>         Ollama model (default: llama3.2)
 *   --ollama-url <url>     Ollama base URL (default: http://localhost:11434)
 *   --config <file>        JSON config file
 *   --max-rounds <n>       Safety limit on fan-out rounds (default: 50)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const pluginDir = rawArgs[0];

if (!pluginDir || pluginDir.startsWith('--')) {
  console.error(
    `Usage: node scripts/dev-runner.js <plugin-dir> [options]\n`
    + `Run with --help or see file header for details.`,
  );
  process.exit(1);
}

function parseFlags(argv) {
  const f = {
    mode: 'live',
    replayDir: null,
    recordDir: null,
    model: 'llama3.2',
    ollamaUrl: 'http://localhost:11434',
    configFile: null,
    maxRounds: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live':       f.mode = 'live'; break;
      case '--replay':     f.mode = 'replay'; f.replayDir = argv[++i]; break;
      case '--record':     f.recordDir = argv[++i]; break;
      case '--model':      f.model = argv[++i]; break;
      case '--ollama-url': f.ollamaUrl = argv[++i]; break;
      case '--config':     f.configFile = argv[++i]; break;
      case '--max-rounds': f.maxRounds = parseInt(argv[++i], 10) || 50; break;
    }
  }
  return f;
}

const flags = parseFlags(rawArgs.slice(1));

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const transcript = [];

function log(msg) {
  transcript.push(msg);
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Plugin loader
// ---------------------------------------------------------------------------

async function loadPlugin(dir) {
  const absDir = resolve(dir);
  const manifestPath = join(absDir, 'manifest.json');
  const indexPath = join(absDir, 'index.js');

  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${absDir}`);
  if (!existsSync(indexPath)) throw new Error(`No index.js in ${absDir}`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const mod = await import(pathToFileURL(indexPath).href);
  const createPlugin = mod.createPlugin || mod.default?.createPlugin;

  if (typeof createPlugin !== 'function') {
    throw new Error(`Plugin at ${absDir} does not export createPlugin()`);
  }

  return { manifest, createPlugin };
}

// ---------------------------------------------------------------------------
// Mock participants
// ---------------------------------------------------------------------------

function buildParticipants(roles) {
  const participants = [];
  const required = roles?.required || ['worker'];
  const minCount = roles?.minCount || {};

  for (const role of required) {
    const count = minCount[role] || 1;
    for (let i = 0; i < count; i++) {
      const id = `${role}_${i + 1}`;
      participants.push({
        agentId: id,
        displayName: `${role.charAt(0).toUpperCase() + role.slice(1)} ${i + 1}`,
        role,
        endpoint: 'dev-harness',
        profile: { id, name: `Dev ${role} ${i + 1}`, provider: 'ollama', model: flags.model },
      });
    }
  }

  return participants;
}

// ---------------------------------------------------------------------------
// Mock context
// ---------------------------------------------------------------------------

function createMockCtx(manifest, userConfig) {
  let state = null;
  let cycle = 0;
  let turnIndex = 0;
  let llmCallIndex = 0;
  let activeFanOut = null;
  const participants = buildParticipants(manifest.roles);

  // Flatten manifest limits: { maxCycles: { default: 4 } } → { maxCycles: 4 }
  const limits = {};
  for (const [key, spec] of Object.entries(manifest.limits || {})) {
    limits[key] = (typeof spec === 'object' && spec !== null) ? (spec.default ?? spec) : spec;
  }

  return {
    roomId: `dev_${Date.now()}`,
    objective: userConfig.objective || 'Development harness run',
    participants,
    limits,
    llmConfig: {},
    orchestratorConfig: userConfig.orchestratorConfig || {},
    roomConfig: userConfig.roomConfig || {},
    syncState: {},
    mode: 'auto',
    get cycle() { return cycle; },
    get turnIndex() { return turnIndex; },
    set turnIndex(n) { turnIndex = n; },

    getState() {
      return state != null ? JSON.parse(JSON.stringify(state)) : null;
    },
    setState(s) {
      state = s != null ? JSON.parse(JSON.stringify(s)) : null;
    },
    setCycle(n) { cycle = n; },
    emitMetrics(metrics) {
      for (const [key, val] of Object.entries(metrics)) {
        if (val?.type === 'phase') {
          log(`  [phase] ${val.value}`);
        } else if (val?.type === 'text') {
          log(`  [metric] ${key}: ${val.value}`);
        } else {
          const display = typeof val === 'object' ? JSON.stringify(val).slice(0, 200) : val;
          log(`  [metric] ${key}: ${display}`);
        }
      }
    },
    getFinalReport() { return {}; },
    getParticipant(agentId) {
      return participants.find((p) => p.agentId === agentId) || null;
    },
    getParticipantsByRole(role) {
      return participants.filter((p) => p.role === role);
    },
    getRoleCounts() {
      const counts = {};
      for (const p of participants) counts[p.role] = (counts[p.role] || 0) + 1;
      return counts;
    },
    getActiveFanOut() {
      return activeFanOut != null ? JSON.parse(JSON.stringify(activeFanOut)) : null;
    },
    getRoles() { return [...new Set(participants.map((p) => p.role))]; },
    async invokeLLM(prompt, options = {}) {
      const currentCall = llmCallIndex++;
      const label = options?.purpose || `llm-${currentCall}`;

      if (flags.mode === 'replay') {
        const fixture = loadLlmFixture(flags.replayDir, currentCall);
        if (!fixture) {
          return {
            ok: false,
            error: `No LLM fixture for call ${currentCall} in ${flags.replayDir}`,
          };
        }
        log(`  [llm replay] ${fixture.label || label}`);
        if (fixture.ok === false) {
          return {
            ok: false,
            error: fixture.error || `llm_fixture_${currentCall}_failed`,
          };
        }
        let data = fixture.data;
        if (data === undefined && options?.responseFormat?.type === 'json_schema') {
          try {
            data = JSON.parse(fixture.text || '');
          } catch (err) {
            return {
              ok: false,
              error: { code: 'invalid_json', message: err.message },
              text: fixture.text || '',
              usage: fixture.usage || { input_tokens: 0, output_tokens: 0 },
            };
          }
        }
        return {
          ok: true,
          text: fixture.text || '',
          data,
          usage: fixture.usage || { input_tokens: 0, output_tokens: 0 },
        };
      }

      try {
        const text = await callOllama(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        const result = { ok: true, text, usage: { input_tokens: 0, output_tokens: 0 } };
        if (options?.responseFormat?.type === 'json_schema') {
          try {
            result.data = JSON.parse(text);
          } catch (err) {
            return {
              ok: false,
              error: { code: 'invalid_json', message: err.message },
              text,
              usage: result.usage,
            };
          }
        }
        if (flags.recordDir) {
          saveLlmFixture(flags.recordDir, currentCall, label, {
            text,
            data: result.data,
            usage: result.usage,
          });
          log(`  Saved LLM fixture ${currentCall} to ${flags.recordDir}/`);
        }
        return result;
      } catch (err) {
        return { ok: false, error: { code: 'llm_error', message: err.message } };
      }
    },
    _setActiveFanOut(snapshot) {
      activeFanOut = snapshot != null ? JSON.parse(JSON.stringify(snapshot)) : null;
    },
    _clearActiveFanOut() {
      activeFanOut = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function callOllama(prompt) {
  const resp = await fetch(`${flags.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: flags.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Ollama ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data.message?.content || '';
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function loadFixture(dir, roundIndex) {
  const padded = String(roundIndex).padStart(3, '0');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(padded) && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
}

function saveFixture(dir, roundIndex, label, responses) {
  mkdirSync(dir, { recursive: true });
  const padded = String(roundIndex).padStart(3, '0');
  const safeName = label.replace(/[^a-z0-9_-]/gi, '_');
  writeFileSync(
    join(dir, `${padded}-${safeName}.json`),
    JSON.stringify({ label, responses }, null, 2),
  );
}

function loadLlmFixture(dir, llmIndex) {
  const padded = String(llmIndex).padStart(3, '0');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`llm-${padded}`) && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
}

function saveLlmFixture(dir, llmIndex, label, result) {
  mkdirSync(dir, { recursive: true });
  const padded = String(llmIndex).padStart(3, '0');
  const safeName = label.replace(/[^a-z0-9_-]/gi, '_');
  writeFileSync(
    join(dir, `llm-${padded}-${safeName}.json`),
    JSON.stringify({ label, ...result }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Resolve fan-out targets → responses
// ---------------------------------------------------------------------------

function resolveRoleTargets(targets, participants) {
  // Expand role-based targets to agentId-based targets
  const resolved = [];
  for (const t of targets) {
    if (t.agentId) {
      resolved.push(t);
    } else if (t.role) {
      for (const p of participants.filter((p) => p.role === t.role)) {
        resolved.push({ agentId: p.agentId, message: t.message });
      }
    }
  }
  return resolved;
}

async function resolveTargets(targets, roundIndex, label, participants) {
  const expanded = resolveRoleTargets(targets, participants);

  if (flags.mode === 'replay') {
    const fixture = loadFixture(flags.replayDir, roundIndex);
    if (!fixture) {
      throw new Error(`No fixture for round ${roundIndex} in ${flags.replayDir}`);
    }
    log(`  Replaying ${fixture.responses.length} response(s) from fixture`);
    return fixture.responses;
  }

  // Live: call Ollama for each target
  const responses = [];
  for (const target of expanded) {
    log(`  -> ${target.agentId}: sending ${target.message.length} chars to Ollama (${flags.model})...`);
    const start = Date.now();
    const text = await callOllama(target.message);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`  <- ${target.agentId}: ${text.length} chars in ${elapsed}s`);

    responses.push({
      agentId: target.agentId,
      response: text,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  if (flags.recordDir) {
    saveFixture(flags.recordDir, roundIndex, label, responses);
    log(`  Saved fixture to ${flags.recordDir}/`);
  }

  return responses;
}

function buildActiveFanOutSnapshot(targets, participants, metadata = {}) {
  const expanded = resolveRoleTargets(targets, participants);
  return {
    id: `fanout_${Date.now()}`,
    startedAt: Date.now(),
    metadata,
    targets: expanded.map((target) => {
      const participant = participants.find((p) => p.agentId === target.agentId);
      return {
        agentId: target.agentId,
        role: participant?.role || 'unknown',
        displayName: participant?.displayName || target.agentId,
        message: target.message,
      };
    }),
    completedAgentIds: [],
    pendingAgentIds: expanded.map((target) => target.agentId),
    disconnectedAgentIds: [],
    partials: {},
  };
}

// ---------------------------------------------------------------------------
// Decision logging
// ---------------------------------------------------------------------------

function logDecision(decision) {
  if (!decision) { log('  Decision: null'); return; }

  switch (decision.type) {
    case 'fan_out':
      log(`  Decision: fan_out -> ${decision.targets?.length || 0} target(s)`);
      for (const t of (decision.targets || [])) {
        log(`    ${t.agentId || t.role}: ${(t.message || '').length} chars`);
      }
      break;
    case 'speak':
      log(`  Decision: speak -> ${decision.agentId} (${(decision.message || '').length} chars)`);
      break;
    case 'stop':
      log(`  Decision: stop (${decision.reason})`);
      break;
    case 'pause':
      log(`  Decision: pause (${decision.reason || ''})`);
      break;
    case 'continue_fan_out':
      log('  Decision: continue_fan_out');
      break;
    default:
      log(`  Decision: ${JSON.stringify(decision).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function run() {
  const startTime = Date.now();
  log('=== Room Dev Harness ===');
  log(`Plugin:  ${resolve(pluginDir)}`);
  log(`Mode:    ${flags.mode}${flags.mode === 'live' ? ` (ollama ${flags.model})` : ` (${flags.replayDir})`}`);
  if (flags.recordDir) log(`Record:  ${flags.recordDir}`);
  log('');

  // Load config
  let userConfig = {};
  if (flags.configFile) {
    userConfig = JSON.parse(readFileSync(resolve(flags.configFile), 'utf8'));
    log(`Config:  ${resolve(flags.configFile)}`);
  }

  // Load plugin
  const { manifest, createPlugin } = await loadPlugin(pluginDir);
  log(`Room:    ${manifest.name || manifest.id}`);
  log(`Roles:   ${(manifest.roles?.required || []).join(', ')}`);

  const plugin = createPlugin();
  const ctx = createMockCtx(manifest, userConfig);
  log(`Agents:  ${ctx.participants.map((p) => `${p.agentId} (${p.role})`).join(', ')}`);
  log('');

  // Init
  if (typeof plugin.init === 'function') {
    log('--- init ---');
    plugin.init(ctx);
  }

  // onRoomStart
  log('--- onRoomStart ---');
  let decision;
  try {
    decision = await plugin.onRoomStart(ctx);
  } catch (err) {
    log(`  onRoomStart error: ${err.message}`);
    decision = { type: 'stop', reason: `onRoomStart_error: ${err.message}` };
  }
  logDecision(decision);

  // Fan-out loop
  let round = 0;
  while (round < flags.maxRounds) {
    if (!decision || decision.type === 'stop' || decision.type === 'pause') break;

    if (decision.type === 'fan_out') {
      const targets = decision.targets || [];
      const state = ctx.getState();
      const label = state?.pendingFanOut || `round-${round}`;
      ctx._setActiveFanOut(buildActiveFanOutSnapshot(targets, ctx.participants, decision.metadata || {}));

      log(`\n--- Fan-out ${round} (${label}) -> ${targets.length} target(s) ---`);
      const responses = await resolveTargets(targets, round, label, ctx.participants);
      const active = ctx.getActiveFanOut();
      if (active) {
        const completedAgentIds = responses.map((response) => response.agentId);
        const partials = { ...active.partials };
        for (const response of responses) {
          partials[response.agentId] = {
            response: response.response,
            responseLength: response.response.length,
            updatedAt: Date.now(),
          };
        }
        ctx._setActiveFanOut({
          ...active,
          completedAgentIds,
          pendingAgentIds: active.pendingAgentIds.filter((agentId) => !completedAgentIds.includes(agentId)),
          partials,
        });
      }

      ctx.turnIndex++;
      try {
        decision = await plugin.onFanOutComplete(ctx, responses);
      } catch (err) {
        log(`  onFanOutComplete error: ${err.message}`);
        decision = { type: 'stop', reason: `hook_error: ${err.message}` };
      }
      ctx._clearActiveFanOut();
      logDecision(decision);
      round++;

    } else if (decision.type === 'continue_fan_out') {
      const active = ctx.getActiveFanOut();
      if (!active || !Array.isArray(active.pendingAgentIds) || active.pendingAgentIds.length === 0) {
        log('  No active pending fan-out to continue.');
        break;
      }

      const targets = active.targets
        .filter((target) => active.pendingAgentIds.includes(target.agentId))
        .map((target) => ({ agentId: target.agentId, message: target.message }));

      log(`\n--- Continue Fan-out ${round} (${active.metadata?.label || 'resume'}) -> ${targets.length} pending target(s) ---`);
      const responses = await resolveTargets(
        targets,
        round,
        active.metadata?.label || `continue-${round}`,
        ctx.participants,
      );

      const completedAgentIds = [...new Set([
        ...active.completedAgentIds,
        ...responses.map((response) => response.agentId),
      ])];
      const partials = { ...active.partials };
      for (const response of responses) {
        partials[response.agentId] = {
          response: response.response,
          responseLength: response.response.length,
          updatedAt: Date.now(),
        };
      }
      ctx._setActiveFanOut({
        ...active,
        completedAgentIds,
        pendingAgentIds: active.pendingAgentIds.filter((agentId) => !responses.some((response) => response.agentId === agentId)),
        partials,
      });

      ctx.turnIndex++;
      try {
        decision = await plugin.onFanOutComplete(ctx, responses);
      } catch (err) {
        log(`  onFanOutComplete error: ${err.message}`);
        decision = { type: 'stop', reason: `hook_error: ${err.message}` };
      }
      ctx._clearActiveFanOut();
      logDecision(decision);
      round++;

    } else if (decision.type === 'speak') {
      log(`\n--- Speak -> ${decision.agentId} ---`);
      const responses = await resolveTargets(
        [{ agentId: decision.agentId, message: decision.message }],
        round, 'speak', ctx.participants,
      );
      ctx.turnIndex++;
      try {
        decision = await plugin.onTurnResult(ctx, responses[0]);
      } catch (err) {
        log(`  onTurnResult error: ${err.message}`);
        decision = { type: 'stop', reason: `hook_error: ${err.message}` };
      }
      logDecision(decision);
      round++;

    } else {
      log(`  Unknown decision type: ${decision.type}`);
      break;
    }
  }

  if (round >= flags.maxRounds) {
    log(`\nSafety limit reached (${flags.maxRounds} rounds)`);
  }

  // Shutdown
  log('\n--- shutdown ---');
  try {
    if (typeof plugin.shutdown === 'function') await plugin.shutdown(ctx);
    log('  Clean shutdown');
  } catch (err) {
    log(`  Shutdown error: ${err.message}`);
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const state = ctx.getState();
  log('\n=== Complete ===');
  log(`Stop reason:  ${decision?.reason || decision?.type || 'unknown'}`);
  log(`Rounds:       ${round}`);
  log(`Final phase:  ${state?.phase || 'unknown'}`);
  log(`Duration:     ${elapsed}s`);

  // Write transcript if recording
  if (flags.recordDir) {
    mkdirSync(flags.recordDir, { recursive: true });
    writeFileSync(
      join(flags.recordDir, 'transcript.txt'),
      transcript.join('\n') + '\n',
    );
    log(`Transcript:   ${flags.recordDir}/transcript.txt`);
  }
}

run().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
