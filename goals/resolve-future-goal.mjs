import { createHash } from 'node:crypto';

const AMENDMENT_ID = 'PROGRAM-AMENDMENT-AI-SPEECH-ACTION-2026-08-09-V1';
const AMENDMENT_PATH = 'goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.json';
const AMENDMENT_SHA256 = 'bf261120ed3d70fbdf78926bb59abfb3c86c1e00dea6bfd637654475e3b5c6ea';
const BASE_MANIFEST_SHA256 = '11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912';
const TARGET_IDS = ['G10', 'G12', 'G13', 'G14', 'G15', 'G16'];
const EXPECTED_ADDS = [
  'policy_driven_multi_path_speech',
  'policy_driven_interaction_execution',
  'hf_overlap_only_qualification',
  'conversation_perception_observations',
  'disclosure_consent_separation',
  'proactive_handoff_policy',
  'human_collaboration_roles',
  'mcp_tool_adapter_governance',
  'advanced_eval_security',
  'verified_context_and_cross_layer_evaluation',
  'business_outcome_kpis',
  'provider_exit_and_full_unit_economics',
];
const EXPECTED_UNCHANGED = [
  'frozen_manifest_bytes',
  'G03_binding_objective_or_hash',
  'G03_through_G08_scope_or_order',
  'domain_authorities',
  'base_goal_dependencies_status_or_hash',
  'evidence_statuses',
  'production_eligibility',
];
const EXPECTED_INVARIANTS = [
  'anything_unproved_remains_not_run',
  'upstream_claims_never_become_converact_evidence',
  'G03_through_G08_scope_and_execution_unchanged',
  'HF_engineering_is_mandatory_but_production_selection_is_evidence_driven',
  'MCP_is_a_tool_adapter_not_an_action_authority',
  'agent_runtime_emits_action_proposals_only',
  'disclosure_never_substitutes_for_consent',
  'ordinary_media_never_depends_on_AI_or_tool_execution',
  'interaction_path_changes_require_a_new_fenced_generation',
  'perception_observations_never_become_business_facts_without_confirmation',
];

export function resolveFutureGoal({ manifest_bytes, amendment_bytes, goal_bytes, goal_id }) {
  const manifest = parseFrozenManifest(manifest_bytes);
  const amendment = parseFrozenAmendment(amendment_bytes);
  if (!manifest || !validAmendment(amendment, manifest) || !TARGET_IDS.includes(goal_id)) {
    throw new Error('future_goal_amendment_invalid');
  }

  const baseGoal = manifest.goals.find((goal) => goal.id === goal_id);
  const frozenTarget = amendment.frozen_inputs.targets.find((candidate) => candidate.goal_id === goal_id);
  const target = amendment.target_goal_clauses.find((candidate) => candidate.goal_id === goal_id);
  if (!baseGoal || !frozenTarget || !target || !validGoalBytes(goal_bytes, baseGoal, frozenTarget)) {
    throw new Error('future_goal_amendment_invalid');
  }

  return {
    base_goal: structuredClone(baseGoal),
    amendment_id: amendment.amendment_id,
    amendment_version: amendment.version,
    amendment_path: AMENDMENT_PATH,
    amendment_sha256: AMENDMENT_SHA256,
    binding_clauses: structuredClone(target.clauses),
    create_goal_addendum: target.create_goal_addendum,
    global_invariants: [...amendment.global_invariants],
    production_eligible: false,
  };
}

export function buildFutureGoalObjective({ manifest_bytes, amendment_bytes, goal_bytes, goal_id }) {
  const effective = resolveFutureGoal({ manifest_bytes, amendment_bytes, goal_bytes, goal_id });
  const baseSummary = extractCreateGoalSummary(goal_bytes);
  if (!baseSummary) throw new Error('future_goal_amendment_invalid');

  return [
    baseSummary,
    '',
    'Binding identities for this execution:',
    `- Base Goal path: \`${effective.base_goal.path}\``,
    `- Base Goal SHA-256: \`${effective.base_goal.sha256}\``,
    `- Additive amendment path: \`${effective.amendment_path}\``,
    `- Additive amendment SHA-256: \`${effective.amendment_sha256}\``,
    '',
    effective.create_goal_addendum,
  ].join('\n');
}

function validGoalBytes(value, baseGoal, frozenTarget) {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > 1024 * 1024) return false;
  const digest = sha256(value);
  return digest === baseGoal.sha256
    && digest === frozenTarget.sha256
    && baseGoal.path === frozenTarget.path;
}

function extractCreateGoalSummary(value) {
  const text = value.toString('utf8');
  const match = text.match(
    /^##\s+[0-9]+\.\s+create_goal summary\s*\r?\n+```text\r?\n([\s\S]*?)\r?\n```/mu,
  );
  return match?.[1]?.trim() || null;
}

function parseFrozenAmendment(value) {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > 1024 * 1024) return null;
  if (sha256(value) !== AMENDMENT_SHA256) return null;
  try {
    return JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
}

