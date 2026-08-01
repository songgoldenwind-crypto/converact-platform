const GOAL_ID = 'G02';
const GOAL_SHA256 = '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9';
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const SECRET_KEY = /(?:password|passwd|secret|token|cookie|authorization|private[_-]?key|credential)/iu;
const SECRET_VALUE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;

const CATALOG = Object.freeze([
  scenario('database', ['timeout', 'partition', 'pool_exhaustion', 'restart']),
  scenario('event_system', ['timeout', 'partition', 'duplicate', 'reorder']),
  scenario('object_store', ['timeout', 'partition', 'partial_write', 'stale_read']),
  scenario('pki_kms', ['timeout', 'partition', 'revoked_key', 'expired_cert']),
  scenario('dns', ['timeout', 'nxdomain', 'stale_answer', 'poisoned_answer']),
  scenario('configuration', ['missing', 'invalid', 'stale', 'conflicting_revision']),
  scenario('wall_clock', ['backward_jump', 'forward_jump', 'cross_node_skew', 'quality_unknown']),
  scenario('ai_gpu', ['timeout', 'oom', 'process_crash', 'capacity_exhaustion']),
  scenario('recording_upload', ['timeout', 'partition', 'checksum_mismatch', 'capacity_exhaustion']),
  scenario('provider', ['timeout', 'duplicate', 'reorder', 'unknown_effect']),
  scenario('observability', ['collector_down', 'exporter_timeout', 'queue_full']),
  scenario('node_crash', ['process_abort', 'oom', 'host_loss'])
]);

export function faultScenarioCatalog() {
  return CATALOG;
}

export function evaluateControlledFaultScenario(input) {
  assertNoSecrets(input);
  if (!plainRecord(input)) throw new Error('fault_scenario_invalid');
  const definition = CATALOG.find((entry) => entry.dependency === input.dependency);
  if (!definition || !definition.failure_modes.includes(input.failure_mode)) {
    throw new Error('fault_scenario_unknown');
  }
  if (input.executed === false) {
    return Object.freeze({
      dependency: definition.dependency,
      failure_mode: input.failure_mode,
      status: 'not_run',
      production_eligible: false,
      real_human_media: false,
      blocker: boundedText(input.blocker, 'fault_scenario_blocker_required'),
      evidence: null
    });
  }
  if (input.executed !== true) throw new Error('fault_scenario_executed_invalid');

  const realHumanMedia = mediaKind(input.media_probe) === 'real_human_media';
  if (realHumanMedia) assertHumanMediaIdentity(input.media_probe);
  const valid = input.actual_fault === true
    && validIdentity(input.identity)
    && validMediaProbe(input.media_probe)
    && validChecks(input.checks);
  const result = {
    dependency: definition.dependency,
    failure_mode: input.failure_mode,
    status: valid ? 'verified_controlled' : 'failed',
    production_eligible: false,
    real_human_media: valid && realHumanMedia,
    blocker: null,
    evidence: valid ? Object.freeze({
      identity: Object.freeze({ ...input.identity }),
      media_probe: deepFreezeCopy(input.media_probe),
      checks: Object.freeze(input.checks.map((check) => Object.freeze({ ...check })))
    }) : null
  };
  return Object.freeze(result);
}

export function summarizeFaultCampaign(results) {
  if (!Array.isArray(results) || results.length > CATALOG.length) {
    throw new Error('fault_campaign_results_invalid');
  }
  const byDependency = new Map();
  for (const result of results) {
    if (!plainRecord(result) || !CATALOG.some((entry) => entry.dependency === result.dependency)
      || byDependency.has(result.dependency)) {
      throw new Error('fault_campaign_results_invalid');
    }
    byDependency.set(result.dependency, result);
  }
  const verified = results.filter((result) => result.status === 'verified_controlled').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const explicitNotRun = results.filter((result) => result.status === 'not_run').length;
  if (verified + failed + explicitNotRun !== results.length) {
    throw new Error('fault_campaign_status_invalid');
  }
  const notRun = explicitNotRun + CATALOG.length - results.length;
  const complete = verified === CATALOG.length;
  return Object.freeze({
    status: complete ? 'verified_controlled' : failed > 0 ? 'failed' : 'partial',
    production_eligible: false,
    verified_controlled: verified,
    failed,
    not_run: notRun,
    real_human_media_dependencies: results.filter(
      (result) => result.status === 'verified_controlled' && result.real_human_media === true
    ).length,
    complete_matrix: complete
  });
}

