// ---------------------------------------------------------------------------
// Response parsers — pull JSON objects out of agent responses and normalize
// them into trusted shapes. Both parsers are permissive about surrounding
// prose (agents often add commentary around the JSON) and strict about the
// fields they return to the rest of the plugin.
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = ['critical', 'major', 'minor', 'nit'];

export function parseReviewerResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { issues: [], parseError: true };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.issues)) return { issues: [], parseError: true };
    return {
      issues: parsed.issues.map((issue, i) => ({
        id: `issue_${i}`,
        title: String(issue.title || `Issue ${i + 1}`),
        severity: VALID_SEVERITIES.includes(issue.severity) ? issue.severity : 'minor',
        description: String(issue.description || ''),
        suggestion: issue.suggestion ? String(issue.suggestion) : null,
        status: 'open',
      })),
      parseError: false,
    };
  } catch {
    return { issues: [], parseError: true };
  }
}

export function parseSynthesisResponse(text, cycleNumber) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.consolidated_issues)) return null;
    const cyclePrefix = cycleNumber != null ? `c${cycleNumber}_` : '';
    return {
      synthesis: parsed.synthesis || { added: [], resolved: [], unchanged: [] },
      consolidated_issues: parsed.consolidated_issues.map((issue, i) => ({
        id: issue.id || `issue_${cyclePrefix}${i}`,
        title: String(issue.title || `Issue ${i + 1}`),
        severity: VALID_SEVERITIES.includes(issue.severity) ? issue.severity : 'minor',
        description: String(issue.description || ''),
        suggestion: issue.suggestion ? String(issue.suggestion) : null,
        status: issue.status === 'resolved' ? 'resolved' : 'open',
        source_reviewers: Array.isArray(issue.source_reviewers) ? issue.source_reviewers : [],
      })),
    };
  } catch {
    return null;
  }
}
