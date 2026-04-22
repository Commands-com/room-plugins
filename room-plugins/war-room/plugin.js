// ---------------------------------------------------------------------------
// War Room Orchestrator Plugin — multi-agent task coordination (entry file).
//
// An orchestrator LLM discovers worker capabilities, decomposes the
// objective into tasks, dispatches them in parallel / sequentially, and
// reviews results between rounds. This file is the slim factory that wires
// together the modules under ./war-room/ into a plugin descriptor.
//
// Module graph:
//   war-room/manifest         — PLUGIN_ID, MANIFEST, size constants
//   war-room/handoff-context  — inbound spec/review payload context builder
//   war-room/config           — room-config accessors (elasticWorkers, ...)
//   war-room/workers          — capability records + assignability helpers
//   war-room/plan-validation  — validate planner output
//   war-room/dispatch         — select dispatchable tasks + metadata
//   war-room/task-result      — apply parsed worker result into a task
//   war-room/decision         — buildDecision / wrapForSemiAuto / regenerate
//   war-room/metrics          — emitBoardMetrics
//   war-room/edits            — applyTaskBoardEdits
//   war-room/orchestrator-review — between-rounds LLM review pass
//   war-room/phase-handlers   — discovery/planning/execution handlers
//   war-room/final-report     — implementation_bundle.v1 assembly
//
// This file is pure decision wiring — no Electron deps, no I/O, no timeouts.
// The room runtime owns all enforcement (limits, retries, fan-out, quorum).
// ---------------------------------------------------------------------------

import {
  DECISION_TYPES,
  AGENT_ROLES,
} from '../core-room-support/room-contracts.js';
import { validateWarRoomStateEdit } from './war-room-state.js';
import { buildDiscoveryPrompt } from './war-room-prompts.js';
import { MANIFEST, PLUGIN_ID } from './war-room/manifest.js';
import { buildInboundPromptContext, mergePromptContexts } from './war-room/handoff-context.js';
import { buildWorkerCapability } from './war-room/workers.js';
import { emitBoardMetrics } from './war-room/metrics.js';
import { applyTaskBoardEdits } from './war-room/edits.js';
import { regenerateDispatch } from './war-room/decision.js';
import {
  handleDiscoveryComplete,
  handleExecutionFanOutComplete,
  handleSingleTaskResult,
} from './war-room/phase-handlers.js';
import { buildImplementationBundleReport } from './war-room/final-report.js';