function scenario(dependency, failureModes) {
  return Object.freeze({ dependency, failure_modes: Object.freeze([...failureModes]) });
}

function validIdentity(value) {
  if (!plainRecord(value) || value.goal_id !== GOAL_ID || value.goal_sha256 !== GOAL_SHA256
    || !COMMIT.test(String(value.source_commit || ''))
    || !SHA256.test(String(value.config_sha256 || ''))
    || !SHA256.test(String(value.raw_output_sha256 || ''))
    || !SHA256.test(String(value.node_binary_sha256 || ''))
    || !/^v24\.\d+\.\d+$/u.test(String(value.node_version || ''))
    || !boundedToken(value.host) || !boundedTextOrFalse(value.hardware)
    || !boundedTextOrFalse(value.clock) || !boundedTextOrFalse(value.workload)
    || !boundedToken(value.seed) || !validTimestamp(value.started_at)
    || !validTimestamp(value.completed_at)
    || Date.parse(value.completed_at) < Date.parse(value.started_at)
    || !Array.isArray(value.image_digests) || value.image_digests.length < 1
    || value.image_digests.length > 32
    || !value.image_digests.every((item) => IMAGE_DIGEST.test(String(item)))) return false;
  return true;
}

function validMediaProbe(value) {
  if (!plainRecord(value) || !['synthetic_transport', 'real_human_media'].includes(value.kind)) return false;
  return value.established_before_fault === true
    && value.continuous_during_fault === true
    && value.completed_after_recovery === true;
}

function mediaKind(value) {
  return plainRecord(value) ? value.kind : '';
}

function assertHumanMediaIdentity(value) {
  if (!plainRecord(value) || !plainRecord(value.human_media_identity)) {
    throw new Error('human_media_identity_required');
  }
  const identity = value.human_media_identity;
  if (!boundedToken(identity.call_id) || !boundedToken(identity.interaction_id)
    || !Array.isArray(identity.participant_ids) || identity.participant_ids.length !== 2
    || !identity.participant_ids.every(boundedToken)
    || !Number.isSafeInteger(identity.duration_ms) || identity.duration_ms < 60_000
    || !SHA256.test(String(identity.raw_media_output_sha256 || ''))) {
    throw new Error('human_media_identity_required');
  }
}

function validChecks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return false;
  const identifiers = new Set();
  for (const check of value) {
    if (!plainRecord(check) || !boundedToken(check.id) || check.passed !== true
      || identifiers.has(check.id)) return false;
    identifiers.add(check.id);
  }
  return true;
}

function assertNoSecrets(value, depth = 0, seen = new Set()) {
  if (depth > 16) throw new Error('evidence_budget_exceeded');
  if (typeof value === 'string') {
    if (value.length > 8192) throw new Error('evidence_budget_exceeded');
    if (SECRET_VALUE.test(value)) throw new Error('evidence_secret_forbidden');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('evidence_cycle_forbidden');
  seen.add(value);
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  if (entries.length > 256) throw new Error('evidence_budget_exceeded');
  for (const [key, child] of entries) {
    if (!Array.isArray(value) && SECRET_KEY.test(key)) throw new Error('evidence_secret_forbidden');
    assertNoSecrets(child, depth + 1, seen);
  }
  seen.delete(value);
}

function boundedText(value, code) {
  if (!boundedTextOrFalse(value)) throw new Error(code);
  return value;
}

function boundedTextOrFalse(value) {
  return typeof value === 'string' && value.trim() === value
    && value.length >= 1 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  if (!plainRecord(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, deepFreezeCopy(child)])
  ));
}
