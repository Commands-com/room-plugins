# FFT Autotune Plugin Handoff

This plugin is now a serious external room example, not a toy room.

It already has the host support needed for meaningful FFT-specific work without further core changes.

## What Exists Now

The room already supports:

- explicit `explorer`, `builder`, and `auditor` roles in `manifest.json`
- role-targeted fan-out in the host runtime
- participant model metadata in plugin context via `ctx.participants[*].profile`
- same-run baseline bootstrap per bucket
- compile -> validate -> benchmark -> frontier ranking
- blocked-bucket reporting and repair-mode escalation
- report tables plus multi-block winner source output via `winnerSources: { blocks: [...] }`

Important current reality:

- the room is a strong plugin/platform example
- it is a useful FFT experimentation baseline
- it is not yet a production-grade FFT/NEON autotuner

## Files That Matter

- `manifest.json`
  Room contract, role layout, dashboard, report config, setup fields.
- `index.js`
  Thin descriptor entrypoint.
- `lib/plugin.js`
  Main room lifecycle orchestration.
- `lib/planning.js`
  Prompt builders, baseline/cycle target generation, promotion decisions.
- `lib/envelope.js`
  Worker response parsing, lane assignment, candidate normalization.
- `lib/candidates.js`
  Merge logic, frontier ranking, stop conditions, improvement tracking.
- `lib/phases.js`
  Phase state and partial fan-out phase advancement.
- `lib/report.js`
  Final report metrics, frontier rows, blocked bucket rows, winner source code blocks.
- `lib/config.js`
  Setup normalization and compatibility hooks.

## Host Capabilities You Can Rely On

These are available now in core.

### 1. Explicit Specialist Roles

The host supports custom manifest roles.

You do not need to keep everything as generic `worker` participants anymore.

The FFT room now declares:

- `explorer`
- `builder`
- `auditor`

The runtime also supports fan-out targets by role or by `agentId`.

That means you can choose between:

- role-wide fan-out when several participants should receive the same prompt
- per-agent fan-out when each explorer should receive a different brief

### 2. Participant Model Metadata

For local participants, plugin context now includes:

```js
participant.profile = {
  id,
  name,
  provider,
  model,
}
```

For remote participants, `profile` is `null`.

This is enough to specialize prompts by model family in plugin code.

### 3. Multi-Code Report Blocks

The host report system now supports a single declared code-block metric rendering multiple blocks:

```js
winnerSources: {
  title: 'Winner Sources',
  blocks: [
    { title, subtitle, path, language, content, footer },
    { title, subtitle, path, language, content, footer },
  ],
}
```

The FFT room already emits this.

## What Was Deliberately Left As Plugin Work

These are not blocked on core.

### Multiple Explorers

You can add multiple `explorer` participants right now.

The plugin already understands explicit roles, and the host already supports role-targeted and `agentId`-targeted fan-out.

### Model-Specific Exploration

You can already branch prompts using `participant.profile.provider` and `participant.profile.model`.

The current plugin includes a first pass of this in `lib/planning.js`.

It is intentionally simple and should be treated as a baseline, not final policy.

### Exploration Synthesis Layer

You can add a dedicated merge/synthesis step without core work.

The plugin can:

- fan out to several explorers
- collect proposal sets
- dedupe and cluster them
- run a synthesis prompt through `ctx.invokeLLM(...)`
- promote a curated set into the build cycle

That is a plugin concern, not a host concern.

## Recommended Next Plugin Iterations

### 1. Turn Exploration Into A Real Multi-Explorer System

Current state:

- explicit explorer role exists
- prompts can inspect model metadata
- the room still behaves mostly like a single-explorer design with optional extras

Recommended update:

- set `roles.minCount.explorer` > 1 if you want multi-explorer by default
- add several default explorers in `manifest.json`
- send exploration prompts by `agentId`, not one generic role-wide explorer prompt
- keep one builder and one auditor until the room stabilizes further

Suggested specialization:

- Gemini explorer: search breadth, decomposition diversity, structural mutations
- GPT explorer: implementation-friendly candidates likely to compile cleanly
- Opus explorer: adversarial search for fragile buckets, edge cases, and local-minimum escapes

### 2. Add An Explicit Exploration Synthesis Step

Right now exploration and promotion are fairly direct.

A stronger design is:

1. explorers emit proposals
2. plugin dedupes and clusters
3. orchestrator runs a synthesis pass
4. synthesis chooses promoted candidates with bucket coverage in mind
5. builder implements only the synthesized frontier candidates

Good insertion points:

- `lib/planning.js` for synthesis prompt generation
- `lib/plugin.js` for a new decision/state transition before `candidate_codegen`
- `lib/candidates.js` for dedupe or cluster utilities if needed

### 3. Tighten FFT-Specific Candidate Control

The room is operational, but FFT-specific rigor can still improve.

Likely next steps:

- move from free-form family synthesis toward `skeleton + knobs`
- add a vetted skeleton registry for `64`, `256`, and `1024`
- strengthen fidelity checks for claimed family / permutation / SIMD properties
- continue improving deterministic harness diagnostics

### 4. Decide The SIMD Strategy Explicitly

Current room behavior allows scalar-but-correct candidates, which is the right default for now.

A future FFT-specific policy could be staged:

- stage 1: scalar correctness and bucket coverage
- stage 2: scalar performance search
- stage 3: NEON lowering and kernel refinement

That avoids mixing “correct FFT search” with “trusted SIMD kernel generation” too early.

## Suggested Immediate Refactor Path

If you want to evolve this room cleanly, do it in this order.

1. Add multiple explorers in `manifest.json`.
2. Update `lib/planning.js` to emit per-explorer prompts keyed by `agentId`.
3. Add an exploration synthesis phase in `lib/plugin.js`.
4. Keep builder singular while refining harness and candidate fidelity.
5. Only after that, revisit multi-builder or stronger SIMD-specific search.

## Things You Do Not Need To Change In Core First

You do not need core changes for:

- multiple explorers
- model-specific prompt specialization
- exploration synthesis
- bucket-aware promotion logic
- richer FFT-domain validation heuristics
- stricter family / fidelity enforcement in the room

Those are all plugin-level changes now.

## Installation / Reload Notes

After plugin edits:

```bash
bash /Users/dtannen/Code/commands-com-agent-rooms/scripts/install-room-plugins.sh --plugin fft-autotune
```

Then restart Commands Desktop.

If you change the source plugin and want the repo allowlist to match:

```bash
node /Users/dtannen/Code/commands-com-agent-rooms/scripts/compute-room-plugin-sha256.mjs \
  /Users/dtannen/Code/commands-com-agent-rooms/room-plugins/fft-autotune
```

and update `room-plugins-allowed.json` accordingly.

## Bottom Line

This plugin is now in the right state for FFT-domain iteration.

The platform work is largely done.

The next meaningful improvements should happen in this plugin, not in core.
