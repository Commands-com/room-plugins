import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));
const promptsDir = path.join(__dirname, 'prompts');
const promptTemplates = {
  build: readFileSync(path.join(promptsDir, 'build.md'), 'utf-8'),
  review: readFileSync(path.join(promptsDir, 'review.md'), 'utf-8'),
  improve: readFileSync(path.join(promptsDir, 'improve.md'), 'utf-8'),
};

const PHASES = {
  BUILD: 'build',
  REVIEW: 'review',
  SYNTHESIZE: 'synthesize',
  IMPROVE: 'improve',
  COMPLETE: 'complete',
};

const TEXT_LIMITS = {
  response: 100000,
  summary: 1200,
  readme: 16000,
  tree: 120,
  feedbackSection: 2400,
};

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const NONE_KEYS = new Set(['none', 'none yet', 'n a', 'na', 'nothing', 'nope']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const TEXT_ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.json']);

function safeTrim(value, maxLen = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function excerpt(value, maxLen = 220) {
  const text = safeTrim(value, maxLen + 20).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}...` : text;
}

function titleCase(value) {
  return safeTrim(value, 120)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function slugify(value, fallback = 'prototype') {
  const slug = safeTrim(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function canonicalKey(value) {
  return safeTrim(value, 200)
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}:;/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoneLike(value) {
  return NONE_KEYS.has(canonicalKey(value));
}

function normalizeList(values, maxItems = 12, itemLen = 400) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const results = [];
  for (const value of values) {
    const cleaned = safeTrim(String(value ?? '').replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''), itemLen);
    const key = canonicalKey(cleaned);
    if (!key || isNoneLike(cleaned) || seen.has(key)) continue;
    seen.add(key);
    results.push(cleaned);
    if (results.length >= maxItems) break;
  }
  return results;
}

function sanitizeFileName(value, fallback = 'README.md') {
  const raw = safeTrim(value, 240);
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function buildSummarySeed(state, participant) {
  return [
    `# ${participant.prototypeLabel}`,
    '',
    '## Objective',
    state.objective,
    '',
    '## Prototype Thesis',
    '- Describe the distinct direction this prototype is taking.',
    '',
    '## What I Built',
    '- Summarize the current prototype.',
    '',
    '## Key Files',
    '- List the most important files in this folder.',
    '',
    '## How To Open Or Inspect',
    '- Explain how someone should explore this prototype.',
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

function renderPromptTemplate(template, replacements) {
  return String(template || '').replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] ?? '')
      : ''
  ));
}

function parseMarkdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let current = null;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      current = canonicalKey(match[1]);
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current) {
      sections.get(current).push(line);
    }
  }

  return sections;
}

function getMarkdownTitle(markdown, fallback = 'Prototype') {
  const match = String(markdown || '').match(/^#\s+(.+)$/m);
  return safeTrim(match?.[1], 200) || fallback;
}

function getFirstParagraph(markdown, fallback = '') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const paragraph = [];

  for (const line of lines) {
    const trimmed = safeTrim(line, 1000);
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#/.test(trimmed)) continue;
    if (/^[-*+]\s+/.test(trimmed)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }

  return safeTrim(paragraph.join(' '), 600) || fallback;
}

function parseDecisionItems(lines) {
  const items = normalizeList(
    Array.isArray(lines) ? lines.map((line) => safeTrim(line, 800)) : [],
    8,
    800,
  );

  return items.map((item) => {
    const match = item.match(/^(?:decision\s*:\s*)?(.+?)(?:\s*[—-]\s*|\s*:\s+)(.+)$/i);
    if (match) {
      return {
        decision: safeTrim(match[1], 300),
        reason: safeTrim(match[2], 500),
      };
    }
    return {
      decision: safeTrim(item, 300),
      reason: '',
    };
  });
}

function inferArtifactKind(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (TEXT_ARTIFACT_EXTENSIONS.has(ext)) return 'text';
  return 'file';
}

function getConfig(ctx) {
  const roomConfig = ctx?.roomConfig || {};
  return {
    outputDir: safeTrim(roomConfig.outputDir, 4000),
    readmeFileName: sanitizeFileName(roomConfig.readmeFileName || 'README.md', 'README.md'),
  };
}

function getMaxCycles(ctx) {
  const configured = Number(ctx?.limits?.maxCycles);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.max(1, Math.min(Math.trunc(configured), manifest.limits?.maxCycles?.max || 5));
  }
  return manifest.limits?.maxCycles?.default || 2;
}

function inferPrototypeBaseName(participant) {
  const displayName = safeTrim(participant?.displayName, 120).toLowerCase();
  if (displayName) {
    if (/(openai|gpt)/.test(displayName)) return 'openai';
    if (/(anthropic|claude)/.test(displayName)) return 'claude';
    if (/(google|gemini)/.test(displayName)) return 'gemini';
    if (/(deepseek)/.test(displayName)) return 'deepseek';
    if (/(meta|llama)/.test(displayName)) return 'llama';
    if (/(qwen)/.test(displayName)) return 'qwen';

    const displaySlug = slugify(displayName, '');
    if (displaySlug) return displaySlug;
  }

  const fields = [
    participant?.profile?.name,
    participant?.profile?.model,
    participant?.profile?.provider,
    participant?.agentId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/(openai|gpt)/.test(fields)) return 'openai';
  if (/(anthropic|claude)/.test(fields)) return 'claude';
  if (/(google|gemini)/.test(fields)) return 'gemini';
  if (/(deepseek)/.test(fields)) return 'deepseek';
  if (/(meta|llama)/.test(fields)) return 'llama';
  if (/(qwen)/.test(fields)) return 'qwen';

  return slugify(participant?.displayName || participant?.profile?.name || participant?.agentId || 'prototype');
}

function getParticipants(ctx) {
  const participants = Array.isArray(ctx?.participants)
    ? ctx.participants
        .filter((participant) => participant?.agentId && participant?.role === 'prototyper')
        .map((participant) => ({
          agentId: participant.agentId,
          displayName: participant.displayName || participant.agentId,
          role: participant.role,
          profile: participant.profile || null,
        }))
    : [];

  const counts = {};
  return participants.map((participant) => {
    const base = inferPrototypeBaseName(participant);
    counts[base] = (counts[base] || 0) + 1;
    const suffix = counts[base] > 1 ? `-${counts[base]}` : '';
    const prototypeKey = `${base}${suffix}`;
    return {
      ...participant,
      prototypeKey,
      prototypeLabel: participant.displayName || titleCase(prototypeKey),
    };
  });
}

