/**
 * Code Arena — head-to-head AI coding tournament.
 *
 * Two contestants solve challenges invented by a judge.
 * The judge evaluates solutions and picks a round winner.
 * Best-of-N rounds with tournament-style progression.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

// --- Prompt builders ---

function buildChallengeInventionPrompt(roundNum, totalRounds, previousChallenges, objective) {
  const previousList = previousChallenges.length > 0
    ? `\n\nPrevious challenges (do NOT repeat these):\n${previousChallenges.map((c, i) => `  Round ${i + 1}: ${c}`).join('\n')}`
    : '';

  return [
    `You are the JUDGE and MC of Code Arena — a dramatic head-to-head coding tournament.`,
    ``,
    `This is Round ${roundNum} of ${totalRounds}. You must INVENT a coding challenge for the contestants.`,
    objective ? `\nTournament theme/constraints: ${objective}` : '',
    previousList,
    ``,
    `Create an original, interesting coding challenge. It should be completable in a single function or class.`,
    `Vary the difficulty and type across rounds — mix algorithms, data structures, utilities, and design patterns.`,
    ``,
    `You MUST respond with two parts:`,
    ``,
    `1. First, a dramatic, exciting announcement of the challenge (be theatrical — you're the MC!)`,
    ``,
    `2. Then, at the END of your response, include this EXACT JSON block:`,
    '```json',
    `{`,
    `  "title": "<catchy challenge title>",`,
    `  "description": "<clear, detailed description of what to build, including requirements and edge cases>",`,
    `  "difficulty": "Easy" or "Medium" or "Hard",`,
    `  "language": "javascript"`,
    `}`,
    '```',
    ``,
    `Make the challenge specific and testable. Include concrete requirements.`,
    `The JSON block is parsed by the system — it MUST be valid JSON.`,
  ].filter(Boolean).join('\n');
}

function buildContestantPrompt(challenge, roundNum, totalRounds, contestantName, opponentName) {
  return [
    `You are ${contestantName}, a contestant in Code Arena — a head-to-head coding tournament.`,
    `You are competing against ${opponentName}.`,
    ``,
    `This is Round ${roundNum} of ${totalRounds}.`,
    ``,
    `## Challenge: ${challenge.title}`,
    `**Difficulty:** ${challenge.difficulty} | **Language:** ${challenge.language}`,
    ``,
    challenge.description,
    ``,
    `Write your solution now. Your code will be judged against your opponent's.`,
    ``,
    `Requirements:`,
    `- Write clean, working ${challenge.language} code`,
    `- Include the complete implementation`,
    `- Add brief comments explaining your approach`,
    `- Handle edge cases`,
    `- Optimize for correctness first, then elegance`,
    ``,
    `Your entire response should be your code solution wrapped in a code block.`,
    `Show your best work — your coding reputation is on the line!`,
  ].join('\n');
}

function buildJudgingPrompt(challenge, roundNum, contestant1, contestant2, solution1, solution2) {
  return [
    `You are the JUDGE in Code Arena. You must evaluate Round ${roundNum}.`,
    ``,
    `## Challenge: ${challenge.title}`,
    `${challenge.description}`,
    ``,
    `---`,
    ``,
    `## ${contestant1.displayName}'s Solution:`,
    '```' + challenge.language,
    solution1,
    '```',
    ``,
    `## ${contestant2.displayName}'s Solution:`,
    '```' + challenge.language,
    solution2,
    '```',
    ``,
    `---`,
    ``,
    `Evaluate both solutions on these criteria:`,
    `1. **Correctness** (40%) — Does it work? Edge cases handled?`,
    `2. **Code Quality** (25%) — Clean, readable, well-structured?`,
    `3. **Completeness** (20%) — All requirements met?`,
    `4. **Elegance** (15%) — Creative approach? Efficient?`,
    ``,
    `You MUST respond with EXACTLY this JSON format (and nothing else outside the JSON):`,
    '```json',
    `{`,
    `  "winner": "${contestant1.displayName}" or "${contestant2.displayName}" or "draw",`,
    `  "contestant1Score": <number 0-100>,`,
    `  "contestant2Score": <number 0-100>,`,
    `  "commentary": "<your dramatic, entertaining verdict — 3-5 sentences>"`,
    `}`,
    '```',
    ``,
    `Be dramatic and entertaining in your commentary. This is a show!`,
    `Be fair but decisive. Draws should be rare — pick a winner when possible.`,
  ].join('\n');
}

// --- Parsers ---

function parseChallenge(response) {
  const text = String(response || '');
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return {
        title: String(parsed.title || 'Untitled Challenge'),
        description: String(parsed.description || 'No description provided.'),
        difficulty: ['Easy', 'Medium', 'Hard'].includes(parsed.difficulty) ? parsed.difficulty : 'Medium',
        language: String(parsed.language || 'javascript'),
      };
    } catch {
      // Fall through
    }
  }
  return {
    title: 'Round Challenge',
    description: text.slice(0, 1000),
    difficulty: 'Medium',
    language: 'javascript',
  };
}

function parseVerdict(response, contestant1, contestant2) {
  const text = String(response || '');
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/) || text.match(/\{[\s\S]*"winner"[\s\S]*\}/);
  let parsed = null;

  if (jsonMatch) {
    try {
      parsed = JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
    } catch {
      // Fall through
    }
  }

  if (!parsed) {
    const c1Lower = contestant1.displayName.toLowerCase();
    const c2Lower = contestant2.displayName.toLowerCase();
    const lower = text.toLowerCase();
    const c1Win = lower.includes(c1Lower) && lower.includes('winner');
    const c2Win = lower.includes(c2Lower) && lower.includes('winner');
    return {
      winner: c1Win && !c2Win ? contestant1.displayName
        : c2Win && !c1Win ? contestant2.displayName : 'draw',
      contestant1Score: 50,
      contestant2Score: 50,
      commentary: text.slice(0, 500),
    };
  }

  let winner = String(parsed.winner || 'draw');
  const c1Name = contestant1.displayName;
  const c2Name = contestant2.displayName;
  if (winner.toLowerCase() !== 'draw'
    && winner.toLowerCase() !== c1Name.toLowerCase()
    && winner.toLowerCase() !== c2Name.toLowerCase()) {
    if (winner.toLowerCase().includes(c1Name.toLowerCase().split(' ')[0])) {
      winner = c1Name;
    } else if (winner.toLowerCase().includes(c2Name.toLowerCase().split(' ')[0])) {
      winner = c2Name;
    } else {
      winner = 'draw';
    }
  } else if (winner.toLowerCase() === c1Name.toLowerCase()) {
    winner = c1Name;
  } else if (winner.toLowerCase() === c2Name.toLowerCase()) {
    winner = c2Name;
  }

  return {
    winner,
    contestant1Score: Math.max(0, Math.min(100, Number(parsed.contestant1Score) || 50)),
    contestant2Score: Math.max(0, Math.min(100, Number(parsed.contestant2Score) || 50)),
    commentary: String(parsed.commentary || '').slice(0, 1000),
  };
}

function extractCode(response) {
  const text = String(response || '');
  const codeMatch = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  if (codeMatch) return codeMatch[1].trim();
  return text.trim();
}

// --- Metrics ---

function emitMetrics(ctx, state, phase, typingAgent = null) {
  const c1 = state.contestants[0];
  const c2 = state.contestants[1];

  const scoreboard = {
    contestant1Wins: state.scores[c1.agentId] || 0,
    contestant2Wins: state.scores[c2.agentId] || 0,
    draws: state.draws || 0,
    _labels: {
      contestant1Wins: c1.displayName,
      contestant2Wins: c2.displayName,
    },
  };

  const roundRows = state.rounds.map((r) => ({
    round: r.roundNum,
    challenge: r.challenge?.title || '\u2014',
    difficulty: r.challenge?.difficulty || '\u2014',
    winner: r.winner || '\u2014',
    score: r.contestant1Score != null && r.contestant2Score != null
      ? `${r.contestant1Score} \u2014 ${r.contestant2Score}` : '\u2014',
    verdict: r.commentary || '\u2014',
  }));

  // Build solution blocks for all rounds — each round gets a tab per contestant
  const solutionBlocks = [];
  for (const r of state.rounds) {
    if (r.solution1) {
      solutionBlocks.push({
        content: r.solution1,
        title: `R${r.roundNum}: ${c1.displayName}`,
        language: r.challenge?.language || 'javascript',
      });
    }
    if (r.solution2) {
      solutionBlocks.push({
        content: r.solution2,
        title: `R${r.roundNum}: ${c2.displayName}`,
        language: r.challenge?.language || 'javascript',
      });
    }
  }

  const challengeBlocks = state.rounds
    .filter((r) => r.challenge)
    .map((r) => ({
      title: `Round ${r.roundNum}: ${r.challenge.title}`,
      content: `${r.challenge.title}\n${'='.repeat(r.challenge.title.length)}\nDifficulty: ${r.challenge.difficulty}  |  Language: ${r.challenge.language}\n\n${r.challenge.description}`,
      language: 'markdown',
    }));

  const total = state.totalRounds;
  const current = Math.min(state.currentRound, total);
  const c1Wins = state.scores[c1.agentId] || 0;
  const c2Wins = state.scores[c2.agentId] || 0;
  let roundHeader = `Round ${current} of ${total}`;
  if (phase === 'complete') {
    if (c1Wins > c2Wins) {
      roundHeader = `${c1.displayName} wins the tournament ${c1Wins}\u2013${c2Wins}!`;
    } else if (c2Wins > c1Wins) {
      roundHeader = `${c2.displayName} wins the tournament ${c2Wins}\u2013${c1Wins}!`;
    } else {
      roundHeader = `Tournament ends in a ${c1Wins}\u2013${c2Wins} draw!`;
    }
  }

  const metrics = {
    tournamentPhase: { active: phase },
    roundHeader: { value: roundHeader },
    scoreboard,
    roundProgress: { value: current, max: total },
    challengeDescription: challengeBlocks.length > 0 ? { blocks: challengeBlocks } : null,
    judgeFeed: {
      entries: state.judgeFeedEntries || [],
      typing: typingAgent ? { agentId: typingAgent.agentId, displayName: typingAgent.displayName } : null,
    },
    roundResults: { rows: roundRows },
  };

  if (solutionBlocks.length > 0) {
    metrics.currentSolutions = { blocks: solutionBlocks };
    metrics.allSolutions = { blocks: solutionBlocks };
  }

  ctx.emitMetrics(metrics);
}

// --- Round lifecycle ---

function startRound(ctx, state) {
  state.rounds.push({
    roundNum: state.currentRound,
    challenge: null, solution1: null, solution2: null,
    winner: null, contestant1Score: null, contestant2Score: null, commentary: null,
  });

  state.phase = 'challenge';
  ctx.setState(state);
  emitMetrics(ctx, state, 'challenge', state.judge);

  const previousChallenges = state.rounds.slice(0, -1).map((r) => r.challenge?.title).filter(Boolean);

  return {
    type: 'speak',
    agentId: state.judge.agentId,
    message: buildChallengeInventionPrompt(state.currentRound, state.totalRounds, previousChallenges, ctx.objective),
  };
}

// --- Plugin ---

function createPlugin() {
  return {
    init(ctx) {
      const contestants = ctx.participants.filter((p) => p.role === 'contestant').slice(0, 2);
      const judge = ctx.participants.find((p) => p.role === 'judge');
      if (contestants.length < 2 || !judge) return;

      const cfg = ctx.roomConfig || ctx.orchestratorConfig || {};
      const totalRounds = Math.max(1, Math.min(10, Number(cfg.rounds) || 3));

      const scores = {};
      scores[contestants[0].agentId] = 0;
      scores[contestants[1].agentId] = 0;

      ctx.setState({
        totalRounds, currentRound: 1, phase: 'challenge',
        contestants, judge, scores, draws: 0, rounds: [], judgeFeedEntries: [],
      });
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
          agentId: state.judge.agentId, displayName: state.judge.displayName, role: 'judge',
          content: announcement || `**Round ${state.currentRound} Challenge: ${challenge.title}**\n\n${challenge.description}`,
        });

        state.phase = 'coding';
        ctx.setState(state);
        emitMetrics(ctx, state, 'coding');

        const c1 = state.contestants[0];
        const c2 = state.contestants[1];
        return {
          type: 'fan_out',
          targets: [
            { agentId: c1.agentId, message: buildContestantPrompt(challenge, state.currentRound, state.totalRounds, c1.displayName, c2.displayName) },
            { agentId: c2.agentId, message: buildContestantPrompt(challenge, state.currentRound, state.totalRounds, c2.displayName, c1.displayName) },
          ],
        };
      }

      if (state.phase === 'judging') {
        const c1 = state.contestants[0];
        const c2 = state.contestants[1];
        const verdict = parseVerdict(response, c1, c2);

        currentRound.winner = verdict.winner;
        currentRound.contestant1Score = verdict.contestant1Score;
        currentRound.contestant2Score = verdict.contestant2Score;
        currentRound.commentary = verdict.commentary;

        if (verdict.winner === c1.displayName) {
          state.scores[c1.agentId] = (state.scores[c1.agentId] || 0) + 1;
        } else if (verdict.winner === c2.displayName) {
          state.scores[c2.agentId] = (state.scores[c2.agentId] || 0) + 1;
        } else {
          state.draws = (state.draws || 0) + 1;
        }

        const feedEntry = verdict.commentary
          ? `**Round ${state.currentRound} Verdict:** ${verdict.commentary}\n\n**Winner: ${verdict.winner}** (${verdict.contestant1Score}\u2013${verdict.contestant2Score})`
          : `**Round ${state.currentRound}: ${verdict.winner} wins!**`;

        state.judgeFeedEntries.push({
          agentId: state.judge.agentId, displayName: state.judge.displayName, role: 'judge',
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

        const c1Wins = state.scores[c1.agentId] || 0;
        const c2Wins = state.scores[c2.agentId] || 0;
        const remaining = state.totalRounds - state.currentRound;
        if (c1Wins > c2Wins + remaining || c2Wins > c1Wins + remaining) {
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
      const c1 = state.contestants[0];
      const c2 = state.contestants[1];

      for (const r of responses) {
        const code = extractCode(r.response);
        if (r.agentId === c1.agentId) currentRound.solution1 = code;
        else if (r.agentId === c2.agentId) currentRound.solution2 = code;
      }

      state.phase = 'judging';
      ctx.setState(state);
      emitMetrics(ctx, state, 'judging', state.judge);

      return {
        type: 'speak',
        agentId: state.judge.agentId,
        message: buildJudgingPrompt(
          currentRound.challenge, state.currentRound, c1, c2,
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
