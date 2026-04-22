// ---------------------------------------------------------------------------
// Review model. Owns the parsing of reviewer responses into per-target
// sections, the per-cycle synthesis (ranked leaderboard + aggregated
// keep/mustChange/risks), and the prompt-facing helpers that turn synthesis
// state into feedback, summaries, and competitive guidance for improve
// prompts.
// ---------------------------------------------------------------------------

import { PHASES, TEXT_LIMITS } from './constants.js';
import { canonicalKey, normalizeList, safeTrim, titleCase } from './text-utils.js';
import {
  sectionToItems,
  sectionToScore,
  splitHeadingSections,
} from './markdown-utils.js';
import { collectPrototypeSnapshot } from './prototype-fs.js';
import { getLatestRound, getRound } from './rounds.js';

function findParticipantForTarget(state, targetName) {
  const targetKey = canonicalKey(targetName);
  return state.participants.find((participant) => (
    canonicalKey(participant.prototypeKey) === targetKey
    || canonicalKey(participant.prototypeLabel) === targetKey
    || canonicalKey(participant.displayName) === targetKey
  )) || null;
}

export function parseReviewTargets(responseText, state) {
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

export function summarizeReviewRound(round, state = null) {
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

export function synthesizeReviewCycle(state, cycleIndex) {
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

export function getSynthesisForCycle(state, cycleIndex = state.cycleCount) {
  return state.reviewSyntheses.find((entry) => entry.cycleIndex === cycleIndex) || null;
}

export function buildLeaderboardRows(state, cycleIndex = state.cycleCount) {
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

export function buildLeaderboardSummary(state, cycleIndex = state.cycleCount) {
  const rows = buildLeaderboardRows(state, cycleIndex);
  if (rows.length === 0) return '(no leaderboard yet)';
  return rows.map((row) => (
    `- #${row.rank} ${row.prototype} — score ${row.score}, reviews ${row.reviews}, must change ${row.mustChange}, risks ${row.risks} (${row.status})`
  )).join('\n');
}

export function buildFeedbackForParticipant(state, participant, cycleIndex = state.cycleCount) {
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

export function buildSynthesisSummaryForParticipant(state, participant, cycleIndex = state.cycleCount) {
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

export function buildCompetitiveGuidance(state, participant, cycleIndex = state.cycleCount) {
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

export function getLatestReviewRound(state) {
  return getLatestRound(state, PHASES.REVIEW);
}
