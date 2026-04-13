/**
 * Shared response-parsing helpers for room plugins.
 *
 * extractJSON — robust JSON extraction from LLM text responses.
 */

/**
 * Extract a JSON object from LLM response text.
 * Tries: (1) markdown code fences, (2) full text, (3) balanced-brace extraction.
 */
export function extractJSON(text) {
  // 1. Try markdown code-fenced JSON first (```json ... ``` or ``` ... ```)
  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fencedMatch) {
    try { return JSON.parse(fencedMatch[1].trim()); } catch { /* fall through */ }
  }
  // 2. Try the full text as JSON
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }
  // 3. Balanced-brace extraction: find outermost { ... } with matching braces
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
