// ---------------------------------------------------------------------------
// UI/UX Testing Plugin — deterministic test/fix/revalidate loop (entry file).
//
// Six-phase orchestration:
//   discovery → scenario_planning → test_writing → test_execution
//            → fix_retry → evaluation → complete
//
// Discovery is UI/UX-specific: asks workers to inventory components, routes,
// test frameworks, selector patterns, and accessibility setup.
//
// Module graph:
//   ui-ux-testing/constants       — PHASES + TURN_LOG_MAX + PLUGIN_ID
//   ui-ux-testing/manifest        — frozen manifest
//   ui-ux-testing/config          — getConfig (orchestratorConfig + roomConfig)
//   ui-ux-testing/handoff-context — inbound spec/impl/review context builder
//   ui-ux-testing/metrics         — emitBoardMetrics + turnLog helpers
//   ui-ux-testing/dispatch        — batch selection + SPEAK/FAN_OUT shape
//   ui-ux-testing/phase-flow      — handlers + transitionTo* helpers
//   ui-ux-testing/final-report    — test_results.v1 assembly
// ---------------------------------------------------------------------------

import {
  AGENT_ROLES,
  DECISION_TYPES,
} from '../core-room-support/room-contracts.js';

import { createUiUxCompatibilityService } from './uiux-compatibility-service.js';
import {
  DOMAIN_CONTEXT,
  buildEvaluationPrompt,
  buildFixPrompt,
  buildScenarioPlanningPrompt,
  buildTestExecutionPrompt,
  buildTestWritingPrompt,
  buildUiUxDiscoveryPrompt,
  parseFixResponse,
  parseScenarioPlanResponse,
  parseTestExecutionResponse,
  parseTestWritingResponse,
  parseUiUxDiscoveryResponse,
} from './uiux-prompts.js';

import { PHASES, PLUGIN_ID } from './ui-ux-testing/constants.js';
import { MANIFEST } from './ui-ux-testing/manifest.js';
import { getConfig } from './ui-ux-testing/config.js';
import {
  buildInboundPromptContext,
  collectPassThroughPayloads,
} from './ui-ux-testing/handoff-context.js';
import { emitBoardMetrics } from './ui-ux-testing/metrics.js';
import {
  handleDiscoveryComplete,
  handleFixRetryComplete,
  handleSingleExecResult,
  handleSingleFixResult,
  handleSingleWriteResult,
  handleTestExecutionComplete,
  handleTestWritingComplete,
} from './ui-ux-testing/phase-flow.js';
import { buildTestResultsReport } from './ui-ux-testing/final-report.js';

export default function createUiUxTestingPlugin() {
  return {
    id: PLUGIN_ID,
    manifest: MANIFEST,

    checkCompatibility(payload, context) {
      const service = createUiUxCompatibilityService(context);
      return service.checkCompatibility({
        targetPath: payload.roomConfig?.targetPath,
        targetRuntime: payload.roomConfig?.targetRuntime,
        harnessCommand: payload.roomConfig?.harnessCommand,
        testPersonas: payload.roomConfig?.testPersonas,
        localAgentProfileIds: payload.localAgentProfileIds,
        workspace: payload.workspace || null,
      });
    },

    makeCompatible(payload, context) {
      const service = createUiUxCompatibilityService(context);
      return service.makeCompatible({
        targetPath: payload.roomConfig?.targetPath,
        targetRuntime: payload.roomConfig?.targetRuntime,
        harnessCommand: payload.roomConfig?.harnessCommand,
        testPersonas: payload.roomConfig?.testPersonas,
        localAgentProfileIds: payload.localAgentProfileIds,
        workspace: payload.workspace || null,
      });
    },

    init(ctx) {
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      ctx.setState({
        phase: PHASES.DISCOVERY,
        handoffPromptContext: buildInboundPromptContext(ctx.handoffContext),
        workerCapabilities: Object.fromEntries(
          workers.map((w) => [w.agentId, { agentId: w.agentId, displayName: w.displayName, available: true }]),
        ),
        scenarios: [],
        nextScenarioId: 1,
        currentCycle: 0,
        retryRound: 0,
        pendingFanOut: null,
        turnLog: [],
        passRate: 0,
        totalPassed: 0,
        totalFailed: 0,
        totalSkipped: 0,
      });
    },

    onRoomStart(ctx) {
      const state = ctx.getState();
      const workers = ctx.participants.filter((p) => p.role === AGENT_ROLES.WORKER);
      const config = getConfig(ctx);
      ctx.emitMetrics({ currentPhase: { active: PHASES.DISCOVERY } });

      const discoveryPrompt = buildUiUxDiscoveryPrompt(ctx.objective, config, state?.handoffPromptContext || '');
      return {
        type: DECISION_TYPES.FAN_OUT,
        targets: workers.map((w) => ({
          agentId: w.agentId,
          message: discoveryPrompt,
        })),
      };
    },

    async onFanOutComplete(ctx, responses) {
      const state = ctx.getState();
      switch (state.phase) {
        case PHASES.DISCOVERY: return await handleDiscoveryComplete(ctx, state, responses);
        case PHASES.TEST_WRITING: return await handleTestWritingComplete(ctx, state, responses);
        case PHASES.TEST_EXECUTION: return await handleTestExecutionComplete(ctx, state, responses);
        case PHASES.FIX_RETRY: return await handleFixRetryComplete(ctx, state, responses);
        default: return null;
      }
    },

    async onTurnResult(ctx, turnResult) {
      const state = ctx.getState();
      switch (state.phase) {
        case PHASES.TEST_WRITING: return await handleSingleWriteResult(ctx, state, turnResult);
        case PHASES.TEST_EXECUTION: return await handleSingleExecResult(ctx, state, turnResult);
        case PHASES.FIX_RETRY: return await handleSingleFixResult(ctx, state, turnResult);
        default: return null;
      }
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
          for (const s of state.scenarios) {
            if (s.assignedTo === event.agentId && ['pending', 'writing', 'written', 'failed', 'running', 'fixing'].includes(s.status)) {
              s.status = 'blocked';
            }
          }
          emitBoardMetrics(ctx, state);
          ctx.setState(state);
        }
      }
    },

    shutdown(ctx) {
      const state = ctx.getState();
      if (state) {
        state.phase = PHASES.COMPLETE;
        emitBoardMetrics(ctx, state);
        ctx.setState(state);
      }
    },

    getFinalReport(ctx) {
      const state = ctx.getState();
      if (!state) {
        return {
          handoffPayloads: [],
          artifacts: [],
        };
      }

      const { payload, artifacts } = buildTestResultsReport(ctx, state);
      return {
        handoffPayloads: [payload, ...collectPassThroughPayloads(ctx.handoffContext)],
        artifacts,
      };
    },
  };
}

// Re-exports for tests (stable contract for test/ui-ux-testing-plugin.test.js).
export {
  PHASES,
  DOMAIN_CONTEXT,
  buildInboundPromptContext,
  buildUiUxDiscoveryPrompt,
  parseUiUxDiscoveryResponse,
  parseScenarioPlanResponse,
  parseTestWritingResponse,
  parseTestExecutionResponse,
  parseFixResponse,
  buildScenarioPlanningPrompt,
  buildTestWritingPrompt,
  buildTestExecutionPrompt,
  buildFixPrompt,
  buildEvaluationPrompt,
  getConfig,
};
