# Getting Started (Rooms)

## 1. Install room plugins

```bash
cd /Users/dtannen/Code/commands-com-agent-rooms
./scripts/install-room-plugins.sh
```

## 2. Restart Commands Desktop

Close and reopen desktop so the room plugin registry reloads.

## 3. Verify plugin appears

In Desktop:

1. Open room creation.
2. Check orchestrator type list.
3. Confirm `template_room` appears.

## 4. Create a test room

Create a room with `template_room` and at least one worker participant.

The template fans out one request to workers, then stops with a summary reason.

## 5. Build your own room type

Duplicate template:

```bash
cp -R ./room-plugins/template-room ./room-plugins/my-room
```

Then edit:

- `./room-plugins/my-room/manifest.json`
- `./room-plugins/my-room/index.js`

Regenerate allowlist:

```bash
node ./scripts/generate-room-allowlist.mjs \
  ~/.commands-agent/room-plugins \
  ~/.commands-agent/room-plugins-allowed.json
```