function parseFrozenManifest(value) {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > 1024 * 1024) return null;
  if (sha256(value) !== BASE_MANIFEST_SHA256) return null;
  try {
    const parsed = JSON.parse(value.toString('utf8'));
    if (!plainRecord(parsed) || !Array.isArray(parsed.goals) || parsed.goals.length !== 18) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validAmendment(value, manifest) {
  if (!exactRecord(value, [
    '$schema', 'amendment_id', 'version', 'authorized_at', 'authorization_basis',
    'status', 'scope', 'frozen_inputs', 'source_review', 'decision_artifacts',
    'target_goal_clauses', 'global_invariants',
  ])
    || value.$schema !== './future-goal-amendment-v1.schema.json'
    || value.amendment_id !== AMENDMENT_ID
    || value.version !== 1
    || value.authorized_at !== '2026-08-09'
    || value.authorization_basis !== 'user_requested_complete_docs_and_goals_before_resuming_G03'
    || value.status !== 'binding_for_future_goal_execution'
    || !exactRecord(value.scope, ['adds', 'does_not_change'])
    || !exactArray(value.scope.adds, EXPECTED_ADDS)
    || !exactArray(value.scope.does_not_change, EXPECTED_UNCHANGED)
    || !exactRecord(value.frozen_inputs, ['manifest_path', 'manifest_sha256', 'targets'])
    || value.frozen_inputs.manifest_path !== 'goals/manifest.json'
    || value.frozen_inputs.manifest_sha256 !== BASE_MANIFEST_SHA256
    || !validSourceReview(value.source_review)
    || !validDecisionArtifacts(value.decision_artifacts)
    || !exactArray(value.global_invariants, EXPECTED_INVARIANTS)
    || !validTargets(value.frozen_inputs.targets, manifest)
    || !validClauses(value.target_goal_clauses)) {
    return false;
  }
  return true;
}

function validSourceReview(value) {
  return exactRecord(value, [
    'source_file_name', 'source_sha256', 'supplemental_source_file_name',
    'supplemental_source_sha256', 'review_path', 'review_disposition', 'upstream_claim_status',
  ])
    && value.source_file_name === 'IPPBX呼叫中心AI机器人部署技术研究（2026）-SIP实验室发布.pdf'
    && value.source_sha256 === 'd45ffbeaa945ec87a7046d420977489c2173c12b86d131cf22af7f31f11ec026'
    && value.supplemental_source_file_name === 'pasted-text.txt'
    && value.supplemental_source_sha256 === 'fc1c98fb7936ff40bfc6957006a73dd435939e4a31ab64fbcdefaabbe8a7094a'
    && value.review_path === 'docs/architecture/2026-08-09-ippbx-contact-center-ai-industry-analysis-adoption-review.md'
    && value.review_disposition === 'accepted_as_research_input_with_binding_forward_amendment'
    && value.upstream_claim_status === 'not_run';
}

function validDecisionArtifacts(value) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const expected = [
    [
      'research_review',
      'docs/architecture/2026-08-09-ippbx-contact-center-ai-industry-analysis-adoption-review.md',
      'ff37c097e0d599a282b1ea916a86f9b451400c30bef24e657b345a993066f132',
    ],
    [
      'adr',
      'docs/adr/ccaas-12-policy-driven-speech-and-tool-adapter-boundaries.md',
      'd13c3248b1a77f7a48540f66359bffa7c15b16b4405b6124becbdf7b51da2b3d',
    ],
  ];
  return value.every((artifact, index) => exactRecord(artifact, ['kind', 'path', 'sha256'])
    && artifact.kind === expected[index][0]
    && artifact.path === expected[index][1]
    && artifact.sha256 === expected[index][2]);
}

function validTargets(value, manifest) {
  if (!Array.isArray(value) || value.length !== TARGET_IDS.length) return false;
  return value.every((target, index) => {
    if (!exactRecord(target, ['goal_id', 'path', 'sha256']) || target.goal_id !== TARGET_IDS[index]) {
      return false;
    }
    const goal = manifest.goals.find((candidate) => candidate.id === target.goal_id);
    return goal?.path === target.path && goal?.sha256 === target.sha256 && isSha256(target.sha256);
  });
}

function validClauses(value) {
  if (!Array.isArray(value) || value.length !== TARGET_IDS.length) return false;
  const ids = new Set();
  return value.every((target, index) => {
    if (!exactRecord(target, ['goal_id', 'clauses', 'create_goal_addendum'])
      || target.goal_id !== TARGET_IDS[index]
      || typeof target.create_goal_addendum !== 'string'
      || target.create_goal_addendum.length < 40
      || !Array.isArray(target.clauses)
      || target.clauses.length === 0) return false;
    return target.clauses.every((clause) => {
      if (!exactRecord(clause, ['id', 'category', 'text', 'evidence_status'])
        || !new RegExp(`^${target.goal_id}-A[0-9]{2}$`, 'u').test(clause.id)
        || ids.has(clause.id)
        || !['required_outcome', 'required_artifact', 'tdd', 'acceptance_gate', 'non_goal'].includes(clause.category)
        || typeof clause.text !== 'string'
        || clause.text.length < 20
        || clause.evidence_status !== 'not_run') return false;
      ids.add(clause.id);
      return true;
    });
  });
}

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
