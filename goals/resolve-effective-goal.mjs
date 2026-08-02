import { createHash } from 'node:crypto';

const FROZEN_MANIFEST_SHA256 = '11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912';
const FROZEN_G02_SHA256 = '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9';
const FROZEN_G03_SHA256 = '05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af';
const EXPECTED_NOT_RUN = [
  'G02-E09-DEPENDENCY',
  'G02-E12-LONG-MEDIA',
  'G02-E14-REGION',
  'G02-E15-NATIVE',
];
const EXPECTED_SCOPE_UNCHANGED = [
  'G02_binding_objective_or_hash',
  'G03_binding_objective_or_hash',
  'domain_authorities',
  'technical_acceptance_gates',
  'evidence_statuses',
  'production_eligibility',
];
const EXPECTED_INVARIANTS = [
  'anything_unproved_remains_not_run',
  'production_eligibility_remains_false',
  'G03_does_not_inherit_G02_external_evidence',
  'G03_must_satisfy_its_own_full_objective',
  'no_production_or_server_mutation_authorized',
];
const EXPECTED_EVIDENCE_URIS = [
  'architecture-foundation/execution/goal-02/evidence-index-v1.json',
  'architecture-foundation/execution/goal-02/independent-review.md',
];

export function resolveEffectiveGoal({ manifest_bytes, amendment, goal_id }) {
  const manifest = parseFrozenManifest(manifest_bytes);
  if (!manifest
    || !validManifest(manifest)
    || !validAmendment(amendment, manifest)
    || goal_id !== 'G03') {
    throw new Error('gate_amendment_invalid');
  }
  const goal = manifest.goals.find((candidate) => candidate.id === goal_id);
  const g02Dependency = goal.dependencies.find((dependency) => dependency.goal_id === 'G02');
  if (g02Dependency?.gate !== amendment.effective_dependency.original_gate) {
    throw new Error('gate_amendment_invalid');
  }
  return {
    ...structuredClone(goal),
    dependencies: goal.dependencies.map((dependency) => dependency.goal_id === 'G02'
      ? { ...dependency, gate: amendment.effective_dependency.effective_gate }
      : { ...dependency }),
    effective_entry_gate: amendment.development_gate.gate_id,
    gate_amendment_id: amendment.amendment_id,
    production_eligible: false,
  };
}

function validManifest(value) {
  if (!plainRecord(value)
    || value.program_id !== 'converact-architecture-foundation-goals'
    || !Array.isArray(value.goals)
    || value.goals.length !== 18
    || !value.goals.every((goal) => plainRecord(goal) && typeof goal.id === 'string')) {
    return false;
  }
  const g02 = value.goals.find((goal) => goal.id === 'G02');
  const g03 = value.goals.find((goal) => goal.id === 'G03');
  return g02?.path === 'goals/goal-02-platform-foundation-security-observability.md'
    && g02?.sha256 === FROZEN_G02_SHA256
    && g02?.status === 'blocked_external'
    && g03?.order === 3
    && g03?.title === 'SIP 与 Durable Call Foundation'
    && g03?.path === 'goals/goal-03-sip-call-durable-foundation.md'
    && g03?.sha256 === FROZEN_G03_SHA256
    && g03?.status === 'not_run'
    && g03?.conditional === false
    && exactDependencies(g03?.dependencies, [
      ['G00', 'completed'],
      ['G02', 'completed'],
    ])
    && exactArray(g03?.external_conditions, [])
    && exactArray(g03?.unlocks, ['G04', 'G05', 'G06', 'G07'])
    && exactArray(g03?.allowed_terminal_statuses, ['completed', 'blocked_external', 'rejected'])
    && g03?.entry_gate === 'Platform identity, durability, event, audit and failure boundaries exist.';
}

