import {
  createHash,
  createPublicKey,
  verify as cryptoVerify
} from 'node:crypto';

import {
  assertEvidenceArtifactSafe,
  assertControlledEvidenceIdentity,
  assertControlledEvidenceSafe
} from './evidence-contract.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EXPECTED_MIGRATION = '116_converact_sip_capability_recovery_fence';
const MAX_RECOVERY_MS = 24 * 60 * 60 * 1_000;
const MAX_OPERATIONS = 100_000_000;
const DRAIN_PHASES = Object.freeze([
  'accepting',
  'route_draining',
  'worker_draining',
  'authority_draining',
  'active_zero_verified',
  'quiesced',
  'stopped'
]);
const DRAIN_AUTHORITIES = Object.freeze([
  'platform_worker_leases',
  'domain_event_inflight',
  'communication_attached_generations',
  'recording_attached_generations',
  'ai_attached_generations',
  'unobserved_effect_receipts',
  'billing_projection_conflicts'
]);
const DRAIN_RAW_ARTIFACT_NAMES = Object.freeze([
  'drain-public-keys.json',
  'drain-receipts.json',
  'drain-result.json',
  'drain-run.log',
  'unrelated-containers-after.tsv',
  'unrelated-containers-before.tsv'
]);
const DRAIN_RECEIPT_BODY_FIELDS = Object.freeze([
  'schema_version',
  'drain_id',
  'node_id',
  'owner_epoch',
  'authority',
  'receipt_revision',
  'active_count',
  'active_id_digest',
  'observed_at',
  'expires_at'
]);
const DRAIN_RESULT_FIELDS = Object.freeze([
  'active_zero_receipts',
  'clock_domain',
  'container_actions',
  'drain_id',
  'drain_node_exit_code',
  'drain_node_exit_signal',
  'drain_node_id',
  'drain_node_pid',
  'drain_owner_epoch',
  'drain_rejection_code',
  'duration_ms',
  'established_close_state',
  'established_mutations_before_drain',
  'established_mutations_during_drain',
  'fresh_receipt_verification_count',
  'fresh_receipt_verified_phase',
  'fresh_verifier_exit_code',
  'fresh_verifier_exit_signal',
  'fresh_verifier_pid',
  'initial_nonzero_receipts',
  'initial_owner_epoch',
  'initial_owner_node_id',
  'lost_node_exit_code',
  'lost_node_exit_signal',
  'lost_node_pid',
  'orchestrator_pid',
  'phase_sequence',
  'post_loss_new_work_state',
  'post_loss_owner_epoch',
  'post_loss_owner_node_id',
  'receipts_manifest_sha256',
  'recovery_node_exit_code',
  'recovery_node_exit_signal',
  'recovery_node_pid',
  'rolling_schema',
  'stale_owner_error_code',
  'status',
  'unrelated_containers_after_sha256',
  'unrelated_containers_before_sha256',
  'validation_processes_remaining'
]);

