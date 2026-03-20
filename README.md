<div align="center">

# Commands.com Room Plugins

**Build custom room orchestrators for Commands Desktop. No source access required.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Security](https://img.shields.io/badge/Integrity-SHA--256%20Allowlist-8B5CF6.svg)](#security-and-loading)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#quick-start)

External room orchestrator plugins for Commands Desktop.
Works with packaged installs — no source repo needed.

```
Room Start  ──>  Orchestrator Plugin  ──>  Fan-out / Workers  ──>  Results
```

https://github.com/user-attachments/assets/7c6ddcd6-45db-4b71-9838-c8f262bd4e7f

</div>

---

## Highlights

| | |
|---|---|
| **Zero dependencies** | Reference plugin uses only Node.js built-ins |
| **Cross-platform** | Bash installer for macOS/Linux, Node.js installer for Windows |
| **Full lifecycle** | Hooks for init, start, turn results, fan-out, events, resume, shutdown |
| **Dashboard panels** | Counter groups, progress bars, charts, agent status, tables, conversation feeds |
| **SHA-256 integrity** | Allowlist with optional hash pins, symlink rejection, dev-only bypass |
| **Declarative rooms** | Define phases, dispatch, and dashboard in `room.yaml` — family runtimes handle orchestration |
| **Copy-and-go** | Clone `template-room`, edit manifest and handler, reinstall |
| **Additive** | External room types extend built-ins — never override |

## Requirements

- Node.js 18+
- Commands Desktop (DMG, installer, or dev build)

## Quick Start

```bash
git clone https://github.com/Commands-com/room-plugins.git
cd room-plugins
```

**macOS / Linux:**

```bash
./scripts/install-room-plugins.sh
```

**Windows (or any platform with Node.js):**

```bash
node scripts/install-room-plugins.mjs
```

Both scripts copy plugins, install npm dependencies, and generate the SHA-256 allowlist.
Use `--plugin <name>` to sync a single plugin without pruning other managed plugin folders already present in the destination. Installer-generated allowlists now only include installer-managed plugin directories in the destination.

```bash
./scripts/install-room-plugins.sh --plugin fft-autotune
node scripts/install-room-plugins.mjs --plugin fft-autotune
```

| Platform | Default install locations |
|---|---|
| macOS / Linux | `~/.commands-agent/room-plugins` |
| Windows | `%LOCALAPPDATA%\commands-agent\room-plugins` |

Restart Commands Desktop.

## Build Your Own Room Type

### Classic (imperative)

```bash
cp -R ./room-plugins/template-room ./room-plugins/my-room
```

Update:

- `manifest.json` — set `orchestratorType`, display name, participant roles
- `index.js` — implement lifecycle hooks (`onRoomStart`, `onTurnResult`, `onFanOutComplete`, etc.)

### Declarative (family-based)

For rooms that follow an established pattern (e.g., empirical search/optimization):

```bash
cp -R ./room-plugins/redshift-query-optimizer ./room-plugins/my-optimizer
```

Update:

- `room.yaml` — phases, dispatch, dashboard, family config
- `lib/engine.js` — domain-specific logic (plan shape, prompt builders, winner rendering)
- `lib/harness.js` — environment interaction (connect, compatibility)

See [Declarative Rooms Guide](./docs/DECLARATIVE_ROOMS.md) for full reference.

### Install

```bash
./scripts/install-room-plugins.sh        # macOS/Linux
node scripts/install-room-plugins.mjs    # Windows (or any platform)
```

Restart Commands Desktop and create a room using your `orchestratorType`.

## Security and Loading

| Rule | Detail |
|---|---|
| Built-in room types | Always load |
| External room types | Additive — cannot override built-ins |
| Allowlist | Plugin directory names must be listed |
| Integrity | If allowlist entry includes `sha256`, enforced at load time |
| File checks | `manifest.json` and `index.js` must be regular files (no symlinks) |

Dev-only bypass:

```bash
COMMANDS_AGENT_DEV=1 COMMANDS_AGENT_TRUST_ALL_PLUGINS=1
```

In Desktop: **Settings > Developer > Dev Mode + Trust All Plugins**.

## Project Layout

```
room-plugins/template-room                  Classic reference implementation (copy to create new)
room-plugins/fft-autotune                   Advanced empirical search room (classic)
room-plugins/postgres-query-optimizer       Declarative room (Docker harness, index + rewrite strategies)
room-plugins/redshift-query-optimizer       Declarative room (live cluster, rewrite + advisory strategies)
room-plugins/sql-optimizer-core             Shared library for SQL optimizer plugins
scripts/dev-runner.js                       Dev harness — run plugins locally with Ollama or fixtures
scripts/install-room-plugins.sh             Bash installer (macOS/Linux)
scripts/install-room-plugins.mjs            Node.js installer (cross-platform)
scripts/generate-room-allowlist.mjs         Generate allowlist with SHA-256 pins
scripts/compute-room-plugin-sha256.mjs      Compute single plugin hash
docs/CONTRACT.md                            Full plugin manifest, hook, and runtime contract
docs/DECLARATIVE_ROOMS.md                   Declarative room definitions (room.yaml, engine, harness)
docs/DASHBOARD_GUIDE.md                     Dashboard panel types and metrics authoring
GETTING_STARTED.md                          End-to-end workflow from install to testing
```

## Additional Docs

- [Getting Started](./GETTING_STARTED.md)
- [Room Plugin Contract](./docs/CONTRACT.md)
- [Declarative Rooms Guide](./docs/DECLARATIVE_ROOMS.md)
- [Dashboard Guide](./docs/DASHBOARD_GUIDE.md)
