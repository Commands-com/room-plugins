/**
 * Code Arena — head-to-head AI coding tournament.
 *
 * Two contestants solve challenges invented by a judge.
 * The judge evaluates solutions and picks a round winner.
 * Best-of-N rounds with tournament-style progression.
 */

import { manifest } from './manifest.js';
import { emitMetrics } from './metrics.js';
import { extractCode, parseChallenge, parseVerdict } from './parsers.js';
import {
  buildContestantPrompt,
  buildJudgingPrompt,
} from './prompts.js';
import { startRound } from './rounds.js';
import { createInitialState } from './state.js';

function createPlugin() {
  return {
    init(ctx) {
      const state = createInitialState(ctx);
      if (!state) return;
      ctx.setState(state);
    },

    onRoomStart(ctx) {
      return startRound(ctx, ctx.getState());
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      const response = String(turnResult?.response || '');
      const currentRound = state.rounds[state.rounds.length - 1];

      if (state.phase === 'challenge') {
        const challenge = parseChallenge(response);
        currentRound.challenge = challenge;

        const announcement = response.replace(/```(?:json)?\s*\n?[\s\S]*?```/, '').trim();
        state.judgeFeedEntries.push({
          agentId: state.judge.agentId,
          displayName: state.judge.displayName,
          role: 'judge',
          content: announcement || `**Round ${state.currentRound} Challenge: ${challenge.title}**\n\n${challenge.description}`,
        });

        state.phase = 'coding';
        ctx.setState(state);
        emitMetrics(ctx, state, 'coding');

        const contestant1 = state.contestants[0];
        const contestant2 = state.contestants[1];
        return {
          type: 'fan_out',
          targets: [
            {
              agentId: contestant1.agentId,
              message: buildContestantPrompt(challenge, state.currentRound, state.totalRounds, contestant1.displayName, contestant2.displayName),
            },
            {
              agentId: contestant2.agentId,
              message: buildContestantPrompt(challenge, state.currentRound, state.totalRounds, contestant2.displayName, contestant1.displayName),
            },
          ],
        };
      }

      if (state.phase === 'judging') {
        const contestant1 = state.contestants[0];
        const contestant2 = state.contestants[1];
        const verdict = parseVerdict(response, contestant1, contestant2);

        currentRound.winner = verdict.winner;
        currentRound.contestant1Score = verdict.contestant1Score;
        currentRound.contestant2Score = verdict.contestant2Score;
        currentRound.commentary = verdict.commentary;

        if (verdict.winner === contestant1.displayName) {
          state.scores[contestant1.agentId] = (state.scores[contestant1.agentId] || 0) + 1;
        } else if (verdict.winner === contestant2.displayName) {
          state.scores[contestant2.agentId] = (state.scores[contestant2.agentId] || 0) + 1;
        } else {
          state.draws = (state.draws || 0) + 1;
        }

        const feedEntry = verdict.commentary
          ? `**Round ${state.currentRound} Verdict:** ${verdict.commentary}\n\n**Winner: ${verdict.winner}** (${verdict.contestant1Score}\u2013${verdict.contestant2Score})`
          : `**Round ${state.currentRound}: ${verdict.winner} wins!**`;

        state.judgeFeedEntries.push({
          agentId: state.judge.agentId,
          displayName: state.judge.displayName,
          role: 'judge',
          content: feedEntry,
        });

        state.phase = 'result';
        ctx.setCycle(state.currentRound);
        ctx.setState(state);
        emitMetrics(ctx, state, 'result');

        if (state.currentRound >= state.totalRounds) {
          state.phase = 'complete';
          ctx.setState(state);
          emitMetrics(ctx, state, 'complete');
          return { type: 'stop', reason: 'convergence' };
        }

        const contestant1Wins = state.scores[contestant1.agentId] || 0;
        const contestant2Wins = state.scores[contestant2.agentId] || 0;
        const remaining = state.totalRounds - state.currentRound;
        if (contestant1Wins > contestant2Wins + remaining || contestant2Wins > contestant1Wins + remaining) {
          state.phase = 'complete';
          ctx.setState(state);
          emitMetrics(ctx, state, 'complete');
          return { type: 'stop', reason: 'convergence' };
        }

        state.currentRound += 1;
        return startRound(ctx, state);
      }

      return { type: 'stop', reason: 'plugin_stop' };
    },

    onFanOutComplete(ctx, responses) {
      const state = ctx.getState();
      const currentRound = state.rounds[state.rounds.length - 1];
      const contestant1 = state.contestants[0];
      const contestant2 = state.contestants[1];

      for (const response of responses) {
        const code = extractCode(response.response);
        if (response.agentId === contestant1.agentId) currentRound.solution1 = code;
        else if (response.agentId === contestant2.agentId) currentRound.solution2 = code;
      }

      state.phase = 'judging';
      ctx.setState(state);
      emitMetrics(ctx, state, 'judging', state.judge);

      return {
        type: 'speak',
        agentId: state.judge.agentId,
        message: buildJudgingPrompt(
          currentRound.challenge,
          state.currentRound,
          contestant1,
          contestant2,
          currentRound.solution1 || '(no solution submitted)',
          currentRound.solution2 || '(no solution submitted)',
        ),
      };
    },

    onEvent(ctx, event) {
      if (event?.type === 'agent_disconnected') {
        const state = ctx.getState();
        state.phase = 'complete';
        ctx.setState(state);
        emitMetrics(ctx, state, 'complete');
        return { type: 'stop', reason: 'contestant_disconnected' };
      }
      return null;
    },

    onResume(ctx) {
      const state = ctx.getState();
      emitMetrics(ctx, state, state.phase);
      return null;
    },

    shutdown() {},
  };
}

export default { manifest, createPlugin };
export { manifest, createPlugin };