export function buildBackupRestoreEvidence(input) {
  assertControlledEvidenceSafe(input);
  const identity = assertControlledEvidenceIdentity(input?.identity);
  const backup = plainRecord(input?.backup) ? input.backup : {};
  const restore = plainRecord(input?.restore) ? input.restore : {};
  const valid = backup.status === 'passed'
    && restore.status === 'passed'
    && positiveInteger(backup.process_pid)
    && positiveInteger(restore.restore_process_pid)
    && positiveInteger(restore.fresh_process_pid)
    && backup.process_pid !== restore.fresh_process_pid
    && backup.process_pid !== restore.restore_process_pid
    && restore.restore_process_pid !== restore.fresh_process_pid
    && token(backup.source_database_id)
    && token(restore.target_database_id)
    && backup.source_database_id !== restore.target_database_id
    && token(backup.backup_id)
    && restore.backup_id === backup.backup_id
    && sha256(backup.artifact_sha256)
    && nonNegativeInteger(backup.checkpoint_records)
    && sha256(backup.checkpoint_digest)
    && positiveInteger(backup.object_count)
    && sha256(backup.object_digest)
    && canonicalTimestamp(backup.backup_started_at)
    && canonicalTimestamp(backup.backup_completed_at)
    && Date.parse(backup.backup_completed_at) >= Date.parse(backup.backup_started_at)
    && restore.target_was_empty === true
    && restore.migration_head === EXPECTED_MIGRATION
    && restore.restored_records === backup.checkpoint_records
    && restore.restored_digest === backup.checkpoint_digest
    && restore.restored_object_count === backup.object_count
    && restore.restored_object_digest === backup.object_digest
    && boundedDuration(restore.measured_rpo_ms, true)
    && boundedDuration(restore.measured_rto_ms, false)
    && restore.rto_clock_domain === 'monotonic'
    && restore.rto_measurement_scope === 'restore_runtime_role_fresh_process_verify'
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
  const identity = assertControlledEvidenceIdentity(input?.identity);
  const binding = verifyDrainRawBinding(input, identity);
  const result = binding?.result || {};
  assertControlledEvidenceSafe(result);
  const processIds = [
    result.orchestrator_pid,
    result.drain_node_pid,
    result.lost_node_pid,
    result.recovery_node_pid,
    result.fresh_verifier_pid
  ];
  const valid = binding !== null
    && result.status === 'passed'
    && boundedDuration(result.duration_ms, false)
    && result.clock_domain === 'monotonic'
    && processIds.every(positiveInteger)
    && new Set(processIds).size === processIds.length
    && result.drain_node_exit_code === 0
    && result.drain_node_exit_signal === null
    && result.lost_node_exit_code === null
    && result.lost_node_exit_signal === 'SIGKILL'
    && result.recovery_node_exit_code === 0
    && result.recovery_node_exit_signal === null
    && result.fresh_verifier_exit_code === 0
    && result.fresh_verifier_exit_signal === null
    && exactArray(result.phase_sequence, DRAIN_PHASES)
    && result.drain_rejection_code === 'component_node_draining'
    && positiveInteger(result.established_mutations_before_drain)
    && result.established_mutations_during_drain
      === result.established_mutations_before_drain
    && result.established_close_state === 'closed'
    && validInitialDrainReceipts(result.initial_nonzero_receipts)
    && validActiveZeroReceipts(result.active_zero_receipts)
    && sha256(result.receipts_manifest_sha256)
    && result.fresh_receipt_verification_count === DRAIN_AUTHORITIES.length
    && result.fresh_receipt_verified_phase === 'active_zero_verified'
    && token(result.initial_owner_node_id)
    && token(result.post_loss_owner_node_id)
    && result.initial_owner_node_id !== result.post_loss_owner_node_id
    && positiveU64(result.initial_owner_epoch)
    && positiveU64(result.post_loss_owner_epoch)
    && BigInt(result.post_loss_owner_epoch) > BigInt(result.initial_owner_epoch)
    && result.stale_owner_error_code === 'stale_owner_epoch'
    && result.post_loss_new_work_state === 'active'
    && validRollingSchema(result.rolling_schema)
    && sha256(result.unrelated_containers_before_sha256)
    && result.unrelated_containers_after_sha256
      === result.unrelated_containers_before_sha256
    && result.container_actions === 0
    && result.validation_processes_remaining === 0;
  return freeze({
    evidence_id: 'G02-E11-DRAIN',
    status: valid ? 'verified_controlled' : 'failed',
    production_eligible: false,
    evidence: valid ? freeze({
      ...result,
      identity,
      initial_nonzero_receipts: freeze(
        result.initial_nonzero_receipts.map((receipt) => freeze({ ...receipt }))
      ),
      active_zero_receipts: freeze(
        result.active_zero_receipts.map((receipt) => freeze({ ...receipt }))
      ),
      phase_sequence: freeze([...result.phase_sequence]),
      rolling_schema: freeze({ ...result.rolling_schema })
    }) : null
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
  const rejectionTotal = input.rejected_overloaded
    + input.rejected_retry_exhausted
    + input.rejected_fanout_exceeded;
  const valid = input.status === 'passed'
    && positiveInteger(input.operations)
    && input.operations <= MAX_OPERATIONS
    && positiveInteger(input.duration_ms)
    && input.duration_ms <= MAX_RECOVERY_MS
    && nonNegativeInteger(input.accepted)
    && positiveInteger(input.overloaded)
    && input.accepted + input.overloaded === input.operations
    && positiveInteger(input.rejected_overloaded)
    && positiveInteger(input.rejected_retry_exhausted)
    && positiveInteger(input.rejected_fanout_exceeded)
    && rejectionTotal === input.overloaded
    && configured.every(positiveInteger)
    && observed.every(nonNegativeInteger)
    && observed.every((value, index) => value === configured[index])
    && input.attempted_max_retry === input.configured_retry_limit + 1
    && input.attempted_max_fanout === input.configured_fanout_limit + 1
    && input.configured_retained_lease_limit
      === input.configured_active_limit + input.configured_pending_limit
    && input.observed_max_retained_leases === input.configured_retained_lease_limit
    && input.queued_requests_at_completion === 0
    && input.policy_rejections_preserved_admission_counters === true
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

function verifyDrainRawBinding(input, identity) {
  if (!plainRecord(input) || !plainRecord(input.raw_artifacts)
    || typeof input.raw_manifest !== 'string'
    || !exactKeys(input, ['identity', 'raw_artifacts', 'raw_manifest'])
    || !exactKeys(input.raw_artifacts, DRAIN_RAW_ARTIFACT_NAMES)) return null;
  try {
    assertEvidenceArtifactSafe(input.raw_manifest);
    for (const name of DRAIN_RAW_ARTIFACT_NAMES) {
      if (typeof input.raw_artifacts[name] !== 'string') return null;
      assertEvidenceArtifactSafe(input.raw_artifacts[name]);
    }
  } catch {
    return null;
  }
  if (digest(input.raw_manifest) !== identity.raw_output_sha256
    || !validRawManifest(input.raw_manifest, input.raw_artifacts)) return null;

  const result = parseCanonicalJson(input.raw_artifacts['drain-result.json']);
  const transitions = parseCanonicalJson(input.raw_artifacts['drain-receipts.json']);
  const keyBundle = parseCanonicalJson(input.raw_artifacts['drain-public-keys.json']);
  if (!plainRecord(result) || !exactKeys(result, DRAIN_RESULT_FIELDS)
    || !plainRecord(transitions) || !plainRecord(keyBundle)
    || input.raw_artifacts['drain-run.log'] !== `${JSON.stringify(result)}\n`
    || input.raw_artifacts['unrelated-containers-before.tsv']
      !== input.raw_artifacts['unrelated-containers-after.tsv']
    || result.unrelated_containers_before_sha256
      !== digest(input.raw_artifacts['unrelated-containers-before.tsv'])
    || result.unrelated_containers_after_sha256
      !== digest(input.raw_artifacts['unrelated-containers-after.tsv'])) return null;

  const verifiedKeys = verifiedDrainPublicKeys(keyBundle);
  if (!verifiedKeys || !exactKeys(transitions, ['active_zero_receipts', 'initial_receipts'])
    || !Array.isArray(transitions.initial_receipts)
    || !Array.isArray(transitions.active_zero_receipts)) return null;
  const initial = verifiedDrainReceiptSet(
    transitions.initial_receipts,
    keyBundle,
    verifiedKeys,
    1,
    false,
    identity
  );
  const activeZero = verifiedDrainReceiptSet(
    transitions.active_zero_receipts,
    keyBundle,
    verifiedKeys,
    2,
    true,
    identity
  );
  if (!initial || !activeZero
    || JSON.stringify(result.initial_nonzero_receipts) !== JSON.stringify(initial)
    || JSON.stringify(result.active_zero_receipts) !== JSON.stringify(activeZero)
    || result.receipts_manifest_sha256 !== digest(JSON.stringify(transitions))
    || result.drain_id !== keyBundle.drain_id
    || result.drain_node_id !== keyBundle.node_id
    || result.drain_owner_epoch !== keyBundle.owner_epoch) return null;
  return { result, transitions, key_bundle: keyBundle };
}

function validRawManifest(value, artifacts) {
  const expected = DRAIN_RAW_ARTIFACT_NAMES.map(
    (name) => `${digest(artifacts[name])}  ${name}\n`
  ).join('');
  return value === expected;
}

function parseCanonicalJson(value) {
  try {
    const parsed = JSON.parse(value);
    return value === `${JSON.stringify(parsed, null, 2)}\n` ? parsed : null;
  } catch {
    return null;
  }
}

function verifiedDrainPublicKeys(bundle) {
  if (!exactKeys(bundle, ['authority_key_ids', 'drain_id', 'node_id', 'owner_epoch', 'public_keys'])
    || !token(bundle.drain_id) || !token(bundle.node_id) || !positiveU64(bundle.owner_epoch)
    || !plainRecord(bundle.authority_key_ids) || !plainRecord(bundle.public_keys)
    || !exactKeys(bundle.authority_key_ids, DRAIN_AUTHORITIES)) return null;
  const keyIds = DRAIN_AUTHORITIES.map((authority) => bundle.authority_key_ids[authority]);
  if (keyIds.some((keyId) => !token(keyId)) || new Set(keyIds).size !== DRAIN_AUTHORITIES.length
    || !exactKeys(bundle.public_keys, [...keyIds].sort())) return null;
  const keys = new Map();
  const fingerprints = new Set();
  try {
    for (const keyId of keyIds) {
      const key = createPublicKey(bundle.public_keys[keyId]);
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return null;
      const fingerprint = createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' }))
        .digest('hex');
      if (fingerprints.has(fingerprint)) return null;
      fingerprints.add(fingerprint);
      keys.set(keyId, key);
    }
  } catch {
    return null;
  }
  return keys;
}

function verifiedDrainReceiptSet(receipts, bundle, publicKeys, revision, activeZero, identity) {
  if (receipts.length !== DRAIN_AUTHORITIES.length) return null;
  const summaries = [];
  const authorities = new Set();
  for (const receipt of receipts) {
    if (!plainRecord(receipt) || !exactKeys(receipt, ['body', 'key_id', 'signature'])
      || !token(receipt.key_id) || !validDrainReceiptBody(receipt.body)
      || authorities.has(receipt.body.authority)
      || receipt.key_id !== bundle.authority_key_ids[receipt.body.authority]
      || receipt.body.drain_id !== bundle.drain_id
      || receipt.body.node_id !== bundle.node_id
      || receipt.body.owner_epoch !== bundle.owner_epoch
      || receipt.body.receipt_revision !== revision
      || receipt.body.active_count !== (
        !activeZero && receipt.body.authority === 'communication_attached_generations' ? '1' : '0'
      )
      || Date.parse(receipt.body.observed_at) < Date.parse(identity.started_at)
      || Date.parse(receipt.body.observed_at) > Date.parse(identity.completed_at)
      || !/^[A-Za-z0-9_-]{86}$/u.test(receipt.signature)) return null;
    const key = publicKeys.get(receipt.key_id);
    if (!key || !cryptoVerify(
      null,
      Buffer.from(canonicalDrainReceiptBody(receipt.body), 'utf8'),
      key,
      Buffer.from(receipt.signature, 'base64url')
    )) return null;
    authorities.add(receipt.body.authority);
    summaries.push({
      authority: receipt.body.authority,
      key_id: receipt.key_id,
      receipt_revision: receipt.body.receipt_revision,
      active_count: receipt.body.active_count,
      body_sha256: digest(JSON.stringify(receipt.body)),
      signature_sha256: digest(receipt.signature)
    });
  }
  return DRAIN_AUTHORITIES.every((authority) => authorities.has(authority)) ? summaries : null;
}

function validDrainReceiptBody(body) {
  if (!plainRecord(body) || !exactKeys(body, DRAIN_RECEIPT_BODY_FIELDS)
    || body.schema_version !== '1.0.0' || !token(body.drain_id) || !token(body.node_id)
    || !positiveU64(body.owner_epoch) || !DRAIN_AUTHORITIES.includes(body.authority)
    || !positiveInteger(body.receipt_revision) || !u64(body.active_count)
    || !sha256(body.active_id_digest) || !canonicalTimestamp(body.observed_at)
    || !canonicalTimestamp(body.expires_at)) return false;
  const observedAt = Date.parse(body.observed_at);
  const expiresAt = Date.parse(body.expires_at);
  return expiresAt > observedAt && expiresAt - observedAt <= 300_000;
}

function canonicalDrainReceiptBody(body) {
  return JSON.stringify({
    schema_version: body.schema_version,
    drain_id: body.drain_id,
    node_id: body.node_id,
    owner_epoch: body.owner_epoch,
    authority: body.authority,
    receipt_revision: body.receipt_revision,
    active_count: body.active_count,
    active_id_digest: body.active_id_digest,
    observed_at: body.observed_at,
    expires_at: body.expires_at
  });
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length
    && required.every((key, index) => actual[index] === key);
}

function validInitialDrainReceipts(value) {
  if (!Array.isArray(value) || value.length !== DRAIN_AUTHORITIES.length) return false;
  const authorities = new Set();
  for (const receipt of value) {
    if (!plainRecord(receipt) || !DRAIN_AUTHORITIES.includes(receipt.authority)
      || authorities.has(receipt.authority) || !token(receipt.key_id)
      || receipt.receipt_revision !== 1
      || receipt.active_count !== (
        receipt.authority === 'communication_attached_generations' ? '1' : '0'
      )
      || !sha256(receipt.body_sha256) || !sha256(receipt.signature_sha256)) return false;
    authorities.add(receipt.authority);
  }
  return DRAIN_AUTHORITIES.every((authority) => authorities.has(authority));
}

function validActiveZeroReceipts(value) {
  if (!Array.isArray(value) || value.length !== DRAIN_AUTHORITIES.length) return false;
  const authorities = new Set();
  const keyIds = new Set();
  const bodies = new Set();
  const signatures = new Set();
  for (const receipt of value) {
    if (!plainRecord(receipt) || !DRAIN_AUTHORITIES.includes(receipt.authority)
      || authorities.has(receipt.authority) || !token(receipt.key_id)
      || keyIds.has(receipt.key_id) || receipt.receipt_revision !== 2
      || receipt.active_count !== '0' || !sha256(receipt.body_sha256)
      || bodies.has(receipt.body_sha256) || !sha256(receipt.signature_sha256)
      || signatures.has(receipt.signature_sha256)) return false;
    authorities.add(receipt.authority);
    keyIds.add(receipt.key_id);
    bodies.add(receipt.body_sha256);
    signatures.add(receipt.signature_sha256);
  }
  return DRAIN_AUTHORITIES.every((authority) => authorities.has(authority));
}

function validRollingSchema(value) {
  return plainRecord(value)
    && value.n_plus_1_reads_n === 'accepted'
    && value.additive_minor === 'accepted'
    && value.unknown_major === 'quarantined:unsupported_schema_version'
    && value.duplicate === 'replay'
    && value.stale === 'stale'
    && value.gap === 'gap_requires_reconcile'
    && value.distinct_ordering_key === 'insert';
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && expected.every((item, index) => value[index] === item);
}

function positiveU64(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function u64(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
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

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
