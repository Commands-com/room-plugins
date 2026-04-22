import { AGENT_ROLES } from '../core-room-support/room-contracts.js';

import { nextRandom } from './text-utils.js';

function buildBaseShares(activeSpeakers, config) {
  const n = activeSpeakers.length;
  if (n === 0) return new Map();

  const xPct = Number(config.thirdParticipantChimePct);
  const x = Math.max(0, Math.min(45, Number.isFinite(xPct) ? xPct : 25)) / 100;
  const decay = Number.isFinite(Number(config.extraParticipantDecayExponent))
    ? Math.max(1, Math.min(3, Number(config.extraParticipantDecayExponent)))
    : 1.5;

  const shares = new Map();
  if (n === 1) {
    shares.set(activeSpeakers[0].agentId, 1);
    return shares;
  }

  if (n === 2) {
    shares.set(activeSpeakers[0].agentId, 0.5);
    shares.set(activeSpeakers[1].agentId, 0.5);
    return shares;
  }

  const coreShare = (1 - x) / 2;
  shares.set(activeSpeakers[0].agentId, coreShare);
  shares.set(activeSpeakers[1].agentId, coreShare);

  if (n === 3) {
    shares.set(activeSpeakers[2].agentId, x);
    return shares;
  }

  const extras = activeSpeakers.slice(2);
  if (x === 0) {
    for (const participant of extras) {
      shares.set(participant.agentId, 0);
    }
    return shares;
  }

  const raw = extras.map((_, i) => 1 / ((i + 1) ** decay));
  const rawSum = raw.reduce((acc, value) => acc + value, 0);
  for (let i = 0; i < extras.length; i += 1) {
    const share = rawSum > 0 ? (x * raw[i]) / rawSum : 0;
    shares.set(extras[i].agentId, share);
  }
  return shares;
}

function weightedPick(candidates, weights, state) {
  const safeWeights = candidates.map((participant) => Math.max(0, Number(weights.get(participant.agentId) || 0)));
  const total = safeWeights.reduce((acc, weight) => acc + weight, 0);
  if (total <= 0) {
    const idx = Math.floor(nextRandom(state) * candidates.length);
    return candidates[Math.max(0, Math.min(candidates.length - 1, idx))];
  }

  const roll = nextRandom(state) * total;
  let cumulative = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    cumulative += safeWeights[i];
    if (roll <= cumulative) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

export function getActiveParticipants(ctx, state) {
  const disconnected = new Set(state.disconnectedIds || []);
  return ctx.participants.filter((participant) => participant.role === AGENT_ROLES.WORKER && !disconnected.has(participant.agentId));
}

export function chooseNextSpeaker(ctx, state, { forcedSpeakerId = null } = {}) {
  const active = getActiveParticipants(ctx, state);
  if (active.length < 2) return { stop: true, reason: 'fewer than 2 active participants' };

  const nonConsecutive = active.filter((participant) => participant.agentId !== state.lastSpeakerId);
  if (nonConsecutive.length === 0) {
    return { stop: true, reason: 'no eligible speaker after no-consecutive rule' };
  }

  if (forcedSpeakerId && nonConsecutive.some((participant) => participant.agentId === forcedSpeakerId)) {
    return { speaker: nonConsecutive.find((participant) => participant.agentId === forcedSpeakerId), forced: true };
  }

  const queuedId = state.queuedAddressedSpeakerId;
  if (queuedId && nonConsecutive.some((participant) => participant.agentId === queuedId)) {
    state.queuedAddressedSpeakerId = null;
    return { speaker: nonConsecutive.find((participant) => participant.agentId === queuedId), forced: true };
  }

  if (queuedId && !active.some((participant) => participant.agentId === queuedId)) {
    state.queuedAddressedSpeakerId = null;
    state.pendingAddressContext = null;
  }

  const baseShares = buildBaseShares(active, state.config);
  const weights = new Map();
  for (const participant of nonConsecutive) {
    const stats = state.speakerStats[participant.agentId] || {};
    const lastSpokeAt = Number(stats.lastSpokeTurn);
    const turnsSinceLastSpoke = Number.isFinite(lastSpokeAt)
      ? Math.max(0, state.bubbleIndex - lastSpokeAt)
      : state.bubbleIndex + 1;
    const silenceBoost = 1 + (Math.min(turnsSinceLastSpoke, 4) * 0.15);
    const base = Number(baseShares.get(participant.agentId) || 0);
    weights.set(participant.agentId, base * silenceBoost);
  }

  return { speaker: weightedPick(nonConsecutive, weights, state), forced: false };
}
