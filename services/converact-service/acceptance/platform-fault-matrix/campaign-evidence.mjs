import {
  assertControlledEvidenceIdentity,
  assertControlledEvidenceSafe
} from './evidence-contract.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EXPECTED_MIGRATION = '112_converact_platform_history_receipt_integrity';
const MAX_RECOVERY_MS = 24 * 60 * 60 * 1_000;
const MAX_OPERATIONS = 100_000_000;

export function buildBackupRestoreEvidence(input) {
  assertControlledEvidenceSafe(input);
  const identity = assertControlledEvidenceIdentity(input?.identity);
  const backup = plainRecord(input?.backup) ? input.backup : {};
  const restore = plainRecord(input?.restore) ? input.restore : {};
  const valid = backup.status === 'passed'
    && restore.status === 'passed'
    && token(backup.source_database_id)
    && token(restore.target_database_id)
    && backup.source_database_id !== restore.target_database_id
    && sha256(backup.artifact_sha256)
    && nonNegativeInteger(backup.checkpoint_records)
    && sha256(backup.checkpoint_digest)
    && canonicalTimestamp(backup.backup_started_at)
    && canonicalTimestamp(backup.backup_completed_at)
    && Date.parse(backup.backup_completed_at) >= Date.parse(backup.backup_started_at)
    && restore.target_was_empty === true
    && positiveInteger(restore.fresh_process_pid)
    && restore.migration_head === EXPECTED_MIGRATION
    && restore.restored_records === backup.checkpoint_records
    && restore.restored_digest === backup.checkpoint_digest
    && boundedDuration(restore.measured_rpo_ms, true)
    && boundedDuration(restore.measured_rto_ms, false)
    && restore.runtime_rls_verified === true
    && restore.append_only_verified === true
    && restore.unrelated_containers_unchanged === true
    && restore.validation_resources_remaining === 0;
  return freeze({
    evidence_id: 'G02-E10-RESTORE',
    status: valid ? 'verified_controlled' : 'failed',
    production_eligible: false,
    measured_rpo_ms: valid ? restore.measured_rpo_ms : null,
    measured_rto_ms: valid ? restore.measured_rto_ms : null,
    evidence: valid ? freeze({ identity, backup: freeze({ ...backup }), restore: freeze({ ...restore }) }) : null
  });
}

export function buildDrainEvidence(input) {
  assertControlledEvidenceSafe(input);
  const identity = assertControlledEvidenceIdentity(input?.identity);
  const valid = positiveInteger(input.process_a_pid)
    && positiveInteger(input.process_b_pid)
    && input.process_a_pid !== input.process_b_pid
    && token(input.initial_owner_node_id)
    && token(input.post_drain_owner_node_id)
    && input.initial_owner_node_id !== input.post_drain_owner_node_id
    && input.drain_rejected_new_work === true
    && input.established_work_survived_drain === true
    && input.active_zero_observed === true
    && input.offline_after_active_zero === true
    && input.process_loss_observed === true
    && input.stale_owner_rejected === true
    && input.n_minus_1_schema_accepted === true
    && input.duplicate_replayed === true
    && input.unrelated_containers_unchanged === true
    && input.validation_processes_remaining === 0;
  return freeze({
    evidence_id: 'G02-E11-DRAIN',
    status: valid ? 'verified_controlled' : 'failed',
    production_eligible: false,
    evidence: valid ? freeze({ ...input, identity }) : null
  });
}

export function buildBoundedCapacityEvidence(input) {
  assertControlledEvidenceSafe(input);
  const identity = assertControlledEvidenceIdentity(input?.identity);
  const configured = [
    input.configured_active_limit,
    input.configured_pending_limit,
    input.configured_retry_limit,
    input.configured_fanout_limit
  ];
  const observed = [
    input.observed_max_active,
    input.observed_max_pending,
    input.observed_max_retry,
    input.observed_max_fanout
  ];
  const valid = positiveInteger(input.operations)
    && input.operations <= MAX_OPERATIONS
    && positiveInteger(input.duration_ms)
    && input.duration_ms <= MAX_RECOVERY_MS
    && nonNegativeInteger(input.accepted)
    && positiveInteger(input.overloaded)
    && input.accepted + input.overloaded === input.operations
    && configured.every(positiveInteger)
    && observed.every(nonNegativeInteger)
    && observed.every((value, index) => value === configured[index])
    && finitePositive(input.p99_operation_us)
    && finiteNonNegative(input.event_loop_delay_p99_ms)
    && positiveInteger(input.rss_start_bytes)
    && positiveInteger(input.rss_peak_bytes)
    && positiveInteger(input.rss_end_bytes)
    && input.rss_peak_bytes >= input.rss_start_bytes
    && input.rss_peak_bytes >= input.rss_end_bytes
    && input.counter_integrity === true
    && input.no_unbounded_queue === true;
  return freeze({
    evidence_id: 'G02-E13-CAPACITY',
    status: valid ? 'verified_controlled' : 'failed',
    production_eligible: false,
    evidence: valid ? freeze({ ...input, identity }) : null
  });
}

function boundedDuration(value, zeroAllowed) {
  return Number.isSafeInteger(value)
    && value >= (zeroAllowed ? 0 : 1)
    && value <= MAX_RECOVERY_MS;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function canonicalTimestamp(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function sha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function token(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freeze(value) {
  return Object.freeze(value);
}
