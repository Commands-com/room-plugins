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

```bash
cp -R ./room-plugins/template-room ./room-plugins/my-room
```

Update both files:

- `./room-plugins/my-room/manifest.json`
- `./room-plugins/my-room/index.js`

Keep `manifest.json` and the exported `manifest` in `index.js` exactly aligned.

## 4. Reinstall and Reload

```bash
./scripts/install-room-plugins.sh
```

Then restart Commands Desktop.

## 5. Validate In-App Behavior

Test these cases before sharing your plugin:

1. Normal start -> first decision from `onRoomStart` executes.
2. Fan-out path -> `onFanOutComplete` receives all successful responses.
3. Single-turn path -> `onTurnResult` receives `{ agentId, response, usage }` (note: `usage` may be `null`).
4. Pause/resume path -> room resumes cleanly and does not replay stale decisions.
5. Disconnect path -> `onEvent({ type: 'participant_disconnected' })` updates state and returns a safe recovery decision (note: during fan-out, returned decisions are not executed — handle recovery in `onFanOutComplete`).
6. Manual/semi-auto approval path -> pending decisions are still valid after edit and approval.

## 6. Publish Safely

When you change plugin code, regenerate allowlist hashes before publishing:

```bash
node ./scripts/generate-room-allowlist.mjs \
  ~/.commands-agent/room-plugins \
  ~/.commands-agent/room-plugins-allowed.json
```

This keeps plugin integrity checks accurate.

## 7. Use the Full Contract While Building

Read [`docs/CONTRACT.md`](./docs/CONTRACT.md) for:

- exact manifest schema and allowed keys
- decision payload rules
- lifecycle hook signatures
- context API (`invokeLLM`, state, metrics, reports)
- timeout, pause, and failure semantics
- loader security and allowlist behavior

