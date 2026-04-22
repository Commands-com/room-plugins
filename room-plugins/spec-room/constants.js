// ---------------------------------------------------------------------------
// Static constants for the Spec Room plugin — phase names, text-size caps,
// per-role prompt framing, and implementation-cycle sizing heuristics.
// ---------------------------------------------------------------------------

export const PHASES = Object.freeze({
  WRITE: 'write',
  REVIEW: 'review',
  REVISE: 'revise',
  COMPLETE: 'complete',
});

export const SPEC_TEXT_LIMITS = Object.freeze({
  summary: 8000,
  problem: 30000,
  shortItem: 2000,
  mediumItem: 4000,
  longItem: 8000,
  parsedLine: 20000,
  paragraph: 30000,
  storedResponse: 100000,
});

export const ROLE_FOCUS = Object.freeze({
  planner: {
    short: 'Product clarity, scope, user value',
    review: 'Review the spec for product clarity, scope discipline, goals, and user value.',
  },
  critic: {
    short: 'Ambiguity, risks, cuts',
    review: 'Review the spec for ambiguity, missing constraints, risks, and scope that should be cut or deferred.',
  },
  implementer: {
    short: 'Author and maintain the canonical spec',
    write: 'Inspect the repo/docs/contracts and author the initial spec file directly.',
    revise: 'Apply reviewer feedback to the same spec file while keeping the document coherent and buildable.',
  },
  researcher: {
    short: 'Patterns, precedents, repo grounding',
    review: 'Review the spec for grounding, precedents, and alignment with observed repo patterns and contracts.',
  },
});

export const PROTOTYPE_INFLUENCE_PROPOSAL = 'Use the selected prototype as directional input for the product shape and required user flows, but define the production design, non-mock functionality, and implementation boundaries independently rather than extending prototype files blindly.';

export const PROTOTYPE_INFLUENCE_ACCEPTANCE = 'The spec defines the production product core, required user flows, non-mock functionality, and implementation boundaries independently of the prototype; the prototype informs the spec but is not the implementation artifact.';

export const IMPLEMENTATION_CYCLE_BANDS = Object.freeze([
  Object.freeze({
    key: 'small',
    minScore: 0,
    maxScore: 5,
    recommendedMaxCycles: 4,
    label: 'small single-flow build',
  }),
  Object.freeze({
    key: 'standard',
    minScore: 6,
    maxScore: 10,
    recommendedMaxCycles: 7,
    label: 'standard MVP',
  }),
  Object.freeze({
    key: 'large',
    minScore: 11,
    maxScore: 15,
    recommendedMaxCycles: 10,
    label: 'larger multi-flow build',
  }),
  Object.freeze({
    key: 'extensive',
    minScore: 16,
    maxScore: Infinity,
    recommendedMaxCycles: 13,
    label: 'larger build with substantial business logic or integration work',
  }),
]);

export const IMPLEMENTATION_COMPLEXITY_KEYWORDS = Object.freeze([
  Object.freeze({
    regex: /\b(auth|login|signup|session|permission|role[- ]based|rbac|oauth)\b/i,
    weight: 2,
    reason: 'Includes authentication or permissioning work',
  }),
  Object.freeze({
    regex: /\b(database|schema|persistence|persist|storage|stored|cache|queue)\b/i,
    weight: 2,
    reason: 'Includes persistence or data-layer work',
  }),
  Object.freeze({
    regex: /\b(api|integration|provider|webhook|sync|realtime|websocket)\b/i,
    weight: 2,
    reason: 'Includes integration or system-boundary work',
  }),
  Object.freeze({
    regex: /\b(payment|billing|subscription|checkout|invoice)\b/i,
    weight: 2,
    reason: 'Includes billing or payment flows',
  }),
  Object.freeze({
    regex: /\b(admin|dashboard|workflow|approval|multi-step|review cycle)\b/i,
    weight: 1,
    reason: 'Includes orchestration, workflow, or admin surfaces',
  }),
  Object.freeze({
    regex: /\b(team|workspace|organization|collaboration|shared)\b/i,
    weight: 2,
    reason: 'Includes multi-user or collaboration behavior',
  }),
]);
