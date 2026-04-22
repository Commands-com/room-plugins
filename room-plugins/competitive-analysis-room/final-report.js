import { parseAnalysis, readAnalysisMarkdown } from './analysis-model.js';

export function buildBundle(state) {
  const parsed = parseAnalysis(readAnalysisMarkdown(state));
  return {
    contract: 'competitive_analysis_bundle.v1',
    summary: {
      title: parsed.title,
      oneLiner: parsed.executiveSummary,
      recommendedDirection: parsed.recommendedPositioning || (parsed.recommendedMoves[0] || ''),
    },
    productRead: parsed.productRead,
    competitorSet: parsed.competitorSet,
    positioningGap: parsed.positioningGap,
    likelyChannels: parsed.likelyChannels,
    messagingStrengths: parsed.messagingStrengths,
    messagingWeaknesses: parsed.messagingWeaknesses,
    patternsToAvoid: parsed.patternsToAvoid,
    recommendedPositioning: parsed.recommendedPositioning,
    recommendedMoves: parsed.recommendedMoves,
    risks: parsed.risks,
    openQuestions: parsed.openQuestions,
    markdown: parsed.markdown,
    provenance: {
      roomType: 'competitive_analysis_room',
      generatedAt: new Date().toISOString(),
      objective: state.objective,
      projectDir: state.config.projectDir,
      cycleCount: state.cycleCount,
    },
  };
}
