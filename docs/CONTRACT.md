# Room Plugin Contract

External room plugin folder must contain:

- `manifest.json`
- `index.js`

## `manifest.json` required fields

- `id` (string)
- `name` (string)
- `version` (string)
- `orchestratorType` (string)
- `roles` (object with at least `required` array)

Common optional fields:

- `description`
- `supportsQuorum`
- `dashboard`
- `limits`
- `endpointConstraints`
- `display`
- `report`
- `configSchema`

## `index.js` required export

```js
export default {
  manifest,
  createPlugin() {
    return {
      init(ctx) {},
      onRoomStart(ctx) {},
      onTurnResult(ctx, turnResult) {},
      onFanOutComplete(ctx, responses) {},
      onEvent(ctx, event) {},
      onResume(ctx) {},
      refreshPendingDecision(ctx, decision) {},
      shutdown(ctx) {},
    };
  },
};
```

## Runtime notes

- Room plugins are not singletons; `createPlugin()` is called for each room instance.
- The runtime enforces hook timeouts from room limits.
- Hook return values must be valid room decisions (`speak`, `fan_out`, `pause`, `stop`) when applicable.
- External plugin code runs in desktop main process; only install trusted code.
