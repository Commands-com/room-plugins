/**
 * Break Room Orchestrator Plugin — live conversational simulator.
 *
 * Decision model:
 * - One speaker per turn (`speak` decisions only)
 * - No same-speaker consecutive turns
 * - Weighted speaker lottery with deterministic PRNG
 * - Direct-address override (`@Name`, `Name,`, `Name:`, or agentId mention)
 *
 * This module is pure decision logic (no Electron deps).
 */

import {
  AGENT_ROLES,
  DECISION_TYPES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';

const PLUGIN_ID = 'break_room';
const TURN_LOG_MAX_CONTENT_LENGTH = 20_000;
const MAX_TRANSCRIPT_ENTRIES = 400;
const TRANSCRIPT_WINDOW = 12;

const MANIFEST = Object.freeze({
  id: PLUGIN_ID,
  name: 'Break Room',
  version: '1.0.0',
  orchestratorType: 'break_room',
  description: 'Live multi-agent conversational simulator for open-ended ideation',
  supportsQuorum: false,
  roles: Object.freeze({
    required: Object.freeze(['worker']),
    optional: Object.freeze([]),
    forbidden: Object.freeze(['implementer', 'reviewer']),
    minCount: Object.freeze({ worker: 2 }),
  }),
  limits: Object.freeze({
    maxCycles: Object.freeze({ default: 5, min: 1, max: 50 }),
    maxTurns: Object.freeze({ default: 40, min: 1, max: 1000 }),
    maxDurationMs: Object.freeze({ default: 10_800_000, max: 43_200_000 }),
    maxFailures: Object.freeze({ default: 3 }),
    agentTimeoutMs: Object.freeze({ default: 1_800_000 }),
    pluginHookTimeoutMs: Object.freeze({ default: 30_000 }),
    llmTimeoutMs: Object.freeze({ default: 60_000, max: 300_000 }),
    turnFloorRole: 'worker',
    turnFloorFormula: '1 + N',
  }),
  endpointConstraints: Object.freeze({
    requiresLocalParticipant: true,
    perRole: Object.freeze({}),
  }),
  dashboard: Object.freeze({
    panels: Object.freeze([
      Object.freeze({
        type: 'counter-group',
        key: 'bubbleSummary',
        label: 'Bubbles',
        layout: 'row',
        counters: Object.freeze([
          Object.freeze({ key: 'completed', label: 'Done', color: 'green' }),
          Object.freeze({ key: 'remaining', label: 'Left', color: 'yellow' }),
        ]),
      }),
      Object.freeze({
        type: 'progress',
        key: 'roundProgress',
        label: 'Round Progress',
        format: '{value} / {max}',
      }),
      Object.freeze({
        type: 'conversation-feed',
        key: 'conversationFeed',
        label: 'Conversation',
      }),
      Object.freeze({
        type: 'table',
        key: 'speakerStats',
        label: 'Speaker Stats',
        sortable: true,
        columns: Object.freeze([
          Object.freeze({ key: 'displayName', label: 'Name' }),
          Object.freeze({ key: 'bubbleCount', label: 'Bubbles', width: 70 }),
          Object.freeze({ key: 'pct', label: '%', width: 60 }),
          Object.freeze({ key: 'addressed', label: 'Addressed', width: 80 }),
        ]),
      }),
    ]),
  }),
  display: Object.freeze({
    typeLabel: 'Break Room',
    typeTag: 'BR',
    cycleNoun: 'Round',
    reportTitle: 'Break Room Transcript',
    activityMessages: Object.freeze({
      idle: 'Waiting...',
      fanOut: 'Conversation in progress',
      singleTurn: 'Participant speaking',
      synthesis: 'Wrapping up',
      planning: 'Starting conversation...',
    }),
    defaultRoster: Object.freeze([
      Object.freeze({ role: 'worker', displayName: 'Participant 1' }),
      Object.freeze({ role: 'worker', displayName: 'Participant 2' }),
      Object.freeze({ role: 'worker', displayName: 'Participant 3' }),
    ]),
    defaultAddRole: 'worker',
  }),
  report: Object.freeze({
    summaryMetrics: Object.freeze(['bubbleSummary']),
    table: Object.freeze({
      metricKey: 'speakerStats',
      columns: Object.freeze([
        Object.freeze({ key: 'displayName', label: 'Name' }),
        Object.freeze({ key: 'bubbleCount', label: 'Bubbles', width: 70 }),
        Object.freeze({ key: 'pct', label: '%', width: 60 }),
        Object.freeze({ key: 'addressed', label: 'Addressed', width: 80 }),
      ]),
    }),
  }),
  configSchema: Object.freeze({
    rounds: Object.freeze({ type: 'integer', min: 1, max: 50, default: 5 }),
    thirdParticipantChimePct: Object.freeze({ type: 'integer', min: 0, max: 45, default: 25 }),
    extraParticipantDecayExponent: Object.freeze({ type: 'number', min: 1, max: 3, default: 1.5 }),
  }),
});

function truncateForTurnLog(text) {
  const raw = text || '';
  if (raw.length <= TURN_LOG_MAX_CONTENT_LENGTH) {
    return raw;
  }
  return `${raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH)}\n... [truncated]`;
}

function hashStringToUint32(input) {
  const text = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

function nextRandom(state) {
  let x = state.randomState >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.randomState = x >>> 0 || 1;
  return (state.randomState >>> 0) / 4294967296;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectDirectAddress(text, participants) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const p of participants) {
    if (!p || !p.agentId) continue;
    const display = String(p.displayName || '');
    const id = String(p.agentId || '');
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
      return p.agentId;
    }
  }
  return null;
}

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

  // First two participants form the "core pair".
  const coreShare = (1 - x) / 2;
  shares.set(activeSpeakers[0].agentId, coreShare);
  shares.set(activeSpeakers[1].agentId, coreShare);

  if (n === 3) {
    shares.set(activeSpeakers[2].agentId, x);
    return shares;
  }

  const extras = activeSpeakers.slice(2);
  if (x === 0) {
    for (const p of extras) {
      shares.set(p.agentId, 0);
    }
    return shares;
  }

  const raw = extras.map((_, i) => 1 / ((i + 1) ** decay));
  const rawSum = raw.reduce((acc, v) => acc + v, 0);
  for (let i = 0; i < extras.length; i += 1) {
    const share = rawSum > 0 ? (x * raw[i]) / rawSum : 0;
    shares.set(extras[i].agentId, share);
  }
  return shares;
}

