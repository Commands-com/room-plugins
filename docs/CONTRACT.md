# Room Plugin Contract (Commands Desktop)

This is the implementation contract for external room plugins loaded by Commands Desktop.

If you follow this file, you can build a room plugin from this repo without access to the app source tree.

## 1. Runtime Loading Model

- Built-in room types are always present.
- External room types are additive (they do not replace built-ins).
- Each room run gets a fresh plugin instance via `createPlugin()`.
- External plugins are loaded from:
  - `~/.commands-com/workspace/room-plugins`
  - override: `COMMANDS_AGENT_ROOM_PLUGINS_DIR`
- Allowlist file is loaded from the plugin directory parent:
  - default: `~/.commands-com/workspace/room-plugins-allowed.json`

No changes to `Commands.app` are required.

## 2. Required Plugin Files

### Classic plugins

Each plugin folder must contain:

- `manifest.json`
- `index.js`

Both files must be regular files (not symlinks, not directories).

```text
room-plugins/
  my-room/
    manifest.json
    index.js
    package.json          # optional
    node_modules/         # optional
```

### Declarative plugins

Declarative rooms use `room.yaml` as the canonical definition and export engine/harness from `index.js`. They also include `manifest.json` for backward compatibility.

```text
room-plugins/
  my-optimizer/
    room.yaml             # Declarative definition (canonical)
    manifest.json         # Classic compat
    index.js              # Exports engine + harness (declarative) AND manifest + createPlugin (classic)
    lib-deps.txt          # Shared library dependencies (optional)
    lib/
    package.json          # optional
```

See [`DECLARATIVE_ROOMS.md`](./DECLARATIVE_ROOMS.md) for the full declarative room contract.

## 3. `index.js` Export Contract

`index.js` must export a descriptor object:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

function createPlugin() {
  return {
    init(ctx) {},
    onRoomStart(ctx) { return null; },
    onTurnResult(ctx, turnResult) { return null; },
    onFanOutComplete(ctx, responses) { return null; },
    onEvent(ctx, event) { return null; },
    onResume(ctx) { return null; },
    refreshPendingDecision(ctx, pendingDecision) { return pendingDecision; },
    shutdown(ctx) {},
  };
}

async function checkCompatibility(payload, ctx) {
  return { ok: true, report: { compatible: true } };
}

async function makeCompatible(payload, ctx) {
  return { ok: true, applied: false, actions: [], report: { compatible: true } };
}

