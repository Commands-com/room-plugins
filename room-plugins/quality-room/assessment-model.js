export function reviewerStatusForAssessment(assessment) {
  if (!assessment || assessment.overall_grade === 'A') return 'a_grade';
  return 'below_a';
}

export function summarizeAssessmentsByReviewer(assessments) {
  return (Array.isArray(assessments) ? assessments : []).map((assessment) => ({
    reviewer: assessment.displayName,
    overallGrade: assessment.overall_grade,
    correctness: assessment.category_grades.correctness || '',
    simplicity: assessment.category_grades.simplicity || '',
    maintainability: assessment.category_grades.maintainability || '',
    verification: assessment.category_grades.verification || '',
    scopeDiscipline: assessment.category_grades.scope_discipline || '',
    blockers: assessment.blockers_to_a.length,
  }));
}

export function countGrades(assessments) {
  const counts = { aCount: 0, bCount: 0, cCount: 0, dCount: 0, fCount: 0 };
  for (const assessment of Array.isArray(assessments) ? assessments : []) {
    switch (assessment.overall_grade) {
      case 'A': counts.aCount += 1; break;
      case 'B': counts.bCount += 1; break;
      case 'C': counts.cCount += 1; break;
      case 'D': counts.dCount += 1; break;
      case 'F': counts.fCount += 1; break;
      default: break;
    }
  }
  return counts;
}

export function buildReviewerFeedbackText(responses, participants) {
  return responses.map((response) => {
    const participant = participants.find((entry) => entry.agentId === response.agentId);
    return `### ${participant?.displayName || response.agentId}\n${response.response}`;
  }).join('\n\n');
}

export function buildCurrentGradesSummary(assessments) {
  return (Array.isArray(assessments) ? assessments : []).map((assessment) => ({
    reviewer: assessment.displayName,
    overall_grade: assessment.overall_grade,
    category_grades: assessment.category_grades,
    blocker_count: assessment.blockers_to_a.length,
  }));
}
