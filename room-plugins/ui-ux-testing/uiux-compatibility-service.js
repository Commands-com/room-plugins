import fsNative from 'node:fs';
import osNative from 'node:os';
import pathNative from 'node:path';

const PATH_CHECK_ID = 'target_path';
const HARNESS_CHECK_ID = 'harness_command';
const TOOLING_CHECK_ID = 'runtime_tooling';
const WEB_SERVER_BINDING_CHECK_ID = 'web_server_binding';
const ARTIFACT_CHECK_ID = 'artifact_dir';
const SELECTOR_CHECK_ID = 'selector_signal';
const PERSONA_CHECK_ID = 'persona_fixtures';
const PERMISSION_CHECK_ID = 'worker_permissions';
const ELECTRON_ENV_CHECK_ID = 'electron_env';

// Env vars inherited from the parent Electron process that prevent target
// Electron apps from launching as GUI applications.
const ELECTRON_HOSTILE_ENV_VARS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'];

const BUILTIN_PERMISSION_IDS = new Set(['read-only', 'dev-safe', 'full']);
const AI_REPO_FIX_TIMEOUT_MS = 600_000;
const AI_REPO_FIX_MAX_TOOL_ROUNDS = 200;
const AI_REPO_FIX_MAX_OUTPUT_CHARS = 16_000;
const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json',
  '.html', '.vue', '.svelte', '.css',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const trimmed = trimString(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeRuntime(raw, packageJson) {
  const explicit = trimString(raw).toLowerCase();
  if (explicit === 'electron' || explicit === 'web') return explicit;
  const deps = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {}),
  };
  return deps.electron ? 'electron' : 'web';
}

function parsePersonas(input) {
  if (Array.isArray(input)) {
    return uniqueStrings(input);
  }
  const asText = trimString(input);
  if (!asText) return [];
  return uniqueStrings(asText.split(/[,\n]/g));
}

