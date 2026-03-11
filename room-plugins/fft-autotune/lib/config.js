import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULTS } from './constants.js';
import {
  buildDefaultOutputDir,
  clampInt,
  isPowerOfTwo,
  isSafeSubpath,
  normalizeNumberArray,
  normalizeStringArray,
  safeTrim,
} from './utils.js';

export function normalizeRoomConfig(input = {}) {
  const workspacePath = safeTrim(input.workspacePath || '', 4000);
  const targetSizes = normalizeNumberArray(input.targetSizes, 32).map((size) => Math.floor(size));
  const targetArch = safeTrim(input.targetArch || DEFAULTS.targetArch, 200) || DEFAULTS.targetArch;
  const candidateLanguage = safeTrim(input.candidateLanguage || DEFAULTS.candidateLanguage, 20) || DEFAULTS.candidateLanguage;
  const compilerCommand = safeTrim(input.compilerCommand || DEFAULTS.compilerCommand, 400) || DEFAULTS.compilerCommand;
  const compilerFlags = normalizeStringArray(input.compilerFlags || DEFAULTS.compilerFlags, 32);
  const benchmarkCommand = safeTrim(input.benchmarkCommand || '', 400);
  const sourceContextPaths = normalizeStringArray(input.sourceContextPaths || [], 10);
  const outputDirInput = safeTrim(input.outputDir || DEFAULTS.outputDir, 4000);
  const outputDir = workspacePath
    ? path.resolve(workspacePath, outputDirInput)
    : outputDirInput;

  return {
    workspacePath,
    targetSizes,
    targetArch,
    candidateLanguage,
    sourceContextPaths,
    compilerCommand,
    compilerFlags,
    benchmarkCommand,
    outputDir,
  };
}

export function getConfig(ctx) {
  const roomConfig = normalizeRoomConfig(ctx?.roomConfig || {});
  return {
    plannedCandidatesPerCycle: clampInt(ctx?.orchestratorConfig?.plannedCandidatesPerCycle, 1, 24, DEFAULTS.plannedCandidatesPerCycle),
    promoteTopK: clampInt(ctx?.orchestratorConfig?.promoteTopK, 1, 8, DEFAULTS.promoteTopK),
    validationSamples: clampInt(ctx?.orchestratorConfig?.validationSamples, 1, 512, DEFAULTS.validationSamples),
    benchmarkWarmups: clampInt(ctx?.orchestratorConfig?.benchmarkWarmups, 1, 50, DEFAULTS.benchmarkWarmups),
    benchmarkTrials: clampInt(ctx?.orchestratorConfig?.benchmarkTrials, 5, 200, DEFAULTS.benchmarkTrials),
    maxRetestCandidates: clampInt(ctx?.orchestratorConfig?.maxRetestCandidates, 1, 5, DEFAULTS.maxRetestCandidates),
    plateauCycles: clampInt(ctx?.orchestratorConfig?.plateauCycles, 1, 5, DEFAULTS.plateauCycles),
    targetImprovementPct: Number.isFinite(Number(ctx?.orchestratorConfig?.targetImprovementPct))
      ? Math.max(0, Math.min(200, Number(ctx.orchestratorConfig.targetImprovementPct)))
      : DEFAULTS.targetImprovementPct,
    maxAuditFindingsPerCandidate: clampInt(ctx?.orchestratorConfig?.maxAuditFindingsPerCandidate, 0, 20, DEFAULTS.maxAuditFindingsPerCandidate),
    maxCandidatesPerFamily: clampInt(ctx?.orchestratorConfig?.maxCandidatesPerFamily, 1, 8, DEFAULTS.maxCandidatesPerFamily),
    ...roomConfig,
  };
}