function weightedPick(candidates, weights, state) {
  const safeWeights = candidates.map((p) => Math.max(0, Number(weights.get(p.agentId) || 0)));
  const total = safeWeights.reduce((acc, w) => acc + w, 0);
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

function buildSpeakPrompt(ctx, state, speaker) {
  const transcriptWindow = state.transcript.slice(-TRANSCRIPT_WINDOW);
  const transcriptText = transcriptWindow.length === 0
    ? '(Conversation just started)'
    : transcriptWindow.map((entry) => {
      const name = entry.displayName || entry.agentId;
      return `${name}: ${entry.content || ''}`;
    }).join('\n');

  const addressedLine = state.pendingAddressContext
    ? `You were directly addressed by ${state.pendingAddressContext.fromDisplayName || state.pendingAddressContext.fromAgentId}. Reply to them first.`
    : 'Continue the conversation naturally.';

  const roundNow = Math.min(state.rounds, state.completedRounds + 1);
  const positionInRound = state.nCurrent > 0 ? (state.epochBubbleIndex + 1) : 1;

  return [
    `You are ${speaker.displayName} in a multi-agent break room conversation.`,
    '',
    `Objective/topic: ${ctx.objective}`,
    `Round ${roundNow}/${state.rounds}, turn ${positionInRound}/${state.nCurrent}`,
    '',
    addressedLine,
    'Write one conversational message (2-6 sentences).',
    'Be specific, playful, and collaborative. Avoid task-list formatting and avoid JSON.',
    '',
    'Recent conversation:',
    transcriptText,
  ].join('\n');
}

function getActiveParticipants(ctx, state) {
  const disconnected = new Set(state.disconnectedIds || []);
  return ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER && !disconnected.has(p.agentId));
}

