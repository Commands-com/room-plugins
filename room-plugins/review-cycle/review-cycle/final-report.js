// ---------------------------------------------------------------------------
// Final report builders — produce the review_findings.v1 payload and the
// pass-through payloads the plugin hands back to the room runtime when the
// cycle terminates.
//
// Pass-through: the plugin forwards at most one copy of each of
// spec_bundle.v1, implementation_bundle.v1, and test_results.v1 from the
// inbound handoff context so downstream consumers can chain on them.
// ---------------------------------------------------------------------------

import { findInboundPayload } from './prompt-context.js';
import {
  deriveReviewDisposition,
  collectReferencedArtifacts,
  buildDocumentationIntegrity,
} from './findings-metadata.js';

const PASS_THROUGH_CONTRACTS = new Set([
  'spec_bundle.v1',
  'implementation_bundle.v1',
  'test_results.v1',
]);

export function collectReviewCyclePassThroughPayloads(ctx) {
  const inboundPayloads = Array.isArray(ctx.handoffContext?.payloads)
    ? ctx.handoffContext.payloads
    : [];
  const seenContracts = new Set();
  const outputs = [];

  for (const payload of inboundPayloads) {
    const contract = payload?.contract;
    if (!PASS_THROUGH_CONTRACTS.has(contract) || seenContracts.has(contract)) continue;
    seenContracts.add(contract);
    outputs.push(payload);
  }

  return outputs;
}

export function buildReviewFindingsPayload(ctx, state) {
  const issues = Array.isArray(state?.issues) ? state.issues : [];
  const openIssues = issues.filter((issue) => issue.status === 'open');
  const resolvedIssues = issues.filter((issue) => issue.status === 'resolved');
  const baseReport = typeof ctx.getFinalReport === 'function' ? ctx.getFinalReport() : null;
  const testResults = findInboundPayload(ctx.handoffContext, 'test_results.v1');
  const testSummary = testResults?.data?.summary || null;

  return {
    contract: 'review_findings.v1',
    data: {
      objective: ctx.objective || '',
      roomId: ctx.roomId || null,
      stopReason: baseReport?.stopReason || null,
      cyclesCompleted: state?.currentCycle ?? ctx.cycle ?? 0,
      reviewerStates: Array.isArray(state?.reviewerStates)
        ? state.reviewerStates.map((reviewer) => ({
          agentId: reviewer.agentId,
          displayName: reviewer.displayName,
          phase: reviewer.phase,
          lastIssueCount: reviewer.lastIssueCount || 0,
        }))
        : [],
      summary: {
        totalFindings: issues.length,
        openFindings: openIssues.length,
        resolvedFindings: resolvedIssues.length,
        severitySummary: {
          critical: openIssues.filter((issue) => issue.severity === 'critical').length,
          major: openIssues.filter((issue) => issue.severity === 'major').length,
          minor: openIssues.filter((issue) => issue.severity === 'minor').length,
          nit: openIssues.filter((issue) => issue.severity === 'nit').length,
        },
        validationSignals: testSummary
          ? {
            totalScenarios: Number(testSummary.totalScenarios) || 0,
            passed: Number(testSummary.passed) || 0,
            failed: Number(testSummary.failed) || 0,
            skipped: Number(testSummary.skipped) || 0,
            passRate: Number(testSummary.passRate) || 0,
          }
          : null,
      },
      disposition: deriveReviewDisposition(openIssues),
      documentationIntegrity: buildDocumentationIntegrity(ctx, openIssues),
      referencedArtifacts: collectReferencedArtifacts(ctx),
      findings: issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        severity: issue.severity,
        description: issue.description,
        suggestion: issue.suggestion || null,
        status: issue.status,
        sourceReviewers: Array.isArray(issue.source_reviewers) ? issue.source_reviewers : [],
        resolvedInCycle: issue.resolvedInCycle ?? null,
      })),
    },
  };
}
