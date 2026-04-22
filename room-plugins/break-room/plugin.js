/**
 * Break Room Orchestrator Plugin — live conversational simulator.
 *
 * Decision model:
 * - One speaker per turn (`speak` decisions only)
 * - No same-speaker consecutive turns
 * - Weighted speaker lottery with deterministic PRNG
 * - Direct-address override (`@Name`, `Name,`, `Name:`, or agentId mention)
 */

import {
  AGENT_ROLES,
  DECISION_TYPES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';

import { normalizeConfig, updateTargetBubblesForRosterChange } from './config.js';
import {
  MAX_TRANSCRIPT_ENTRIES,
  PLUGIN_ID,
} from './constants.js';
import { manifest } from './manifest.js';
import { emitMetrics } from './metrics.js';
import { buildSpeakPrompt } from './prompts.js';
import { chooseNextSpeaker, getActiveParticipants } from './speaker-selection.js';
import { detectDirectAddress, hashStringToUint32, truncateForTurnLog } from './text-utils.js';

export default function createBreakRoomPlugin() {
  return {
    id: PLUGIN_ID,
    manifest,

    init(ctx) {
      const workers = ctx.participants.filter((participant) => participant.role === AGENT_ROLES.WORKER);
      const config = normalizeConfig(ctx);
      const rounds = config.rounds;
      const targetBubbles = rounds * workers.length;
      const speakerStats = {};
      for (const participant of workers) {
        speakerStats[participant.agentId] = {
          displayName: participant.displayName,
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
      const speaker = ctx.participants.find((participant) => participant.agentId === speakerId);
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

    onFanOutComplete() {
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
        ctx.setCycle(state.completedRounds);
        emitMetrics(ctx, state);

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

      return null;
    },

    refreshPendingDecision(ctx, pendingDecision) {
      if (!pendingDecision || pendingDecision.type !== DECISION_TYPES.SPEAK) {
        return pendingDecision;
      }
      const state = ctx.getState();
      const speaker = ctx.participants.find((participant) => participant.agentId === pendingDecision.agentId);
      if (!speaker) return pendingDecision;
      return {
        ...pendingDecision,
        message: buildSpeakPrompt(ctx, state, speaker),
      };
    },

    shutdown() {
      // No-op.
    },
  };
}
