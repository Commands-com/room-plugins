import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function createPlugin() {
  const state = {
    startedAt: null,
    fanOutIssued: false,
  };

  function init() {
    state.startedAt = Date.now();
  }

  function onRoomStart(ctx) {
    const participants = Array.isArray(ctx?.participants) ? ctx.participants : [];
    const workers = participants.filter((p) => p?.role === 'worker' && p?.agentId);

    if (workers.length === 0) {
      return {
        type: 'stop',
        reason: 'template_room requires at least one worker participant',
      };
    }

    state.fanOutIssued = true;
    const objective = safeTrim(ctx?.objective, 2000) || 'No objective provided.';

    return {
      type: 'fan_out',
      targets: workers.map((worker) => ({
        agentId: worker.agentId,
        message: `Template task for ${worker.displayName || worker.agentId}: ${objective}`,
      })),
    };
  }

  function onFanOutComplete(_ctx, responses) {
    const count = Array.isArray(responses) ? responses.length : 0;
    return {
      type: 'stop',
      reason: `template_room completed one fan-out cycle (${count} responses)`,
    };
  }

  function onTurnResult(_ctx, turnResult) {
    const agentId = safeTrim(turnResult?.agentId, 200) || 'unknown';
    return {
      type: 'stop',
      reason: `template_room single-turn completed by ${agentId}`,
    };
  }

  function onEvent(_ctx, event) {
    if (event?.type === 'participant_disconnected') {
      return {
        type: 'pause',
      };
    }
    return null;
  }

  function onResume() {
    return null;
  }

  function refreshPendingDecision(_ctx, decision) {
    return decision;
  }

  function shutdown() {
    // No-op for template cleanup.
  }

  return {
    init,
    onRoomStart,
    onTurnResult,
    onFanOutComplete,
    onEvent,
    onResume,
    refreshPendingDecision,
    shutdown,
  };
}

export default {
  manifest,
  createPlugin,
};

export { manifest, createPlugin };
