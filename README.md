# Commands.com Agent Rooms

External room orchestrator plugins for Commands.com Desktop.

This repo is for adding custom room types without modifying core desktop code.

## Important behavior

- Built-in room plugins still load (`review_cycle`, `war_room`, `break_room`, `ui_ux_testing`).
- External room plugins are additive.
- Room plugins are instantiated per room run (`createPlugin()` per resolve).

## Repo layout

```text
commands-com-agent-rooms/
  room-plugins/
    template-room/
      manifest.json
      index.js
  scripts/
    install-room-plugins.sh
    compute-room-plugin-sha256.mjs
    generate-room-allowlist.mjs
  docs/
    CONTRACT.md
  room-plugins-allowed.json.example
  README.md
  GETTING_STARTED.md
```

## Quick install (recommended)

```bash
cd /Users/dtannen/Code/commands-com-agent-rooms
./scripts/install-room-plugins.sh
```

This installs plugins to:

- `~/.commands-agent/room-plugins`
- `~/.commands-agent/room-plugins-allowed.json`

Then restart Commands Desktop.

## Manual install

```bash
mkdir -p ~/.commands-agent/room-plugins
rsync -a --delete --exclude '.DS_Store' --exclude '.git/' \
  ./room-plugins/ ~/.commands-agent/room-plugins/
node ./scripts/generate-room-allowlist.mjs \
  ~/.commands-agent/room-plugins \
  ~/.commands-agent/room-plugins-allowed.json
```

## Use repo path directly (optional)

```bash
export COMMANDS_AGENT_ROOM_PLUGINS_DIR=/Users/dtannen/Code/commands-com-agent-rooms/room-plugins
```

If you do this, put allowlist at:

- `/Users/dtannen/Code/commands-com-agent-rooms/room-plugins-allowed.json`

## Security model

- Default secure mode: allowlist + optional integrity hash pin per plugin.
- Dev bypass exists but should not be used in production:

```bash
COMMANDS_AGENT_DEV=1
COMMANDS_AGENT_TRUST_ALL_PLUGINS=1
```

## Add a new room plugin

1. Copy `room-plugins/template-room` to a new folder.
2. Update `manifest.json` (`id`, `orchestratorType`, roles, limits).
3. Implement orchestration hooks in `index.js`.
4. Regenerate allowlist with hashes:

```bash
node ./scripts/generate-room-allowlist.mjs \
  ~/.commands-agent/room-plugins \
  ~/.commands-agent/room-plugins-allowed.json
```

## Contract

See [`docs/CONTRACT.md`](./docs/CONTRACT.md).

## Troubleshooting

- Room type not visible:
  - Check `manifest.json` schema, `orchestratorType` uniqueness, and allowlist.
- Plugin rejected:
  - Check manifest-export parity (`index.js` exported `manifest` must match `manifest.json`).
- Hash mismatch:
  - Regenerate allowlist after any file change.