export default { manifest, createPlugin, checkCompatibility, makeCompatible };
export { manifest, createPlugin, checkCompatibility, makeCompatible };
```

Rules:

- `createPlugin` must be a function.
- `checkCompatibility` and `makeCompatible` are optional descriptor-level hooks.
- `manifest` must be JSON-serializable.
- Exported `manifest` must match `manifest.json` exactly.
- Implement `onRoomStart`, `onTurnResult`, `onFanOutComplete`, and `onEvent` as real functions; missing hooks can trigger hook failures and pause the room.
- `manifest.orchestratorType` must be unique across all loaded plugins.
- `manifest.id` must be unique across all loaded plugins.

## 4. Manifest Schema (`manifest.json`)

Allowed top-level keys:

- `id` (required string)
- `name` (required string)
- `version` (required string)
- `orchestratorType` (required string)
- `roles` (required object)
- `description` (optional non-empty string)
- `supportsQuorum` (optional boolean)
- `dashboard` (optional object)
- `limits` (optional object)
- `endpointConstraints` (optional object)
- `display` (optional object)
- `report` (optional object)
- `configSchema` (optional object)
- `roomConfigSchema` (optional object)
- `setup` (optional object)

Unknown fields are rejected.

### 4.1 `roles`

Allowed keys:

- `required` (required non-empty string array)
- `optional` (optional string array)
- `forbidden` (optional string array)
- `minCount` (optional object: `{ [role]: number >= 0 }`)

### 4.2 `limits`

Allowed keys:

- `maxCycles`
- `maxTurns`
- `maxDurationMs`
- `maxFailures`
- `agentTimeoutMs`
- `pluginHookTimeoutMs`
- `llmTimeoutMs`
- `turnFloorRole`
- `turnFloorFormula`

For numeric limit keys, values must be objects with only:

- `default`
- `min`
- `max`

Each bound must be a finite number if present.

Additional rules:

- `min <= max` when both exist.
- `turnFloorRole` must be a non-empty string when present.
- `turnFloorFormula` must be exactly `"1 + N"` or `"2 + N"`.

### 4.3 `endpointConstraints`

Allowed keys:

- `requiresLocalParticipant` (boolean)
- `perRole` (object)

Current hard enforcement is `requiresLocalParticipant`.

### 4.4 `dashboard`

Allowed keys:

- `panels` (required array when `dashboard` is provided)

Important behavior:

- dashboard panel data is read from `metrics[panel.key]`
- use `ctx.emitMetrics({ [panelKey]: value })` to populate each panel
- panel-specific field validation is lightweight, so malformed panel config can load but render poorly

For exact panel schemas and concrete examples, see [`DASHBOARD_GUIDE.md`](./DASHBOARD_GUIDE.md).

### 4.5 `display`

Allowed keys:

- `typeLabel`
- `typeTag`
- `cycleNoun`
- `reportTitle`
- `activityMessages`
- `defaultRoster`
- `defaultAddRole`

Rules:

- String fields above must be non-empty when present.
- `activityMessages` allowed keys only:
  - `idle`, `discovery`, `writing`, `fanOut`, `singleTurn`, `synthesis`, `planning`
- `defaultRoster` entries must be `{ role, displayName }` with both non-empty strings.

### 4.6 `report`

Allowed keys:

- `summaryMetrics` (string array)
- `table` object with:
  - `metricKey` (non-empty string)
  - `columns` (array of `{ key, label, width? }`)
- `codeBlocks` (array of `{ metricKey, label, language? }`)

`width` must be a finite number when present.

Each `codeBlocks` entry points at a metric object emitted by the plugin with
fields such as:

- `title`
- `subtitle`
- `path`
- `language`
- `content`
- `footer`

The metric may also emit a collection:

```js
{
  title: 'Winner Sources',
  blocks: [
    { title, subtitle, path, language, content, footer },
    { title, subtitle, path, language, content, footer },
  ]
}
```

The host renders those as report artifact/code panels when present.

### 4.7 `configSchema`

`configSchema` is numeric-only.

Per field allowed keys:

- `type` (`"integer"` or `"number"`)
- `min` (finite number)
- `max` (finite number)
- `default` (finite number)

Rules:

- `type`, `min`, `max`, and `default` are required and must be finite values.
- `min <= max`
- `default` must be within `[min, max]`
- if `type === "integer"`, `default` must be an integer

At runtime, user-provided `orchestratorConfig` is clamped to this schema.

### 4.8 `roomConfigSchema`

`roomConfigSchema` supports non-numeric room setup fields that are rendered in the create UI and passed to plugins as `ctx.roomConfig`.

Per field allowed keys:

- `type` (`"string"`, `"directory"`, `"enum"`, `"boolean"`, `"string_array"`, or `"number_array"`)
- `label` (required non-empty string)
- `description` (optional string)
- `required` (optional boolean)
- `default` (optional type-matching default value)
- `placeholder` (optional string)
- `options` (required non-empty string array for `"enum"`)
- `minItems` (optional integer >= 0 for array fields)
- `maxItems` (optional integer >= 0 for array fields)

Rules:

- `label` is required for every field.
- `options` is valid only for `enum`.
- `minItems` / `maxItems` are valid only for `string_array` and `number_array`.
- user-provided `roomConfig` is validated against this schema before room creation.

### 4.9 `setup`

`setup` controls compatibility/preflight gating in the room create flow.

Allowed keys:

- `compatibilityGate` (boolean)
- `compatibilityTitle` (non-empty string)
- `compatibilityDescription` (non-empty string)
- `checkLabel` (non-empty string)
- `fixLabel` (non-empty string)
- `allowMakeCompatible` (boolean)

## 5. Decision Contract

Hooks that return decisions must return one of:

```js
{ type: 'speak', agentId: string, message: string }

{ type: 'fan_out', targets: [ { agentId: string, message: string } ] }

{ type: 'fan_out', targets: [ { role: string, message: string } ] }

