export function normalizeConfig(ctx) {
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

export function updateTargetBubblesForRosterChange(state, activeCount) {
  state.nCurrent = Math.max(1, activeCount);
  if (state.epochBubbleIndex > 0) {
    state.completedRounds += 1;
  }
  state.epochBubbleIndex = 0;
  const remainingRounds = Math.max(0, state.rounds - state.completedRounds);
  state.targetBubbles = state.bubbleIndex + (remainingRounds * state.nCurrent);
}
