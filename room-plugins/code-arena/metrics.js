export function emitMetrics(ctx, state, phase, typingAgent = null) {
  const contestant1 = state.contestants[0];
  const contestant2 = state.contestants[1];

  const scoreboard = {
    contestant1Wins: state.scores[contestant1.agentId] || 0,
    contestant2Wins: state.scores[contestant2.agentId] || 0,
    draws: state.draws || 0,
    _labels: {
      contestant1Wins: contestant1.displayName,
      contestant2Wins: contestant2.displayName,
    },
  };

  const roundRows = state.rounds.map((round) => ({
    round: round.roundNum,
    challenge: round.challenge?.title || '\u2014',
    difficulty: round.challenge?.difficulty || '\u2014',
    winner: round.winner || '\u2014',
    score: round.contestant1Score != null && round.contestant2Score != null
      ? `${round.contestant1Score} \u2014 ${round.contestant2Score}` : '\u2014',
    verdict: round.commentary || '\u2014',
  }));

  const solutionBlocks = [];
  for (const round of state.rounds) {
    if (round.solution1) {
      solutionBlocks.push({
        content: round.solution1,
        title: `R${round.roundNum}: ${contestant1.displayName}`,
        language: round.challenge?.language || 'javascript',
      });
    }
    if (round.solution2) {
      solutionBlocks.push({
        content: round.solution2,
        title: `R${round.roundNum}: ${contestant2.displayName}`,
        language: round.challenge?.language || 'javascript',
      });
    }
  }

  const challengeBlocks = state.rounds
    .filter((round) => round.challenge)
    .map((round) => ({
      title: `Round ${round.roundNum}: ${round.challenge.title}`,
      content: `${round.challenge.title}\n${'='.repeat(round.challenge.title.length)}\nDifficulty: ${round.challenge.difficulty}  |  Language: ${round.challenge.language}\n\n${round.challenge.description}`,
      language: 'markdown',
    }));

  const total = state.totalRounds;
  const current = Math.min(state.currentRound, total);
  const contestant1Wins = state.scores[contestant1.agentId] || 0;
  const contestant2Wins = state.scores[contestant2.agentId] || 0;
  let roundHeader = `Round ${current} of ${total}`;
  if (phase === 'complete') {
    if (contestant1Wins > contestant2Wins) {
      roundHeader = `${contestant1.displayName} wins the tournament ${contestant1Wins}\u2013${contestant2Wins}!`;
    } else if (contestant2Wins > contestant1Wins) {
      roundHeader = `${contestant2.displayName} wins the tournament ${contestant2Wins}\u2013${contestant1Wins}!`;
    } else {
      roundHeader = `Tournament ends in a ${contestant1Wins}\u2013${contestant2Wins} draw!`;
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