function findMissingRoles(participants) {
  const minCount = manifest.roles?.minCount || {};
  const roleCounts = {};
  for (const participant of participants) {
    roleCounts[participant.role] = (roleCounts[participant.role] || 0) + 1;
  }
  return Object.entries(minCount)
    .filter(([role, min]) => (roleCounts[role] || 0) < min)
    .map(([role]) => role);
}

function createInitialState(ctx) {
  const config = getConfig(ctx);
  const outputDir = config.outputDir ? path.resolve(config.outputDir) : '';
  const participants = getParticipants(ctx).map((participant) => ({
    ...participant,
    prototypeDir: outputDir ? path.join(outputDir, participant.prototypeKey) : '',
    readmePath: outputDir ? path.join(outputDir, participant.prototypeKey, config.readmeFileName) : '',
  }));
  const objective = safeTrim(ctx?.objective, 2400) || 'No objective provided.';

  return {
    objective,
    config: {
      ...config,
      outputDir,
    },
    participants,
    phase: PHASES.BUILD,
    cycleCount: 1,
    maxCycles: getMaxCycles(ctx),
    rounds: [],
    reviewSyntheses: [],
    snapshots: {},
    feedEntries: [
      {
        displayName: 'Prototype Room',
        role: 'system',
        createdAt: Date.now(),
        content: `Captured objective: ${excerpt(objective, 180)}`,
      },
      {
        displayName: 'Prototype Room',
        role: 'system',
        createdAt: Date.now(),
        content: outputDir
          ? `Prototype root directory: ${outputDir}`
          : 'Prototype Room needs an output directory from the room setup UI before it can start.',
      },
    ],
    missingRoles: findMissingRoles(participants),
    agentStatus: Object.fromEntries(participants.map((participant) => [participant.agentId, 'idle'])),
    disconnectedAgents: [],
  };
}

function appendFeed(state, content, extra = {}) {
  const entry = {
    displayName: extra.displayName || 'Prototype Room',
    role: extra.role || 'system',
    agentId: extra.agentId || null,
    createdAt: typeof extra.createdAt === 'number' ? extra.createdAt : Date.now(),
    content: safeTrim(content, 1400),
  };
  if (!entry.content) return;
  state.feedEntries.push(entry);
  if (state.feedEntries.length > 80) {
    state.feedEntries = state.feedEntries.slice(-80);
  }
}

function buildRoundLabel(phase, passIndex) {
  return `Cycle ${passIndex} — ${titleCase(phase)}`;
}

function ensureRound(state, phase, passIndex = state.cycleCount) {
  let round = state.rounds.find((entry) => entry.phase === phase && entry.passIndex === passIndex);
  if (!round) {
    round = {
      phase,
      passIndex,
      label: buildRoundLabel(phase, passIndex),
      responses: [],
    };
    state.rounds.push(round);
  }
  return round;
}

function getRound(state, phase, passIndex) {
  return state.rounds.find((entry) => entry.phase === phase && entry.passIndex === passIndex) || null;
}

function getLatestRound(state, phase) {
  return state.rounds
    .filter((entry) => entry.phase === phase)
    .sort((left, right) => right.passIndex - left.passIndex)[0] || null;
}

function getRoundResponseMap(round) {
  const responses = new Map();
  for (const response of round?.responses || []) {
    if (!response?.agentId) continue;
    responses.set(response.agentId, response);
  }
  return responses;
}

function upsertRoundResponse(round, participant, response) {
  const responseMap = getRoundResponseMap(round);
  responseMap.set(participant.agentId, {
    agentId: participant.agentId,
    displayName: participant.displayName,
    role: participant.role,
    prototypeKey: participant.prototypeKey,
    response: safeTrim(response.response, TEXT_LIMITS.response),
    status: response.rejected ? `rejected: ${safeTrim(response.rejectionReason, 120)}` : (response.status || 'submitted'),
  });
  round.responses = Array.from(responseMap.values());
}

function updateAgentStatuses(state, agentIds, status) {
  for (const agentId of agentIds) {
    state.agentStatus[agentId] = status;
  }
}

function getCompletedAgentIdsForCurrentPass(state) {
  const round = ensureRound(state, state.phase, state.cycleCount);
  const completed = new Set(Array.from(getRoundResponseMap(round).keys()));
  for (const [agentId, status] of Object.entries(state.agentStatus || {})) {
    if (status === 'submitted') completed.add(agentId);
  }
  return completed;
}

function buildPendingTargetsForPhase(state, phase) {
  const completed = getCompletedAgentIdsForCurrentPass(state);
  return buildTargetsForPhase(state, phase)
    .filter((target) => !completed.has(target.agentId));
}

