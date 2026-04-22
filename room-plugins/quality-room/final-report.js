import { findInboundPayload, trimPromptText } from './prompt-context.js';

const PASS_THROUGH_CONTRACTS = new Set([
  'spec_bundle.v1',
  'implementation_bundle.v1',
  'test_results.v1',
]);

export function collectQualityRoomPassThroughPayloads(ctx) {
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

function collectReferencedArtifacts(ctx) {
  const payloads = Array.isArray(ctx.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const artifacts = [];
  const seen = new Set();

  function addArtifact(contract, path, label = null, kind = 'file') {
    const cleanPath = trimPromptText(path, 260);
    if (!cleanPath) return;
    const key = `${contract}:${cleanPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push({ contract, kind, path: cleanPath, label: label ? trimPromptText(label, 120) : null });
  }

  for (const payload of payloads) {
    const contract = payload?.contract;
    const data = payload?.data || {};

    if (contract === 'spec_bundle.v1') {
      for (const artifact of Array.isArray(data.artifacts) ? data.artifacts : []) {
        addArtifact(contract, artifact?.path, artifact?.label, artifact?.kind || 'file');
      }
      continue;
    }

    if (contract === 'implementation_bundle.v1') {
      for (const changedFile of Array.isArray(data.changedFiles) ? data.changedFiles : []) {
        addArtifact(contract, changedFile, 'Changed file');
      }
      continue;
    }

    if (contract === 'test_results.v1') {
      for (const scenario of Array.isArray(data.scenarios) ? data.scenarios : []) {
        addArtifact(contract, scenario?.testFilePath, scenario?.title || 'Test scenario');
      }
    }
  }

  return artifacts;
}

function deriveReviewDisposition(openFindings) {
  const criticalOrMajor = openFindings.filter((finding) => ['critical', 'major'].includes(finding?.severity)).length;
  if (criticalOrMajor > 0) return 'changes_requested';
  if (openFindings.length > 0) return 'approved_with_followups';
  return 'approved';
}

export function buildReviewFindingsPayload(ctx, state) {
  const findings = Array.isArray(state?.findings) ? state.findings : [];
  const openFindings = findings.filter((finding) => finding.status === 'open');
  const resolvedFindings = findings.filter((finding) => finding.status === 'resolved');
  const testResults = findInboundPayload(ctx.handoffContext, 'test_results.v1');
  const testSummary = testResults?.data?.summary || null;

  return {
    contract: 'review_findings.v1',
    data: {
      objective: ctx.objective || '',
      roomId: ctx.roomId || null,
      stopReason: null,
      cyclesCompleted: state?.currentCycle ?? ctx.cycle ?? 0,
      reviewerStates: Array.isArray(state?.reviewerStates)
        ? state.reviewerStates.map((reviewer) => ({
          agentId: reviewer.agentId,
          displayName: reviewer.displayName,
          grade: reviewer.lastGrade || null,
          blockerCount: reviewer.lastBlockerCount || 0,
          status: reviewer.status || null,
        }))
        : [],
      summary: {
        totalFindings: findings.length,
        openFindings: openFindings.length,
        resolvedFindings: resolvedFindings.length,
        severitySummary: {
          critical: openFindings.filter((finding) => finding.severity === 'critical').length,
          major: openFindings.filter((finding) => finding.severity === 'major').length,
          minor: openFindings.filter((finding) => finding.severity === 'minor').length,
          nit: openFindings.filter((finding) => finding.severity === 'nit').length,
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
      qualitySummary: {
        targetGrade: 'A',
        latestGrades: Array.isArray(state?.latestAssessments)
          ? state.latestAssessments.map((assessment) => ({
            agentId: assessment.agentId,
            displayName: assessment.displayName,
            overallGrade: assessment.overall_grade,
            categoryGrades: assessment.category_grades,
            blockerCount: assessment.blockers_to_a.length,
          }))
          : [],
      },
      disposition: deriveReviewDisposition(openFindings),
      referencedArtifacts: collectReferencedArtifacts(ctx),
      findings: findings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        description: finding.description,
        suggestion: finding.suggestion || null,
        status: finding.status,
        sourceReviewers: Array.isArray(finding.source_reviewers) ? finding.source_reviewers : [],
        resolvedInCycle: finding.resolvedInCycle ?? null,
      })),
    },
  };
}