function checkCommandAvailability(commandText) {
  const command = safeTrim(commandText, 200);
  if (!command) {
    return { ok: false, message: 'compilerCommand must be a non-empty string if provided' };
  }
  const executable = command.split(/\s+/)[0];
  try {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf-8', timeout: 3000 });
    if (result.error) {
      return { ok: false, message: `compiler command '${executable}' is not available` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: `compiler command '${executable}' is not available` };
  }
}

export function buildCompatibilityReport(config, localAgentProfileIds = []) {
  const good = [];
  const missing = [];
  const warnings = [];
  const hardFailures = [];

  if (!config.workspacePath) {
    hardFailures.push({
      id: 'workspace_path_missing',
      label: 'Workspace Path',
      details: 'workspacePath is required and must be an existing directory',
    });
  } else if (!fs.existsSync(config.workspacePath) || !fs.statSync(config.workspacePath).isDirectory()) {
    hardFailures.push({
      id: 'workspace_path_invalid',
      label: 'Workspace Path',
      details: 'workspacePath is required and must be an existing directory',
    });
  } else {
    good.push({
      id: 'workspace_path',
      label: 'Workspace Path',
      details: config.workspacePath,
    });
  }

  if (config.targetSizes.length === 0 || !config.targetSizes.every(isPowerOfTwo)) {
    hardFailures.push({
      id: 'target_sizes_invalid',
      label: 'Target Sizes',
      details: 'targetSizes must be an array of power-of-two integers between 2 and 16384',
    });
  } else {
    good.push({
      id: 'target_sizes',
      label: 'Target Sizes',
      details: config.targetSizes.join(', '),
    });
  }

  if (config.targetArch !== 'apple_silicon_neon') {
    hardFailures.push({
      id: 'target_arch_invalid',
      label: 'Target Architecture',
      details: "targetArch must be 'apple_silicon_neon' in v1",
    });
  } else {
    good.push({
      id: 'target_arch',
      label: 'Target Architecture',
      details: config.targetArch,
    });
  }

  if (config.candidateLanguage !== 'c') {
    hardFailures.push({
      id: 'candidate_language_invalid',
      label: 'Candidate Language',
      details: "candidateLanguage must be 'c' in v1",
    });
  } else {
    good.push({
      id: 'candidate_language',
      label: 'Candidate Language',
      details: config.candidateLanguage,
    });
  }

  if (!Array.isArray(config.compilerFlags) || config.compilerFlags.some((flag) => !safeTrim(flag, 200))) {
    hardFailures.push({
      id: 'compiler_flags_invalid',
      label: 'Compiler Flags',
      details: 'compilerFlags must be an array of compiler flags',
    });
  } else {
    good.push({
      id: 'compiler_flags',
      label: 'Compiler Flags',
      details: config.compilerFlags.join(' '),
    });
  }

  const compilerCheck = checkCommandAvailability(config.compilerCommand);
  if (!compilerCheck.ok) {
    hardFailures.push({
      id: 'compiler_missing',
      label: 'Compiler Command',
      details: compilerCheck.message,
    });
  } else {
    good.push({
      id: 'compiler_command',
      label: 'Compiler Command',
      details: config.compilerCommand,
    });
  }

  if (config.workspacePath) {
    if (!isSafeSubpath(config.workspacePath, config.outputDir)) {
      hardFailures.push({
        id: 'output_dir_unsafe',
        label: 'Output Directory',
        details: 'outputDir must resolve to a writable workspace-safe directory',
      });
    } else if (fs.existsSync(config.outputDir)) {
      good.push({
        id: 'output_dir',
        label: 'Output Directory',
        details: config.outputDir,
      });
    } else {
      missing.push({
        id: 'output_dir_missing',
        label: 'Output Directory',
        details: `${config.outputDir} does not exist yet`,
      });
    }
  }

  if (config.sourceContextPaths.length > 0) {
    const invalidPath = config.sourceContextPaths.find((sourcePath) => {
      const resolved = path.resolve(config.workspacePath, sourcePath);
      return !isSafeSubpath(config.workspacePath, resolved) || !fs.existsSync(resolved);
    });
    if (invalidPath) {
      hardFailures.push({
        id: 'source_context_invalid',
        label: 'Source Context Paths',
        details: 'sourceContextPaths must be an array of up to 10 readable file paths',
      });
    } else {
      good.push({
        id: 'source_context_paths',
        label: 'Source Context Paths',
        details: config.sourceContextPaths.join(', '),
      });
    }
  } else {
    warnings.push({
      id: 'source_context_paths_empty',
      label: 'Source Context Paths',
      details: 'No sourceContextPaths were provided; discovery will rely on broader workspace search',
    });
  }

  if (config.benchmarkCommand) {
    good.push({
      id: 'benchmark_command',
      label: 'Benchmark Command',
      details: config.benchmarkCommand,
    });
  } else {
    warnings.push({
      id: 'benchmark_command_missing',
      label: 'Benchmark Command',
      details: 'No benchmarkCommand override set; workers must use the built-in harness flow or local scripts they discover',
    });
  }

  if (!Array.isArray(localAgentProfileIds) || localAgentProfileIds.length === 0) {
    warnings.push({
      id: 'local_workers_missing',
      label: 'Local Participant Profiles',
      details: 'No local participant profile IDs were supplied for compatibility context',
    });
  } else {
    good.push({
      id: 'local_workers_present',
      label: 'Local Participant Profiles',
      details: `${localAgentProfileIds.length} local participant profile(s) available`,
    });
  }

  return {
    compatible: hardFailures.length === 0,
    good,
    missing,
    warnings,
    hardFailures,
  };
}

export async function checkCompatibility(payload = {}) {
  const roomConfig = normalizeRoomConfig(payload.roomConfig || payload);
  const report = buildCompatibilityReport(roomConfig, payload.localAgentProfileIds || []);
  return { ok: true, report };
}

export async function makeCompatible(payload = {}) {
  const roomConfig = normalizeRoomConfig(payload.roomConfig || payload);
  const actions = [];
  const errors = [];

  const precheck = buildCompatibilityReport(roomConfig, payload.localAgentProfileIds || []);
  if (precheck.hardFailures.some((failure) => failure.id === 'workspace_path_missing' || failure.id === 'workspace_path_invalid')) {
    return {
      ok: false,
      error: {
        code: 'compatibility_unavailable',
        message: 'workspacePath must exist before output directories can be created',
      },
    };
  }

  try {
    if (!fs.existsSync(roomConfig.outputDir) && isSafeSubpath(roomConfig.workspacePath, roomConfig.outputDir)) {
      fs.mkdirSync(roomConfig.outputDir, { recursive: true });
      actions.push(`Created output directory ${roomConfig.outputDir}`);
    }
  } catch (err) {
    errors.push(err?.message || String(err));
  }

  const report = buildCompatibilityReport(roomConfig, payload.localAgentProfileIds || []);
  return {
    ok: true,
    applied: actions.length > 0,
    actions,
    errors,
    precheck,
    report,
  };
}

export { buildDefaultOutputDir };
