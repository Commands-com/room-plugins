# Room Dashboard Guide (Commands Desktop)

This guide shows exactly how to define `manifest.dashboard.panels` and what data shape to send through `ctx.emitMetrics(...)`.

## 1. Core Rule

Each panel in `manifest.dashboard.panels` should have:

- `type` (string)
- `key` (string)
- `label` (optional string)

At runtime, panel data is read from `metrics[panel.key]`, so your emitted metric key should match the panel `key`.

## 2. Minimal Example

```json
{
  "dashboard": {
    "panels": [
      {
        "type": "counter-group",
        "key": "taskSummary",
        "label": "Tasks",
        "counters": [
          { "key": "pending", "label": "Pending", "color": "yellow" },
          { "key": "done", "label": "Done", "color": "green" }
        ]
      },
      {
        "type": "progress",
        "key": "taskProgress",
        "label": "Progress",
        "format": "{value} / {max}"
      },
      {
        "type": "table",
        "key": "taskBoard",
        "label": "Task Board",
        "sortable": true,
        "filterable": ["status", "assignedTo"],
        "columns": [
          { "key": "title", "label": "Task" },
          { "key": "assignedTo", "label": "Worker", "width": 120 },
          { "key": "status", "label": "Status", "width": 90 }
        ]
      }
    ]
  }
}
```

## 3. Emit Matching Metrics

Inside plugin hooks:

```js
ctx.emitMetrics({
  taskSummary: { pending: 3, done: 5 },
  taskProgress: { value: 5, max: 8 },
  taskBoard: {
    rows: [
      { title: 'Fix auth timeout', assignedTo: 'Worker 1', status: 'in_progress' },
      { title: 'Patch webhook retry', assignedTo: 'Worker 2', status: 'pending' },
    ],
  },
});
```

If you emit a panel key with no data, the UI shows a "No data" state.

## 4. Supported Panel Types

### `counter-group`

Panel config:

- `counters`: array of `{ key, label, color? }`

Metrics shape:

- object with numeric-ish values at each counter key

Notes:

- known colors: `red`, `orange`, `yellow`, `green`

### `progress`

Panel config:

- optional `format` string, e.g. `"{value} / {max}"` or `"{value}%"`

Metrics shape:

- `{ value: number, max: number }`

### `phase`

Panel config:

- `phases`: string array in display order
- optional `phaseLabels`: `{ [phaseKey]: label }`

Metrics shape:

- `{ active: string }`

Notes:

- phase is shown in the controls bar (not in the main panel grid).

### `bar-chart`

Panel config:

- `series`: array of `{ key, label, color? }`

Metrics shape:

- `{ labels: string[], series: { [seriesKey]: number[] } }`

Each series array should align by index with `labels`.

### `agent-status`

Panel config:

- no extra required fields (optional `states` metadata is fine)

Metrics shape:

- object map: `{ [agentIdOrName]: status }`

### `table`

Panel config:

- `columns`: array of `{ key, label, width? }`
- optional `sortable`: boolean
- optional `filterable`: string array of column keys

Metrics shape:

- `{ rows: object[] }`

### `conversation-feed`

Panel config:

- no extra required fields

Metrics shape:

- `{ entries: [{ agentId?, displayName?, role?, content? }], typing? }`

`typing` can be:

- `{ agentId?, displayName? }`

## 5. Layout Behavior

Room dashboard layout is type-aware:

- `phase` panel renders in the top control bar
- `conversation-feed` and `table` panels render in full-width sections below the top grid
- all other panel types render in the top metric grid

## 6. Validation Reality

Manifest validation currently enforces:

- `dashboard` must be an object
- `dashboard.panels` must be an array

It does not deeply validate panel-specific fields, so malformed panel config may load but render poorly.