{ type: 'pause', reason?: string }

{ type: 'stop', reason: string }
```

Validation rules:

- `speak.agentId` must exist in room participants.
- `speak.message` must be non-empty.
- `fan_out.targets` must be non-empty.
- every `fan_out` target must specify exactly one of `agentId` or `role`.
- `fan_out` `agentId` values must exist in room participants.
- `fan_out` `role` values must match at least one participant role.
- duplicate concrete participants inside one `fan_out` are rejected, including overlaps between explicit `agentId` targets and role-expanded targets.
- every `fan_out` target `message` must be non-empty.
- `stop.reason` must be non-empty.

If a decision is invalid:

- room failure count increments
- `invalid_decision` event is emitted
- room pauses or stops (depending on stop conditions)

## 6. Lifecycle Hooks

Hooks are called in a serialized queue (`hookQueue`), never concurrently.

### 6.1 `init(ctx)`

- Called once when room starts.
- Return value ignored.
- Use to initialize plugin state.

### 6.2 `onRoomStart(ctx)`

- Called after `init`.
- Return first decision (or `null`).
- Typical output: initial `fan_out` or first `speak`.

### 6.3 `onTurnResult(ctx, turnResult)`

`turnResult` shape:

```js
{
  agentId: string,
  response: string,
  usage: {                       // may be null when token reporting is unavailable
    input_tokens: number,
    output_tokens: number,
  } | null
}
```

> **Note:** `usage` can be `null` when the runtime has no token data for the turn.
> Always access token fields defensively (e.g. `turnResult.usage?.input_tokens ?? 0`).

Return next decision or `null`.

### 6.4 `onFanOutComplete(ctx, responses)`

`responses` contains successful submissions (plus sync-rejected submissions marked with `rejected: true` when applicable):

```js
[
  {
    agentId: string,
    response: string,
    usage: { input_tokens: number, output_tokens: number } | null,
    observedRevision?: string | null,
    rejected?: boolean,
    rejectionReason?: string,
    authoritativeRevision?: string | null,
  }
]
```

> **Note:** `usage` can be `null` per response when token reporting is unavailable.
> Always access token fields defensively (e.g. `r.usage?.input_tokens ?? 0`).

Return next decision or `null`.

### 6.5 `onEvent(ctx, event)`

Runtime currently emits:

- participant disconnect:

```js
{ type: 'participant_disconnected', agentId: string }
```

- fan-out partial completion:

```js
{
  type: 'fan_out_partial',
  agentId: string,
  displayName?: string,
  detail: {
    response: string,
    responseLength: number,
  }
}
```

- user edit state request:

```js
{ type: 'user_edit_state', edits: object }
```

For disconnect events, return a recovery decision when possible.

> **Important:** During an active fan-out, `fan_out_partial` and
> `participant_disconnected` events are dispatched for state mutation only —
> return values from `onEvent(...)` are **not** executed as decisions in that
> context. Use the hook to update plugin state (for example, progress metrics,
> phase changes, or marking a participant as lost) and handle recovery when the
> fan-out completes via `onFanOutComplete`. Outside of fan-out, returned
> decisions are applied normally.

For `user_edit_state`, mutate plugin state directly via `ctx.setState(...)`; return values are not used for edit application.

### 6.6 `onResume(ctx)`

Called only when room resumes from pause and there is no pending decision to replay.

### 6.7 `refreshPendingDecision(ctx, pendingDecision)`

Called after user edits when a pending decision exists.

Use this to regenerate message text so approval executes fresh content.

### 6.8 `shutdown(ctx)`

Called on room stop for cleanup. Errors are ignored.

## 7. Orchestrator Context (`ctx`)

Hook `ctx` includes immutable snapshots plus helper methods:

```js
{
  roomId,
  objective,
  participants,      // [{ agentId, displayName, role, endpoint, profile? }]
  getParticipant(agentId),
  getParticipantsByRole(role),
  getRoleCounts(),
  getRoles(),
  limits,
  llmConfig,
  orchestratorConfig,
  roomConfig,        // normalized manifest-defined roomConfig fields
  syncState,
  mode,
  cycle,
  turnIndex,

  invokeLLM(prompt, options?),
  getState(),
  setState(state),
  setCycle(n),
  emitMetrics(metrics),
  getFinalReport(),
}
```

For local participants, `profile` is a read-only summary snapshot:

```js
{
  id,
  name,
  provider,
  model,
}
```

For remote participants, `profile` is `null`.

Descriptor-level compatibility hooks, when present, receive:

```js
async function checkCompatibility(payload, ctx) {}
async function makeCompatible(payload, ctx) {}
```

`payload` includes:

- `orchestratorType`
- `roomConfig` (normalized against `manifest.roomConfigSchema`)
- `localAgentProfileIds` (when available)

`ctx` includes:

- `manifest`
- `fs`
- `path`
- `readProfileById`
- `permissionProfileStorage`
- `saveProfile`
- `requestLocalPrompt`
- `isProfileRunning`

### 7.1 `invokeLLM(prompt, options?)`

Options:

- `purpose`: `"planning"` or `"synthesis"` (drives UI activity state)
- `allow_tool_use`: defaults to `true`
- `timeoutMs`: defaults to `limits.llmTimeoutMs`
- `max_output_chars`: optional output cap

Return shape:

```js
// success
{ ok: true, text: string, usage: { input_tokens: number, output_tokens: number } }

