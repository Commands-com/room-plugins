// ---------------------------------------------------------------------------
// Filesystem side of the Prototype Room. This module owns everything that
// touches disk for a given participant:
//   buildSummarySeed           — initial README scaffold seeded into empty dirs
//   ensurePrototypeDirectories — mkdirs + seeds missing summary files
//   scanPrototypeDirectory     — bounded recursive directory walker
//   collectPrototypeSnapshot   — read summary + tree + derive entry/preview
//   refreshSnapshots           — recompute snapshots for all participants
//   ensureGeneratedPreviewImage — QuickLook HTML → PNG thumbnails (macOS)
//   pickPrototypeArtifacts     — choose the artifacts to surface downstream
// Keeping the disk-touching code in one module makes the phase-flow logic
// easier to test and keeps error handling localized.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  GENERATED_PREVIEW_DIR,
  HTML_EXTENSIONS,
  IGNORED_DIRS,
  IMAGE_EXTENSIONS,
  QUICKLOOK_PREVIEW_SIZE,
  QUICKLOOK_TIMEOUT_MS,
  TEXT_ARTIFACT_EXTENSIONS,
  TEXT_LIMITS,
} from './constants.js';
import { excerpt, safeTrim } from './text-utils.js';
import { parseMarkdownSections } from './markdown-utils.js';

export function isReadableFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function inferArtifactKind(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (TEXT_ARTIFACT_EXTENSIONS.has(ext)) return 'text';
  return 'file';
}

export function findPreviewImagePath(filePaths) {
  return Array.isArray(filePaths)
    ? filePaths.find((filePath) => IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase())) || ''
    : '';
}

export function findEntryHtmlPath(filePaths) {
  const htmlFiles = Array.isArray(filePaths)
    ? filePaths.filter((filePath) => HTML_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase()))
    : [];
  const indexPath = htmlFiles.find((filePath) => /(^|[\/])index\.html?$/i.test(String(filePath || '')));
  return indexPath || htmlFiles[0] || '';
}

