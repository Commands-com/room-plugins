<div align="center">

# Commands.com Room Plugins

**Build custom room orchestrators for Commands Desktop. No source access required.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Security](https://img.shields.io/badge/Integrity-SHA--256%20Allowlist-8B5CF6.svg)](#security-and-loading)

External room orchestrator plugins for Commands Desktop.
Works with packaged DMG installs — no `Commands.app` source repo needed.

```
Room Start  ──>  Orchestrator Plugin  ──>  Fan-out / Workers  ──>  Results
```

</div>

---

## Highlights

| | |
|---|---|
| **Zero dependencies** | Reference plugin uses only Node.js built-ins |
| **Full lifecycle** | Hooks for init, start, turn results, fan-out, events, resume, shutdown |
| **Dashboard panels** | Counter groups, progress bars, charts, agent status, tables, conversation feeds |
| **SHA-256 integrity** | Allowlist with optional hash pins, symlink rejection, dev-only bypass |
| **Copy-and-go** | Clone `template-room`, edit manifest and handler, reinstall |
| **Additive** | External room types extend built-ins — never override |

## Requirements

- Node.js 18+
- Commands Desktop (DMG or dev build)

## Quick Start

```bash
git clone https://github.com/Commands-com/room-plugins.git
cd room-plugins
./scripts/install-room-plugins.sh
```

Install locations:

| Path | Contents |
|---|---|
| `~/.commands-agent/room-plugins` | Plugin directories |
| `~/.commands-agent/room-plugins-allowed.json` | Generated allowlist with SHA-256 pins |

Restart Commands Desktop.

## Build Your Own Room Type

```bash
cp -R ./room-plugins/template-room ./room-plugins/my-room
```

Update:

- `manifest.json` — set `orchestratorType`, display name, participant roles
- `index.js` — implement lifecycle hooks (`onRoomStart`, `onTurnResult`, `onFanOutComplete`, etc.)

Reinstall and regenerate allowlist:

```bash
./scripts/install-room-plugins.sh
```

Restart Commands Desktop and create a room using your `manifest.orchestratorType`.

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
room-plugins/template-room       Reference implementation (copy to create new)
scripts/install-room-plugins.sh           Install + generate allowlist
scripts/generate-room-allowlist.mjs       Generate allowlist with SHA-256 pins
scripts/compute-room-plugin-sha256.mjs    Compute single plugin hash
docs/CONTRACT.md                  Full plugin manifest, hook, and runtime contract
docs/DASHBOARD_GUIDE.md           Dashboard panel types and metrics authoring
GETTING_STARTED.md                End-to-end workflow from install to testing
```

## Additional Docs

- [Getting Started](./GETTING_STARTED.md)
- [Room Plugin Contract](./docs/CONTRACT.md)
- [Dashboard Guide](./docs/DASHBOARD_GUIDE.md)
