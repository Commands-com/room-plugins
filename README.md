# Commands.com Room Plugins

Build external room orchestrator plugins for Commands Desktop without modifying `Commands.app`.

This repo is meant for desktop users (including DMG installs) who want to create and ship custom room types.

## What You Get

- `room-plugins/template-room`: reference implementation you can copy
- `scripts/install-room-plugins.sh`: install plugins into the desktop plugin directory
- `scripts/generate-room-allowlist.mjs`: generate secure allowlist with SHA-256 hashes
- `docs/CONTRACT.md`: full plugin manifest, hook, and runtime contract
- `GETTING_STARTED.md`: end-to-end workflow from install to app testing

## Install Plugins Into Commands Desktop

```bash
git clone https://github.com/Commands-com/room-plugins.git
cd room-plugins
./scripts/install-room-plugins.sh
```

This installs to:

- `~/.commands-agent/room-plugins`
- `~/.commands-agent/room-plugins-allowed.json`

Then restart Commands Desktop.

## Build Your Own Room Type

1. Copy the reference plugin:

```bash
cp -R ./room-plugins/template-room ./room-plugins/my-room
```

2. Update:

- `./room-plugins/my-room/manifest.json`
- `./room-plugins/my-room/index.js`

3. Reinstall + regenerate allowlist:

```bash
./scripts/install-room-plugins.sh
```

4. Restart Commands Desktop and create a room using your `manifest.orchestratorType`.

## Security and Loading

- Built-in room types continue to load.
- External room types are additive.
- Plugin directory names must be allowlisted.
- `manifest.json` and `index.js` must be regular files (no symlinks).
- If allowlist entry includes `sha256`, plugin integrity is enforced.

## Full Authoring Docs

- [Getting Started](./GETTING_STARTED.md)
- [Room Plugin Contract](./docs/CONTRACT.md)