function validAmendment(value, manifest) {
  if (!exactRecord(value, [
    '$schema', 'amendment_id', 'version', 'authorized_at', 'authorization_basis',
    'scope', 'frozen_inputs', 'development_gate', 'production_gate',
    'effective_dependency', 'invariants',
  ])
    || value.$schema !== './goal-gate-amendment-v1.schema.json'
    || value.amendment_id !== 'GATE-AMENDMENT-G02-G03-2026-08-02-V1'
    || value.version !== 1
    || value.authorized_at !== '2026-08-02'
    || value.authorization_basis !== 'user_authorized_split_then_start_g03'
    || !exactRecord(value.scope, ['changes', 'does_not_change'])
    || !exactArray(value.scope.changes, ['G03_dependency_gate_only'])
    || !exactArray(value.scope.does_not_change, EXPECTED_SCOPE_UNCHANGED)
    || !exactRecord(value.frozen_inputs, [
      'manifest_path', 'manifest_sha256', 'goal_02_path', 'goal_02_sha256',
      'goal_03_path', 'goal_03_sha256',
    ])
    || value.frozen_inputs.manifest_path !== 'goals/manifest.json'
    || value.frozen_inputs.manifest_sha256 !== FROZEN_MANIFEST_SHA256
    || value.frozen_inputs.goal_02_path !== 'goals/goal-02-platform-foundation-security-observability.md'
    || value.frozen_inputs.goal_02_sha256 !== FROZEN_G02_SHA256
    || value.frozen_inputs.goal_03_path !== 'goals/goal-03-sip-call-durable-foundation.md'
    || value.frozen_inputs.goal_03_sha256 !== FROZEN_G03_SHA256
    || !exactRecord(value.development_gate, [
      'gate_id', 'status', 'closure_commit', 'evidence_uris', 'review_findings',
      'production_eligible',
    ])
    || value.development_gate?.gate_id !== 'G02_PLATFORM_FOUNDATION_GATE'
    || value.development_gate?.status !== 'completed'
    || value.development_gate?.closure_commit !== '16ab4af98c5f3b453ad3d9bdd1ae5fe959a37720'
    || !exactArray(value.development_gate?.evidence_uris, EXPECTED_EVIDENCE_URIS)
    || value.development_gate?.production_eligible !== false
    || !exactRecord(value.production_gate, [
      'gate_id', 'status', 'not_run_evidence_ids', 'production_eligible',
    ])
    || value.production_gate?.gate_id !== 'G02_PRODUCTION_EVIDENCE_GATE'
    || value.production_gate?.status !== 'blocked_external'
    || value.production_gate?.production_eligible !== false
    || !exactRecord(value.effective_dependency, [
      'dependent_goal', 'prerequisite_goal', 'original_gate', 'effective_gate',
      'amendment_precedence',
    ])
    || value.effective_dependency?.dependent_goal !== 'G03'
    || value.effective_dependency?.prerequisite_goal !== 'G02'
    || value.effective_dependency?.original_gate !== 'completed'
    || value.effective_dependency?.effective_gate !== 'platform_foundation_gate_completed'
    || value.effective_dependency?.amendment_precedence !== 'later_user_authorized_gate_only'
    || !exactArray(value.invariants, EXPECTED_INVARIANTS)) {
    return false;
  }
  const findings = value.development_gate.review_findings;
  if (!exactRecord(findings, ['critical', 'high', 'important', 'minor'])
    || findings.critical !== 0
    || findings.high !== 0
    || findings.important !== 0
    || findings.minor !== 0) return false;
  if (!exactArray(value.production_gate.not_run_evidence_ids, EXPECTED_NOT_RUN)) {
    return false;
  }
  const g02 = manifest.goals.find((goal) => goal.id === 'G02');
  const g03 = manifest.goals.find((goal) => goal.id === 'G03');
  return g02?.sha256 === value.frozen_inputs.goal_02_sha256
    && g03?.sha256 === value.frozen_inputs.goal_03_sha256
    && g02?.status === 'blocked_external'
    && g03?.status === 'not_run';
}

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFrozenManifest(value) {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > 1024 * 1024) return null;
  if (createHash('sha256').update(value).digest('hex') !== FROZEN_MANIFEST_SHA256) return null;
  try {
    return JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
}

function exactRecord(value, expectedFields) {
  if (!plainRecord(value)) return false;
  const fields = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  return fields.length === expected.length
    && fields.every((field, index) => field === expected[index]);
}

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function exactDependencies(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((dependency, index) => exactRecord(dependency, ['goal_id', 'gate'])
      && dependency.goal_id === expected[index][0]
      && dependency.gate === expected[index][1]);
}