function ensurePrototypeDirectories(state) {
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

function scanPrototypeDirectory(rootDir) {
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

function collectPrototypeSnapshot(state, participant) {
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

  return snapshot;
}

function refreshSnapshots(state) {
  state.snapshots = Object.fromEntries(
    state.participants.map((participant) => [
      participant.agentId,
      collectPrototypeSnapshot(state, participant),
    ]),
  );
}

function buildArtifactBlocks(state) {
  const prototypeBlocks = state.participants.map((participant) => {
    const snapshot = state.snapshots[participant.agentId] || collectPrototypeSnapshot(state, participant);
    const readmeBody = snapshot.readmeContent || '_Summary file missing._';
    const fileTree = snapshot.treeLines.length > 0
      ? snapshot.treeLines.join('\n')
      : '_No visible files yet._';

    return {
      title: `${participant.prototypeLabel} (${participant.prototypeKey})`,
      language: 'markdown',
      path: snapshot.hasReadme ? snapshot.readmePath : undefined,
      footer: `${snapshot.fileCount} visible file${snapshot.fileCount === 1 ? '' : 's'} in ${snapshot.prototypeDir}`,
      content: [
        `# ${participant.prototypeLabel}`,
        '',
        `- Prototype key: \`${participant.prototypeKey}\``,
        `- Directory: \`${participant.prototypeDir}\``,
        `- Summary file: \`${participant.readmePath}\``,
        `- Status: ${titleCase(snapshot.status)}`,
        snapshot.issue ? `- Issue: ${snapshot.issue}` : '',
        '',
        '## Visible Files',
        fileTree,
        '',
        '## Summary File',
        readmeBody,
      ].filter(Boolean).join('\n'),
    };
  });

  const synthesisBlocks = state.reviewSyntheses.map((synthesis) => ({
    title: `Cycle ${synthesis.cycleIndex} Review Synthesis`,
    language: 'markdown',
    content: synthesis.markdown,
  }));

  return [...prototypeBlocks, ...synthesisBlocks];
}

function buildLeaderboardRows(state, cycleIndex = state.cycleCount) {
  const synthesis = getSynthesisForCycle(state, cycleIndex) || state.reviewSyntheses.at(-1) || null;
  if (!synthesis) {
    return state.participants.map((participant) => {
      const snapshot = state.snapshots[participant.agentId] || collectPrototypeSnapshot(state, participant);
      return {
        rank: '-',
        prototype: participant.prototypeLabel,
        score: '-',
        reviews: '-',
        mustChange: '-',
        risks: '-',
        status: snapshot.status === 'ready' ? 'Built, awaiting review' : titleCase(snapshot.status),
      };
    });
  }

  return synthesis.ranked.map((entry) => ({
    rank: String(entry.rank),
    prototype: entry.prototypeLabel,
    score: entry.reviewCount > 0 ? entry.averageScore.toFixed(1) : '-',
    reviews: String(entry.reviewCount),
    mustChange: String(entry.mustChange.length),
    risks: String(entry.risks.length),
    status: entry.rank === 1
      ? (entry.mustChange.length === 0 ? 'Current leader, no required changes' : 'Current leader')
      : (entry.mustChange.length === 0 ? 'Pressuring the leader' : 'Needs sharper iteration'),
  }));
}

function buildLeaderboardSummary(state, cycleIndex = state.cycleCount) {
  const rows = buildLeaderboardRows(state, cycleIndex);
  if (rows.length === 0) return '(no leaderboard yet)';
  return rows.map((row) => (
    `- #${row.rank} ${row.prototype} — score ${row.score}, reviews ${row.reviews}, must change ${row.mustChange}, risks ${row.risks} (${row.status})`
  )).join('\n');
}

function pickPrototypeArtifacts(snapshot, { primary = false } = {}) {
  const visibleFiles = Array.isArray(snapshot?.visibleFiles) ? snapshot.visibleFiles : [];
  const htmlFiles = visibleFiles.filter((filePath) => HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const imageFiles = visibleFiles.filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const textFiles = visibleFiles.filter((filePath) => TEXT_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const artifacts = [];
  const seen = new Set();

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

  if (htmlFiles[0]) {
    pushArtifact(htmlFiles[0], primary ? 'Main prototype' : `${snapshot.prototypeLabel} prototype`, primary);
  } else if (snapshot?.readmePath) {
    pushArtifact(snapshot.readmePath, primary ? 'Prototype summary' : `${snapshot.prototypeLabel} summary`, primary);
  }

  for (const filePath of imageFiles.slice(0, 4)) {
    pushArtifact(filePath, path.basename(filePath));
  }

  for (const filePath of htmlFiles.slice(1, 3)) {
    pushArtifact(filePath, path.basename(filePath));
  }

  for (const filePath of textFiles.filter((filePath) => filePath !== snapshot?.readmePath).slice(0, 2)) {
    pushArtifact(filePath, path.basename(filePath));
  }

  return artifacts;
}

function buildPrototypeBundle(state) {
  const snapshots = state.participants.map((participant) => collectPrototypeSnapshot(state, participant));
  const latestSynthesis = state.reviewSyntheses.at(-1) || null;
  const ranked = latestSynthesis?.ranked || [];
  const leaderEntry = ranked[0] || null;
  const leaderSnapshot = leaderEntry
    ? snapshots.find((snapshot) => snapshot.agentId === leaderEntry.agentId)
    : snapshots.find((snapshot) => snapshot.status === 'ready') || snapshots[0] || null;
  const leaderReadme = leaderSnapshot?.readmeContent || '';
  const sections = parseMarkdownSections(leaderReadme);
  const title = getMarkdownTitle(leaderReadme, leaderSnapshot?.prototypeLabel || 'Prototype Bundle');
  const oneLiner = getFirstParagraph(
    leaderReadme,
    leaderEntry
      ? `${leaderEntry.prototypeLabel} is currently the leading prototype direction.`
      : `Prototype room captured ${snapshots.length} prototype${snapshots.length === 1 ? '' : 's'}.`,
  );
  const recommendedDirection = leaderEntry
    ? (
        leaderEntry.mustChange.length > 0
          ? `Use ${leaderEntry.prototypeLabel} as the leading direction, but address: ${leaderEntry.mustChange.slice(0, 2).join(' | ')}`
          : `Use ${leaderEntry.prototypeLabel} as the current leading direction.`
      )
    : 'Review the prototype summaries and pick the strongest direction to carry forward.';
  const artifacts = leaderSnapshot ? pickPrototypeArtifacts(leaderSnapshot, { primary: true }) : [];

  for (const snapshot of snapshots) {
    if (!leaderSnapshot || snapshot.agentId === leaderSnapshot.agentId) continue;
    for (const artifact of pickPrototypeArtifacts(snapshot)) {
      if (artifacts.length >= 12) break;
      if (!artifacts.some((existing) => existing.path === artifact.path)) {
        artifacts.push(artifact);
      }
    }
    if (artifacts.length >= 12) break;
  }

  const designDecisions = parseDecisionItems(sections.get('design decisions'));
  const constraints = normalizeList(sections.get('constraints'), 8, 600);
  const openQuestions = normalizeList(sections.get('open questions'), 8, 600);
  const nextSteps = normalizeList(sections.get('next bets') || sections.get('next steps'), 8, 600);

  return {
    contract: 'prototype_bundle.v1',
    summary: {
      title,
      oneLiner,
      recommendedDirection: safeTrim(recommendedDirection, 500),
    },
    artifacts,
    screens: [],
    flows: [],
    designDecisions,
    constraints,
    openQuestions,
    nextSteps: nextSteps.length > 0
      ? nextSteps
      : normalizeList(leaderEntry?.mustChange || [], 6, 600),
    prototypes: snapshots.map((snapshot) => ({
      id: snapshot.prototypeKey,
      title: snapshot.prototypeLabel,
      directory: snapshot.prototypeDir,
      summaryPath: snapshot.readmePath,
      status: snapshot.status,
      summary: getFirstParagraph(snapshot.readmeContent, snapshot.readmeExcerpt || ''),
      artifactPaths: pickPrototypeArtifacts(snapshot).map((artifact) => artifact.path),
    })),
    leaderboard: ranked.map((entry) => ({
      rank: entry.rank,
      prototypeId: entry.prototypeKey,
      prototypeTitle: entry.prototypeLabel,
      averageScore: Number(entry.averageScore.toFixed(2)),
      reviewCount: entry.reviewCount,
      mustChangeCount: entry.mustChange.length,
      riskCount: entry.risks.length,
    })),
    provenance: {
      roomType: 'prototype_room',
      generatedAt: new Date().toISOString(),
      outputDir: state.config.outputDir,
      cycleCount: state.cycleCount,
    },
  };
}

function buildReportArtifacts(state, bundle) {
  const artifacts = [];
  const seen = new Set();

  for (const artifact of Array.isArray(bundle?.artifacts) ? bundle.artifacts : []) {
    if (!artifact?.path || seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    artifacts.push({
      type: artifact.kind || inferArtifactKind(artifact.path),
      path: artifact.path,
      label: artifact.label || path.basename(artifact.path),
      ...(artifact.primary ? { primary: true } : {}),
    });
  }

  for (const participant of state.participants) {
    const snapshot = collectPrototypeSnapshot(state, participant);
    if (!snapshot.readmePath || seen.has(snapshot.readmePath)) continue;
    seen.add(snapshot.readmePath);
    artifacts.push({
      type: 'text',
      path: snapshot.readmePath,
      label: `${participant.prototypeLabel} summary`,
    });
  }

  return artifacts;
}

function emitMetrics(ctx, state) {
  const displayNameCounts = {};
  for (const participant of state.participants) {
    const name = participant.displayName || participant.agentId;
    displayNameCounts[name] = (displayNameCounts[name] || 0) + 1;
  }

  const contributorStatus = {};
  for (const participant of state.participants) {
    const baseName = participant.displayName || participant.agentId;
    const label = displayNameCounts[baseName] > 1
      ? `${baseName} (${participant.agentId})`
      : baseName;
    contributorStatus[label] = state.agentStatus[participant.agentId] || 'idle';
  }

  const reviewSummary = summarizeReviewRound(getLatestRound(state, PHASES.REVIEW), state);
  const snapshots = state.participants.map((participant) => state.snapshots[participant.agentId]).filter(Boolean);
  const latestSynthesis = state.reviewSyntheses.at(-1) || null;

  ctx.emitMetrics({
    currentPhase: { active: state.phase },
    prototypePhase: { active: state.phase },
    prototypeProgress: { value: Math.max(state.cycleCount, 1), max: state.maxCycles },
    prototypeCounts: {
      prototypes: snapshots.filter((snapshot) => snapshot.status === 'ready').length,
      files: snapshots.reduce((sum, snapshot) => sum + (snapshot.fileCount || 0), 0),
      reviews: latestSynthesis?.reviewBlockCount || reviewSummary.reviewBlockCount,
      changes: latestSynthesis?.mustChangeCount || reviewSummary.mustChangeCount,
    },
    contributorStatus,
    contributionTable: { rows: collectContributionRows(state) },
    leaderboardTable: { rows: buildLeaderboardRows(state) },
    roomFeed: { entries: state.feedEntries },
    prototypeArtifacts: { blocks: buildArtifactBlocks(state) },
    finalArtifacts: { blocks: buildArtifactBlocks(state) },
  });
}

function collectContributionRows(state) {
  return state.rounds.flatMap((round) => round.responses.map((response) => ({
    phase: round.label,
    contributor: response.displayName,
    prototype: titleCase(response.prototypeKey),
    status: response.status || 'submitted',
    summary: excerpt(response.response, 220) || 'No response summary available.',
  })));
}

function buildPeerCatalog(state, participant) {
  const peers = state.participants.filter((entry) => entry.agentId !== participant.agentId);
  if (peers.length === 0) return '- None.';

  return peers.map((peer) => {
    const snapshot = state.snapshots[peer.agentId] || collectPrototypeSnapshot(state, peer);
    const lines = [
      `### ${peer.prototypeKey}`,
      `- Label: ${peer.prototypeLabel}`,
      `- Directory: ${peer.prototypeDir}`,
      `- Summary file: ${peer.readmePath}`,
      `- Status: ${titleCase(snapshot.status)}`,
      snapshot.issue ? `- Issue: ${snapshot.issue}` : '',
      `- Visible files: ${snapshot.fileCount}`,
      '',
      'Visible file tree:',
      ...(snapshot.treeLines.length > 0 ? snapshot.treeLines : ['- None yet.']),
      '',
      'Summary excerpt:',
      snapshot.readmeExcerpt ? snapshot.readmeExcerpt : '(missing summary file)',
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
}

function buildSelfSnapshot(state, participant) {
  const snapshot = state.snapshots[participant.agentId] || collectPrototypeSnapshot(state, participant);
  return [
    `- Directory: ${participant.prototypeDir}`,
    `- Summary file: ${participant.readmePath}`,
    `- Status: ${titleCase(snapshot.status)}`,
    snapshot.issue ? `- Issue: ${snapshot.issue}` : '',
    `- Visible files: ${snapshot.fileCount}`,
    '',
    'Visible file tree:',
    ...(snapshot.treeLines.length > 0 ? snapshot.treeLines : ['- None yet.']),
    '',
    'Current summary excerpt:',
    snapshot.readmeExcerpt ? snapshot.readmeExcerpt : '(missing summary file)',
  ].filter(Boolean).join('\n');
}

function splitHeadingSections(markdown, headingPrefix = '###') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let currentSection = null;

  for (const line of lines) {
    const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = line.match(new RegExp(`^\\s*${escaped}\\s+(.+)$`));
    if (match) {
      currentSection = canonicalKey(match[1]);
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }

    if (currentSection) {
      sections.get(currentSection).push(line);
    }
  }

  return sections;
}

function sectionToItems(lines, maxItems = 12, itemLen = 500) {
  if (!Array.isArray(lines)) return [];
  return normalizeList(
    lines
      .map((line) => safeTrim(line, itemLen))
      .filter(Boolean),
    maxItems,
    itemLen,
  );
}

function sectionToScore(lines) {
  const text = safeTrim(
    Array.isArray(lines)
      ? lines.map((line) => safeTrim(line, 80)).join(' ')
      : '',
    120,
  );
  const match = text.match(/\b(10|[1-9])(?:\.\d+)?\b/);
  return match ? Number(match[1]) : null;
}

function parseReviewTargets(responseText, state) {
  const text = String(responseText || '').replace(/\r\n/g, '\n');
  const targetMatches = Array.from(text.matchAll(/^##\s*Target:\s*(.+)$/gim));
  if (targetMatches.length === 0) return [];

  return targetMatches.map((match, index) => {
    const targetName = safeTrim(match[1], 120);
    const start = match.index + match[0].length;
    const end = index + 1 < targetMatches.length ? targetMatches[index + 1].index : text.length;
    const block = text.slice(start, end);
    const sections = splitHeadingSections(block, '###');
    const participant = findParticipantForTarget(state, targetName);
    if (!participant) return null;
    return {
      targetAgentId: participant.agentId,
      targetPrototypeKey: participant.prototypeKey,
      score: sectionToScore(sections.get('score')),
      keep: sectionToItems(sections.get('keep'), 12, TEXT_LIMITS.feedbackSection),
      mustChange: sectionToItems(sections.get('must change'), 12, TEXT_LIMITS.feedbackSection),
      niceToHave: sectionToItems(sections.get('nice to have'), 12, TEXT_LIMITS.feedbackSection),
      risks: sectionToItems(sections.get('risks'), 12, TEXT_LIMITS.feedbackSection),
    };
  }).filter(Boolean);
}

function findParticipantForTarget(state, targetName) {
  const targetKey = canonicalKey(targetName);
  return state.participants.find((participant) => (
    canonicalKey(participant.prototypeKey) === targetKey
    || canonicalKey(participant.prototypeLabel) === targetKey
    || canonicalKey(participant.displayName) === targetKey
  )) || null;
}

function summarizeReviewRound(round, state = null) {
  const parsed = (round?.responses || []).map((response) => ({
    reviewer: response,
    targets: state ? parseReviewTargets(response.response, state) : [],
  }));

  const reviewBlockCount = parsed.reduce((sum, entry) => sum + entry.targets.length, 0);
  const mustChangeCount = parsed.reduce((sum, entry) => (
    sum + entry.targets.reduce((targetSum, target) => targetSum + target.mustChange.length, 0)
  ), 0);
  const scoreCount = parsed.reduce((sum, entry) => (
    sum + entry.targets.filter((target) => typeof target.score === 'number').length
  ), 0);

  return {
    parsed,
    reviewBlockCount,
    mustChangeCount,
    scoreCount,
  };
}

function collectSharedThemes(ranked, field, maxItems = 5) {
  const counts = new Map();
  for (const entry of Array.isArray(ranked) ? ranked : []) {
    const seenForPrototype = new Set();
    for (const item of Array.isArray(entry[field]) ? entry[field] : []) {
      const key = canonicalKey(item);
      if (!key || seenForPrototype.has(key)) continue;
      seenForPrototype.add(key);
      const existing = counts.get(key) || { text: item, count: 0 };
      existing.count += 1;
      if (String(item).length > String(existing.text).length) {
        existing.text = item;
      }
      counts.set(key, existing);
    }
  }

  return Array.from(counts.values())
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return String(left.text).localeCompare(String(right.text));
    })
    .slice(0, maxItems)
    .map((entry) => entry.count > 1 ? `${entry.text} (${entry.count} prototypes)` : entry.text);
}

function buildSynthesisMarkdown(synthesis) {
  if (!synthesis) return 'No review synthesis available yet.';

  const commonStrengths = collectSharedThemes(synthesis.ranked, 'keep');
  const commonMustChanges = collectSharedThemes(synthesis.ranked, 'mustChange');
  const commonRisks = collectSharedThemes(synthesis.ranked, 'risks');

  const lines = [
    `# Cycle ${synthesis.cycleIndex} Review Synthesis`,
    '',
    synthesis.ranked.length > 0
      ? `Top prototype this cycle: **${synthesis.ranked[0].prototypeLabel}** with an average score of **${synthesis.ranked[0].averageScore.toFixed(1)} / 10**.`
      : 'No scored review data was available this cycle.',
    '',
    '## Leaderboard',
    ...(synthesis.ranked.length > 0
      ? synthesis.ranked.map((entry) => `- #${entry.rank} ${entry.prototypeLabel} — ${entry.averageScore.toFixed(1)} / 10 (${entry.reviewCount} review${entry.reviewCount === 1 ? '' : 's'})`)
      : ['- No leaderboard yet.']),
    '',
    '## Cross-Prototype Themes',
    '### Common Strengths',
    ...(commonStrengths.length > 0 ? commonStrengths.map((item) => `- ${item}`) : ['- No repeated strengths yet.']),
    '',
    '### Common Must-Change Themes',
    ...(commonMustChanges.length > 0 ? commonMustChanges.map((item) => `- ${item}`) : ['- No repeated required changes yet.']),
    '',
    '### Common Risks',
    ...(commonRisks.length > 0 ? commonRisks.map((item) => `- ${item}`) : ['- No repeated risks yet.']),
  ];

  for (const entry of synthesis.ranked) {
    lines.push(
      '',
      `## Rank ${entry.rank}: ${entry.prototypeLabel} (\`${entry.prototypeKey}\`)`,
      `- Average score: ${entry.averageScore.toFixed(1)} / 10 from ${entry.reviewCount} review${entry.reviewCount === 1 ? '' : 's'}`,
      `- Required changes: ${entry.mustChange.length}`,
      `- Risks: ${entry.risks.length}`,
      '',
      '### What It Got Right',
      ...(entry.keep.length > 0 ? entry.keep.map((item) => `- ${item}`) : ['- None highlighted.']),
      '',
      '### What Must Improve',
      ...(entry.mustChange.length > 0 ? entry.mustChange.map((item) => `- ${item}`) : ['- None.']),
      '',
      '### Nice To Have',
      ...(entry.niceToHave.length > 0 ? entry.niceToHave.map((item) => `- ${item}`) : ['- None.']),
      '',
      '### Risks',
      ...(entry.risks.length > 0 ? entry.risks.map((item) => `- ${item}`) : ['- None.']),
    );
  }

  return lines.join('\n');
}

function synthesizeReviewCycle(state, cycleIndex) {
  const reviewRound = getRound(state, PHASES.REVIEW, cycleIndex);
  const summary = summarizeReviewRound(reviewRound, state);
  const byTarget = new Map();

  for (const participant of state.participants) {
    byTarget.set(participant.agentId, {
      participant,
      scores: [],
      keep: [],
      mustChange: [],
      niceToHave: [],
      risks: [],
    });
  }

  for (const entry of summary.parsed) {
    for (const target of entry.targets) {
      const aggregate = byTarget.get(target.targetAgentId);
      if (!aggregate) continue;
      if (typeof target.score === 'number') {
        aggregate.scores.push(target.score);
      }
      aggregate.keep.push(...target.keep);
      aggregate.mustChange.push(...target.mustChange);
      aggregate.niceToHave.push(...target.niceToHave);
      aggregate.risks.push(...target.risks);
    }
  }

  const ranked = Array.from(byTarget.values())
    .map((aggregate) => {
      const averageScore = aggregate.scores.length > 0
        ? aggregate.scores.reduce((sum, score) => sum + score, 0) / aggregate.scores.length
        : 0;
      return {
        agentId: aggregate.participant.agentId,
        prototypeKey: aggregate.participant.prototypeKey,
        prototypeLabel: aggregate.participant.prototypeLabel,
        reviewCount: aggregate.scores.length,
        averageScore,
        keep: normalizeList(aggregate.keep, 8, TEXT_LIMITS.feedbackSection),
        mustChange: normalizeList(aggregate.mustChange, 8, TEXT_LIMITS.feedbackSection),
        niceToHave: normalizeList(aggregate.niceToHave, 8, TEXT_LIMITS.feedbackSection),
        risks: normalizeList(aggregate.risks, 8, TEXT_LIMITS.feedbackSection),
      };
    })
    .sort((left, right) => {
      if (right.averageScore !== left.averageScore) return right.averageScore - left.averageScore;
      if (left.mustChange.length !== right.mustChange.length) return left.mustChange.length - right.mustChange.length;
      if (left.risks.length !== right.risks.length) return left.risks.length - right.risks.length;
      return left.prototypeKey.localeCompare(right.prototypeKey);
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  const synthesis = {
    cycleIndex,
    reviewBlockCount: summary.reviewBlockCount,
    mustChangeCount: summary.mustChangeCount,
    scoreCount: summary.scoreCount,
    ranked,
    markdown: '',
  };
  synthesis.markdown = buildSynthesisMarkdown(synthesis);

  state.reviewSyntheses = [
    ...state.reviewSyntheses.filter((entry) => entry.cycleIndex !== cycleIndex),
    synthesis,
  ].sort((left, right) => left.cycleIndex - right.cycleIndex);

  return synthesis;
}

function getSynthesisForCycle(state, cycleIndex = state.cycleCount) {
  return state.reviewSyntheses.find((entry) => entry.cycleIndex === cycleIndex) || null;
}

function buildFeedbackForParticipant(state, participant, cycleIndex = state.cycleCount) {
  const reviewRound = getRound(state, PHASES.REVIEW, cycleIndex);
  const parsed = summarizeReviewRound(reviewRound, state).parsed
    .map((entry) => ({
      reviewer: entry.reviewer,
      target: entry.targets.find((target) => target.targetAgentId === participant.agentId),
    }))
    .filter((entry) => entry.target);

  if (parsed.length === 0) {
    return '(none yet)';
  }

  const blocks = [];
  let totalChars = 0;

  for (const entry of parsed) {
    const block = [
      `### ${entry.reviewer.displayName}`,
      `Score:\n- ${typeof entry.target.score === 'number' ? `${entry.target.score} / 10` : 'Not provided.'}`,
      entry.target.keep.length > 0 ? `Keep:\n${entry.target.keep.map((item) => `- ${item}`).join('\n')}` : 'Keep:\n- None.',
      entry.target.mustChange.length > 0 ? `Must Change:\n${entry.target.mustChange.map((item) => `- ${item}`).join('\n')}` : 'Must Change:\n- None.',
      entry.target.niceToHave.length > 0 ? `Nice To Have:\n${entry.target.niceToHave.map((item) => `- ${item}`).join('\n')}` : 'Nice To Have:\n- None.',
      entry.target.risks.length > 0 ? `Risks:\n${entry.target.risks.map((item) => `- ${item}`).join('\n')}` : 'Risks:\n- None.',
    ].join('\n');

    const nextLength = block.length + (blocks.length > 0 ? 2 : 0);
    if (blocks.length > 0 && totalChars + nextLength > 18000) break;
    blocks.push(block);
    totalChars += nextLength;
  }

  return blocks.join('\n\n') || '(none yet)';
}

function buildSynthesisSummaryForParticipant(state, participant, cycleIndex = state.cycleCount) {
  const synthesis = getSynthesisForCycle(state, cycleIndex);
  if (!synthesis) return '(no synthesis summary yet)';

  const entry = synthesis.ranked.find((item) => item.agentId === participant.agentId);
  if (!entry) return '(no synthesis summary yet)';

  return [
    `- Cycle: ${cycleIndex}`,
    `- Rank this cycle: ${entry.rank} of ${synthesis.ranked.length}`,
    `- Average score: ${entry.averageScore.toFixed(1)} / 10 from ${entry.reviewCount} review${entry.reviewCount === 1 ? '' : 's'}`,
    '',
    'Strongest signals:',
    ...(entry.keep.length > 0 ? entry.keep.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    'Most important changes:',
    ...(entry.mustChange.length > 0 ? entry.mustChange.map((item) => `- ${item}`) : ['- None yet.']),
    '',
    'Main risks:',
    ...(entry.risks.length > 0 ? entry.risks.map((item) => `- ${item}`) : ['- None.']),
  ].join('\n');
}

function buildCompetitiveGuidance(state, participant, cycleIndex = state.cycleCount) {
  const synthesis = getSynthesisForCycle(state, cycleIndex);
  if (!synthesis || synthesis.ranked.length === 0) {
    return '(no competitive guidance yet)';
  }

  const entry = synthesis.ranked.find((item) => item.agentId === participant.agentId);
  const leader = synthesis.ranked[0];
  if (!entry || !leader) return '(no competitive guidance yet)';

  const lines = [
    `- Leaderboard leader: ${leader.prototypeLabel} at ${leader.averageScore.toFixed(1)} / 10.`,
    `- Your current position: #${entry.rank} of ${synthesis.ranked.length}.`,
  ];

  if (entry.agentId === leader.agentId) {
    lines.push('- You are currently leading. Protect the strongest parts of your prototype while removing the clearest reasons someone could overtake you.');
    lines.push(
      leader.mustChange.length > 0
        ? `- The fastest way to stay ahead is to fix: ${leader.mustChange.slice(0, 2).join(' | ')}`
        : '- Reviewers are not asking for required changes right now; use this pass to sharpen clarity and polish.',
    );
  } else {
    const gap = Math.max(0, leader.averageScore - entry.averageScore);
    lines.push(`- Score gap to leader: ${gap.toFixed(1)} points.`);
    lines.push(
      leader.keep.length > 0
        ? `- Study what reviewers like about the leader: ${leader.keep.slice(0, 3).join(' | ')}`
        : '- Reviewers have not converged on a clear leader strength yet.',
    );
    lines.push(
      entry.mustChange.length > 0
        ? `- Your fastest path upward is to fix: ${entry.mustChange.slice(0, 3).join(' | ')}`
        : '- You have no required changes; look for ways to increase clarity, taste, and distinctiveness.',
    );
  }

  return lines.join('\n');
}

function buildBuildPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.build, {
    display_name: participant.displayName,
    objective: state.objective,
    prototype_label: participant.prototypeLabel,
    prototype_key: participant.prototypeKey,
    prototype_dir: participant.prototypeDir,
    readme_path: participant.readmePath,
  });
}

function buildReviewPrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.review, {
    display_name: participant.displayName,
    objective: state.objective,
    prototype_label: participant.prototypeLabel,
    prototype_dir: participant.prototypeDir,
    peer_catalog: buildPeerCatalog(state, participant),
  });
}

function buildImprovePrompt(state, participant) {
  return renderPromptTemplate(promptTemplates.improve, {
    display_name: participant.displayName,
    objective: state.objective,
    prototype_label: participant.prototypeLabel,
    prototype_dir: participant.prototypeDir,
    readme_path: participant.readmePath,
    self_snapshot: buildSelfSnapshot(state, participant),
    leaderboard_summary: buildLeaderboardSummary(state),
    synthesis_summary: buildSynthesisSummaryForParticipant(state, participant),
    competitive_guidance: buildCompetitiveGuidance(state, participant),
    review_feedback: buildFeedbackForParticipant(state, participant),
  });
}

function buildTargetsForPhase(state, phase) {
  if (phase === PHASES.COMPLETE || phase === PHASES.SYNTHESIZE) return [];

  return state.participants.map((participant) => ({
    agentId: participant.agentId,
    message: phase === PHASES.BUILD
      ? buildBuildPrompt(state, participant)
      : (phase === PHASES.REVIEW
          ? buildReviewPrompt(state, participant)
          : buildImprovePrompt(state, participant)),
  }));
}

function issuePhaseDecision(ctx, state, phase, options = {}) {
  state.phase = phase;
  ensureRound(state, phase, state.cycleCount);

  const targets = options.pendingOnly
    ? buildPendingTargetsForPhase(state, phase)
    : buildTargetsForPhase(state, phase);

  updateAgentStatuses(state, targets.map((target) => target.agentId), 'assigned');

  const phaseMessage = options.pendingOnly
    ? `Resuming ${phase} cycle work — ${targets.length} contributor(s) remaining.`
    : (phase === PHASES.BUILD
        ? `Starting build pass for cycle ${state.cycleCount} in ${state.config.outputDir}.`
        : (phase === PHASES.REVIEW
            ? `Starting review cycle ${state.cycleCount} across all prototype folders.`
            : `Starting improve cycle ${state.cycleCount} so each participant can upgrade its own prototype.`));

  appendFeed(state, phaseMessage);
  ctx.setCycle(state.cycleCount);
  ctx.setState(state);
  emitMetrics(ctx, state);

  return {
    type: 'fan_out',
    targets,
    metadata: {
      phase,
      cycle: state.cycleCount,
      outputDir: state.config.outputDir,
      label: options.pendingOnly ? `resume-${phase}-${state.cycleCount}` : `${phase}-${state.cycleCount}`,
    },
  };
}

function mergeResponsesIntoRound(state, phase, responses) {
  const round = ensureRound(state, phase, state.cycleCount);

  for (const response of Array.isArray(responses) ? responses : []) {
    const participant = state.participants.find((entry) => entry.agentId === response.agentId);
    if (!participant) continue;
    upsertRoundResponse(round, participant, response);
  }

  updateAgentStatuses(
    state,
    state.participants.map((participant) => participant.agentId),
    'idle',
  );
}

function stopForMissingRoles(ctx, state) {
  appendFeed(
    state,
    `Cannot start Prototype Room without required roles: ${state.missingRoles.map(titleCase).join(', ')}.`,
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `missing_required_roles:${state.missingRoles.join(',')}`,
  };
}

function stopForMissingOutputDir(ctx, state) {
  appendFeed(
    state,
    'Cannot start Prototype Room without an output directory from the room setup UI.',
  );
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: 'missing_output_directory',
  };
}

function finalizeRoom(ctx, state, reason) {
  state.phase = PHASES.COMPLETE;
  appendFeed(state, `Prototype room complete. Review the folders under ${state.config.outputDir}.`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return { type: 'stop', reason };
}

function shouldStopForConvergence(state) {
  const synthesis = getSynthesisForCycle(state, state.cycleCount);
  return Boolean(
    synthesis
      && state.cycleCount >= 2
      && synthesis.reviewBlockCount > 0
      && synthesis.mustChangeCount === 0
  );
}

async function continueFromCollectedResponses(ctx, state) {
  refreshSnapshots(state);

  if (state.phase === PHASES.BUILD) {
    const snapshots = state.participants.map((participant) => state.snapshots[participant.agentId]);
    const incomplete = snapshots.filter((snapshot) => snapshot && snapshot.status !== 'ready');
    appendFeed(
      state,
      incomplete.length > 0
        ? `Build pass finished with ${incomplete.length} incomplete prototype folder${incomplete.length === 1 ? '' : 's'}. Review will continue with the current snapshots.`
        : 'Build pass finished. All prototype folders have a summary file.',
    );
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  if (state.phase === PHASES.REVIEW) {
    const summary = summarizeReviewRound(ensureRound(state, PHASES.REVIEW, state.cycleCount), state);
    appendFeed(
      state,
      `Collected ${summary.reviewBlockCount} peer review block${summary.reviewBlockCount === 1 ? '' : 's'} with ${summary.mustChangeCount} required change${summary.mustChangeCount === 1 ? '' : 's'}.`,
    );
    state.phase = PHASES.SYNTHESIZE;
    const synthesis = synthesizeReviewCycle(state, state.cycleCount);
    const leader = synthesis.ranked[0];
    appendFeed(
      state,
      leader
        ? `Cycle ${state.cycleCount} synthesis complete. ${leader.prototypeLabel} is currently leading at ${leader.averageScore.toFixed(1)} / 10.`
        : `Cycle ${state.cycleCount} synthesis complete.`,
    );
    ctx.setState(state);
    emitMetrics(ctx, state);
    return issuePhaseDecision(ctx, state, PHASES.IMPROVE);
  }

  if (state.phase === PHASES.IMPROVE) {
    appendFeed(state, `Improve cycle ${state.cycleCount} finished.`);
    if (shouldStopForConvergence(state)) {
      appendFeed(state, 'Reviewers are no longer asking for material changes. Stopping after this improve pass.');
      return finalizeRoom(ctx, state, 'prototype_converged');
    }
    if (state.cycleCount >= state.maxCycles) {
      appendFeed(state, 'Reached the configured cycle limit. Final prototype snapshots are ready.');
      return finalizeRoom(ctx, state, 'prototype_complete');
    }

    state.cycleCount += 1;
    return issuePhaseDecision(ctx, state, PHASES.REVIEW);
  }

  appendFeed(state, `Unexpected collected-response continuation while in phase "${state.phase}".`);
  ctx.setState(state);
  emitMetrics(ctx, state);
  return {
    type: 'stop',
    reason: `unexpected_resume_phase:${state.phase}`,
  };
}

function getPhaseResponses(state, phase) {
  const round = ensureRound(state, phase, state.cycleCount);
  return round.responses.map((response) => ({
    agentId: response.agentId,
    response: response.response,
    rejected: response.status?.startsWith('rejected:'),
    rejectionReason: response.status?.startsWith('rejected:') ? response.status.slice('rejected:'.length).trim() : '',
  }));
}

function createPlugin() {
  return {
    init(ctx) {
      const state = createInitialState(ctx);
      refreshSnapshots(state);
      ctx.setState(state);
      emitMetrics(ctx, state);
    },

    onRoomStart(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      if (state.missingRoles.length > 0) {
        return stopForMissingRoles(ctx, state);
      }
      if (!state.config.outputDir) {
        return stopForMissingOutputDir(ctx, state);
      }
      const seededCount = ensurePrototypeDirectories(state);
      refreshSnapshots(state);
      if (seededCount > 0) {
        appendFeed(state, `Seeded ${seededCount} prototype summary file${seededCount === 1 ? '' : 's'} to make the first build pass easier to start.`);
      }
      return issuePhaseDecision(ctx, state, PHASES.BUILD);
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState() || createInitialState(ctx);
      mergeResponsesIntoRound(state, state.phase, responses);
      if (state.phase === PHASES.BUILD || state.phase === PHASES.REVIEW || state.phase === PHASES.IMPROVE) {
        return continueFromCollectedResponses(ctx, state);
      }

      appendFeed(state, `Unexpected fan-out completion while in phase "${state.phase}".`);
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: `unexpected_fan_out_phase:${state.phase}`,
      };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState() || createInitialState(ctx);
      appendFeed(
        state,
        `Received unexpected single-turn response from ${turnResult?.agentId || 'unknown agent'}.`,
      );
      ctx.setState(state);
      emitMetrics(ctx, state);
      return {
        type: 'stop',
        reason: 'unexpected_single_turn',
      };
    },

    onEvent(ctx, event) {
      const state = ctx.getState() || createInitialState(ctx);

      if (event?.type === 'fan_out_partial' && event.agentId) {
        if (event.progress?.completedAgentIds) {
          updateAgentStatuses(state, event.progress.completedAgentIds, 'submitted');
        }
        if (event.progress?.pendingAgentIds) {
          updateAgentStatuses(state, event.progress.pendingAgentIds, 'assigned');
        }
        state.agentStatus[event.agentId] = 'submitted';
        const round = ensureRound(state, state.phase, state.cycleCount);
        const participant = state.participants.find((entry) => entry.agentId === event.agentId);
        if (participant && event.detail?.response) {
          upsertRoundResponse(round, participant, {
            response: event.detail.response,
            status: 'submitted',
          });
        }
        appendFeed(
          state,
          `${event.displayName || event.agentId} submitted a partial response.`,
          {
            displayName: event.displayName || event.agentId,
            role: 'participant',
            agentId: event.agentId,
          },
        );
        ctx.setState(state);
        emitMetrics(ctx, state);
        return null;
      }

      if (event?.type === 'participant_disconnected' && event.agentId) {
        state.agentStatus[event.agentId] = 'disconnected';
        if (!state.disconnectedAgents.includes(event.agentId)) {
          state.disconnectedAgents.push(event.agentId);
        }
        appendFeed(state, `${event.agentId} disconnected.`, {
          displayName: event.agentId,
          role: 'participant',
          agentId: event.agentId,
        });
        ctx.setState(state);
        emitMetrics(ctx, state);
        return {
          type: 'pause',
          reason: `participant_disconnected:${event.agentId}`,
        };
      }

      if (event?.type === 'user_edit_state') {
        refreshSnapshots(state);
        emitMetrics(ctx, state);
        return null;
      }

      return null;
    },

    async onResume(ctx) {
      const state = ctx.getState() || createInitialState(ctx);
      refreshSnapshots(state);
      emitMetrics(ctx, state);
      if (state.phase === PHASES.COMPLETE) return null;

      const activeFanOut = typeof ctx.getActiveFanOut === 'function'
        ? ctx.getActiveFanOut()
        : null;

      if (activeFanOut?.pendingAgentIds?.length > 0) {
        updateAgentStatuses(state, activeFanOut.completedAgentIds || [], 'submitted');
        updateAgentStatuses(state, activeFanOut.pendingAgentIds, 'assigned');
        appendFeed(state, `Resuming ${state.phase} cycle work — ${activeFanOut.pendingAgentIds.length} contributor(s) remaining.`);
        ctx.setState(state);
        emitMetrics(ctx, state);
        return { type: 'continue_fan_out' };
      }

      const targets = buildPendingTargetsForPhase(state, state.phase);
      if (targets.length > 0) {
        return issuePhaseDecision(ctx, state, state.phase, { pendingOnly: true });
      }

      const phaseResponses = getPhaseResponses(state, state.phase);
      if (phaseResponses.length > 0) {
        return continueFromCollectedResponses(ctx, state);
      }

      return null;
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (!pendingDecision || pendingDecision.type !== 'fan_out' || !state) {
        return pendingDecision;
      }

      const targets = buildPendingTargetsForPhase(state, state.phase);
      return targets.length > 0 ? { ...pendingDecision, targets } : pendingDecision;
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state?.participants?.length) return null;

      const bundle = buildPrototypeBundle(state);
      const artifacts = buildReportArtifacts(state, bundle);
      const leader = bundle.leaderboard?.[0] || null;

      return {
        summary: {
          title: bundle.summary.title,
          highlights: [
            bundle.summary.oneLiner,
            leader
              ? `${leader.prototypeTitle} is currently ranked #1 at ${leader.averageScore} / 10.`
              : `Captured ${bundle.prototypes.length} prototype${bundle.prototypes.length === 1 ? '' : 's'}.`,
            bundle.summary.recommendedDirection,
          ].filter(Boolean).slice(0, 6),
          outcome: state.phase === PHASES.COMPLETE ? 'prototype_bundle_ready' : 'prototype_bundle_partial',
        },
        metrics: {
          cycles: state.cycleCount,
          turns: state.rounds.length,
          failures: 0,
          tokensUsed: null,
        },
        artifacts,
        handoffPayloads: [
          {
            contract: 'prototype_bundle.v1',
            data: bundle,
          },
        ],
      };
    },

    shutdown() {
      // No-op.
    },
  };
}

export default { manifest, createPlugin };
export { manifest, createPlugin };
