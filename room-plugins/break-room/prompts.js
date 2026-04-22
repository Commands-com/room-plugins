import { TRANSCRIPT_WINDOW } from './constants.js';

export function buildSpeakPrompt(ctx, state, speaker) {
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
