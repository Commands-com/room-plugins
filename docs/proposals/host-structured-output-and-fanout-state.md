# Proposal: Host APIs for Structured Output and Active Fan-Out State

Status: Landed in host. See `docs/CONTRACT.md` for the authoritative runtime contract.

## Summary

Add two host-level capabilities that reduce repeated plugin complexity:

1. Structured `ctx.invokeLLM(...)` output using JSON Schema.
2. Host-managed active fan-out state for safer pause/resume behavior.

These are motivated by `spec_room`, but the APIs are intentionally generic and
should benefit any room that synthesizes structured data or needs to resume
partially completed fan-outs.

## Goals

- Remove plugin-local JSON scraping and validation boilerplate.
- Make pause/resume behavior deterministic without plugins reconstructing target
  completion from partial events and local state.
- Keep both additions backward-compatible with existing plugins.

## Non-Goals

- No spec-room-specific host behavior.
- No generic "text room core" abstraction in the host.
- No change to existing `null` decision semantics.

## 1. Structured LLM Output

### Proposed call shape

```ts
const result = await ctx.invokeLLM(prompt, {
  purpose: 'synthesis',
  timeoutMs: 90_000,
  maxRetries: 1,
  responseFormat: {
    type: 'json_schema',
    name: 'spec_room_synthesis',
    schema: SPEC_SCHEMA,
    strict: true,
  },
});
```

### Options

```ts
type InvokeLLMOptions = {
  purpose?: 'planning' | 'synthesis';
  timeoutMs?: number;
  allow_tool_use?: boolean;
  maxRetries?: number;
  responseFormat?: {
    type: 'json_schema';
    name: string;
    schema: JsonSchema;
    strict: true;
  };
};
```

### v1 decision on `strict: false`

V1 should be strict-only.

- `strict: true` is supported.
- `strict: false` is rejected as an invalid option in v1.

This keeps the contract clear while leaving room for a future best-effort mode
once host semantics are well-defined.

### Return shape

```ts
type LLMUsage = {
  input_tokens: number;
  output_tokens: number;
};

type LLMResult<T = string> =
  | {
      ok: true;
      text: string;
      data?: T;
      usage: LLMUsage | null;
      model?: string;
      provider?: string;
    }
  | {
      ok: false;
      error: string;
      text?: string;
      raw?: unknown;
      validationErrors?: Array<{
        path: string;
        message: string;
      }>;
      usage: LLMUsage | null;
      model?: string;
      provider?: string;
    };
```

### Host behavior

- If `responseFormat` is absent, preserve current behavior.
- If `responseFormat.type === 'json_schema'`, the host should prefer provider
  features such as constrained decoding, tool calls, or native structured
  output when available.
- If the provider lacks native structured output, the host may fall back to
  prompt + validate internally.
- Invalid plugin-supplied schema should fail fast before model invocation.
- Validation failure returns `ok: false`; it does not throw.
- `maxRetries` is top-level and applies to the whole invocation. The host may
  decide internally which failures are retryable.

### Why this matters

Plugins should not need to repeatedly implement:

- raw-text JSON extraction
- schema validation glue
- provider-specific structured-output fallback logic

Plugins can still apply semantic defaults after validation, but the host should
own syntactic correctness.

## 2. Active Fan-Out State

### Proposed context API

Add one method to hook context:

```ts
type ActiveFanOut = {
  id: string;
  startedAt: number;
  targets: Array<{
    agentId: string;
    role: string;
    displayName: string;
    message: string;
  }>;
  completedAgentIds: string[];
  pendingAgentIds: string[];
  disconnectedAgentIds: string[];
  partials: Record<string, {
    response?: string;
    responseLength?: number;
    updatedAt: number;
  }>;
  metadata?: Record<string, unknown>;
};

ctx.getActiveFanOut(): ActiveFanOut | null;
```

Method-only is intentional. It signals that plugins are reading a snapshot, not
holding a live mutable reference across async boundaries.

### Extend `fan_out` decisions

```ts
{
  type: 'fan_out',
  targets: [...],
  metadata?: {
    phase?: string,
    label?: string,
  }
}
```

The host stores this metadata on the active fan-out snapshot and passes it
through events when relevant.

### Extend runtime events

```ts
{
  type: 'fan_out_partial',
  fanOutId: string,
  agentId: string,
  displayName?: string,
  detail: {
    response: string,
    responseLength: number,
  },
  progress: {
    completedAgentIds: string[],
    pendingAgentIds: string[],
  }
}
```

```ts
{
  type: 'participant_disconnected',
  agentId: string,
  activeFanOutId?: string,
  progress?: {
    completedAgentIds: string[],
    pendingAgentIds: string[],
  }
}
```

### New decision type for resume

Add one explicit resume-only decision:

```ts
{ type: 'continue_fan_out' }
```

Rules:

- Valid only from `onResume(ctx)`.
- Valid only when an active fan-out exists and `pendingAgentIds.length > 0`.
- The host re-dispatches only the pending targets using the original concrete
  target messages for that active fan-out.
- `null` from `onResume` remains a true no-op.
- If a plugin wants to modify targets or messages on resume, it returns a new
  `fan_out` decision instead.

This avoids a backward-incompatible semantic shift where `null` would
implicitly restart work.

### Why this matters

Without host-owned fan-out state, plugins end up reconstructing completion from
multiple signals:

- round-local stored responses
- partial submission events
- participant disconnect events

That logic is repetitive and easy to get subtly wrong.

## 3. Example Plugin Usage

### Structured synthesis

```ts
const result = await ctx.invokeLLM<SpecShape>(prompt, {
  purpose: 'synthesis',
  maxRetries: 1,
  responseFormat: {
    type: 'json_schema',
    name: 'spec',
    schema: SPEC_SCHEMA,
    strict: true,
  },
});

if (!result.ok) {
  return buildFallbackFromError(result.error, result.text);
}

return normalizeSpec(result.data);
```

### Resume behavior

```ts
async function onResume(ctx) {
  const active = ctx.getActiveFanOut();
  if (!active) return null;
  if (active.pendingAgentIds.length === 0) return null;
  return { type: 'continue_fan_out' };
}
```

## 4. Rollout Order

1. Structured output support in `invokeLLM`.
2. Active fan-out state plus `continue_fan_out`.
3. Optional future artifact/document APIs after real usage proves the need.

This order removes the most plugin complexity first while keeping the second
change narrowly scoped to resume correctness.
