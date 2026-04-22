// ---------------------------------------------------------------------------
// Worker capability + assignability helpers. buildWorkerCapability creates
// the capability record stored in state.workerCapabilities. The assignability
// helpers handle both real agent IDs and the "replica placeholder" IDs
// emitted by the planner when it asks the runtime for extra replicas.
// ---------------------------------------------------------------------------

import { parseReplicaPlaceholder } from '../war-room-prompts.js';

export function buildWorkerCapability(participant, available = true) {
  return {
    agentId: participant.agentId,
    displayName: participant.displayName,
    available,
    temporary: participant.temporary === true,
    replicaOfAgentId: participant.replicaOfAgentId || null,
    endpointType: participant.endpoint?.type || null,
    profileId: participant.endpoint?.profileId || null,
  };
}

export function buildCapacityBudget(capacityRequests) {
  const budget = new Map();
  for (const request of Array.isArray(capacityRequests) ? capacityRequests : []) {
    const sourceAgentId = typeof request?.sourceAgentId === 'string' ? request.sourceAgentId.trim() : '';
    const count = Number(request?.count);
    if (!sourceAgentId || !Number.isInteger(count) || count < 1) continue;
    budget.set(sourceAgentId, (budget.get(sourceAgentId) || 0) + count);
  }
  return budget;
}

export function isAssignableWorkerId(assignedTo, availableWorkerIds, options = {}) {
  if (typeof assignedTo !== 'string' || assignedTo.trim().length === 0) return false;
  if (availableWorkerIds.includes(assignedTo)) return true;
  const placeholder = parseReplicaPlaceholder(assignedTo);
  if (!placeholder) return false;
  const sourceCap = options?.workerCapabilities?.[placeholder.sourceAgentId];
  if (!sourceCap || sourceCap.available === false) return false;
  if (sourceCap.temporary === true || sourceCap.replicaOfAgentId) return false;
  const budget = options?.capacityBudget instanceof Map ? options.capacityBudget : new Map();
  return placeholder.index <= (budget.get(placeholder.sourceAgentId) || 0);
}

export function getWorkerCapabilityForAssignment(state, assignedTo) {
  if (typeof assignedTo !== 'string' || assignedTo.trim().length === 0) return null;
  const direct = state.workerCapabilities[assignedTo];
  if (direct) return direct;
  const placeholder = parseReplicaPlaceholder(assignedTo);
  if (!placeholder) return null;
  return state.workerCapabilities[placeholder.sourceAgentId] || null;
}
