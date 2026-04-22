// ---------------------------------------------------------------------------
// Prompt templates — pure string builders for the five prompts the review
// cycle emits:
//   - initial review (reviewers, before implementer has acted)
//   - re-review (reviewers, with previously-identified open issues in scope)
//   - clean review (reviewers, no open issues but convergence not yet reached)
//   - implementer (act on consolidated issues)
//   - synthesis (consolidate reviewer responses into a single issue list)
//
// handoffPromptContext is produced by prompt-context.js and is spliced in
// verbatim near the top so the agents see upstream spec/implementation/test
// context when relevant.
// ---------------------------------------------------------------------------

export function buildInitialReviewPrompt(objective, reviewerDisplayName, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a code reviewer.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `Review the implementation against the objective and identify only real issues the implementer should act on.`,
    `Start from the stated objective and the observed code or behavior. Do not invent requirements that are not implied by either.`,
    `State any material assumptions behind a finding. If a concern depends on an unstated assumption, say that explicitly.`,
    `Prefer concrete, verifiable findings over speculative advice.`,
    `Call out unnecessary complexity when a substantially simpler change would solve the objective with less code or risk.`,
    `Call out non-surgical changes when the implementation refactors, reformats, or broadens scope beyond what was needed to satisfy the objective.`,
    `Do not ask for new abstractions, configurability, or cleanup work unless they are necessary to fix a real problem.`,
    `Do not nitpick stylistic differences that already match the local codebase.`,
    `Only report issues that are meaningfully actionable. Omit weak, hypothetical, or preference-only comments.`,
    `For each issue found, provide:`,
    `- A short title`,
    `- Severity: critical | major | minor | nit`,
    `- Description of the problem`,
    `- Suggested fix (if applicable)`,
    '',
    `Respond with a JSON object: { "issues": [{ "title", "severity", "description", "suggestion" }] }`,
    `If no issues found, respond with: { "issues": [] }`,
  );
  return lines.join('\n');
}

export function buildReReviewPrompt(objective, reviewerDisplayName, openIssues, latestImplementation, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a code reviewer.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  lines.push(
    `## Previously Identified Issues`,
    JSON.stringify(openIssues, null, 2),
    '',
  );

  if (latestImplementation) {
    lines.push(
      `## Implementer's Latest Changes`,
      latestImplementation,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `The implementer has made changes. Re-review the implementation against the issues above.`,
    `For each previously identified issue, check if it has been resolved.`,
    `Also check for any new issues introduced by the changes.`,
    '',
    `**Important:** Only include issues that are **still open**. If a previously identified issue has been fixed by the implementer's changes, omit it from your response entirely — do NOT re-report resolved issues.`,
    `Do not move the goalposts by introducing new preferences, broader refactors, or nice-to-have cleanup that was not required by the objective or introduced by the latest changes.`,
    `If a remaining concern depends on an assumption, state that assumption explicitly.`,
    `Prefer concrete, verifiable findings over speculative advice.`,
    '',
    `Respond with a JSON object: { "issues": [{ "title", "severity", "description", "suggestion" }] }`,
    `If all issues are resolved and no new issues, respond with: { "issues": [] }`,
  );
  return lines.join('\n');
}

export function buildCleanReviewPrompt(objective, reviewerDisplayName, latestImplementation, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a code reviewer.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  if (latestImplementation) {
    lines.push(
      `## Implementer's Latest Changes`,
      latestImplementation,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `Perform a clean review of the latest changes and identify only real issues the implementer should act on.`,
    `Start from the stated objective and the observed code or behavior. Do not invent requirements that are not implied by either.`,
    `State any material assumptions behind a finding. If a concern depends on an unstated assumption, say that explicitly.`,
    `Prefer concrete, verifiable findings over speculative advice.`,
    `Call out unnecessary complexity when a substantially simpler change would solve the objective with less code or risk.`,
    `Call out non-surgical changes when the implementation refactors, reformats, or broadens scope beyond what was needed to satisfy the objective.`,
    `Do not ask for new abstractions, configurability, or cleanup work unless they are necessary to fix a real problem.`,
    `Do not nitpick stylistic differences that already match the local codebase.`,
    `Only report issues that are meaningfully actionable. Omit weak, hypothetical, or preference-only comments.`,
    '',
    `Respond with a JSON object: { "issues": [{ "title", "severity", "description", "suggestion" }] }`,
    `If no issues found, respond with: { "issues": [] }`,
  );
  return lines.join('\n');
}

export function buildImplementerPrompt(objective, consolidatedIssues, reviewerFeedback, handoffPromptContext = '') {
  const lines = [
    `You are the implementer. Your job is to fix the code by editing the actual files using your tools.`,
    '',
    `## Objective`,
    objective,
    '',
  ];

  if (handoffPromptContext) {
    lines.push(
      handoffPromptContext,
      '',
    );
  }

  lines.push(
    `## Issues to Fix`,
    JSON.stringify(consolidatedIssues, null, 2),
    '',
  );

  if (reviewerFeedback) {
    lines.push(
      `## Reviewer Feedback`,
      `The reviewers provided the following detailed feedback:`,
      reviewerFeedback,
      '',
    );
  }

  lines.push(
    `## Instructions`,
    `Fix all the issues listed above. Focus on critical and major severity issues first.`,
    `You MUST edit the actual files to make your changes. Use your tools to read and modify the source files directly.`,
    `Do NOT just describe changes or output code blocks — actually apply the fixes to the files on disk.`,
    `Prefer the smallest change that fully resolves each issue.`,
    `If you write 200 lines and it could be 50, rewrite it.`,
    `Keep the diff surgical. Do not refactor, reformat, or clean up unrelated code. Only remove code or imports that become unused because of your own changes.`,
    `Match the existing style and patterns of the codebase unless a listed issue requires a different approach.`,
    `Do not add new abstractions, configurability, or speculative improvements unless they are necessary to resolve the issue.`,
    `If multiple plausible interpretations would lead to meaningfully different fixes, state the ambiguity explicitly and choose the safest minimal path; if that would still be risky, stop and say what is unclear.`,
    `When a bug can be verified with a focused test, add or update the narrowest test that proves the fix, then make it pass. Otherwise run the most direct verification available and report the result briefly.`,
    `If you believe a reported issue is incorrect or overreaching, say so briefly and explain the simpler correct fix.`,
    `After making all changes, briefly summarize what you fixed and how you verified it.`,
  );
  return lines.join('\n');
}

export function buildSynthesisPrompt(reviewerResponses) {
  return [
    `You are a code review synthesis engine.`,
    '',
    `## Reviewer Responses`,
    JSON.stringify(reviewerResponses, null, 2),
    '',
    `## Instructions`,
    `Consolidate the reviewer feedback into a single list of unique issues.`,
    `Merge duplicate issues. Resolve conflicting assessments by choosing the higher severity.`,
    '',
    `Respond ONLY with a JSON object in this exact format:`,
    `{`,
    `  "synthesis": {`,
    `    "added": [{ "title", "severity", "description", "suggestion", "source_reviewers": [] }],`,
    `    "resolved": [{ "title", "reason" }],`,
    `    "unchanged": [{ "title" }]`,
    `  },`,
    `  "consolidated_issues": [{ "id", "title", "severity", "description", "suggestion", "status": "open"|"resolved", "source_reviewers": ["agent_id"] }]`,
    `}`,
  ].join('\n');
}
