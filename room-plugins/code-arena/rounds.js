import { emitMetrics } from './metrics.js';
import { buildChallengeInventionPrompt } from './prompts.js';

export function startRound(ctx, state) {
  state.rounds.push({
    roundNum: state.currentRound,
    challenge: null,
    solution1: null,
    solution2: null,
    winner: null,
    contestant1Score: null,
    contestant2Score: null,
    commentary: null,
  });

  state.phase = 'challenge';
  ctx.setState(state);
  emitMetrics(ctx, state, 'challenge', state.judge);

  const previousChallenges = state.rounds.slice(0, -1).map((round) => round.challenge?.title).filter(Boolean);

  return {
    type: 'speak',
    agentId: state.judge.agentId,
    message: buildChallengeInventionPrompt(state.currentRound, state.totalRounds, previousChallenges, ctx.objective),
  };
}
