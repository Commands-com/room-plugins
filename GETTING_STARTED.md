# Getting Started: Build a High-Quality Room Plugin

This guide is for Commands Desktop users who want to build a production-grade room plugin.

## Prerequisites

Before you begin, ensure the following tools are installed:

- **Node.js** >= 18 (required to run hash/allowlist scripts and install plugin dependencies)
- **npm** (bundled with Node.js)
- **rsync** (used by the install script to sync plugin files)
- **bash** (the install script uses `bash` with `set -euo pipefail`)

## 1. Clone and Install

```bash
git clone https://github.com/Commands-com/room-plugins.git
cd room-plugins
./scripts/install-room-plugins.sh
```

Restart Commands Desktop after install.

## 2. Confirm the Reference Plugin Works

In the app:

1. Create a room.
2. Choose `template_room` as the room type.
3. Add at least one worker participant.
4. Use objective text like: `Reply with one sentence saying your name`.

Expected result: one fan-out cycle runs, then the room stops with a summary similar to:

`template_room completed one fan-out cycle (N responses)`

## 3. Create Your Plugin

### Option A: Classic (imperative)

```bash
cp -R ./room-plugins/template-room ./room-plugins/my-room
```

Update both files:

- `./room-plugins/my-room/manifest.json`
- `./room-plugins/my-room/index.js`

Keep `manifest.json` and the exported `manifest` in `index.js` exactly aligned.

### Option B: Declarative (family-based)

For rooms that follow an established pattern like empirical search:

```bash
cp -R ./room-plugins/redshift-query-optimizer ./room-plugins/my-optimizer
```

Update:

- `room.yaml` — room definition (phases, dispatch, dashboard, family config)
- `lib/engine.js` — domain-specific logic
- `lib/harness.js` — environment interaction

See [`docs/DECLARATIVE_ROOMS.md`](./docs/DECLARATIVE_ROOMS.md) for the full reference.

## 4. Reinstall and Reload

```bash
./scripts/install-room-plugins.sh
```

Then restart Commands Desktop.
For faster iteration on one room, install just that plugin:

```bash
./scripts/install-room-plugins.sh --plugin my-room
```

## 5. Test Locally with the Dev Harness

Before installing to Commands Desktop, you can run your plugin end-to-end locally using the dev harness. It drives the full plugin lifecycle (init → onRoomStart → fan-out loop → shutdown) with agent responses provided by Ollama or recorded fixtures.

**Prerequisites:** [Ollama](https://ollama.com) running locally with a model pulled (e.g., `ollama pull llama3.2`).

### Live mode — Ollama answers for every agent

```bash
node scripts/dev-runner.js room-plugins/my-room --config my-config.json
```

Where `my-config.json` contains your room and orchestrator config:

```json
{
  "objective": "Describe what the room should do",
  "roomConfig": { "demoMode": true },
  "orchestratorConfig": {}
}
```

### Record a run as fixtures

```bash
node scripts/dev-runner.js room-plugins/my-room \
  --config my-config.json --record fixtures/my-run-1
```

This saves each fan-out round's responses as numbered JSON files:

```
fixtures/my-run-1/
  000-baseline.json
  001-planning.json
  002-cycle.json
  ...
  transcript.txt
```

### Replay recorded fixtures (no Ollama, deterministic)

```bash
node scripts/dev-runner.js room-plugins/my-room \
  --config my-config.json --replay fixtures/my-run-1
```

Replays the recorded agent responses through the same plugin lifecycle. Useful for testing state machine changes without waiting for LLM responses.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--live` | (default) | Use Ollama for agent responses |
| `--replay <dir>` | | Replay recorded fixtures |
| `--record <dir>` | | Record live responses as fixtures |
| `--model <name>` | `llama3.2` | Ollama model name |
| `--ollama-url <url>` | `http://localhost:11434` | Ollama API base URL |
| `--config <file>` | | JSON config (roomConfig, orchestratorConfig, objective) |
| `--max-rounds <n>` | `50` | Safety limit on fan-out rounds |

## 6. Validate In-App Behavior

Test these cases before sharing your plugin:

1. Normal start -> first decision from `onRoomStart` executes.
2. Fan-out path -> `onFanOutComplete` receives all successful responses.
3. Single-turn path -> `onTurnResult` receives `{ agentId, response, usage }` (note: `usage` may be `null`).
4. Pause/resume path -> room resumes cleanly and does not replay stale decisions.
5. Disconnect path -> `onEvent({ type: 'participant_disconnected' })` updates state and returns a safe recovery decision (note: during fan-out, returned decisions are not executed — handle recovery in `onFanOutComplete`).
6. Manual/semi-auto approval path -> pending decisions are still valid after edit and approval.
7. Dashboard path -> every dashboard panel key has matching `ctx.emitMetrics({ [panelKey]: ... })` data and renders correctly.

## 7. Publish Safely

When you change plugin code, regenerate allowlist hashes before publishing:

```bash
node ./scripts/generate-room-allowlist.mjs \
  --managed-only \
  ~/.commands-agent/room-plugins \
  ~/.commands-agent/room-plugins-allowed.json
```

This keeps plugin integrity checks accurate.

## 8. Use the Full Contract While Building

Read [`docs/CONTRACT.md`](./docs/CONTRACT.md) for:

- exact manifest schema and allowed keys
- decision payload rules
- lifecycle hook signatures
- context API (`invokeLLM`, state, metrics, reports)
- timeout, pause, and failure semantics
- loader security and allowlist behavior

For declarative rooms (`room.yaml`, engine/harness, family runtimes):

- [`docs/DECLARATIVE_ROOMS.md`](./docs/DECLARATIVE_ROOMS.md)

For dashboard authoring details (panel types, field shapes, and metrics payloads):

- [`docs/DASHBOARD_GUIDE.md`](./docs/DASHBOARD_GUIDE.md)