function chooseNextSpeaker(ctx, state, { forcedSpeakerId = null } = {}) {
  const active = getActiveParticipants(ctx, state);
  if (active.length < 2) return { stop: true, reason: 'fewer than 2 active participants' };

  const nonConsecutive = active.filter((p) => p.agentId !== state.lastSpeakerId);
  if (nonConsecutive.length === 0) {
    return { stop: true, reason: 'no eligible speaker after no-consecutive rule' };
  }

  if (forcedSpeakerId && nonConsecutive.some((p) => p.agentId === forcedSpeakerId)) {
    return { speaker: nonConsecutive.find((p) => p.agentId === forcedSpeakerId), forced: true };
  }

  const queuedId = state.queuedAddressedSpeakerId;
  if (queuedId && nonConsecutive.some((p) => p.agentId === queuedId)) {
    state.queuedAddressedSpeakerId = null;
    return { speaker: nonConsecutive.find((p) => p.agentId === queuedId), forced: true };
  }

  if (queuedId && !active.some((p) => p.agentId === queuedId)) {
    state.queuedAddressedSpeakerId = null;
    state.pendingAddressContext = null;
  }

  const baseShares = buildBaseShares(active, state.config);
  const weights = new Map();
  for (const p of nonConsecutive) {
    const stats = state.speakerStats[p.agentId] || {};
    const lastSpokeAt = Number(stats.lastSpokeTurn);
    const turnsSinceLastSpoke = Number.isFinite(lastSpokeAt)
      ? Math.max(0, state.bubbleIndex - lastSpokeAt)
      : state.bubbleIndex + 1;
    const silenceBoost = 1 + (Math.min(turnsSinceLastSpoke, 4) * 0.15);
    const base = Number(baseShares.get(p.agentId) || 0);
    weights.set(p.agentId, base * silenceBoost);
  }

  return { speaker: weightedPick(nonConsecutive, weights, state), forced: false };
}

function emitMetrics(ctx, state, inFlightSpeakerId = null) {
  const active = getActiveParticipants(ctx, state);
  const completed = state.bubbleIndex;
  const remaining = Math.max(0, state.targetBubbles - state.bubbleIndex);
  const roundValue = Math.min(state.rounds, state.completedRounds + (state.bubbleIndex >= state.targetBubbles ? 0 : 1));
  const roundMax = Math.max(1, state.rounds);
  const rows = ctx.participants
    .filter((p) => p.role === AGENT_ROLES.WORKER)
    .map((p) => {
      const stats = state.speakerStats[p.agentId];
      const count = Number(stats?.bubbleCount || 0);
      const pct = state.bubbleIndex > 0 ? (count / state.bubbleIndex) * 100 : 0;
      return {
        agentId: p.agentId,
        displayName: p.displayName,
        bubbleCount: count,
        pct: `${pct.toFixed(1)}%`,
        addressed: Number(stats?.addressed || 0),
      };
    });

  const statuses = {};
  const disconnected = new Set(state.disconnectedIds || []);
  for (const p of ctx.participants.filter((x) => x.role === AGENT_ROLES.WORKER)) {
    if (disconnected.has(p.agentId)) {
      statuses[p.displayName] = 'disconnected';
    } else if (inFlightSpeakerId && p.agentId === inFlightSpeakerId) {
      statuses[p.displayName] = 'speaking';
    } else {
      statuses[p.displayName] = 'idle';
    }
  }

  ctx.emitMetrics({
    bubbleSummary: {
      completed,
      remaining,
    },
    roundProgress: {
      value: roundValue,
      max: roundMax,
    },
    conversationFeed: {
      entries: state.transcript,
      typing: inFlightSpeakerId
        ? (() => {
          const p = active.find((a) => a.agentId === inFlightSpeakerId)
            || ctx.participants.find((a) => a.agentId === inFlightSpeakerId);
          return p ? { agentId: p.agentId, displayName: p.displayName } : null;
        })()
        : null,
    },
    speakerStatus: statuses,
    speakerStats: { rows },
    turnLog: { entries: state.turnLog },
  });
}

