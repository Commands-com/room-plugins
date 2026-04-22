export function createInitialState(ctx) {
  const contestants = ctx.participants.filter((participant) => participant.role === 'contestant').slice(0, 2);
  const judge = ctx.participants.find((participant) => participant.role === 'judge');
  if (contestants.length < 2 || !judge) return null;

  const cfg = ctx.roomConfig || ctx.orchestratorConfig || {};
  const totalRounds = Math.max(1, Math.min(10, Number(cfg.rounds) || 3));

  const scores = {};
  scores[contestants[0].agentId] = 0;
  scores[contestants[1].agentId] = 0;

  return {
    totalRounds,
    currentRound: 1,
    phase: 'challenge',
    contestants,
    judge,
    scores,
    draws: 0,
    rounds: [],
    judgeFeedEntries: [],
  };
}
