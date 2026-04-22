/**
 * review-cycle-plugin.js — Review Cycle Orchestrator plugin.
 *
 * Decision logic for the review-cycle orchestration pattern:
 *   1 implementer + N reviewers in a convergence loop.
 *   Reviewers find issues, orchestrator LLM consolidates them,
 *   implementer fixes, repeat until convergence or limits.
 *
 * This is pure decision logic — no Electron deps, no I/O, no timeouts.
 * The room runtime owns all enforcement (limits, retries, fan-out, quorum).
 *
 * This file wires the module graph in desktop/room/review-cycle/. The actual
 * logic lives in focused modules:
 *   manifest            — PLUGIN_ID + dashboard/limits/roles/cli config.
 *   prompt-context      — workspace + handoff context string builders.
 *   findings-metadata   — disposition/artifacts/doc-integrity derivations.
 *   prompts             — five prompt templates (initial/re/clean/impl/synth).
 *   response-parsing    — reviewer + synthesis JSON extraction.
 *   reviewer-state      — phase transitions + convergence evaluation.
 *   final-report        — review_findings.v1 + pass-through payload builders.
 */

import {
  DECISION_TYPES,
  AGENT_ROLES,
  REVIEWER_PHASES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';

import { PLUGIN_ID, MANIFEST } from './review-cycle/manifest.js';
import { buildWorkspaceContext, buildHandoffPromptContext } from './review-cycle/prompt-context.js';
import {
  buildInitialReviewPrompt,
  buildReReviewPrompt,
  buildCleanReviewPrompt,
  buildImplementerPrompt,
  buildSynthesisPrompt,
} from './review-cycle/prompts.js';
import { parseReviewerResponse, parseSynthesisResponse } from './review-cycle/response-parsing.js';
import { nextReviewerPhase, evaluateConvergence } from './review-cycle/reviewer-state.js';
import {
  collectReviewCyclePassThroughPayloads,
  buildReviewFindingsPayload,
} from './review-cycle/final-report.js';

/** Max characters stored per turnLog entry content to prevent unbounded growth. */
const TURN_LOG_MAX_CONTENT_LENGTH = 20_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function createReviewCyclePlugin() {
  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    /**
     * Initialize plugin state.
     */
    init(ctx) {
      const participants = ctx.participants;
      const implementer = participants.find((p) => p.role === AGENT_ROLES.IMPLEMENTER);
      const reviewers = participants.filter((p) => p.role === AGENT_ROLES.REVIEWER);

      ctx.setState({
        currentCycle: 0,
        maxCycles: ctx.limits.maxCycles || 5,
        latestImplementation: null,
        latestReviewerFeedback: null,
        issues: [],
        reviewerStates: reviewers.map((r) => ({
          agentId: r.agentId,
          displayName: r.displayName,
          phase: REVIEWER_PHASES.INITIAL_REVIEW,
          lastIssueCount: 0,
        })),
        cycleHistory: [],
        turnLog: [],
        implementerId: implementer ? implementer.agentId : null,
      });
    },

    /**
     * Room starts — send initial review prompts to all reviewers.
     */
    onRoomStart(ctx) {
      const reviewers = ctx.participants.filter((p) => p.role === AGENT_ROLES.REVIEWER);
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      ctx.emitMetrics({ currentPhase: { active: 'reviewing' } });

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: reviewers.map((r) => ({
          agentId: r.agentId,
          message: buildInitialReviewPrompt(ctx.objective, r.displayName, handoffPromptContext) + wsCtx,
        })),
      };
    },

    /**
     * All fan-out reviewers responded — synthesize and decide next action.
     */
    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      // Separate accepted and rejected responses (spec-21 sync rejection)
      const acceptedResponses = responses.filter((r) => !r.rejected);
      const rejectedResponses = responses.filter((r) => r.rejected);

      // Parse reviewer responses (only from accepted submissions)
      const reviewerResults = acceptedResponses.map((r) => ({
        agentId: r.agentId,
        ...parseReviewerResponse(r.response),
      }));

      // Store raw reviewer feedback for the implementer prompt (only accepted)
      state.latestReviewerFeedback = acceptedResponses.map((r) => {
        const p = ctx.participants.find((a) => a.agentId === r.agentId);
        return `### ${p?.displayName || r.agentId}\n${r.response}`;
      }).join('\n\n');

      // Log rejected submissions in the turn log with rejection metadata (spec-21)
      for (const r of rejectedResponses) {
        const p = ctx.participants.find((a) => a.agentId === r.agentId);
        const raw = r.response || '';
        state.turnLog.push({
          cycle: state.currentCycle,
          role: 'reviewer',
          agent: p?.displayName || r.agentId,
          content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
            ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
            : raw,
          rejected: true,
          rejectionReason: r.rejectionReason || 'unknown',
          observedRevision: r.observedRevision || null,
          authoritativeRevision: r.authoritativeRevision || null,
        });
        // Update reviewer sync status for rejected submissions
        const rs = state.reviewerStates.find((s) => s.agentId === r.agentId);
        if (rs) {
          rs.lastObservedRevision = r.observedRevision || null;
          rs.lastSyncStatus = r.rejectionReason === 'revision_mismatch' ? 'mismatch' : 'error';
        }
      }

      // Log accepted reviewer responses for final report (truncate to cap memory).
      // Include observedRevision from sync evidence when available.
      for (const r of acceptedResponses) {
        const p = ctx.participants.find((a) => a.agentId === r.agentId);
        const raw = r.response || '';
        const turnEntry = {
          cycle: state.currentCycle,
          role: 'reviewer',
          agent: p?.displayName || r.agentId,
          content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
            ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
            : raw,
        };
        // Attach observed revision from response (sync evidence)
        if (r.observedRevision) {
          turnEntry.observedRevision = r.observedRevision;
        }
        state.turnLog.push(turnEntry);

        // Update reviewer state with sync evidence
        const rs = state.reviewerStates.find((s) => s.agentId === r.agentId);
        if (rs && r.observedRevision) {
          rs.lastObservedRevision = r.observedRevision;
        }
      }

      // Build this cycle's issue list from reviewer responses.
      // Skip synthesis when all reviewers report zero issues — nothing to consolidate,
      // and LLM hallucinations here can re-open resolved issues and block convergence.
      const totalNewIssues = reviewerResults.reduce((n, rr) => n + rr.issues.length, 0);
      let updatedIssues;

      if (totalNewIssues > 0 && reviewerResults.length > 1) {
        // Synthesize: consolidate overlapping issues from multiple reviewers
        const synthesisResult = await ctx.invokeLLM(
          buildSynthesisPrompt(reviewerResults),
          {
            purpose: 'synthesis',
            allow_tool_use: true,
            permission_profile_override: 'read-only',
          },
        );

        if (synthesisResult.ok && synthesisResult.text) {
          const parsed = parseSynthesisResponse(synthesisResult.text, state.currentCycle);
          if (parsed) {
            updatedIssues = parsed.consolidated_issues;
          }
        }
      }

      // Fallback: merge issues without synthesis
      if (!updatedIssues) {
        updatedIssues = [];
        let issueId = 0;
        for (const rr of reviewerResults) {
          for (const issue of rr.issues) {
            updatedIssues.push({
              ...issue,
              id: `issue_c${state.currentCycle}_${issueId++}`,
              source_reviewers: [rr.agentId],
            });
          }
        }
      }

      // Merge issues: preserve the full issue history across cycles.
      //
      // 1. Previously-open issues absent from the new set are implicitly
      //    resolved (reviewers didn't re-report them → they're fixed).
      // 2. Previously-resolved issues are always carried forward.
      // 3. New issues from synthesis/fallback are added.
      const newById = new Map(updatedIssues.map((i) => [i.id, i]));

      // Stamp resolvedInCycle on newly resolved issues from synthesis
      for (const issue of updatedIssues) {
        if (issue.status === 'resolved' && issue.resolvedInCycle == null) {
          issue.resolvedInCycle = state.currentCycle;
        }
      }

      // Carry forward all previous issues that aren't in the new set
      for (const prev of state.issues) {
        if (newById.has(prev.id)) continue; // new set has a fresh version
        if (prev.status === 'open') {
          // Implicitly resolved — reviewers didn't re-report it
          prev.status = 'resolved';
          if (prev.resolvedInCycle == null) prev.resolvedInCycle = state.currentCycle;
        }
        updatedIssues.push(prev);
      }
      state.issues = updatedIssues;

      // Update reviewer phases.
      // On parseError, treat as 0 issues — the reviewer responded but didn't
      // format as JSON.  Freezing the phase here causes infinite re-review
      // loops when the reviewer gives a prose "all clear" response.
      for (const rr of reviewerResults) {
        const rs = state.reviewerStates.find((s) => s.agentId === rr.agentId);
        if (rs) {
          const issueCount = rr.parseError ? 0 : rr.issues.length;
          rs.lastIssueCount = issueCount;
          rs.phase = nextReviewerPhase(rs.phase, issueCount);
        }
      }

      // Mirror sync status into reviewer state for spec-21 contract extension
      if (ctx.syncState && Array.isArray(ctx.syncState.reviewerRevisions)) {
        for (const rr of ctx.syncState.reviewerRevisions) {
          const rs = state.reviewerStates.find((s) => s.agentId === rr.reviewerId);
          if (rs) {
            rs.lastSyncStatus = rr.status || null;
          }
        }
      }

      // Record cycle snapshot (with per-severity breakdown for trend chart)
      const openForHistory = updatedIssues.filter((i) => i.status === 'open');
      const cycleEntry = {
        cycle: state.currentCycle,
        issueCount: openForHistory.length,
        p1: openForHistory.filter((i) => i.severity === 'critical').length,
        p2: openForHistory.filter((i) => i.severity === 'major').length,
        p3: openForHistory.filter((i) => i.severity === 'minor').length,
        p4: openForHistory.filter((i) => i.severity === 'nit').length,
        reviewerPhases: state.reviewerStates.map((r) => ({
          agentId: r.agentId,
          phase: r.phase,
        })),
      };

      // Attach sync evidence from room syncState if available (spec-21)
      const syncState = ctx.syncState;
      if (syncState && syncState.authoritativeRevision) {
        cycleEntry.authoritativeRevision = syncState.authoritativeRevision;
        cycleEntry.syncMode = syncState.mode || null;
        cycleEntry.syncDurationMs = syncState.syncDurationMs || 0;
        cycleEntry.syncOverride = !!(syncState.override);
        cycleEntry.reviewerRevisionEvidence = (syncState.reviewerRevisions || []).map((rr) => ({
          agentId: rr.reviewerId,
          observedRevision: rr.revision || null,
          status: rr.status || 'unknown',
        }));
      }

      state.cycleHistory.push(cycleEntry);

      // Emit metrics (keyed by manifest panel keys — F8 contract)
      const openIssues = updatedIssues.filter((i) => i.status === 'open');
      const resolvedCount = updatedIssues.filter((i) => i.status === 'resolved').length;

      // F10: severity-to-counter mapping
      const p1Open = openIssues.filter((i) => i.severity === 'critical').length;
      const p2Open = openIssues.filter((i) => i.severity === 'major').length;
      const p3Open = openIssues.filter((i) => i.severity === 'minor').length;

      // Build convergence trend from cycle history (per-severity breakdown)
      const trendLabels = state.cycleHistory.map((h) => `C${h.cycle}`);
      const trendP1 = state.cycleHistory.map((h) => h.p1 || 0);
      const trendP2 = state.cycleHistory.map((h) => h.p2 || 0);
      const trendP3 = state.cycleHistory.map((h) => h.p3 || 0);
      const trendP4 = state.cycleHistory.map((h) => h.p4 || 0);

      ctx.emitMetrics({
        issueSummary: { p1Open, p2Open, p3Open, totalResolved: resolvedCount },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
        currentPhase: { active: 'synthesizing' },
        convergenceTrend: {
          labels: trendLabels,
          series: { p1: trendP1, p2: trendP2, p3: trendP3, p4: trendP4 },
        },
        reviewerStatus: Object.fromEntries(
          state.reviewerStates.map((r) => {
            const p = ctx.participants.find((a) => a.agentId === r.agentId);
            return [p?.displayName || r.agentId, r.phase];
          }),
        ),
        issueLog: {
          rows: state.issues.map((issue) => ({
            id: issue.id,
            severity: issue.severity,
            title: issue.title,
            reportedBy: (issue.source_reviewers || [])
              .map((id) => {
                const p = ctx.participants.find((a) => a.agentId === id);
                return p?.displayName || id;
              })
              .join(', '),
            status: issue.status,
            resolvedInCycle: issue.resolvedInCycle != null ? `C${issue.resolvedInCycle}` : null,
          })),
        },
        turnLog: { entries: state.turnLog },
      });

      ctx.setState(state);

      // Check convergence
      const convergence = evaluateConvergence(state);
      if (convergence) {
        return {
          type: DECISION_TYPES.STOP,
          reason: convergence,
        };
      }

      // Check cycle limit
      if (state.currentCycle >= state.maxCycles) {
        return {
          type: DECISION_TYPES.STOP,
          reason: STOP_REASON.CYCLE_LIMIT,
        };
      }

      // Open issues remain — send to implementer
      if (openIssues.length === 0) {
        // No open issues but not all reviewers done — clean review pass
        const activeReviewers = state.reviewerStates.filter(
          (r) => r.phase !== REVIEWER_PHASES.DONE && r.phase !== REVIEWER_PHASES.WITHDRAWN,
        );
        ctx.emitMetrics({ currentPhase: { active: 'reviewing' } });
        return {
          type: DECISION_TYPES.FAN_OUT,
          targets: activeReviewers.map((r) => {
            const participant = ctx.participants.find((p) => p.agentId === r.agentId);
            return {
              agentId: r.agentId,
              message: buildCleanReviewPrompt(
                ctx.objective,
                participant?.displayName || r.agentId,
                state.latestImplementation,
                handoffPromptContext,
              ) + wsCtx,
            };
          }),
        };
      }

      ctx.emitMetrics({ currentPhase: { active: 'implementing' } });

      return {
        type: DECISION_TYPES.SPEAK,
        agentId: state.implementerId,
        message: buildImplementerPrompt(
          ctx.objective,
          openIssues,
          state.latestReviewerFeedback,
          handoffPromptContext,
        ) + wsCtx,
      };
    },

    /**
     * Implementer responded — increment cycle, fan-out to active reviewers.
     */
    onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      // Log implementer response for final report (truncate to cap memory)
      const implParticipant = ctx.participants.find((a) => a.agentId === state.implementerId);
      const rawImpl = turnResult.response || '';
      state.turnLog.push({
        cycle: state.currentCycle,
        role: 'implementer',
        agent: implParticipant?.displayName || state.implementerId,
        content: rawImpl.length > TURN_LOG_MAX_CONTENT_LENGTH
          ? rawImpl.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
          : rawImpl,
      });

      state.latestImplementation = turnResult.response;
      state.currentCycle += 1;
      ctx.setCycle(state.currentCycle);

      ctx.emitMetrics({
        currentPhase: { active: 'reviewing' },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
        turnLog: { entries: state.turnLog },
      });

      ctx.setState(state);

      // No cycle-limit check here — always let reviewers do one final pass
      // after the implementer's fixes so issue statuses get properly updated
      // (resolved vs still open). The cycle limit is enforced in
      // onFanOutComplete after the issue merge logic runs.

      // Fan-out to active reviewers for re-review
      const activeReviewers = state.reviewerStates.filter(
        (r) => r.phase !== REVIEWER_PHASES.DONE && r.phase !== REVIEWER_PHASES.WITHDRAWN,
      );

      if (activeReviewers.length === 0) {
        // All reviewers done or withdrawn — evaluate convergence
        const convergence = evaluateConvergence(state);
        if (convergence) {
          return { type: DECISION_TYPES.STOP, reason: convergence };
        }
        return { type: DECISION_TYPES.PAUSE };
      }

      const openIssues = state.issues.filter((i) => i.status === 'open');

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: activeReviewers.map((r) => {
          const participant = ctx.participants.find((p) => p.agentId === r.agentId);
          return {
            agentId: r.agentId,
            message: buildReReviewPrompt(
              ctx.objective,
              participant?.displayName || r.agentId,
              openIssues,
              state.latestImplementation,
              handoffPromptContext,
            ) + wsCtx,
          };
        }),
      };
    },

    /**
     * Handle room events (participant disconnect, user edits).
     */
    onEvent(ctx, event) {
      const state = ctx.getState();

      if (event.type === 'participant_disconnected' && event.agentId) {
        const rs = state.reviewerStates.find((s) => s.agentId === event.agentId);
        if (rs) {
          rs.phase = REVIEWER_PHASES.WITHDRAWN;
          ctx.setState(state);
        }
      }

      if (event.type === 'user_edit_state' && event.edits) {
        // Delta edits: apply changes by issue ID to preserve full metadata
        if (Array.isArray(event.edits.issueEdits)) {
          for (const edit of event.edits.issueEdits) {
            const issue = state.issues.find((i) => i.id === edit.id);
            if (!issue) continue;
            if (edit.severity) issue.severity = edit.severity;
            if (edit.status) {
              issue.status = edit.status;
              if (edit.status === 'resolved' && issue.resolvedInCycle == null) {
                issue.resolvedInCycle = state.currentCycle;
              }
            }
          }
          ctx.setState(state);
        }
        // Legacy: full replacement (backwards compat)
        if (Array.isArray(event.edits.issues)) {
          state.issues = event.edits.issues;
          ctx.setState(state);
        }
      }
    },

    /**
     * Regenerate a pending decision's message content using current state.
     * Called by the runtime after editRoomState when a pendingDecision exists,
     * so that approved decisions reflect the user's edits.
     */
    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      const openIssues = state.issues.filter((i) => i.status === 'open');
      const wsCtx = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      if (pendingDecision.type === DECISION_TYPES.SPEAK) {
        return {
          ...pendingDecision,
          message: buildImplementerPrompt(
            ctx.objective,
            openIssues,
            state.latestReviewerFeedback,
            handoffPromptContext,
          ) + wsCtx,
        };
      }

      if (pendingDecision.type === DECISION_TYPES.FAN_OUT && Array.isArray(pendingDecision.targets)) {
        return {
          ...pendingDecision,
          targets: pendingDecision.targets.map((t) => {
            const participant = ctx.participants.find((p) => p.agentId === t.agentId);
            return {
              ...t,
              message: buildReReviewPrompt(
                ctx.objective,
                participant?.displayName || t.agentId,
                openIssues,
                state.latestImplementation,
                handoffPromptContext,
              ) + wsCtx,
            };
          }),
        };
      }

      return pendingDecision;
    },

    /**
     * Cleanup on shutdown.
     */
    shutdown(_ctx) {
      // No cleanup needed for in-process plugin
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      const handoffPayloads = [];

      if (state) {
        handoffPayloads.push(buildReviewFindingsPayload(ctx, state));
      }

      handoffPayloads.push(...collectReviewCyclePassThroughPayloads(ctx));

      return {
        handoffPayloads,
        artifacts: [],
      };
    },
  };
}

// Export internals for testing
export {
  parseReviewerResponse,
  parseSynthesisResponse,
  nextReviewerPhase,
  evaluateConvergence,
  buildInitialReviewPrompt,
  buildReReviewPrompt,
  buildCleanReviewPrompt,
  buildImplementerPrompt,
  buildSynthesisPrompt,
};