function normalizePrototypePathValue(value, prototypeDir) {
  const cleaned = safeTrim(
    String(value || '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^`+|`+$/g, ''),
    4000,
  );
  if (!cleaned) return '';
  if (path.isAbsolute(cleaned)) return cleaned;
  return path.resolve(prototypeDir, cleaned);
}

function findExplicitEntryHtmlPath(readmeContent, prototypeDir) {
  const sections = parseMarkdownSections(readmeContent);
  const entryLines = Array.isArray(sections.get('entry point')) ? sections.get('entry point') : [];

  for (const line of entryLines) {
    const candidate = normalizePrototypePathValue(line, prototypeDir);
    if (!candidate) continue;
    if (!HTML_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    if (isReadableFile(candidate)) return candidate;
  }

  return '';
}

export function ensureGeneratedPreviewImage(outputDir, prototypeKey, entryHtmlPath) {
  const normalizedOutputDir = safeTrim(outputDir, 4000);
  const normalizedPrototypeKey = safeTrim(prototypeKey, 120);
  const normalizedEntryHtmlPath = safeTrim(entryHtmlPath, 4000);
  if (process.platform !== 'darwin' || !normalizedOutputDir || !normalizedPrototypeKey || !normalizedEntryHtmlPath) {
    return '';
  }
  if (!isReadableFile(normalizedEntryHtmlPath)) return '';

  const previewDir = path.join(normalizedOutputDir, GENERATED_PREVIEW_DIR, normalizedPrototypeKey);
  const previewPath = path.join(previewDir, `${path.basename(normalizedEntryHtmlPath)}.png`);

  try {
    const previewStats = statSync(previewPath);
    const sourceStats = statSync(normalizedEntryHtmlPath);
    if (previewStats.isFile() && previewStats.mtimeMs >= sourceStats.mtimeMs) {
      return previewPath;
    }
  } catch {}

  try {
    mkdirSync(previewDir, { recursive: true });
  } catch {
    return isReadableFile(previewPath) ? previewPath : '';
  }

  try {
    const result = spawnSync('/usr/bin/qlmanage', [
      '-t',
      '-s',
      String(QUICKLOOK_PREVIEW_SIZE),
      '-o',
      previewDir,
      normalizedEntryHtmlPath,
    ], {
      encoding: 'utf8',
      timeout: QUICKLOOK_TIMEOUT_MS,
    });
    if (result?.error || result?.status !== 0) {
      return isReadableFile(previewPath) ? previewPath : '';
    }
  } catch {
    return isReadableFile(previewPath) ? previewPath : '';
  }

  return isReadableFile(previewPath) ? previewPath : '';
}

export function buildSummarySeed(state, participant) {
  const conceptLines = state.conceptContext?.selectedConcept
    ? [
        '## Seed Concept',
        `- ${state.conceptContext.selectedConcept.title}`,
        state.conceptContext.selectedConcept.oneLiner ? `- ${state.conceptContext.selectedConcept.oneLiner}` : '',
        state.conceptContext.selectedConcept.requiredUserFlows?.length
          ? `- Required user flows: ${state.conceptContext.selectedConcept.requiredUserFlows.join(' | ')}`
          : '',
        state.conceptContext.selectedConcept.prototypeFocus?.length
          ? `- Prototype focus: ${state.conceptContext.selectedConcept.prototypeFocus.join(' | ')}`
          : '',
        state.conceptContext.selectedConcept.nonMockFunctionality?.length
          ? `- Non-mock functionality: ${state.conceptContext.selectedConcept.nonMockFunctionality.join(' | ')}`
          : '',
        state.conceptContext.selectedConcept.implementationBoundaries?.length
          ? `- Implementation boundaries: ${state.conceptContext.selectedConcept.implementationBoundaries.join(' | ')}`
          : '',
        '',
      ].filter(Boolean)
    : [];

  return [
    `# ${participant.prototypeLabel}`,
    '',
    '## Objective',
    state.objective,
    '',
    ...conceptLines,
    '## Prototype Thesis',
    '- Describe the distinct direction this prototype is taking.',
    '',
    '## What I Built',
    '- Summarize the current prototype.',
    '',
    '## Entry Point',
    '- Point to the one canonical HTML entry for this prototype, ideally `index.html`.',
    '',
    '## Visual Direction',
    '- Describe the aesthetic direction, typography, color system, and overall feel of the prototype.',
    '',
    '## Interaction Model',
    '- Explain the core interaction patterns, motion, and how the user moves through the prototype.',
    '',
    '## Key Files',
    '- List the most important files in this folder.',
    '',
    '## How To Open Or Inspect',
    '- Explain how someone should explore this prototype, starting from the canonical HTML entry point.',
    '',
    '## Strengths',
    '- Call out what this version is trying to do especially well.',
    '',
    '## Design Decisions',
    '- Decision: Why this prototype is shaped this way.',
    '',
    '## Constraints',
    '- Call out meaningful product or technical constraints.',
    '',
    '## Open Questions',
    '- Note decisions that still need to be made.',
    '',
    '## Known Gaps',
    '- Note the biggest weaknesses or missing pieces.',
    '',
    '## Next Bets',
    '- If given another cycle, what would you improve next?',
    '',
  ].join('\n');
}

export function ensurePrototypeDirectories(state) {
  if (!state.config.outputDir) return 0;
  mkdirSync(state.config.outputDir, { recursive: true });
  let seededCount = 0;
  for (const participant of state.participants) {
    mkdirSync(participant.prototypeDir, { recursive: true });
    try {
      readFileSync(participant.readmePath, 'utf-8');
    } catch {
      writeFileSync(participant.readmePath, buildSummarySeed(state, participant), 'utf-8');
      seededCount += 1;
    }
  }
  return seededCount;
}

export function scanPrototypeDirectory(rootDir) {
  const lines = [];
  let fileCount = 0;
  const visibleFiles = [];

  function visit(currentDir, relativeDir = '', depth = 0) {
    if (lines.length >= TEXT_LIMITS.tree) return;
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (lines.length >= TEXT_LIMITS.tree) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

      const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const displayPath = relPath.split(path.sep).join('/');

      if (entry.isDirectory()) {
        lines.push(`${'  '.repeat(depth)}- ${displayPath}/`);
        visit(path.join(currentDir, entry.name), relPath, depth + 1);
      } else {
        fileCount += 1;
        if (visibleFiles.length < 200) {
          visibleFiles.push(path.join(rootDir, relPath));
        }
        lines.push(`${'  '.repeat(depth)}- ${displayPath}`);
      }
    }
  }

  visit(rootDir);
  return {
    lines,
    fileCount,
    visibleFiles,
  };
}

export function collectPrototypeSnapshot(state, participant, { generatePreviewImage = false } = {}) {
  const snapshot = {
    agentId: participant.agentId,
    displayName: participant.displayName,
    prototypeKey: participant.prototypeKey,
    prototypeLabel: participant.prototypeLabel,
    prototypeDir: participant.prototypeDir,
    readmePath: participant.readmePath,
    exists: false,
    hasReadme: false,
    fileCount: 0,
    treeLines: [],
    visibleFiles: [],
    entryHtmlPath: '',
    previewImagePath: '',
    readmeContent: '',
    readmeExcerpt: '',
    status: 'missing',
    issue: '',
  };

  try {
    if (!statSync(participant.prototypeDir).isDirectory()) {
      snapshot.issue = 'Prototype directory is not a directory.';
      return snapshot;
    }
    snapshot.exists = true;
  } catch {
    snapshot.issue = 'Prototype directory does not exist yet.';
    return snapshot;
  }

  const tree = scanPrototypeDirectory(participant.prototypeDir);
  snapshot.fileCount = tree.fileCount;
  snapshot.treeLines = tree.lines;
  snapshot.visibleFiles = tree.visibleFiles;

  try {
    const readme = readFileSync(participant.readmePath, 'utf-8');
    snapshot.hasReadme = true;
    snapshot.readmeContent = safeTrim(readme, TEXT_LIMITS.readme);
    snapshot.readmeExcerpt = excerpt(snapshot.readmeContent, 420);
  } catch {
    snapshot.issue = `Missing ${path.basename(participant.readmePath)}.`;
  }

  if (snapshot.hasReadme) {
    snapshot.status = 'ready';
  } else if (snapshot.exists) {
    snapshot.status = 'incomplete';
  }

  snapshot.entryHtmlPath = findExplicitEntryHtmlPath(snapshot.readmeContent, snapshot.prototypeDir)
    || findEntryHtmlPath(snapshot.visibleFiles);
  snapshot.previewImagePath = findPreviewImagePath(snapshot.visibleFiles);
  if (generatePreviewImage && !snapshot.previewImagePath && snapshot.entryHtmlPath) {
    snapshot.previewImagePath = ensureGeneratedPreviewImage(state?.config?.outputDir, snapshot.prototypeKey, snapshot.entryHtmlPath);
  }

  return snapshot;
}

export function refreshSnapshots(state) {
  state.snapshots = Object.fromEntries(
    state.participants.map((participant) => [
      participant.agentId,
      collectPrototypeSnapshot(state, participant),
    ]),
  );
}

export function pickPrototypeArtifacts(snapshot, { primary = false } = {}) {
  const visibleFiles = Array.isArray(snapshot?.visibleFiles) ? snapshot.visibleFiles : [];
  const htmlFiles = visibleFiles.filter((filePath) => HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const imageFiles = visibleFiles.filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const textFiles = visibleFiles.filter((filePath) => TEXT_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const artifacts = [];
  const seen = new Set();
  const canonicalHtmlPath = snapshot?.entryHtmlPath || '';

  const pushArtifact = (filePath, label, isPrimary = false) => {
    if (!filePath || seen.has(filePath)) return;
    seen.add(filePath);
    artifacts.push({
      kind: inferArtifactKind(filePath),
      path: filePath,
      label,
      ...(isPrimary ? { primary: true } : {}),
    });
  };

  if (canonicalHtmlPath) {
    pushArtifact(canonicalHtmlPath, primary ? 'Main prototype' : `${snapshot.prototypeLabel} prototype`, primary);
  } else if (snapshot?.readmePath) {
    pushArtifact(snapshot.readmePath, primary ? 'Prototype summary' : `${snapshot.prototypeLabel} summary`, primary);
  }

  for (const filePath of imageFiles.slice(0, 4)) {
    pushArtifact(filePath, path.basename(filePath));
  }

  for (const filePath of htmlFiles.filter((filePath) => filePath !== canonicalHtmlPath).slice(0, 2)) {
    pushArtifact(filePath, path.basename(filePath));
  }

  for (const filePath of textFiles.filter((filePath) => filePath !== snapshot?.readmePath).slice(0, 2)) {
    pushArtifact(filePath, path.basename(filePath));
  }

  return artifacts;
}
