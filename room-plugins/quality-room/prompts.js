import { QUALITY_CATEGORIES } from './constants.js';

function gradeRubricLines() {
  return [
    'Use this stable grading rubric every cycle:',
    '- A = ship-ready for the stated objective; no meaningful changes needed to reach the quality bar.',
    '- B = strong, but meaningful changes are still needed before this deserves an A.',
    '- C = mixed; several important issues still weaken quality.',
    '- D = weak; major issues or risky implementation decisions remain.',
    '- F = fundamentally broken, unsafe, or far below the stated objective.',
    `Grade these categories: ${QUALITY_CATEGORIES.join(', ')}.`,
  ];
}

export function buildInitialReviewPrompt(objective, reviewerDisplayName, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a quality reviewer.`,
    '',
    '## Objective',
    objective,
    '',
  ];

  if (handoffPromptContext) lines.push(handoffPromptContext, '');

  lines.push(
    '## Instructions',
    'Grade the current implementation from A to F and identify only the real blockers that still prevent an A.',
    'Start from the stated objective and the observed code or behavior. Do not invent requirements that are not implied by either.',
    'Do not move the goalposts between cycles. Use the same quality bar every time.',
    'Prefer concrete, verifiable blockers over speculative advice.',
    'Call out unnecessary complexity when a substantially simpler change would solve the objective with less code or risk.',
    'Call out non-surgical changes when the implementation refactors, reformats, or broadens scope beyond what was needed.',
    'Do not ask for new abstractions, configurability, or cleanup work unless they are necessary to reach A.',
    'Do not nitpick stylistic differences that already match the local codebase.',
    'If a concern depends on an assumption, say that assumption explicitly.',
    ...gradeRubricLines(),
    '',
    'Respond with a JSON object in this exact shape:',
    '{',
    '  "overall_grade": "A" | "B" | "C" | "D" | "F",',
    '  "category_grades": {',
    '    "correctness": "A" | "B" | "C" | "D" | "F",',
    '    "simplicity": "A" | "B" | "C" | "D" | "F",',
    '    "maintainability": "A" | "B" | "C" | "D" | "F",',
    '    "verification": "A" | "B" | "C" | "D" | "F",',
    '    "scope_discipline": "A" | "B" | "C" | "D" | "F"',
    '  },',
    '  "strengths": ["what is already strong"],',
    '  "blockers_to_a": [{ "title", "severity", "description", "suggestion" }],',
    '  "assumptions": ["material assumptions behind any blocker"]',
    '}',
    'If the implementation already deserves an A, set "blockers_to_a" to [] and keep assumptions empty unless they materially matter.',
  );

  return lines.join('\n');
}

export function buildReReviewPrompt(objective, reviewerDisplayName, previousFindings, latestImplementation, handoffPromptContext = '') {
  const lines = [
    `You are ${reviewerDisplayName}, a quality reviewer.`,
    '',
    '## Objective',
    objective,
    '',
  ];

  if (handoffPromptContext) lines.push(handoffPromptContext, '');

  lines.push(
    '## Previous Blockers To A',
    JSON.stringify(previousFindings, null, 2),
    '',
  );

  if (latestImplementation) {
    lines.push(
      '## Implementer Latest Changes',
      latestImplementation,
      '',
    );
  }

  lines.push(
    '## Instructions',
    'Re-grade the implementation against the same grading rubric.',
    'Only list blockers that still prevent an A, plus any newly introduced blocker caused by the latest changes.',
    'Do not move the goalposts by inventing new preferences, broader refactors, or nice-to-have cleanup that was not required by the objective or introduced by the latest changes.',
    'If a remaining concern depends on an assumption, state that assumption explicitly.',
    'Prefer concrete, verifiable blockers over speculative advice.',
    ...gradeRubricLines(),
    '',
    'Respond with the same JSON shape as before:',
    '{ "overall_grade": "...", "category_grades": { ... }, "strengths": [], "blockers_to_a": [], "assumptions": [] }',
  );

  return lines.join('\n');
}

export function buildImplementerPrompt(objective, consolidatedFindings, reviewerFeedback, currentGrades, handoffPromptContext = '') {
  const lines = [
    'You are the implementer. Your job is to improve the code by editing the actual files using your tools.',
    '',
    '## Objective',
    objective,
    '',
  ];

  if (handoffPromptContext) lines.push(handoffPromptContext, '');

  lines.push(
    '## Current Reviewer Grades',
    JSON.stringify(currentGrades, null, 2),
    '',
    '## Consolidated Blockers To A',
    JSON.stringify(consolidatedFindings, null, 2),
    '',
  );

  if (reviewerFeedback) {
    lines.push(
      '## Reviewer Feedback',
      reviewerFeedback,
      '',
    );
  }

  lines.push(
    '## Instructions',
    'Address the blockers that still prevent an A grade.',
    'Prefer the smallest change that fully resolves each blocker.',
    'If you write 200 lines and it could be 50, rewrite it.',
    'Keep the diff surgical. Do not refactor, reformat, or clean up unrelated code. Only remove code or imports that become unused because of your own changes.',
    'Match the existing style and patterns of the codebase unless a listed blocker requires a different approach.',
    'Do not add new abstractions, configurability, or speculative improvements unless they are necessary to reach A.',
    'If multiple plausible interpretations would lead to meaningfully different fixes, state the ambiguity explicitly and choose the safest minimal path; if that would still be risky, stop and say what is unclear.',
    'When a blocker can be verified with a focused test, add or update the narrowest test that proves the fix, then make it pass. Otherwise run the most direct verification available and report the result briefly.',
    'If you believe a blocker is incorrect or overreaching, say so briefly and explain the simpler correct fix.',
    'After making all changes, briefly summarize what you fixed and how you verified it.',
  );

  return lines.join('\n');
}