// error
{ ok: false, error: { code: string, message: string } }
```

Important:

- LLM calls route through a local participant.
- If no local participant exists, call returns `{ ok: false, error }`.

### 7.2 Plugin state helpers

- `getState()` returns deep-cloned plugin state.
- `setState(state)` stores deep-cloned plugin state.

### 7.3 Metrics/report helpers

- `emitMetrics(metrics)` updates latest room metrics and emits telemetry.
- `getFinalReport()` returns summary fields for final room report.

## 8. Timeouts, Failures, and Pause Behavior

- Default hook timeout: `limits.pluginHookTimeoutMs` (runtime ensures this is at least `limits.llmTimeoutMs`).
- `onTurnResult` and `onFanOutComplete` use `limits.agentTimeoutMs` to allow full internal LLM round-trips.
- Hook timeout/error increments room failure count and emits `plugin_error`.
- After hook failure:
  - if stop conditions hit -> room stops
  - otherwise -> room pauses

Manual/semi-auto note:

- In manual/semi-auto modes, decisions may pause for approval.
- `refreshPendingDecision` is your chance to refresh stale pending text after edits.

## 9. Security and Allowlist

Allowlist schema:

```json
{
  "allowed": [
    "my-room",
    { "name": "my-room", "sha256": "<hash>" }
  ]
}
```

Rules:

- entries match plugin directory names, not `manifest.id`
- when `sha256` is present, full plugin integrity is verified
- hashing includes all files (including `node_modules`) and file paths
- symlinks are rejected during integrity hashing
- plugin with `node_modules` and no `sha256` is allowed but warns

Dev-only bypass (not for production):

- `COMMANDS_AGENT_DEV=1`
- `COMMANDS_AGENT_TRUST_ALL_PLUGINS=1`

## 10. High-Quality Room Checklist

Use this checklist before publishing:

1. Deterministic state transitions: every hook produces predictable next decisions.
2. Safe start behavior: `onRoomStart` handles missing/invalid participants and can stop with clear reason.
3. Disconnect resilience: `onEvent(participant_disconnected)` updates state and returns a recovery decision or controlled stop (note: during fan-out, the returned decision is not executed — handle recovery in `onFanOutComplete` instead).
4. Pause/resume correctness: no infinite pause loop; pending decisions can be refreshed.
5. Bounded prompts: trim/sanitize plugin-generated prompt text to avoid oversized payloads.
6. Limit-aware logic: stop or converge before `maxTurns`, `maxCycles`, and timeout budgets hit unexpectedly.
7. Clear stop summary: return explicit `stop.reason` text that helps users understand completion/failure.
8. Security hygiene: regenerate allowlist hash after every code change.

## 11. Reference Implementation

Start from:

- `room-plugins/template-room/manifest.json`
- `room-plugins/template-room/index.js`

Then iterate with `GETTING_STARTED.md` and reinstall using `./scripts/install-room-plugins.sh`.
