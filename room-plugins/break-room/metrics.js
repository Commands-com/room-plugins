import { getActiveParticipants } from './speaker-selection.js';

export function emitMetrics(ctx, state, inFlightSpeakerId = null) {
  const active = getActiveParticipants(ctx, state);
  const completed = state.bubbleIndex;
  const remaining = Math.max(0, state.targetBubbles - state.bubbleIndex);
  const roundValue = Math.min(state.rounds, state.completedRounds + (state.bubbleIndex >= state.targetBubbles ? 0 : 1));
  const roundMax = Math.max(1, state.rounds);
  const rows = ctx.participants
    .filter((participant) => participant.role === 'worker')
    .map((participant) => {
      const stats = state.speakerStats[participant.agentId];
      const count = Number(stats?.bubbleCount || 0);
      const pct = state.bubbleIndex > 0 ? (count / state.bubbleIndex) * 100 : 0;
      return {
        agentId: participant.agentId,
        displayName: participant.displayName,
        bubbleCount: count,
        pct: `${pct.toFixed(1)}%`,
        addressed: Number(stats?.addressed || 0),
      };
    });

  const statuses = {};
  const disconnected = new Set(state.disconnectedIds || []);
  for (const participant of ctx.participants.filter((entry) => entry.role === 'worker')) {
    if (disconnected.has(participant.agentId)) {
      statuses[participant.displayName] = 'disconnected';
    } else if (inFlightSpeakerId && participant.agentId === inFlightSpeakerId) {
      statuses[participant.displayName] = 'speaking';
    } else {
      statuses[participant.displayName] = 'idle';
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
          const participant = active.find((entry) => entry.agentId === inFlightSpeakerId)
            || ctx.participants.find((entry) => entry.agentId === inFlightSpeakerId);
          return participant ? { agentId: participant.agentId, displayName: participant.displayName } : null;
        })()
        : null,
    },
    speakerStatus: statuses,
    speakerStats: { rows },
    turnLog: { entries: state.turnLog },
  });
}
