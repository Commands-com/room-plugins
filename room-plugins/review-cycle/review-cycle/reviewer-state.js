// ---------------------------------------------------------------------------
// Reviewer phase FSM + convergence evaluation — pure functions that reason
// about per-reviewer state and the room-wide stop condition.
//
// Phase ladder:
//   initial_review → has_open_issues → clean_review → done (terminal)
// A reviewer bumps back to has_open_issues any time they report new issues.
// Convergence happens when every non-withdrawn reviewer is in `done`.
// ---------------------------------------------------------------------------

import { REVIEWER_PHASES, STOP_REASON } from '../../core-room-support/room-contracts.js';

/**
 * Compute next phase for a reviewer based on their current phase and issue count.
 *
 * initial_review → always → has_open_issues
 * has_open_issues + 0 issues → clean_review
 * clean_review + 0 issues → done (terminal)
 * clean_review + new issues → has_open_issues
 */
export function nextReviewerPhase(currentPhase, issueCount) {
  if (currentPhase === REVIEWER_PHASES.INITIAL_REVIEW) {
    return REVIEWER_PHASES.HAS_OPEN_ISSUES;
  }
  if (currentPhase === REVIEWER_PHASES.HAS_OPEN_ISSUES) {
    return issueCount === 0
      ? REVIEWER_PHASES.CLEAN_REVIEW
      : REVIEWER_PHASES.HAS_OPEN_ISSUES;
  }
  if (currentPhase === REVIEWER_PHASES.CLEAN_REVIEW) {
    return issueCount === 0
      ? REVIEWER_PHASES.DONE
      : REVIEWER_PHASES.HAS_OPEN_ISSUES;
  }
  // done or withdrawn — no transition
  return currentPhase;
}

export function evaluateConvergence(state) {
  const activeReviewers = state.reviewerStates.filter(
    (r) => r.phase !== REVIEWER_PHASES.WITHDRAWN,
  );

  if (activeReviewers.length === 0) {
    // All reviewers withdrawn — stop with open issues if any remain
    const openCount = state.issues.filter((i) => i.status === 'open').length;
    return openCount > 0 ? STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES : STOP_REASON.CONVERGENCE;
  }

  const allDone = activeReviewers.every((r) => r.phase === REVIEWER_PHASES.DONE);
  if (!allDone) return null; // not converged yet

  const openCount = state.issues.filter((i) => i.status === 'open').length;
  return openCount > 0 ? STOP_REASON.CONVERGENCE_WITH_OPEN_ISSUES : STOP_REASON.CONVERGENCE;
}