function normalizeConfig(ctx) {
  const cfg = ctx.orchestratorConfig || {};
  const rounds = Number.isFinite(Number(cfg.rounds)) ? Math.floor(Number(cfg.rounds)) : 5;
  const thirdParticipantChimePct = Number.isFinite(Number(cfg.thirdParticipantChimePct))
    ? Math.floor(Number(cfg.thirdParticipantChimePct))
    : 25;
  const extraParticipantDecayExponent = Number.isFinite(Number(cfg.extraParticipantDecayExponent))
    ? Number(cfg.extraParticipantDecayExponent)
    : 1.5;

  return {
    rounds: Math.max(1, Math.min(50, rounds)),
    thirdParticipantChimePct: Math.max(0, Math.min(45, thirdParticipantChimePct)),
    extraParticipantDecayExponent: Math.max(1, Math.min(3, extraParticipantDecayExponent)),
  };
}

function updateTargetBubblesForRosterChange(state, activeCount) {
  state.nCurrent = Math.max(1, activeCount);
  // Treat the in-progress partial round as completed on roster change so that
  // remaining bubble accounting does not over-count. A truncated round (where
  // a disconnected participant's turn is skipped) counts as a finished epoch.
  if (state.epochBubbleIndex > 0) {
    state.completedRounds += 1;
  }
  state.epochBubbleIndex = 0;
  const remainingRounds = Math.max(0, state.rounds - state.completedRounds);
  state.targetBubbles = state.bubbleIndex + (remainingRounds * state.nCurrent);
}

