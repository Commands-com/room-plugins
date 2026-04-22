// ---------------------------------------------------------------------------
// Orchestrator review between rounds. Invokes the orchestrator LLM to
// review just-completed tasks and update the task board (descriptions,
// new tasks, removals) before the next dispatch. Skipped when there are
// no completions this cycle or no remaining work.
// ---------------------------------------------------------------------------

import {
  STRUCTURED_ROOM_LLM_OUTPUT_CHARS,
  TURN_LOG_MAX_CONTENT_LENGTH,
} from './manifest.js';
import {
  applyResultProcessing,
  buildResultProcessingPrompt,
  parseResultProcessingResponse,
} from '../war-room-prompts.js';
import { useElasticWorkers } from './config.js';
import { buildCapacityBudget, isAssignableWorkerId } from './workers.js';

export async function invokeResultReview(ctx, state) {
  const recentResults = state.taskBoard.filter(
    (t) => t.completedInCycle === state.currentCycle && (t.status === 'done' || t.status === 'blocked'),
  );
  const hasRemainingWork = state.taskBoard.some(
    (t) => t.status === 'pending' || t.status === 'blocked',
  );

  if (recentResults.length === 0 || !hasRemainingWork) return;

  const availableWorkerIds = Object.entries(state.workerCapabilities)
    .filter(([, cap]) => cap.available !== false)
    .map(([id]) => id);

  const reviewResult = await ctx.invokeLLM(
    buildResultProcessingPrompt(recentResults, state.taskBoard, ctx.objective, {
      elasticWorkers: useElasticWorkers(ctx),
    }),
    {
      purpose: 'synthesis',
      allow_tool_use: true,
      permission_profile_override: 'read-only',
      max_output_chars: STRUCTURED_ROOM_LLM_OUTPUT_CHARS,
    },
  );

  if (!reviewResult.ok || !reviewResult.text) return;

  const review = parseResultProcessingResponse(reviewResult.text);
  if (!review) return;

  applyResultProcessing(state, review, availableWorkerIds, {
    assignmentValidator: (assignedTo) => isAssignableWorkerId(assignedTo, availableWorkerIds, {
      capacityBudget: buildCapacityBudget(review.capacityRequests),
      workerCapabilities: state.workerCapabilities,
    }),
  });
  state.pendingCapacityRequests = Array.isArray(review.capacityRequests) ? review.capacityRequests : [];

  const raw = reviewResult.text || '';
  state.turnLog.push({
    cycle: state.currentCycle,
    role: 'reviewer',
    agent: 'Orchestrator',
    content: raw.length > TURN_LOG_MAX_CONTENT_LENGTH
      ? raw.slice(0, TURN_LOG_MAX_CONTENT_LENGTH) + '\n… [truncated]'
      : raw,
  });
}
