import path from 'node:path';

import {
  collectArtifactFiles,
  guessArtifactType,
  parseSummary,
  readSummaryMarkdown,
} from './execution-model.js';

export function buildBundle(state) {
  const parsed = parseSummary(readSummaryMarkdown(state));
  const assetFiles = collectArtifactFiles(state.config.outputDir, state.summaryPath);
  return {
    contract: 'marketing_execution_bundle.v1',
    summary: {
      title: parsed.title,
      oneLiner: parsed.executiveSummary,
      recommendedDirection: parsed.selectedPriorities[0] || parsed.assetInventory[0] || '',
    },
    selectedPriorities: parsed.selectedPriorities,
    assetInventory: parsed.assetInventory,
    messagingNotes: parsed.messagingNotes,
    launchChecklist: parsed.launchChecklist,
    risks: parsed.risks,
    openQuestions: parsed.openQuestions,
    artifacts: assetFiles.map((artifactPath) => ({
      kind: guessArtifactType(artifactPath),
      path: artifactPath,
      label: path.relative(state.config.outputDir, artifactPath),
      primary: false,
    })),
    markdown: parsed.markdown,
    provenance: {
      roomType: 'marketing_execution_room',
      generatedAt: new Date().toISOString(),
      objective: state.objective,
      projectDir: state.config.projectDir,
      sourceMarketingPlan: state.planContext?.title || '',
      cycleCount: state.cycleCount,
    },
  };
}
