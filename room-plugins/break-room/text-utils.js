import { TURN_LOG_MAX_CONTENT_LENGTH } from './constants.js';

export function truncateForTurnLog(text) {
  const raw = text || '';
  if (raw.length <= TURN_LOG_MAX_CONTENT_LENGTH) {
    return raw;
  }
  return `${raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH)}\n... [truncated]`;
}

export function hashStringToUint32(input) {
  const text = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

export function nextRandom(state) {
  let x = state.randomState >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.randomState = x >>> 0 || 1;
  return (state.randomState >>> 0) / 4294967296;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectDirectAddress(text, participants) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const participant of participants) {
    if (!participant || !participant.agentId) continue;
    const display = String(participant.displayName || '');
    const id = String(participant.agentId || '');
    const patterns = [];
    if (display) {
      const escaped = escapeRegex(display);
      patterns.push(new RegExp(`@${escaped}\\b`, 'i'));
      patterns.push(new RegExp(`\\b${escaped}\\s*[,:]`, 'i'));
    }
    if (id) {
      patterns.push(new RegExp(`\\b${escapeRegex(id)}\\b`, 'i'));
    }
    if (patterns.some((re) => re.test(text))) {
      return participant.agentId;
    }
  }
  return null;
}
