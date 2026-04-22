import {
  DECISION_TYPES,
  AGENT_ROLES,
  STOP_REASON,
} from '../core-room-support/room-contracts.js';

import { PLUGIN_ID, TURN_LOG_MAX_CONTENT_LENGTH } from './constants.js';
import {
  buildWorkspaceContext,
  buildHandoffPromptContext,
} from './prompt-context.js';
import {
  buildInitialReviewPrompt,
  buildReReviewPrompt,
  buildImplementerPrompt,
} from './prompts.js';
import {
  parseReviewerResponse,
  mergeBlockers,
} from './response-parsing.js';
import {
  reviewerStatusForAssessment,
  summarizeAssessmentsByReviewer,
  countGrades,
  buildReviewerFeedbackText,
  buildCurrentGradesSummary,
} from './assessment-model.js';
import {
  collectQualityRoomPassThroughPayloads,
  buildReviewFindingsPayload,
} from './final-report.js';

export default function createQualityRoomPlugin() {
  return {
    id: PLUGIN_ID,

    init(ctx) {
      const participants = ctx.participants || [];
      const implementer = participants.find((participant) => participant.role === AGENT_ROLES.IMPLEMENTER);
      const reviewers = participants.filter((participant) => participant.role === AGENT_ROLES.REVIEWER);

      ctx.setState({
        currentCycle: 1,
        maxCycles: ctx.limits.maxCycles || 5,
        latestImplementation: null,
        latestReviewerFeedback: null,
        latestAssessments: [],
        findings: [],
        reviewerStates: reviewers.map((reviewer) => ({
          agentId: reviewer.agentId,
          displayName: reviewer.displayName,
          status: 'grading',
          lastGrade: null,
          lastCategoryGrades: {},
          lastBlockerCount: 0,
        })),
        cycleHistory: [],
        turnLog: [],
        implementerId: implementer ? implementer.agentId : null,
      });
    },

    onRoomStart(ctx) {
      const state = ctx.getState();
      const reviewers = ctx.participants.filter((participant) => participant.role === AGENT_ROLES.REVIEWER);
      const implementer = ctx.participants.find((participant) => participant.role === AGENT_ROLES.IMPLEMENTER);
      if (!implementer || reviewers.length === 0) {
        return { type: DECISION_TYPES.STOP, reason: 'missing_required_roles:implementer,reviewer' };
      }

      const workspaceContext = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      ctx.emitMetrics({
        currentPhase: { active: 'reviewing' },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
      });

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: reviewers.map((reviewer) => ({
          agentId: reviewer.agentId,
          message: buildInitialReviewPrompt(ctx.objective, reviewer.displayName, handoffPromptContext) + workspaceContext,
        })),
      };
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();
      const workspaceContext = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);
      const acceptedResponses = responses.filter((response) => !response.rejected);
      const rejectedResponses = responses.filter((response) => response.rejected);

      for (const response of rejectedResponses) {
        const participant = ctx.participants.find((entry) => entry.agentId === response.agentId);
        state.turnLog.push({
          cycle: state.currentCycle,
          role: 'reviewer',
          agent: participant?.displayName || response.agentId,
          rejected: true,
          rejectionReason: response.rejectionReason || 'unknown',
          content: '',
        });
      }

      const assessments = acceptedResponses.map((response) => {
        const participant = ctx.participants.find((entry) => entry.agentId === response.agentId);
        const parsed = parseReviewerResponse(response.response);
        state.turnLog.push({
          cycle: state.currentCycle,
          role: 'reviewer',
          agent: participant?.displayName || response.agentId,
          content: (response.response || '').length > TURN_LOG_MAX_CONTENT_LENGTH
            ? response.response.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
            : response.response || '',
        });
        return {
          agentId: response.agentId,
          displayName: participant?.displayName || response.agentId,
          ...parsed,
        };
      });

      state.latestAssessments = assessments;
      state.latestReviewerFeedback = buildReviewerFeedbackText(acceptedResponses, ctx.participants);
      state.findings = mergeBlockers(state.findings, assessments, state.currentCycle);

      for (const reviewerState of state.reviewerStates) {
        const assessment = assessments.find((entry) => entry.agentId === reviewerState.agentId);
        if (!assessment) continue;
        reviewerState.lastGrade = assessment.overall_grade;
        reviewerState.lastCategoryGrades = assessment.category_grades;
        reviewerState.lastBlockerCount = assessment.blockers_to_a.length;
        reviewerState.status = reviewerStatusForAssessment(assessment);
      }

      const openFindings = state.findings.filter((finding) => finding.status === 'open');
      const gradeCounts = countGrades(assessments);

      state.cycleHistory.push({
        cycle: state.currentCycle,
        blockers: openFindings.length,
        ...gradeCounts,
      });

      ctx.emitMetrics({
        qualitySummary: {
          ...gradeCounts,
          blockers: openFindings.length,
        },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
        currentPhase: { active: 'reviewing' },
        reviewerStatus: Object.fromEntries(
          state.reviewerStates.map((reviewer) => [reviewer.displayName, reviewer.status]),
        ),
        gradeLog: { rows: summarizeAssessmentsByReviewer(assessments) },
      });

      ctx.setState(state);

      const activeReviewers = state.reviewerStates.filter((reviewer) => reviewer.status !== 'withdrawn');
      const allA = activeReviewers.length > 0 && activeReviewers.every((reviewer) => reviewer.lastGrade === 'A');
      if (allA && openFindings.length === 0) {
        ctx.emitMetrics({ currentPhase: { active: 'converging' } });
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CONVERGENCE };
      }

      if (state.currentCycle >= state.maxCycles) {
        return { type: DECISION_TYPES.STOP, reason: STOP_REASON.CYCLE_LIMIT };
      }

      ctx.emitMetrics({ currentPhase: { active: 'implementing' } });
      return {
        type: DECISION_TYPES.SPEAK,
        agentId: state.implementerId,
        message: buildImplementerPrompt(
          ctx.objective,
          openFindings,
          state.latestReviewerFeedback,
          buildCurrentGradesSummary(assessments),
          handoffPromptContext,
        ) + workspaceContext,
      };
    },

    onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      const workspaceContext = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);

      const implementer = ctx.participants.find((entry) => entry.agentId === state.implementerId);
      const raw = turnResult.response || '';
      state.turnLog.push({
        cycle: state.currentCycle,
        role: 'implementer',
        agent: implementer?.displayName || state.implementerId,
        content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
          ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
          : raw,
      });

      state.latestImplementation = turnResult.response;
      state.currentCycle += 1;
      ctx.setCycle(state.currentCycle);
      ctx.setState(state);

      ctx.emitMetrics({
        currentPhase: { active: 'reviewing' },
        cycleProgress: { value: state.currentCycle, max: state.maxCycles },
      });

      const activeReviewers = state.reviewerStates.filter((reviewer) => reviewer.status !== 'withdrawn');
      const openFindings = state.findings.filter((finding) => finding.status === 'open');

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: activeReviewers.map((reviewer) => {
          const participant = ctx.participants.find((entry) => entry.agentId === reviewer.agentId);
          return {
            agentId: reviewer.agentId,
            message: buildReReviewPrompt(
              ctx.objective,
              participant?.displayName || reviewer.agentId,
              openFindings,
              state.latestImplementation,
              handoffPromptContext,
            ) + workspaceContext,
          };
        }),
      };
    },

    onEvent(ctx, event) {
      const state = ctx.getState();

      if (event.type === 'participant_disconnected' && event.agentId) {
        const reviewer = state.reviewerStates.find((entry) => entry.agentId === event.agentId);
        if (reviewer) {
          reviewer.status = 'withdrawn';
          ctx.setState(state);
        }
      }
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      const workspaceContext = buildWorkspaceContext(ctx);
      const handoffPromptContext = buildHandoffPromptContext(ctx.handoffContext);
      const openFindings = state.findings.filter((finding) => finding.status === 'open');

      if (pendingDecision.type === DECISION_TYPES.SPEAK) {
        return {
          ...pendingDecision,
          message: buildImplementerPrompt(
            ctx.objective,
            openFindings,
            state.latestReviewerFeedback,
            buildCurrentGradesSummary(state.latestAssessments),
            handoffPromptContext,
          ) + workspaceContext,
        };
      }

      if (pendingDecision.type === DECISION_TYPES.FAN_OUT && Array.isArray(pendingDecision.targets)) {
        return {
          ...pendingDecision,
          targets: pendingDecision.targets.map((target) => {
            const participant = ctx.participants.find((entry) => entry.agentId === target.agentId);
            return {
              ...target,
              message: buildReReviewPrompt(
                ctx.objective,
                participant?.displayName || target.agentId,
                openFindings,
                state.latestImplementation,
                handoffPromptContext,
              ) + workspaceContext,
            };
          }),
        };
      }

      return pendingDecision;
    },

    shutdown() {
      // No cleanup needed.
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      const handoffPayloads = [];
      if (state) handoffPayloads.push(buildReviewFindingsPayload(ctx, state));
      handoffPayloads.push(...collectQualityRoomPassThroughPayloads(ctx));
      return {
        handoffPayloads,
        artifacts: [],
      };
    },
  };
}

export {
  parseReviewerResponse,
  buildInitialReviewPrompt,
  buildReReviewPrompt,
  buildImplementerPrompt,
};
