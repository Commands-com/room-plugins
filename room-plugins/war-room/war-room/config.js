// ---------------------------------------------------------------------------
// Room-config accessors. Each lookup applies sensible defaults when the
// caller omits the key, so decision logic can treat the config as always
// populated. The manifest declares these in roomConfigSchema; this module
// is the single place to read them.
// ---------------------------------------------------------------------------

export function useElasticWorkers(ctx) {
  return ctx?.roomConfig?.elasticWorkers === true;
}

export function getMaxDynamicWorkers(ctx) {
  const configured = Number(ctx?.roomConfig?.maxDynamicWorkers);
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return 0;
}

export function getMaxReplicasPerWorker(ctx) {
  const configured = Number(ctx?.roomConfig?.maxReplicasPerWorker);
  if (Number.isInteger(configured) && configured >= 1) return configured;
  return 1;
}

export function getMaxParallelWrites(ctx) {
  const configured = Number(ctx?.roomConfig?.maxParallelWrites);
  if (Number.isInteger(configured) && configured >= 1) return configured;
  return 1;
}

export function useIsolatedWriteWorktrees(ctx) {
  return ctx?.roomConfig?.isolatedWriteWorktrees !== false;
}