export default function createWarRoomPlugin(opts = {}) {
  const domainContext = opts.domainContext || '';

  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    init(ctx) {
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);

      ctx.setState({
        phase: 'discovery',
        handoffPromptContext: buildInboundPromptContext(ctx.handoffContext),
        workerCapabilities: Object.fromEntries(
          workers.map((w) => [w.agentId, buildWorkerCapability(w)]),
        ),
        taskBoard: [],
        currentCycle: 0,
        blockedPauseIssued: false,
        pendingFanOut: null,
        pendingCapacityRequests: [],
        turnLog: [],
        nextTaskId: 1,
      });
    },

    onRoomStart(ctx) {
      const state = ctx.getState();
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      const effectiveDomainContext = mergePromptContexts(domainContext, state?.handoffPromptContext || '');

      ctx.emitMetrics({
        currentPhase: { active: 'discovery' },
        workerStatus: Object.fromEntries(
          workers.map((w) => [w.displayName, 'discovering']),
        ),
      });

      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: workers.map((w) => ({
          agentId: w.agentId,
          message: buildDiscoveryPrompt(ctx.objective, effectiveDomainContext),
        })),
      };
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();

      if (state.phase === 'discovery') {
        return await handleDiscoveryComplete(ctx, state, responses, domainContext);
      }
      if (state.phase === 'executing') {
        return await handleExecutionFanOutComplete(ctx, state, responses);
      }
      return null;
    },

    async onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      if (state.phase !== 'executing') return null;
      return await handleSingleTaskResult(ctx, state, turnResult);
    },

    onResume(ctx) {
      const state = ctx.getState();
      if (state.pendingFanOut) {
        const decision = state.pendingFanOut;
        state.pendingFanOut = null;
        ctx.setState(state);
        return decision;
      }
      return null;
    },

    onEvent(ctx, event) {
      const state = ctx.getState();

      if (event.type === 'participant_disconnected' && event.agentId) {
        const cap = state.workerCapabilities[event.agentId];
        if (cap) {
          cap.available = false;
          for (const task of state.taskBoard) {
            if (task.assignedTo === event.agentId && task.status === 'pending') {
              if (cap.temporary) {
                task.assignedTo = null;
                task.unassignedReason = 'replica_failed';
                task.unassignedDetails = `Temporary replica ${event.agentId} disconnected`;
              } else {
                task.status = 'blocked';
                task.blockedReason = `Worker ${event.agentId} disconnected`;
              }
            }
          }
          ctx.setState(state);
        }
      }

      if (event.type === 'elastic_workers_materialized') {
        const grantedReplicaIds = Array.isArray(event.grantedReplicaIds) ? event.grantedReplicaIds : [];
        const placeholderMap = event.placeholderMap && typeof event.placeholderMap === 'object'
          ? event.placeholderMap
          : {};
        const deniedPlaceholders = event.deniedPlaceholders && typeof event.deniedPlaceholders === 'object'
          ? event.deniedPlaceholders
          : {};

        for (const replicaId of grantedReplicaIds) {
          const participant = ctx.participants.find((p) => p.agentId === replicaId);
          if (!participant) continue;
          state.workerCapabilities[replicaId] = buildWorkerCapability(participant);
        }

        for (const task of state.taskBoard) {
          const assignedTo = typeof task.assignedTo === 'string' ? task.assignedTo.trim() : '';
          if (!assignedTo) continue;
          if (placeholderMap[assignedTo]) {
            task.assignedTo = placeholderMap[assignedTo];
            task.unassignedReason = null;
            task.unassignedDetails = null;
            continue;
          }
          if (deniedPlaceholders[assignedTo]) {
            task.assignedTo = null;
            if (task.status === 'in_progress') task.status = 'pending';
            task.unassignedReason = deniedPlaceholders[assignedTo].reason || 'replica_not_granted';
            task.unassignedDetails = deniedPlaceholders[assignedTo].details || null;
          }
        }

        state.pendingCapacityRequests = [];
        ctx.setState(state);
        emitBoardMetrics(ctx, state);
      }

      if (event.type === 'user_edit_state' && event.edits) {
        const availableWorkerIds = Object.entries(state.workerCapabilities)
          .filter(([, cap]) => cap.available !== false)
          .map(([id]) => id);

        const validation = validateWarRoomStateEdit(event.edits, state.taskBoard, availableWorkerIds);
        if (!validation.valid) {
          throw new Error(`Invalid state edit: ${validation.errors.join('; ')}`);
        }

        applyTaskBoardEdits(state, event.edits);

        state.blockedPauseIssued = false;

        // Refresh plugin-owned pending FAN_OUT (semi_auto). buildDecision
        // marked dispatched tasks in_progress but the runtime hasn't sent
        // them yet; revert them to pending so regenerateDispatch (which
        // uses getReadyTasks on pending tasks) rebuilds correctly.
        if (state.pendingFanOut) {
          const queuedAgentIds = new Set(
            state.pendingFanOut.targets
              ? state.pendingFanOut.targets.map((t) => t.agentId)
              : state.pendingFanOut.agentId ? [state.pendingFanOut.agentId] : [],
          );
          for (const task of state.taskBoard) {
            if (task.status === 'in_progress' && queuedAgentIds.has(task.assignedTo)) {
              task.status = 'pending';
            }
          }
          state.pendingFanOut = regenerateDispatch(ctx, state);
        }

        ctx.setState(state);
        emitBoardMetrics(ctx, state);
      }
    },

    refreshPendingDecision(ctx, pendingDecision) {
      const state = ctx.getState();
      if (state.phase !== 'executing') return pendingDecision;
      const fresh = regenerateDispatch(ctx, state);
      return fresh || pendingDecision;
    },

    shutdown(ctx) {
      const state = ctx.getState();
      state.phase = 'complete';
      emitBoardMetrics(ctx, state);
      ctx.setState(state);
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) {
        return {
          handoffPayloads: [],
          artifacts: [],
        };
      }

      const { payload, artifacts } = buildImplementationBundleReport(ctx, state);
      return {
        handoffPayloads: [payload],
        artifacts,
      };
    },
  };
}

// Re-export prompts/parsers so existing test imports keep working.
export {
  buildDiscoveryPrompt,
  buildPlanningPrompt,
  buildTaskContext,
  buildTaskAssignmentPrompt,
  buildResultProcessingPrompt,
  buildCompletionPrompt,
  parseDiscoveryResponse,
  parsePlanningResponse,
  parseTaskResponse,
  parseResultProcessingResponse,
  applyResultProcessing,
} from './war-room-prompts.js';

// Export internals for testing.
export { validatePlan } from './war-room/plan-validation.js';
export {
  deduplicateByWorker,
  getReadyTasks,
} from './war-room/dispatch.js';
export { buildDecision } from './war-room/decision.js';
export { applyTaskBoardEdits } from './war-room/edits.js';
export { buildInboundPromptContext } from './war-room/handoff-context.js';
