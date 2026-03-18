/**
 * declarative.test.js — Tests for the declarative room definition (room.yaml)
 * and the manifest compilation pipeline.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roomYamlPath = path.join(__dirname, '..', 'room.yaml');
const manifestJsonPath = path.join(__dirname, '..', 'manifest.json');

// ---------------------------------------------------------------------------
// Helpers — inline the schema validation and manifest builder since they live
// in the desktop app repo (not available as a dependency here)
// ---------------------------------------------------------------------------

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const KNOWN_FAMILIES = new Set(['empirical_search', 'review_loop', 'custom']);
const EMPIRICAL_SEARCH_PREDICATES = new Set([
  'builtNewCandidates', 'schemaRepairNeeded', 'hasMeasuredPromotions',
  'hasAdvisoryOnlyPromotions', 'stopReasonPresent', 'needsRetest',
  'plateauReached', 'noCandidatesProduced',
]);
const EMPIRICAL_SEARCH_FAMILY_KEYS = new Set([
  'strategyTypes', 'measuredStrategyTypes', 'promoteTopK',
  'plannedCandidatesPerCycle', 'maxRetestCandidates', 'plateauCycles',
  'targetImprovementPct', 'supportsSchemaRepair', 'supportsBaselineRetest',
]);

function buildManifestFromDefinition(def) {
  const manifest = {
    id: def.metadata.id,
    name: def.metadata.name,
    version: '1.0.0',
    orchestratorType: def.metadata.orchestratorType,
  };
  if (def.metadata.description) manifest.description = def.metadata.description;
  if (def.supportsQuorum != null) manifest.supportsQuorum = def.supportsQuorum;
  manifest.roles = { required: [...def.roles.required] };
  if (def.roles.optional) manifest.roles.optional = [...def.roles.optional];
  if (def.roles.forbidden) manifest.roles.forbidden = [...def.roles.forbidden];
  if (def.roles.minCount) manifest.roles.minCount = { ...def.roles.minCount };
  if (def.limits) manifest.limits = JSON.parse(JSON.stringify(def.limits));
  if (def.endpointConstraints) manifest.endpointConstraints = JSON.parse(JSON.stringify(def.endpointConstraints));
  if (def.display) manifest.display = JSON.parse(JSON.stringify(def.display));
  if (def.objective) manifest.objective = JSON.parse(JSON.stringify(def.objective));
  if (def.dashboard) manifest.dashboard = JSON.parse(JSON.stringify(def.dashboard));
  if (def.report) manifest.report = JSON.parse(JSON.stringify(def.report));
  if (def.configSchema) manifest.configSchema = JSON.parse(JSON.stringify(def.configSchema));
  if (def.roomConfig?.fields) {
    manifest.roomConfigSchema = {};
    for (const field of def.roomConfig.fields) {
      const entry = { ...field };
      const key = entry.key;
      delete entry.key;
      if (entry.type === 'text') {
        entry.type = 'string';
        if (entry.multiline === undefined) entry.multiline = true;
      }
      if (entry.type === 'string[]') entry.type = 'string_array';
      if (entry.helpText !== undefined) {
        entry.description = entry.helpText;
        delete entry.helpText;
      }
      manifest.roomConfigSchema[key] = entry;
    }
  }
  if (def.setup?.compatibilityGate) {
    const gate = def.setup.compatibilityGate;
    manifest.setup = {};
    if (gate.enabled != null) manifest.setup.compatibilityGate = gate.enabled;
    if (gate.title) manifest.setup.compatibilityTitle = gate.title;
    if (gate.description) manifest.setup.compatibilityDescription = gate.description;
    if (gate.checkLabel) manifest.setup.checkLabel = gate.checkLabel;
    if (gate.fixLabel) manifest.setup.fixLabel = gate.fixLabel;
    if (gate.allowMakeCompatible != null) manifest.setup.allowMakeCompatible = gate.allowMakeCompatible;
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('room.yaml', () => {
  let def;
  beforeAll(() => {
    const content = fs.readFileSync(roomYamlPath, 'utf-8');
    def = yaml.load(content);
  });

  it('has valid apiVersion and kind', () => {
    expect(def.apiVersion).toBe('room/v1');
    expect(def.kind).toBe('declarative_room');
  });

  it('has valid metadata', () => {
    expect(isNonEmptyString(def.metadata.id)).toBe(true);
    expect(isNonEmptyString(def.metadata.orchestratorType)).toBe(true);
    expect(isNonEmptyString(def.metadata.name)).toBe(true);
    expect(KNOWN_FAMILIES.has(def.metadata.family)).toBe(true);
  });

  it('has required roles', () => {
    expect(def.roles.required).toEqual(['explorer', 'builder', 'auditor']);
    expect(def.roles.minCount.explorer).toBe(1);
    expect(def.roles.minCount.builder).toBe(1);
    expect(def.roles.minCount.auditor).toBe(1);
  });

  it('has valid phases with unique ids', () => {
    const ids = def.phases.states.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(def.phases.initial);
    expect(def.phases.initial).toBe('preflight');
  });

  it('uses only known predicates in phase transitions', () => {
    for (const phase of def.phases.states) {
      if (!phase.onComplete?.when) continue;
      for (const cond of phase.onComplete.when) {
        if (cond.if) {
          expect(EMPIRICAL_SEARCH_PREDICATES.has(cond.if)).toBe(true);
        }
      }
    }
  });

  it('all next phase references exist', () => {
    const ids = new Set(def.phases.states.map((s) => s.id));
    for (const phase of def.phases.states) {
      if (phase.onComplete?.next) {
        expect(ids.has(phase.onComplete.next)).toBe(true);
      }
      if (phase.onComplete?.when) {
        for (const cond of phase.onComplete.when) {
          if (cond.next) {
            expect(ids.has(cond.next)).toBe(true);
          }
        }
      }
    }
  });

  it('has only known familyConfig keys', () => {
    for (const key of Object.keys(def.familyConfig)) {
      expect(EMPIRICAL_SEARCH_FAMILY_KEYS.has(key)).toBe(true);
    }
  });

  it('has valid dashboard panels', () => {
    expect(def.dashboard.panels.length).toBeGreaterThan(0);
    for (const panel of def.dashboard.panels) {
      expect(isNonEmptyString(panel.type)).toBe(true);
      expect(isNonEmptyString(panel.key)).toBe(true);
    }
  });

  it('has lanes matching required roles', () => {
    expect(def.lanes.explorer.fromRoles).toContain('explorer');
    expect(def.lanes.builder.fromRoles).toContain('builder');
    expect(def.lanes.auditor.fromRoles).toContain('auditor');
  });
});

describe('manifest compilation', () => {
  let def;
  let compiled;
  let existing;

  beforeAll(() => {
    const content = fs.readFileSync(roomYamlPath, 'utf-8');
    def = yaml.load(content);
    compiled = buildManifestFromDefinition(def);
    existing = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf-8'));
  });

  it('produces matching id and orchestratorType', () => {
    expect(compiled.id).toBe(existing.id);
    expect(compiled.orchestratorType).toBe(existing.orchestratorType);
  });

  it('produces matching roles', () => {
    expect(compiled.roles.required).toEqual(existing.roles.required);
    expect(compiled.roles.forbidden).toEqual(existing.roles.forbidden);
    expect(compiled.roles.minCount).toEqual(existing.roles.minCount);
  });

  it('produces matching limits', () => {
    expect(compiled.limits.maxCycles).toEqual(existing.limits.maxCycles);
    expect(compiled.limits.maxTurns).toEqual(existing.limits.maxTurns);
    expect(compiled.limits.turnFloorFormula).toBe(existing.limits.turnFloorFormula);
  });

  it('produces matching dashboard panel count', () => {
    expect(compiled.dashboard.panels.length).toBe(existing.dashboard.panels.length);
  });

  it('produces matching dashboard panel keys', () => {
    const compiledKeys = compiled.dashboard.panels.map((p) => p.key);
    const existingKeys = existing.dashboard.panels.map((p) => p.key);
    expect(compiledKeys).toEqual(existingKeys);
  });

  it('produces matching configSchema', () => {
    expect(Object.keys(compiled.configSchema).sort())
      .toEqual(Object.keys(existing.configSchema).sort());
    for (const [key, field] of Object.entries(compiled.configSchema)) {
      expect(field.type).toBe(existing.configSchema[key].type);
      expect(field.default).toBe(existing.configSchema[key].default);
    }
  });

  it('produces matching roomConfigSchema keys', () => {
    expect(Object.keys(compiled.roomConfigSchema).sort())
      .toEqual(Object.keys(existing.roomConfigSchema).sort());
  });

  it('maps helpText to description', () => {
    expect(compiled.roomConfigSchema.dbUrl.description)
      .toBe(existing.roomConfigSchema.dbUrl.description);
  });

  it('maps text type to string with multiline', () => {
    expect(compiled.roomConfigSchema.slowQuery.type).toBe('string');
    expect(compiled.roomConfigSchema.slowQuery.multiline).toBe(true);
  });

  it('produces matching setup', () => {
    expect(compiled.setup.compatibilityGate).toBe(existing.setup.compatibilityGate);
    expect(compiled.setup.checkLabel).toBe(existing.setup.checkLabel);
    expect(compiled.setup.fixLabel).toBe(existing.setup.fixLabel);
    expect(compiled.setup.allowMakeCompatible).toBe(existing.setup.allowMakeCompatible);
  });

  it('produces matching report', () => {
    expect(compiled.report.summaryMetrics).toEqual(existing.report.summaryMetrics);
    expect(compiled.report.table.metricKey).toBe(existing.report.table.metricKey);
    expect(compiled.report.codeBlocks.length).toBe(existing.report.codeBlocks.length);
  });
});

describe('index.js exports', () => {
  it('exports engine with required hooks', async () => {
    const mod = await import('../index.js');
    expect(mod.engine).toBeDefined();
    expect(mod.engine.strategyTypes).toEqual(['rewrite', 'sort_dist']);
    expect(mod.engine.measuredStrategyTypes).toEqual(['rewrite']);
    expect(typeof mod.engine.extendBuilderResult).toBe('function');
    expect(typeof mod.engine.buildWinnerBlock).toBe('function');
    expect(typeof mod.engine.targetBuilders.baseline).toBe('function');
    expect(typeof mod.engine.targetBuilders.planning).toBe('function');
  });

  it('exports harness with connection functions', async () => {
    const mod = await import('../index.js');
    expect(mod.harness).toBeDefined();
    expect(typeof mod.harness.checkCompatibility).toBe('function');
    expect(typeof mod.harness.makeCompatible).toBe('function');
    expect(typeof mod.harness.connect).toBe('function');
    expect(typeof mod.harness.getConfig).toBe('function');
  });

  it('still exports classic format', async () => {
    const mod = await import('../index.js');
    expect(mod.default).toBeDefined();
    expect(mod.default.manifest).toBeDefined();
    expect(typeof mod.default.createPlugin).toBe('function');
  });
});
