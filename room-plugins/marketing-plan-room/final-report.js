import { parsePlan, readPlanMarkdown } from './plan-model.js';

export function buildBundle(state) {
  const parsed = parsePlan(readPlanMarkdown(state));
  return {
    contract: 'marketing_plan_bundle.v1',
    summary: {
      title: parsed.title,
      oneLiner: parsed.executiveSummary,
      recommendedDirection: parsed.positioning || parsed.channelPriorities[0] || '',
    },
    positioning: parsed.positioning,
    audience: parsed.audience,
    messagingPillars: parsed.messagingPillars,
    channelPriorities: parsed.channelPriorities,
    campaignBets: parsed.campaignBets,
    assetPlan: parsed.assetPlan,
    launchPlan: parsed.launchPlan,
    successMetrics: parsed.successMetrics,
    risks: parsed.risks,
    openQuestions: parsed.openQuestions,
    markdown: parsed.markdown,
    provenance: {
      roomType: 'marketing_plan_room',
      generatedAt: new Date().toISOString(),
      objective: state.objective,
      projectDir: state.config.projectDir,
      sourceCompetitiveAnalysis: state.competitiveContext?.title || '',
      cycleCount: state.cycleCount,
    },
  };
}
