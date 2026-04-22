// ---------------------------------------------------------------------------
// Findings metadata helpers — derive disposition, referenced artifacts, and
// documentation-integrity signals from the current state + inbound handoff
// payloads. Consumed by final-report.js when building the review_findings.v1
// output payload.
// ---------------------------------------------------------------------------

import { trimPromptText, findInboundPayload } from './prompt-context.js';

export function deriveReviewDisposition(openIssues) {
  const criticalOrMajor = openIssues.filter((issue) => ['critical', 'major'].includes(issue?.severity)).length;
  if (criticalOrMajor > 0) return 'changes_requested';
  if (openIssues.length > 0) return 'approved_with_followups';
  return 'approved';
}

export function collectReferencedArtifacts(ctx) {
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

export function buildDocumentationIntegrity(ctx, openIssues) {
  const payloads = Array.isArray(ctx.handoffContext?.payloads) ? ctx.handoffContext.payloads : [];
  const checkedAgainst = payloads
    .map((payload) => payload?.contract)
    .filter((value, index, array) => typeof value === 'string' && array.indexOf(value) === index);
  const testResults = findInboundPayload(ctx.handoffContext, 'test_results.v1');
  const failedScenarios = Number(testResults?.data?.summary?.failed) || 0;

  if (!testResults && checkedAgainst.length === 0) {
    return {
      status: 'not_evaluated',
      summary: 'No upstream artifacts were available to verify documentation or artifact claims.',
      checkedAgainst,
    };
  }

  if (failedScenarios > 0) {
    return {
      status: 'issues_found',
      summary: `Upstream validation reported ${failedScenarios} failing scenario${failedScenarios === 1 ? '' : 's'}; public documentation should avoid stronger correctness claims until they are resolved.`,
      checkedAgainst,
    };
  }

  if (openIssues.length > 0) {
    return {
      status: 'follow_up_required',
      summary: `Review identified ${openIssues.length} unresolved finding${openIssues.length === 1 ? '' : 's'}; documentation should reflect outstanding risk until follow-up is complete.`,
      checkedAgainst,
    };
  }

  return {
    status: 'no_mismatches_found',
    summary: 'Reviewed the available spec, implementation, and validation artifacts without identifying documentation-integrity mismatches.',
    checkedAgainst,
  };
}