function tokenizeCommand(command) {
  const out = [];
  const src = trimString(command);
  if (!src) return out;

  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? '';
    if (token) out.push(token.replace(/\\(["'])/g, '$1'));
  }
  return out;
}

function deriveRequiredShellPrefixes(command) {
  const argv = tokenizeCommand(command);
  if (argv.length === 0) return [];

  const cmd = argv[0];
  if ((cmd === 'npm' || cmd === 'pnpm') && argv[1] === 'run' && argv[2]) {
    return [[cmd, 'run', argv[2]]];
  }
  if (cmd === 'yarn' && argv[1]) {
    return [['yarn', argv[1]]];
  }
  if (cmd === 'npx' && argv[1]) {
    return [['npx', argv[1]]];
  }
  return [[cmd]];
}

function formatPrefix(prefix) {
  return Array.isArray(prefix) ? prefix.join(' ') : '';
}

function prefixesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function dedupePrefixes(prefixes) {
  const out = [];
  for (const prefix of prefixes || []) {
    if (!Array.isArray(prefix) || prefix.length === 0) continue;
    const normalized = prefix.map((token) => trimString(token)).filter(Boolean);
    if (normalized.length === 0) continue;
    if (!out.some((existing) => prefixesEqual(existing, normalized))) {
      out.push(normalized);
    }
  }
  return out;
}

function matchesArgvPrefix(argv, prefix) {
  if (!Array.isArray(argv) || !Array.isArray(prefix)) return false;
  if (prefix.length === 0 || prefix.length > argv.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== argv[i]) return false;
  }
  return true;
}

function mergePrefixes(existing, required) {
  return dedupePrefixes([...(existing || []), ...(required || [])]);
}

function isWithinPath(pathLib, root, target) {
  const resolvedRoot = pathLib.resolve(root);
  const resolvedTarget = pathLib.resolve(target);
  if (resolvedRoot === resolvedTarget) return true;
  const prefix = resolvedRoot.endsWith(pathLib.sep) ? resolvedRoot : `${resolvedRoot}${pathLib.sep}`;
  return resolvedTarget.startsWith(prefix);
}

function collectWorkspaceRoots(workspace, pathLib) {
  if (!workspace || typeof workspace !== 'object') return [];
  const roots = [];
  const seen = new Set();
  const candidates = [
    workspace.primaryCwd,
    ...(Array.isArray(workspace.roots) ? workspace.roots : []),
  ];
  for (const candidate of candidates) {
    const value = trimString(candidate);
    if (!value) continue;
    let normalized = value;
    try {
      normalized = pathLib.resolve(value);
    } catch {
      normalized = value;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

function parsePermissionRef(agentProfile) {
  const profileId = trimString(agentProfile?.permissionProfileId);
  if (profileId) return profileId;
  const builtIn = trimString(agentProfile?.permissions);
  return builtIn || 'read-only';
}

function normalizeProvider(profile) {
  const provider = trimString(profile?.provider).toLowerCase();
  return provider || 'claude';
}

function profileHasWildcardShell(permissionProfile) {
  const allow = permissionProfile?.shell?.allowPrefixes;
  return Array.isArray(allow) && allow.some((prefix) => Array.isArray(prefix) && prefix.length === 1 && prefix[0] === '*');
}

function analyzePermissionCoverage({
  permissionProfile,
  requiredShellPrefixes,
  targetPath,
  agentWorkspace,
  workspaceRoots,
}) {
  const missingShell = [];
  const allowPrefixes = Array.isArray(permissionProfile?.shell?.allowPrefixes)
    ? permissionProfile.shell.allowPrefixes
    : [];
  const wildcardShell = profileHasWildcardShell(permissionProfile);

  if (!wildcardShell) {
    for (const required of requiredShellPrefixes) {
      const allowed = allowPrefixes.some((allowPrefix) => matchesArgvPrefix(required, allowPrefix));
      if (!allowed) {
        missingShell.push(required);
      }
    }
  }

  let missingCwd = false;
  let effectiveCwdRoots = [];

  // 'full' built-in has no CWD enforcement at runtime (mode: 'none')
  if (permissionProfile?.id === 'full' && permissionProfile?.builtIn) {
    missingCwd = false;
    effectiveCwdRoots = [];
  } else {
    // Mirror runtime compilation (compilePermissionProfile in agent-env.js):
    // non-full policies always get a base CWD root injected from the agent's
    // workspace or default CWD. Compute effective roots as that union.
    const baseCwdRoot = agentWorkspace || osNative.homedir();
    const effective = new Set();
    if (baseCwdRoot) effective.add(baseCwdRoot);

    const profileRoots = Array.isArray(permissionProfile?.allowedCwdRoots)
      ? permissionProfile.allowedCwdRoots.filter((v) => typeof v === 'string' && v.trim())
      : [];
    for (const root of profileRoots) {
      effective.add(root.trim());
    }

    for (const root of Array.isArray(workspaceRoots) ? workspaceRoots : []) {
      if (typeof root === 'string' && root.trim()) effective.add(root.trim());
    }

    effectiveCwdRoots = [...effective];
    if (effectiveCwdRoots.length > 0) {
      missingCwd = !effectiveCwdRoots.some((root) => {
        try {
          return isWithinPath(pathNative, root, targetPath);
        } catch {
          return false;
        }
      });
    }
  }

  return {
    missingShell,
    missingCwd,
    allowPrefixes,
    cwdRoots: effectiveCwdRoots,
  };
}

async function readPackageJson(fs, pathLib, targetPath) {
  const packageJsonPath = pathLib.join(targetPath, 'package.json');
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { packageJsonPath, packageJson: parsed };
  } catch {
    return { packageJsonPath, packageJson: null };
  }
}

function discoverHarnessCommand(packageJson, explicitHarnessCommand) {
  const explicit = trimString(explicitHarnessCommand);
  if (explicit) return { command: explicit, source: 'explicit' };

  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : null;
  if (!scripts) return { command: '', source: 'none' };

  const candidates = ['test:uiux', 'test:ui-ux', 'test:ux', 'test:e2e', 'test:ui', 'e2e', 'playwright'];
  for (const scriptName of candidates) {
    if (typeof scripts[scriptName] === 'string' && scripts[scriptName].trim()) {
      return { command: `npm run ${scriptName}`, source: `package.json:${scriptName}` };
    }
  }
  return { command: '', source: 'none' };
}

function extractStaticWebServerCommand(configSource) {
  const text = trimString(configSource);
  if (!text) return '';
  const match = text.match(/webServer\s*:\s*\{[\s\S]*?command\s*:\s*["'`]([^"'`]+)["'`]/m);
  return trimString(match?.[1]);
}

function assessServeLoopbackBinding(command) {
  const argv = tokenizeCommand(command);
  if (argv.length === 0) return { applicable: false, ok: true, details: '' };
  const usesServe = argv[0] === 'serve' || (argv[0] === 'npx' && argv[1] === 'serve');
  if (!usesServe) return { applicable: false, ok: true, details: '' };

  const bindsLoopback = argv.some((token) => /(?:^|\/\/)(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(token))
    || argv.some((token) => token === 'localhost' || token === '127.0.0.1');

  if (bindsLoopback) {
    return {
      applicable: true,
      ok: true,
      details: `Serve command binds to loopback: ${command}`,
    };
  }

  return {
    applicable: true,
    ok: false,
    details: `Serve command "${command}" does not bind to localhost. The serve package defaults to 0.0.0.0, which can fail in restricted environments. Bind it explicitly with something like "npx serve site -l tcp://127.0.0.1:3000".`,
  };
}

async function inspectWebServerBinding(fs, pathLib, targetPath) {
  const candidateConfigs = [
    'playwright.config.js',
    'playwright.config.cjs',
    'playwright.config.mjs',
    'playwright.config.ts',
  ];

  for (const relativePath of candidateConfigs) {
    const fullPath = pathLib.join(targetPath, relativePath);
    try {
      const source = await fs.readFile(fullPath, 'utf8');
      const command = extractStaticWebServerCommand(source);
      const assessment = assessServeLoopbackBinding(command);
      if (!assessment.applicable) continue;
      return {
        ok: assessment.ok,
        details: assessment.details,
        meta: {
          configPath: fullPath,
          command,
        },
      };
    } catch {
      // Ignore missing/unreadable config files.
    }
  }

  return null;
}

function runtimeToolingStatus({ runtime, packageJson, resolvedHarnessCommand }) {
  const deps = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {}),
  };

  if (runtime === 'electron' && !deps.electron) {
    return {
      ok: false,
      details: 'Runtime is electron but package.json has no electron dependency',
    };
  }

  const harnessTokens = tokenizeCommand(resolvedHarnessCommand).join(' ').toLowerCase();
  const hasPlaywright = Boolean(deps['@playwright/test'] || deps.playwright);
  const hasCypress = Boolean(deps.cypress);
  const commandHintsHarness = harnessTokens.includes('playwright') || harnessTokens.includes('cypress');
  const hasUiHarness = hasPlaywright || hasCypress || commandHintsHarness;

  if (!hasUiHarness) {
    return {
      ok: false,
      details: 'No supported UI harness detected (expected Playwright or Cypress dependency/command)',
    };
  }

  return { ok: true, details: `${runtime} runtime + UI harness detected` };
}

async function artifactWritableStatus(fs, pathLib, targetPath) {
  const artifactDir = pathLib.join(targetPath, '.commands-artifacts', 'uiux');
  const marker = pathLib.join(artifactDir, '.compat-write-test.tmp');
  try {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(marker, 'ok', 'utf8');
    await fs.unlink(marker);
    return { ok: true, details: `Writable: ${artifactDir}`, artifactDir };
  } catch (err) {
    return { ok: false, details: `Artifact directory not writable: ${artifactDir} (${err?.message || 'write failed'})`, artifactDir };
  }
}

async function scanForSelectorSignal(fs, pathLib, targetPath, maxFiles = 300) {
  const stack = [targetPath];
  let visited = 0;

  while (stack.length > 0 && visited < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      const fullPath = pathLib.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(pathLib.extname(entry.name))) continue;
      visited += 1;
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        if (content.includes('data-testid') || content.includes('data-test-id')) {
          return { ok: true, details: `Selector signal found in ${fullPath}` };
        }
      } catch {
        // Ignore unreadable files.
      }
    }
  }
  return { ok: false, details: 'No data-testid/data-test-id selector signal found in sampled source files' };
}

async function scanPersonaFixtureHints(fs, pathLib, targetPath, personas, maxEntries = 500) {
  if (!Array.isArray(personas) || personas.length <= 1) {
    return { ok: true, details: 'Single persona flow or no persona overrides configured' };
  }

  const normalized = personas.map((p) => p.toLowerCase());
  const matched = new Set();
  const stack = [targetPath];
  let seen = 0;
  // Track fixture-like files to scan contents for persona references
  const contentCandidates = [];

  while (stack.length > 0 && seen < maxEntries) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) break;
      const fullPath = pathLib.join(current, entry.name);
      const relative = pathLib.relative(targetPath, fullPath).toLowerCase();
      seen += 1;

      for (const persona of normalized) {
        if (relative.includes(persona)) {
          matched.add(persona);
        }
      }
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        stack.push(fullPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(pathLib.extname(entry.name))) {
        // Queue fixture/persona-related files for content scanning
        const nameLower = entry.name.toLowerCase();
        if (nameLower.includes('persona') || nameLower.includes('fixture') || relative.includes('fixture')) {
          contentCandidates.push(fullPath);
        }
      }
    }
  }

  // If path-based matching didn't find all personas, scan file contents
  const stillMissing = normalized.filter((p) => !matched.has(p));
  if (stillMissing.length > 0 && contentCandidates.length > 0) {
    for (const filePath of contentCandidates.slice(0, 20)) {
      try {
        const content = (await fs.readFile(filePath, 'utf8')).toLowerCase();
        for (const persona of stillMissing) {
          if (content.includes(persona)) {
            matched.add(persona);
          }
        }
      } catch {
        // Ignore unreadable files
      }
      if (normalized.every((p) => matched.has(p))) break;
    }
  }

  const missing = normalized.filter((persona) => !matched.has(persona));
  if (missing.length === 0) {
    return { ok: true, details: 'Persona fixture hints detected for all configured personas' };
  }
  return {
    ok: false,
    details: `No obvious fixture hints found for personas: ${missing.join(', ')}`,
  };
}

function buildProbe(id, label, status, details, hardFailure = false, meta = null) {
  const probe = { id, label, status, details, hardFailure: hardFailure === true };
  if (meta && typeof meta === 'object') probe.meta = meta;
  return probe;
}

function describeTargetPathAccessError(targetPath, err) {
  const code = trimString(err?.code);
  if (!code || code === 'ENOENT') {
    return {
      details: `Directory not found: ${targetPath}`,
      meta: null,
    };
  }

  const message = trimString(err?.message);
  const suffix = message ? ` — ${message}` : '';
  return {
    details: `Directory is not accessible: ${targetPath} (${code})${suffix}`,
    meta: { errorCode: code },
  };
}

function summarizeProbes(probes) {
  const good = probes.filter((probe) => probe.status === 'good');
  const missing = probes.filter((probe) => probe.status === 'missing');
  const warnings = probes.filter((probe) => probe.status === 'warning');
  const hardFailures = missing.filter((probe) => probe.hardFailure);
  return {
    good,
    missing,
    warnings,
    hardFailures,
    compatible: hardFailures.length === 0,
  };
}

async function ensureUniqueProfileId(permissionProfileStorage, baseId) {
  let candidate = baseId;
  let i = 1;
  while (true) {
    const result = await permissionProfileStorage.get(candidate);
    if (!result?.ok) return candidate;
    candidate = `${baseId}_${i}`;
    i += 1;
  }
}

function sanitizeProfileId(raw) {
  const cleaned = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const shortened = cleaned.slice(0, 96);
  return shortened || 'uiux_profile';
}

function roomCheckInputError(message) {
  return {
    ok: false,
    error: {
      code: 'invalid_compatibility_input',
      message,
      recoverable: true,
    },
  };
}

function formatHardFailureForPrompt(failure) {
  const label = trimString(failure?.label) || trimString(failure?.id) || 'unknown';
  const details = trimString(failure?.details) || 'No details provided';
  return `- ${label}: ${details}`;
}

function buildRepoCompatibilityFixPrompt({ targetPath, report }) {
  const hardFailures = Array.isArray(report?.hardFailures) ? report.hardFailures : [];
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  const recommendedActions = Array.isArray(report?.recommendedActions) ? report.recommendedActions : [];
  const runtime = trimString(report?.runtime) || 'web';
  const harness = trimString(report?.resolvedHarnessCommand) || '(none)';
  const personas = Array.isArray(report?.personas) ? report.personas : [];

  const lines = [
    'You are preparing a repository to be compatible with UI/UX workflow testing.',
    `Repository path: ${targetPath}`,
    `Target runtime: ${runtime}`,
    `Current harness command: ${harness}`,
    `Personas: ${personas.length > 0 ? personas.join(', ') : 'default'}`,
    '',
    'Hard compatibility failures to fix:',
    hardFailures.length > 0
      ? hardFailures.map(formatHardFailureForPrompt).join('\n')
      : '- none',
  ];

  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings (optional improvements):');
    lines.push(warnings.map(formatHardFailureForPrompt).join('\n'));
  }

  if (recommendedActions.length > 0) {
    lines.push('');
    lines.push('Recommended actions:');
    lines.push(recommendedActions.map((action) => `- ${trimString(action?.title) || trimString(action?.type) || 'action'}: ${trimString(action?.details) || ''}`).join('\n'));
  }

  lines.push('');
  lines.push('Instructions:');
  lines.push('- Make only minimal repo changes needed to clear hard failures.');
  lines.push('- Prefer deterministic, explicit test harness setup (package.json scripts/deps/config).');
  lines.push('- If ELECTRON_RUN_AS_NODE or similar hostile env vars are flagged, ensure test fixtures/shared helpers explicitly delete them from the child process env before spawning the Electron app (e.g. `delete env.ELECTRON_RUN_AS_NODE`). Do NOT use `...process.env` without stripping these.');
  lines.push('- Do not change authentication/business logic unrelated to compatibility.');
  lines.push('- You may run shell commands and edit files in this repo.');
  lines.push('');
  lines.push('When done, respond with:');
  lines.push('1) what you changed,');
  lines.push('2) exact files touched,');
  lines.push('3) anything still blocked.');
  return lines.join('\n');
}

export function createUiUxCompatibilityService({
  fs = fsNative.promises,
  path = pathNative,
  processEnv = process.env,
  readProfileById,
  permissionProfileStorage,
  saveProfile,
  requestLocalPrompt,
  isProfileRunning,
} = {}) {
  if (typeof readProfileById !== 'function') {
    throw new Error('uiux-compatibility-service requires readProfileById');
  }
  if (!permissionProfileStorage || typeof permissionProfileStorage.get !== 'function') {
    throw new Error('uiux-compatibility-service requires permissionProfileStorage');
  }
  if (typeof saveProfile !== 'function') {
    throw new Error('uiux-compatibility-service requires saveProfile');
  }

  async function resolveClaudeFixerProfile(localAgentProfileIds) {
    const claudeNotRunning = [];
    for (const profileId of localAgentProfileIds) {
      const agentProfile = await readProfileById(profileId);
      if (!agentProfile) continue;
      if (normalizeProvider(agentProfile) !== 'claude') continue;
      const resolvedProfileId = trimString(agentProfile.id) || trimString(profileId);
      if (typeof isProfileRunning === 'function' && resolvedProfileId) {
        let running = false;
        try {
          running = isProfileRunning(resolvedProfileId) === true;
        } catch {
          running = false;
        }
        if (!running) {
          claudeNotRunning.push(resolvedProfileId);
          continue;
        }
      }
      return { profile: agentProfile, reason: '' };
    }
    if (claudeNotRunning.length > 0) {
      return {
        profile: null,
        reason: `Claude worker profile is not running: ${claudeNotRunning.join(', ')}`,
      };
    }
    return {
      profile: null,
      reason: 'No selected local worker is configured with provider "claude"',
    };
  }

  async function attemptClaudeRepoFix({ targetPath, report, localAgentProfileIds }) {
    if (typeof requestLocalPrompt !== 'function') {
      return {
        attempted: false,
        ok: false,
        reason: 'Claude repo-fix is unavailable in this runtime',
      };
    }

    const selection = await resolveClaudeFixerProfile(localAgentProfileIds);
    if (!selection.profile) {
      return {
        attempted: false,
        ok: false,
        reason: selection.reason || 'No compatible Claude worker available for repo fixes',
      };
    }

    const profileId = trimString(selection.profile.id);
    if (!profileId) {
      return {
        attempted: false,
        ok: false,
        reason: 'Selected Claude worker is missing a valid profile id',
      };
    }
    const prompt = buildRepoCompatibilityFixPrompt({ targetPath, report });
    try {
      const response = await requestLocalPrompt(
        profileId,
        {
          text: prompt,
          cwd: targetPath,
          accessible_roots: [targetPath],
          constraints: {
            allow_tool_use: true,
            max_tool_rounds: AI_REPO_FIX_MAX_TOOL_ROUNDS,
            max_output_chars: AI_REPO_FIX_MAX_OUTPUT_CHARS,
            local_turn_timeout_ms: AI_REPO_FIX_TIMEOUT_MS,
          },
        },
        AI_REPO_FIX_TIMEOUT_MS,
      );

      if (!response?.ok) {
        return {
          attempted: true,
          ok: false,
          profileId,
          reason: trimString(response?.error?.message) || 'Claude repo-fix request failed',
        };
      }
      const frame = response?.frame || {};
      if (frame.status !== 'ok') {
        return {
          attempted: true,
          ok: false,
          profileId,
          reason: trimString(frame.reason) || 'Claude repo-fix response was not successful',
        };
      }
      return {
        attempted: true,
        ok: true,
        profileId,
        summary: trimString(frame.draft_message) || 'Claude compatibility fix attempt completed.',
      };
    } catch (err) {
      return {
        attempted: true,
        ok: false,
        profileId,
        reason: `Claude repo-fix threw: ${err?.message || String(err)}`,
      };
    }
  }

  async function checkCompatibility(input = {}) {
    const targetPath = trimString(input.targetPath);
    if (!targetPath) {
      return roomCheckInputError('targetPath is required');
    }

    const localAgentProfileIds = uniqueStrings(input.localAgentProfileIds || []);
    const personas = parsePersonas(input.testPersonas);
    const workspaceRoots = collectWorkspaceRoots(input.workspace, path);
    const probes = [];

    let targetStat = null;
    let targetPathError = null;
    try {
      targetStat = await fs.stat(targetPath);
    } catch (err) {
      targetPathError = err;
    }
    if (!targetStat || !targetStat.isDirectory()) {
      const accessError = describeTargetPathAccessError(targetPath, targetPathError);
      probes.push(buildProbe(
        PATH_CHECK_ID,
        'Target path exists',
        'missing',
        accessError.details,
        true,
        accessError.meta,
      ));
      const summary = summarizeProbes(probes);
      const recommendedActions = accessError.meta?.errorCode
        ? [{
            type: 'grant_directory_access',
            title: 'Re-select or grant access to the target directory',
            details: `The app could not access ${targetPath}. Re-pick the repo directory or grant the packaged app filesystem access, then retry.`,
          }]
        : [];
      return {
        ok: true,
        report: {
          checkedAt: new Date().toISOString(),
          targetPath,
          resolvedHarnessCommand: '',
          requiredShellPrefixes: [],
          recommendedActions,
          ...summary,
        },
      };
    }
    probes.push(buildProbe(PATH_CHECK_ID, 'Target path exists', 'good', `Directory exists: ${targetPath}`));

    const { packageJsonPath, packageJson } = await readPackageJson(fs, path, targetPath);
    const runtime = normalizeRuntime(input.targetRuntime, packageJson);

    const harness = discoverHarnessCommand(packageJson, input.harnessCommand);
    const resolvedHarnessCommand = harness.command;
    const requiredShellPrefixes = dedupePrefixes(deriveRequiredShellPrefixes(resolvedHarnessCommand));

    if (!resolvedHarnessCommand) {
      probes.push(buildProbe(
        HARNESS_CHECK_ID,
        'Harness command',
        'missing',
        `No harness command provided or discovered in ${packageJsonPath}`,
        true,
      ));
    } else {
      probes.push(buildProbe(
        HARNESS_CHECK_ID,
        'Harness command',
        'good',
        `Using "${resolvedHarnessCommand}" (${harness.source})`,
      ));
    }

    const tooling = runtimeToolingStatus({
      runtime,
      packageJson,
      resolvedHarnessCommand,
    });
    probes.push(buildProbe(
      TOOLING_CHECK_ID,
      'Runtime/tooling',
      tooling.ok ? 'good' : 'missing',
      tooling.details,
      !tooling.ok,
      { runtime },
    ));

    const webServerBinding = await inspectWebServerBinding(fs, path, targetPath);
    if (webServerBinding) {
      probes.push(buildProbe(
        WEB_SERVER_BINDING_CHECK_ID,
        'Web server loopback binding',
        webServerBinding.ok ? 'good' : 'missing',
        webServerBinding.details,
        !webServerBinding.ok,
        webServerBinding.meta || null,
      ));
    }

    if (runtime === 'electron') {
      const hostile = ELECTRON_HOSTILE_ENV_VARS.filter((key) => processEnv[key]);
      if (hostile.length > 0) {
        probes.push(buildProbe(
          ELECTRON_ENV_CHECK_ID,
          'Electron environment',
          'missing',
          `Inherited env vars will prevent Electron app launch: ${hostile.join(', ')}. Test fixtures must delete these from the child process env.`,
          true,
          { hostileVars: hostile },
        ));
      } else {
        probes.push(buildProbe(
          ELECTRON_ENV_CHECK_ID,
          'Electron environment',
          'good',
          'No hostile Electron env vars detected in parent environment',
        ));
      }
    }

    const artifact = await artifactWritableStatus(fs, path, targetPath);
    probes.push(buildProbe(
      ARTIFACT_CHECK_ID,
      'Artifact directory writable',
      artifact.ok ? 'good' : 'missing',
      artifact.details,
      !artifact.ok,
      artifact.artifactDir ? { artifactDir: artifact.artifactDir } : null,
    ));

    const selectorStatus = await scanForSelectorSignal(fs, path, targetPath);
    probes.push(buildProbe(
      SELECTOR_CHECK_ID,
      'Selector readiness signal',
      selectorStatus.ok ? 'good' : 'warning',
      selectorStatus.details,
      false,
    ));

    const personaStatus = await scanPersonaFixtureHints(fs, path, targetPath, personas);
    probes.push(buildProbe(
      PERSONA_CHECK_ID,
      'Persona fixtures',
      personaStatus.ok ? 'good' : 'warning',
      personaStatus.details,
      false,
      { personas: personas.length > 0 ? personas : ['default'] },
    ));

    const permissionFindings = [];
    if (localAgentProfileIds.length === 0) {
      probes.push(buildProbe(
        PERMISSION_CHECK_ID,
        'Worker permission profile coverage',
        'warning',
        'No local worker profiles selected yet; permission compatibility cannot be fully validated',
        false,
      ));
    } else if (!resolvedHarnessCommand) {
      probes.push(buildProbe(
        PERMISSION_CHECK_ID,
        'Worker permission profile coverage',
        'warning',
        'Skipped until a harness command is resolved',
        false,
      ));
    } else {
      const failures = [];
      for (const profileId of localAgentProfileIds) {
        const agentProfile = await readProfileById(profileId);
        if (!agentProfile) {
          failures.push(`Worker profile '${profileId}' was not found`);
          permissionFindings.push({
            profileId,
            permissionProfileId: null,
            missingShell: requiredShellPrefixes,
            missingCwd: true,
          });
          continue;
        }

        const permissionRef = parsePermissionRef(agentProfile);
        const permissionResult = await permissionProfileStorage.get(permissionRef);
        if (!permissionResult?.ok || !permissionResult.profile) {
          failures.push(`Permission profile '${permissionRef}' for worker '${profileId}' was not found`);
          permissionFindings.push({
            profileId,
            permissionProfileId: permissionRef,
            missingShell: requiredShellPrefixes,
            missingCwd: true,
          });
          continue;
        }

        const coverage = analyzePermissionCoverage({
          permissionProfile: permissionResult.profile,
          requiredShellPrefixes,
          targetPath,
          agentWorkspace: agentProfile.workspace,
          workspaceRoots,
        });
        permissionFindings.push({
          profileId,
          permissionProfileId: permissionResult.profile.id,
          missingShell: coverage.missingShell,
          missingCwd: coverage.missingCwd,
          builtIn: permissionResult.profile.builtIn === true,
        });

        if (coverage.missingShell.length > 0) {
          failures.push(
            `Worker '${profileId}' missing shell command access: ${coverage.missingShell.map(formatPrefix).join(', ')}`
          );
        }
        if (coverage.missingCwd) {
          failures.push(`Worker '${profileId}' profile does not allow cwd root '${targetPath}'`);
        }
      }

      if (failures.length > 0) {
        probes.push(buildProbe(
          PERMISSION_CHECK_ID,
          'Worker permission profile coverage',
          'missing',
          failures.join('; '),
          true,
          { permissionFindings },
        ));
      } else {
        probes.push(buildProbe(
          PERMISSION_CHECK_ID,
          'Worker permission profile coverage',
          'good',
          'Local worker profiles allow required harness commands and cwd roots',
          false,
          { permissionFindings },
        ));
      }
    }

    const summary = summarizeProbes(probes);
    const recommendedActions = [];
    if (summary.missing.some((probe) => probe.id === HARNESS_CHECK_ID)) {
      recommendedActions.push({
        type: 'set_harness_command',
        title: 'Set or add a UI harness command',
        details: 'Define harnessCommand explicitly or add a package.json script such as test:uiux.',
      });
    }
    const targetPathProbe = summary.missing.find((probe) => probe.id === PATH_CHECK_ID);
    if (targetPathProbe?.meta?.errorCode) {
      recommendedActions.push({
        type: 'grant_directory_access',
        title: 'Re-select or grant access to the target directory',
        details: `The app could not access ${targetPathProbe.details.includes(': ') ? targetPath : 'the target directory'}. Re-pick the repo directory or grant the packaged app filesystem access, then retry.`,
      });
    }
    if (summary.missing.some((probe) => probe.id === TOOLING_CHECK_ID)) {
      recommendedActions.push({
        type: 'install_ui_harness',
        title: 'Install supported UI harness tooling',
        details: 'Add Playwright (@playwright/test) or Cypress dependencies to the target project.',
      });
    }
    if (summary.missing.some((probe) => probe.id === WEB_SERVER_BINDING_CHECK_ID)) {
      recommendedActions.push({
        type: 'bind_web_server_loopback',
        title: 'Bind static test servers to loopback only',
        details: 'Update Playwright webServer or related serve commands to bind explicitly to 127.0.0.1/localhost instead of the serve default 0.0.0.0.',
      });
    }
    if (summary.missing.some((probe) => probe.id === PERMISSION_CHECK_ID)) {
      recommendedActions.push({
        type: 'permission_patch',
        title: 'Patch worker permission profiles',
        details: 'Add scoped shell.allowPrefixes and allowedCwdRoots for the resolved harness command.',
        requiredShellPrefixes,
        targetPath,
      });
    }
    if (summary.missing.some((probe) => probe.id === ELECTRON_ENV_CHECK_ID)) {
      const hostileProbe = summary.missing.find((probe) => probe.id === ELECTRON_ENV_CHECK_ID);
      const hostileVars = hostileProbe?.meta?.hostileVars || ELECTRON_HOSTILE_ENV_VARS;
      recommendedActions.push({
        type: 'strip_electron_env',
        title: 'Strip hostile Electron env vars from test fixtures',
        details: `Test fixtures and harness scripts must explicitly delete ${hostileVars.join(', ')} from the child process environment when launching the target Electron app. Without this, Electron runs as plain Node.js and the app will not render a UI.`,
      });
    }

    return {
      ok: true,
      report: {
        checkedAt: new Date().toISOString(),
        targetPath,
        runtime,
        resolvedHarnessCommand,
        requiredShellPrefixes,
        personas: personas.length > 0 ? personas : ['default'],
        recommendedActions,
        permissionFindings,
        ...summary,
      },
    };
  }

  async function makeCompatible(input = {}) {
    const precheck = await checkCompatibility(input);
    if (!precheck.ok) return precheck;

    const preReport = precheck.report;
    const targetPath = trimString(preReport.targetPath);
    const localAgentProfileIds = uniqueStrings(input.localAgentProfileIds || []);
    const workspaceRoots = collectWorkspaceRoots(input.workspace, path);

    if (!targetPath) {
      return roomCheckInputError('targetPath is required');
    }
    if (localAgentProfileIds.length === 0) {
      return {
        ok: true,
        applied: false,
        actions: [],
        errors: ['No local worker profiles were provided to patch'],
        precheck: preReport,
        report: preReport,
      };
    }

    const actions = [];
    const errors = [];
    const patchableHardFailureIds = new Set([PERMISSION_CHECK_ID]);
    let workingReport = preReport;
    let nonPatchableHardFailures = (workingReport.hardFailures || []).filter((f) => !patchableHardFailureIds.has(f.id));

    if (nonPatchableHardFailures.length > 0) {
      const aiFix = await attemptClaudeRepoFix({
        targetPath,
        report: workingReport,
        localAgentProfileIds,
      });
      if (aiFix.attempted) {
        actions.push({
          type: 'ai_repo_fix_attempt',
          provider: 'claude',
          profileId: aiFix.profileId || '',
          status: aiFix.ok ? 'ok' : 'error',
          details: aiFix.ok ? aiFix.summary : aiFix.reason,
          hardFailureCount: nonPatchableHardFailures.length,
        });
      }
      if (!aiFix.attempted || !aiFix.ok) {
        errors.push(aiFix.reason || 'No compatible Claude worker available for repo fixes');
      }

      const aiPostcheck = await checkCompatibility(input);
      if (!aiPostcheck.ok) return aiPostcheck;
      workingReport = aiPostcheck.report;
      nonPatchableHardFailures = (workingReport.hardFailures || []).filter((f) => !patchableHardFailureIds.has(f.id));

      if (nonPatchableHardFailures.length > 0) {
        errors.push(...nonPatchableHardFailures.map((f) => `Non-patchable hard failure: ${f.label} — ${f.details}`));
      }
    }

    if (nonPatchableHardFailures.length > 0) {
      return {
        ok: true,
        applied: false,
        actions,
        errors,
        precheck: preReport,
        report: workingReport,
      };
    }

    const requiredShellPrefixes = dedupePrefixes(workingReport.requiredShellPrefixes || []);

    for (const profileId of localAgentProfileIds) {
      try {
        const agentProfile = await readProfileById(profileId);
        if (!agentProfile) {
          errors.push(`Worker profile '${profileId}' was not found`);
          continue;
        }

        const permissionRef = parsePermissionRef(agentProfile);
        const permissionResult = await permissionProfileStorage.get(permissionRef);
        if (!permissionResult?.ok || !permissionResult.profile) {
          errors.push(`Permission profile '${permissionRef}' for worker '${profileId}' was not found`);
          continue;
        }

        const permissionProfile = permissionResult.profile;
        const coverage = analyzePermissionCoverage({
          permissionProfile,
          requiredShellPrefixes,
          targetPath,
          agentWorkspace: agentProfile.workspace,
          workspaceRoots,
        });

        if (coverage.missingShell.length === 0 && !coverage.missingCwd) {
          actions.push({
            type: 'noop',
            profileId,
            permissionProfileId: permissionProfile.id,
            details: 'Already compatible',
          });
          continue;
        }

        if (permissionProfile.builtIn === true || BUILTIN_PERMISSION_IDS.has(permissionProfile.id)) {
          const baseId = sanitizeProfileId(`${agentProfile.id}_uiux`);
          const newPermissionProfileId = await ensureUniqueProfileId(permissionProfileStorage, baseId);
          const created = await permissionProfileStorage.create({
            id: newPermissionProfileId,
            name: `${agentProfile.name || agentProfile.id} UI/UX`,
            description: 'Auto-generated for UI/UX testing room compatibility',
            basedOn: permissionProfile.id,
            decisionMode: 'block',
            shell: {
              allowPrefixes: requiredShellPrefixes,
            },
            allowedCwdRoots: [targetPath],
            createdBy: 'agent',
          });
          if (!created?.ok) {
            errors.push(`Failed to create permission profile '${newPermissionProfileId}' for worker '${profileId}'`);
            continue;
          }

          const saved = await saveProfile({
            ...agentProfile,
            permissionProfileId: newPermissionProfileId,
          });
          if (!saved?.ok) {
            errors.push(`Created profile '${newPermissionProfileId}' but failed to assign it to worker '${profileId}'`);
            continue;
          }

          actions.push({
            type: 'create_profile_and_assign',
            profileId,
            fromPermissionProfileId: permissionProfile.id,
            toPermissionProfileId: newPermissionProfileId,
            addedAllowPrefixes: requiredShellPrefixes.map(formatPrefix),
            addedCwdRoots: [targetPath],
          });
          continue;
        }

        const mergedAllowPrefixes = mergePrefixes(permissionProfile?.shell?.allowPrefixes || [], requiredShellPrefixes);
        const shellPatch = {
          ...(permissionProfile.shell || {}),
          allowPrefixes: mergedAllowPrefixes,
        };

        // If the compatibility check detected a missing CWD root, always add
        // targetPath. Runtime compilation (compilePermissionProfile) restricts
        // non-full profiles to agentWorkspace/homedir even when allowedCwdRoots
        // is empty/undefined, so an empty array does NOT mean unrestricted access.
        const existingCwdRoots = permissionProfile?.allowedCwdRoots;
        const updatePayload = { shell: shellPatch };
        if (coverage.missingCwd) {
          updatePayload.allowedCwdRoots = uniqueStrings([...(existingCwdRoots || []), targetPath]);
        }

        const updated = await permissionProfileStorage.update(permissionProfile.id, updatePayload);
        if (!updated?.ok) {
          errors.push(`Failed to update permission profile '${permissionProfile.id}' for worker '${profileId}'`);
          continue;
        }

        const addedCwdRoots = updatePayload.allowedCwdRoots
          ? updatePayload.allowedCwdRoots.filter((cwd) => !(existingCwdRoots || []).includes(cwd))
          : [];
        actions.push({
          type: 'patch_profile',
          profileId,
          permissionProfileId: permissionProfile.id,
          addedAllowPrefixes: requiredShellPrefixes
            .filter((prefix) => !permissionProfile.shell?.allowPrefixes?.some((existing) => prefixesEqual(existing, prefix)))
            .map(formatPrefix),
          addedCwdRoots,
        });
      } catch (err) {
        errors.push(`Failed to patch worker '${profileId}': ${err?.message || String(err)}`);
      }
    }

    const postcheck = await checkCompatibility(input);
    if (!postcheck.ok) return postcheck;

    // Compute applied based on both error-free patching AND postcheck clearance
    // of hard failures, not just the absence of patching errors.
    return {
      ok: true,
      applied: errors.length === 0 && postcheck.report.hardFailures.length === 0,
      actions,
      errors,
      precheck: preReport,
      report: postcheck.report,
    };
  }

  return {
    checkCompatibility,
    makeCompatible,
  };
}