export default function createBreakRoomPlugin() {
  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    init(ctx) {
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      const config = normalizeConfig(ctx);
      const rounds = config.rounds;
      const targetBubbles = rounds * workers.length;
      const speakerStats = {};
      for (const p of workers) {
        speakerStats[p.agentId] = {
          displayName: p.displayName,
          bubbleCount: 0,
          addressed: 0,
          lastSpokeTurn: null,
        };
      }

      ctx.setState({
        config,
        rounds,
        targetBubbles,
        bubbleIndex: 0,
        completedRounds: 0,
        nCurrent: workers.length,
        epochBubbleIndex: 0,
        lastSpeakerId: null,
        queuedAddressedSpeakerId: null,
        pendingAddressContext: null,
        disconnectedIds: [],
        transcript: [],
        turnLog: [],
        speakerStats,
        randomState: hashStringToUint32(ctx.roomId),
      });

      ctx.emitMetrics({
        roundProgress: { value: 1, max: rounds },
      });
    },

    onRoomStart(ctx) {
      const state = ctx.getState();
      emitMetrics(ctx, state);

      const next = chooseNextSpeaker(ctx, state);
      if (next.stop || !next.speaker) {
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
      }

      emitMetrics(ctx, state, next.speaker.agentId);
      ctx.setState(state);
      return {
        type: DECISION_TYPES.SPEAK,
        agentId: next.speaker.agentId,
        message: buildSpeakPrompt(ctx, state, next.speaker),
      };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      const speakerId = turnResult?.agentId || '';
      const speaker = ctx.participants.find((p) => p.agentId === speakerId);
      if (!speaker) {
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
      }

      state.bubbleIndex += 1;
      state.lastSpeakerId = speakerId;
      state.epochBubbleIndex += 1;
      if (state.nCurrent > 0 && state.epochBubbleIndex >= state.nCurrent) {
        state.completedRounds += 1;
        state.epochBubbleIndex = 0;
        ctx.setCycle(state.completedRounds);
      }

      const stats = state.speakerStats[speakerId] || {
        displayName: speaker.displayName,
        bubbleCount: 0,
        addressed: 0,
        lastSpokeTurn: null,
      };
      stats.bubbleCount += 1;
      stats.lastSpokeTurn = state.bubbleIndex;
      state.speakerStats[speakerId] = stats;

      const content = String(turnResult?.response || '').trim();
      const transcriptEntry = {
        turn: state.bubbleIndex,
        agentId: speakerId,
        displayName: speaker.displayName,
        role: speaker.role,
        content,
      };
      state.transcript.push(transcriptEntry);
      if (state.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
        state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT_ENTRIES);
      }

      const roundLabel = Math.min(state.rounds, state.completedRounds + (state.epochBubbleIndex > 0 ? 1 : 0));
      state.turnLog.push({
        cycle: roundLabel,
        role: 'worker',
        agent: speaker.displayName || speakerId,
        content: truncateForTurnLog(content),
      });
      if (state.turnLog.length > MAX_TRANSCRIPT_ENTRIES) {
        state.turnLog.splice(0, state.turnLog.length - MAX_TRANSCRIPT_ENTRIES);
      }

      // Parse direct addresses from the latest bubble.
      const activeParticipants = getActiveParticipants(ctx, state);
      const addressedId = detectDirectAddress(content, activeParticipants);
      let forcedSpeakerId = null;
      if (addressedId && addressedId !== state.lastSpeakerId) {
        forcedSpeakerId = addressedId;
        state.pendingAddressContext = {
          fromAgentId: speakerId,
          fromDisplayName: speaker.displayName,
        };
      } else if (addressedId && addressedId === state.lastSpeakerId) {
        state.queuedAddressedSpeakerId = addressedId;
        state.pendingAddressContext = {
          fromAgentId: speakerId,
          fromDisplayName: speaker.displayName,
        };
      } else {
        state.pendingAddressContext = null;
      }

      if (state.bubbleIndex >= state.targetBubbles) {
        emitMetrics(ctx, state);
        ctx.setState(state);
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE };
      }

      const next = chooseNextSpeaker(ctx, state, { forcedSpeakerId });
      if (next.stop || !next.speaker) {
        emitMetrics(ctx, state);
        ctx.setState(state);
        return {
          type: DECISION_TYPES.STOP,
          reason: STOP_REASON.PLUGIN_STOP,
        };
      }

      if (next.forced) {
        const nextStats = state.speakerStats[next.speaker.agentId];
        if (nextStats) nextStats.addressed += 1;
        state.queuedAddressedSpeakerId = null;
      }

      emitMetrics(ctx, state, next.speaker.agentId);
      ctx.setState(state);
      return {
        type: DECISION_TYPES.SPEAK,
        agentId: next.speaker.agentId,
        message: buildSpeakPrompt(ctx, state, next.speaker),
      };
    },

    onFanOutComplete(_ctx, _responses) {
      return { type: DECISION_TYPES.PAUSE, reason: 'break_room does not use fan_out' };
    },

    onEvent(ctx, event) {
      const state = ctx.getState();
      if (event?.type === 'participant_disconnected' && event.agentId) {
        if (!state.disconnectedIds.includes(event.agentId)) {
          state.disconnectedIds.push(event.agentId);
        }

        const active = getActiveParticipants(ctx, state);
        if (active.length < 2) {
          ctx.setState(state);
          return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
        }

        updateTargetBubblesForRosterChange(state, active.length);
        // Sync runtime cycle metadata after partial-round completion
        ctx.setCycle(state.completedRounds);
        emitMetrics(ctx, state);

        // Return a fresh decision so the runtime can continue the conversation
        // without preserving a stale SPEAK targeting the disconnected agent.
        const next = chooseNextSpeaker(ctx, state);
        if (next.stop || !next.speaker) {
          ctx.setState(state);
          return { type: DECISION_TYPES.STOP, reason: STOP_REASON.PLUGIN_STOP };
        }

        emitMetrics(ctx, state, next.speaker.agentId);
        ctx.setState(state);
        return {
          type: DECISION_TYPES.SPEAK,
          agentId: next.speaker.agentId,
          message: buildSpeakPrompt(ctx, state, next.speaker),
        };
      }
    },

    refreshPendingDecision(ctx, pendingDecision) {
      if (!pendingDecision || pendingDecision.type !== DECISION_TYPES.SPEAK) {
        return pendingDecision;
      }
      const state = ctx.getState();
      const speaker = ctx.participants.find((p) => p.agentId === pendingDecision.agentId);
      if (!speaker) return pendingDecision;
      return {
        ...pendingDecision,
        message: buildSpeakPrompt(ctx, state, speaker),
      };
    },

    shutdown() {},
  };
}
