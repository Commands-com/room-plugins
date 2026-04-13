/**
 * UI/UX Testing prompt builders and response parsers.
 *
 * Pure functions — no state, no I/O, no Electron deps.
 */

import { extractJSON } from './parse-helpers.js';

export const DOMAIN_CONTEXT = [
  'This is a **UI/UX Testing** room. The goal is to test the frontend user interface and user experience.',
  '',
  '**What to test:**',
  '- Visual rendering: Do pages/screens render correctly? Are layouts, colors, typography, spacing correct?',
  '- User interactions: Do buttons, forms, modals, dropdowns, navigation work as expected?',
  '- User workflows: Can a user complete key journeys (sign up, log in, create/edit/delete, etc.)?',
  '- Responsive design: Does the UI adapt to different viewport sizes?',
  '- Accessibility: Are ARIA labels, keyboard navigation, focus management, contrast ratios correct?',
  '- Error states: What happens when forms have invalid input, network fails, or data is missing?',
  '- Edge cases: Empty states, long text overflow, special characters, rapid clicks',
  '',
  '**What NOT to test:**',
  '- Do NOT write backend/API unit tests or domain logic tests',
  '- Do NOT test database queries, server routes, or business rule implementations',
  '- Focus exclusively on what a user sees and interacts with in the UI',
].join('\n');

// ---------------------------------------------------------------------------
// Discovery — UI/UX-specific
// ---------------------------------------------------------------------------

export function buildUiUxDiscoveryPrompt(objective, config, upstreamContext = '') {
  const targetHint = config.targetPath
    ? `Focus your exploration on: **${config.targetPath}**`
    : 'Explore the full project to find UI source code';
  const harnessHint = config.harnessCommand
    ? `The expected test harness command is: \`${config.harnessCommand}\`. Verify it works and note the framework it uses.`
    : 'Determine the test harness by inspecting package.json devDependencies and existing test configs.';
  const upstreamBlock = upstreamContext
    ? ['', '## Upstream Context', upstreamContext, '']
    : [];

  return [
    'You are a UI/UX test worker. Your team is about to write and run **frontend UI tests** for this objective:',
    '',
    `> ${objective}`,
    '',
    ...upstreamBlock,
    DOMAIN_CONTEXT,
    '',
    `${targetHint}`,
    '',
    'Use your tools to investigate the following — be thorough, the orchestrator cannot see your filesystem:',
    '',
    '1. **UI framework** — What renders the UI? (React, Vue, Svelte, Angular, vanilla JS, Electron renderer, etc.) Which version?',
    '2. **Pages / views / screens** — List every user-facing page or view with its file path. Look in routes, pages/, views/, screens/, or component directories.',
    '3. **Route map** — How is navigation structured? (React Router, file-based routing, hash routing, Electron webContents, etc.) List the URL paths or navigation entries.',
    '4. **Test framework** — What UI testing tools are installed? (Playwright, Cypress, Testing Library, Puppeteer, WebdriverIO, Vitest, Jest) Check package.json devDependencies and find config files (playwright.config.ts, cypress.config.js, etc.).',
    '5. **Example test files** — Find 1-2 existing UI test files. Note the file path, what framework they use, and how they select elements.',
    '6. **Selector patterns** — Does the project use `data-testid`? CSS classes? ARIA roles? What naming conventions are used for targeting elements in tests?',
    '7. **Styling approach** — CSS modules, Tailwind, styled-components, plain CSS files? This matters for visual and responsive tests.',
    '8. **Key interactions** — List the main interactive elements: forms, modals, dropdowns, navigation menus, drag-and-drop, etc. with their file locations.',
    '9. **Accessibility setup** — Any ARIA landmarks, skip links, focus management, screen reader attributes? Any existing a11y testing (axe-core, pa11y)?',
    '10. **Entry points** — Main HTML files, app shell, root layout components. How does the app start?',
    '11. **Existing test coverage** — What UI areas already have tests? What is untested?',
    '',
    `${harnessHint}`,
    '',
    'After exploring, respond with a JSON object:',
    '{',
    '  "workingDirectory": "/full/path/to/repo",',
    '  "uiFramework": "react 18 | vue 3 | svelte | vanilla | electron-renderer | ...",',
    '  "componentPages": [',
    '    { "name": "Login Page", "path": "src/pages/Login.tsx", "description": "Email/password form with OAuth buttons" },',
    '    { "name": "Dashboard", "path": "src/pages/Dashboard.tsx", "description": "Main app view with sidebar nav" }',
    '  ],',
    '  "routeMap": "/ -> Landing, /login -> Login, /dashboard -> Dashboard, ...",',
    '  "testFramework": "playwright | cypress | testing-library | vitest | jest | none",',
    '  "testConfigPath": "playwright.config.ts or similar",',
    '  "exampleTestFile": "path/to/existing-test.spec.ts",',
    '  "selectorPattern": "data-testid | css-class | aria-role | mixed",',
    '  "stylingApproach": "tailwind | css-modules | styled-components | plain-css | ...",',
    '  "keyInteractions": [',
    '    { "element": "Login form", "path": "src/components/LoginForm.tsx", "type": "form" },',
    '    { "element": "Navigation menu", "path": "src/components/Nav.tsx", "type": "navigation" }',
    '  ],',
    '  "accessibilitySetup": "Description of ARIA usage, focus management, skip links, a11y tools",',
    '  "entryPoints": ["src/main.tsx", "public/index.html"],',
    '  "existingTestCoverage": "What has tests, what lacks tests",',
    '  "notes": "Anything else relevant for UI test planning"',
    '}',
  ].join('\n');
}

export function parseUiUxDiscoveryResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) {
    return { rawReport: text || '', parseError: true };
  }
  return {
    workingDirectory: String(parsed.workingDirectory || ''),
    uiFramework: String(parsed.uiFramework || ''),
    componentPages: Array.isArray(parsed.componentPages) ? parsed.componentPages : [],
    routeMap: String(parsed.routeMap || ''),
    testFramework: String(parsed.testFramework || 'none'),
    testConfigPath: String(parsed.testConfigPath || ''),
    exampleTestFile: String(parsed.exampleTestFile || ''),
    selectorPattern: String(parsed.selectorPattern || ''),
    stylingApproach: String(parsed.stylingApproach || ''),
    keyInteractions: Array.isArray(parsed.keyInteractions) ? parsed.keyInteractions : [],
    accessibilitySetup: String(parsed.accessibilitySetup || ''),
    entryPoints: Array.isArray(parsed.entryPoints) ? parsed.entryPoints.map(String) : [],
    existingTestCoverage: String(parsed.existingTestCoverage || ''),
    notes: String(parsed.notes || ''),
    rawReport: '',
    parseError: false,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildScenarioPlanningPrompt(objective, workers, config, upstreamContext = '') {
  const workerSections = workers.map((w) => {
    const lines = [`### ${w.displayName} (${w.agentId})`];

    // Prefer structured UI/UX discovery fields
    if (w.uiFramework || w.componentPages?.length || w.testFramework) {
      if (w.uiFramework) lines.push(`UI Framework: ${w.uiFramework}`);
      if (w.testFramework && w.testFramework !== 'none') lines.push(`Test Framework: ${w.testFramework}`);
      if (w.selectorPattern) lines.push(`Selector Pattern: ${w.selectorPattern}`);
      if (w.routeMap) lines.push(`Routes: ${w.routeMap}`);
      if (w.componentPages?.length) {
        lines.push('Pages/Views:');
        for (const p of w.componentPages) {
          const name = typeof p === 'string' ? p : `${p.name || 'Unknown'} (${p.path || '?'}) — ${p.description || ''}`;
          lines.push(`  - ${name}`);
        }
      }
      if (w.keyInteractions?.length) {
        lines.push('Key Interactions:');
        for (const k of w.keyInteractions) {
          const desc = typeof k === 'string' ? k : `${k.element || '?'} [${k.type || '?'}] — ${k.path || ''}`;
          lines.push(`  - ${desc}`);
        }
      }
      if (w.accessibilitySetup) lines.push(`Accessibility: ${w.accessibilitySetup}`);
      if (w.existingTestCoverage) lines.push(`Existing Coverage: ${w.existingTestCoverage}`);
      if (w.exampleTestFile) lines.push(`Example Test: ${w.exampleTestFile}`);
      if (w.testConfigPath) lines.push(`Test Config: ${w.testConfigPath}`);
    } else if (w.fullReport) {
      // Fall back to raw report when structured fields are missing
      lines.push(w.fullReport);
    }
    return lines.join('\n');
  }).join('\n\n');

  const extras = [];
  if (config.runAccessibility) extras.push('Include at least 1-2 accessibility-focused scenarios (ARIA, keyboard nav, contrast).');
  if (config.runVisualDiff) extras.push('Include at least 1-2 visual regression scenarios.');
  const upstreamBlock = upstreamContext
    ? ['', '## Upstream Context', upstreamContext, '']
    : [];

  return [
    'You are a UI/UX test planning orchestrator. Based on worker discovery reports, generate specific test scenarios.',
    '',
    '## Objective',
    objective,
    ...upstreamBlock,
    '',
    '## Domain Context',
    DOMAIN_CONTEXT,
    '',
    '## Worker Discovery Reports',
    workerSections,
    '',
    '## Configuration',
    `- Target path: ${config.targetPath}`,
    `- Target runtime: ${config.targetRuntime}`,
    `- Harness command: ${config.harnessCommand || '(auto-detect from package.json)'}`,
    `- Test personas: ${config.testPersonas.join(', ')}`,
    `- Planned scenarios: ${config.plannedScenarios}`,
    ...extras,
    '',
    '## Instructions',
    `Generate exactly ${config.plannedScenarios} concrete, specific UI/UX test scenarios that address the objective.`,
    'Each scenario must:',
    '- Target specific pages/views/components discovered by the workers',
    '- Use the selector patterns found in the codebase (data-testid, ARIA roles, etc.)',
    '- Be testable with the detected test framework',
    '- Focus on what a user sees and interacts with — NOT backend logic',
    '- Be assigned to a worker who has access to the relevant codebase',
    '- Be categorized: interaction, validation, accessibility, visual, workflow, or responsive',
    '',
    'Respond ONLY with JSON — no explanation before or after:',
    '{',
    '  "scenarios": [',
    '    {',
    '      "id": "scenario_1",',
    '      "title": "Short descriptive title",',
    '      "description": "Detailed steps: open page X, click button Y, verify Z appears",',
    '      "assignedTo": "agentId from worker reports above",',
    '      "category": "interaction|validation|accessibility|visual|workflow|responsive"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function buildTestWritingPrompt(scenario, config, upstreamContext = '') {
  const upstreamBlock = upstreamContext
    ? [upstreamContext, '']
    : [];
  return [
    `## Task: Write UI Test — ${scenario.title}`,
    '',
    scenario.description,
    '',
    ...upstreamBlock,
    '## Test Requirements',
    `- Target directory: ${config.targetPath}`,
    `- Harness command: ${config.harnessCommand || 'auto-detect from package.json'}`,
    `- Runtime: ${config.targetRuntime}`,
    `- Category: ${scenario.category || 'workflow'}`,
    '',
    '## Instructions',
    '1. Write a runnable test file in the project\'s test directory following existing test patterns',
    '2. Use the project\'s existing test framework (Playwright, Cypress, Testing Library, etc.)',
    '3. Use data-testid or existing selector patterns for targeting UI elements',
    '4. The test must exercise real rendered UI — not mock or unit level',
    '5. Name the file descriptively (e.g., login-validation.spec.ts)',
    '',
    'After writing the test, verify it can at least be parsed/compiled without errors.',
    '',
    'Respond with JSON:',
    '{ "status": "written", "testFilePath": "relative/path/to/test.spec.ts",',
    '  "summary": "What the test covers" }',
    'OR if blocked:',
    '{ "status": "blocked", "blockedReason": "Why this test cannot be written" }',
  ].join('\n');
}

export function buildTestExecutionPrompt(scenario, config) {
  const filterHint = config.harnessCommand
    ? `Run: \`${config.harnessCommand}\` — if it runs the full suite, try to filter to just the file: ${scenario.testFilePath}`
    : `Find and run the appropriate test command for: ${scenario.testFilePath}`;

  return [
    `## Task: Execute UI Test — ${scenario.title}`,
    '',
    `Test file: ${scenario.testFilePath}`,
    '',
    '## Instructions',
    `1. ${filterHint}`,
    '2. Collect the full stdout and stderr output',
    '3. Determine pass/fail status and counts',
    '4. If the test fails, capture the error messages and stack traces',
    '',
    'Respond with JSON:',
    '{ "passed": true/false, "passCount": N, "failCount": N,',
    '  "errors": ["error message 1", ...],',
    '  "output": "relevant stdout/stderr (keep under 3000 chars)" }',
  ].join('\n');
}

export function buildFixPrompt(scenario, config, upstreamContext = '') {
  const lr = scenario.lastResult || {};
  const errorSection = Array.isArray(lr.errors) && lr.errors.length > 0
    ? `Errors:\n${lr.errors.map((e) => `- ${e}`).join('\n')}`
    : '';
  const outputSection = lr.output
    ? `Output (truncated):\n${String(lr.output).slice(0, 3000)}`
    : '';
  const upstreamBlock = upstreamContext
    ? [upstreamContext, '']
    : [];

  return [
    `## Task: Fix Failing UI Test — ${scenario.title}`,
    '',
    `Test file: ${scenario.testFilePath}`,
    '',
    ...upstreamBlock,
    '## Last Execution Results',
    `Passed: ${lr.passed ? 'YES' : 'NO'}`,
    `Pass count: ${lr.passCount || 0}, Fail count: ${lr.failCount || 0}`,
    errorSection,
    outputSection,
    '',
    '## Instructions',
    '1. Read the test file and the failing output carefully',
    '2. Determine if the failure is a test bug (wrong selector, timing issue, wrong assertion)',
    '   or a real product bug (the UI genuinely does the wrong thing)',
    '3. Fix the test file, the application code, or both as appropriate',
    '4. Re-run the test to verify the fix works',
    '5. Report the new results',
    '',
    'Respond with JSON:',
    '{ "fixApplied": "test|code|both|none",',
    '  "summary": "What was fixed and why",',
    '  "passed": true/false, "passCount": N, "failCount": N,',
    '  "errors": [...], "output": "..." }',
  ].join('\n');
}

export function buildEvaluationPrompt(objective, scenarios, passRate, config, upstreamContext = '') {
  const lines = scenarios.map((s, i) => {
    const r = s.lastResult;
    const result = r ? (r.passed ? 'PASS' : 'FAIL') : 'N/A';
    const errHint = r && !r.passed && r.errors?.length ? ` — ${r.errors[0].slice(0, 80)}` : '';
    return `${i + 1}. [${result}] ${s.title} (${s.category || '-'}) retries:${s.retries}${errHint}`;
  }).join('\n');
  const upstreamBlock = upstreamContext
    ? ['', '## Upstream Context', upstreamContext, '']
    : [];

  return [
    'You are the UI/UX test orchestrator producing a final evaluation report.',
    '',
    '## Objective',
    objective,
    ...upstreamBlock,
    '',
    '## Test Results',
    `Overall pass rate: ${passRate}% (target: ${config.minPassRatePct}%)`,
    `Total scenarios: ${scenarios.length}`,
    '',
    lines,
    '',
    '## Instructions',
    'Produce a structured summary covering:',
    '1. Overall assessment — did the test suite meet the target pass rate?',
    '2. Key findings — what UI issues were discovered?',
    '3. Failing scenarios — root cause analysis for each failure',
    '4. Accessibility/visual results (if applicable)',
    '5. Recommended follow-up actions for the development team',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

export function parseScenarioPlanResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed || !Array.isArray(parsed.scenarios)) return null;
  return parsed.scenarios.map((s, i) => ({
    id: s.id || `scenario_${i + 1}`,
    title: String(s.title || `Scenario ${i + 1}`),
    description: String(s.description || ''),
    assignedTo: String(s.assignedTo || ''),
    category: String(s.category || 'workflow'),
  }));
}

export function parseTestWritingResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) return { status: 'written', testFilePath: '', summary: text || '', parseError: true };
  return {
    status: parsed.status === 'blocked' ? 'blocked' : 'written',
    testFilePath: String(parsed.testFilePath || ''),
    summary: String(parsed.summary || ''),
    blockedReason: parsed.blockedReason ? String(parsed.blockedReason) : null,
    parseError: false,
  };
}

export function parseTestExecutionResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) return { passed: false, passCount: 0, failCount: 0, errors: [text || 'unparseable response'], output: '', parseError: true };
  return {
    passed: Boolean(parsed.passed),
    passCount: Number(parsed.passCount) || 0,
    failCount: Number(parsed.failCount) || 0,
    errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
    output: String(parsed.output || '').slice(0, 5000),
    parseError: false,
  };
}

export function parseFixResponse(text) {
  const parsed = extractJSON(text);
  if (!parsed) return { fixApplied: 'none', summary: '', passed: false, passCount: 0, failCount: 0, errors: [text || 'unparseable response'], output: '', parseError: true };
  return {
    fixApplied: String(parsed.fixApplied || 'none'),
    summary: String(parsed.summary || ''),
    passed: Boolean(parsed.passed),
    passCount: Number(parsed.passCount) || 0,
    failCount: Number(parsed.failCount) || 0,
    errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
    output: String(parsed.output || '').slice(0, 5000),
    parseError: false,
  };
}
