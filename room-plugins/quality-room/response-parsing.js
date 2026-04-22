import {
  QUALITY_CATEGORIES,
  SEVERITY_ORDER,
  VALID_GRADES,
} from './constants.js';

function normalizeGrade(value, fallback = 'C') {
  const candidate = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return VALID_GRADES.has(candidate) ? candidate : fallback;
}

function normalizeSeverity(value) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, candidate) ? candidate : 'major';
}

function canonicalKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[`'"!?.,()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseReviewerResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        overall_grade: 'A',
        category_grades: {},
        strengths: [],
        blockers_to_a: [],
        assumptions: [],
        parseError: true,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const blockers = Array.isArray(parsed.blockers_to_a)
      ? parsed.blockers_to_a.map((blocker, index) => ({
        title: String(blocker?.title || `Blocker ${index + 1}`),
        severity: normalizeSeverity(blocker?.severity),
        description: String(blocker?.description || ''),
        suggestion: blocker?.suggestion ? String(blocker.suggestion) : null,
      }))
      : [];

    const category_grades = {};
    for (const category of QUALITY_CATEGORIES) {
      category_grades[category] = normalizeGrade(parsed?.category_grades?.[category], 'C');
    }

    let overall_grade = normalizeGrade(parsed?.overall_grade, 'C');
    if (blockers.length === 0) {
      overall_grade = 'A';
      for (const category of QUALITY_CATEGORIES) {
        if (!VALID_GRADES.has(category_grades[category])) category_grades[category] = 'A';
      }
    } else if (overall_grade === 'A') {
      overall_grade = 'B';
    }

    return {
      overall_grade,
      category_grades,
      strengths: Array.isArray(parsed?.strengths) ? parsed.strengths.map((value) => String(value)) : [],
      blockers_to_a: blockers,
      assumptions: Array.isArray(parsed?.assumptions) ? parsed.assumptions.map((value) => String(value)) : [],
      parseError: false,
    };
  } catch {
    return {
      overall_grade: 'A',
      category_grades: {},
      strengths: [],
      blockers_to_a: [],
      assumptions: [],
      parseError: true,
    };
  }
}

export function mergeBlockers(previousFindings, reviewerResults, cycleNumber) {
  const previousByKey = new Map();
  for (const finding of Array.isArray(previousFindings) ? previousFindings : []) {
    if (finding?.key) previousByKey.set(finding.key, finding);
  }

  let createdCount = 0;
  const nextByKey = new Map();

  for (const result of reviewerResults) {
    for (const blocker of result.blockers_to_a) {
      const key = canonicalKey(blocker.title || blocker.description);
      if (!key) continue;

      const previous = previousByKey.get(key) || null;
      let finding = nextByKey.get(key);
      if (!finding) {
        finding = {
          id: previous?.id || `finding_c${cycleNumber}_${createdCount++}`,
          key,
          title: blocker.title,
          severity: blocker.severity,
          description: blocker.description,
          suggestion: blocker.suggestion,
          status: 'open',
          source_reviewers: [result.agentId],
          firstSeenInCycle: previous?.firstSeenInCycle || cycleNumber,
          resolvedInCycle: null,
        };
        nextByKey.set(key, finding);
      } else {
        if (SEVERITY_ORDER[blocker.severity] > SEVERITY_ORDER[finding.severity]) {
          finding.severity = blocker.severity;
        }
        if ((blocker.description || '').length > (finding.description || '').length) {
          finding.description = blocker.description;
        }
        if ((blocker.suggestion || '').length > (finding.suggestion || '').length) {
          finding.suggestion = blocker.suggestion;
        }
        if (!finding.source_reviewers.includes(result.agentId)) {
          finding.source_reviewers.push(result.agentId);
        }
      }
    }
  }

  const merged = Array.from(nextByKey.values());

  for (const previous of Array.isArray(previousFindings) ? previousFindings : []) {
    if (nextByKey.has(previous.key)) continue;
    if (previous.status === 'open') {
      merged.push({
        ...previous,
        status: 'resolved',
        resolvedInCycle: previous.resolvedInCycle ?? cycleNumber,
      });
    } else {
      merged.push(previous);
    }
  }

  return merged;
}
