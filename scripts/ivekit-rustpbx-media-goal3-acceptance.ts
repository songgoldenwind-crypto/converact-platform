import { createHash } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_EVIDENCE_BYTES = 1_048_576;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REASON = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,255}$/;
const FORBIDDEN_KEY = /(?:authorization|cookie|password|private[_-]?key|secret|token|credential|raw[_-]?(?:log|packet|sdp))/i;
const FORBIDDEN_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{32,})/i;

export const GOAL3_ACCEPTANCE_CHECKS = [
  check('deployment_readiness', ['ordinary', 't1']),
  check('invite_183_prack_200_ack_bye', ['ordinary', 't1']),
  check('cancel_before_offer', ['ordinary', 't1']),
  check('cancel_after_offer', ['ordinary', 't1']),
  check('cancel_200_race', ['ordinary', 't1']),
  check('update_reinvite_hold_resume', ['ordinary', 't1']),
  check('dtmf_session_timer', ['ordinary', 't1']),
  check('rtp_rtcp_bidirectional', ['ordinary', 't1']),
  check('sdes_srtp_bidirectional', ['ordinary', 't1']),
  check('effective_sdp_sequence_continuity', ['ordinary', 't1']),
  check('rustpbx_owner_outage_media_continuity', ['ordinary', 't1']),
  check('media_control_outage_media_continuity', ['ordinary', 't1']),
  check('media_control_unknown_reconcile', ['ordinary', 't1']),
  check('rtpengine_outage_classified', ['ordinary', 't1']),
  check('recorder_outage_isolation', ['ordinary', 't1']),
  check('object_storage_outage_isolation', ['ordinary', 't1']),
  check('postgres_outage_contract', ['ordinary', 't1']),
  check('nats_outage_ordinary_continuity', ['ordinary']),
  check('t1_shadow_quorum_fail_closed', ['t1']),
  check('t1_owner_takeover_under_5000ms', ['t1']),
  check('orphan_cleanup_under_60000ms', ['ordinary', 't1']),
  check('rolling_rollback_media_continuity', ['ordinary', 't1']),
  check('dual_leg_cdr_convergence', ['ordinary', 't1']),
  check('tracing_continuity', ['ordinary', 't1']),
  check('led_services_unchanged', ['ordinary', 't1'])
] as const;

export type Goal3AcceptanceCheckId =
  typeof GOAL3_ACCEPTANCE_CHECKS[number]['id'];
export type Goal3AcceptanceStatus =
  'passed' | 'failed' | 'not_run';
export type Goal3ProfileStatus =
  'passed' | 'failed' | 'not_run';
export type Goal3OptionalCapability =
  'kernel_forwarding' | 'recording' | 'transcoding' | 'capacity';

export interface Goal3AcceptanceCheckInput {
  status: Goal3AcceptanceStatus;
  evidence_sha256: string;
  duration_ms: number;
  measurements: Record<string, unknown>;
  reason?: string;
}

export interface Goal3OptionalCapabilityInput {
  status: Goal3AcceptanceStatus;
  evidence_sha256: string;
  reason?: string;
}

export interface RustPbxMediaGoal3AcceptanceInput {
  schema_version: '1.0.0';
  attempt_id: string;
  started_at: string;
  finished_at: string;
  source_identity: {
    opc_commit: string;
    rustpbx_commit: string;
    rsipstack_commit: string;
    rustrtc_commit: string;
    rtpengine_commit: string;
    rustpbx_patch_ids: string[];
    rustpbx_patch_set_sha256: string;
    rtpengine_patch_set_sha256: string;
    opc_image_digest: string;
    media_control_image_digest: string;
    rustpbx_image_digest: string;
    rtpengine_image_digest: string;
    runtime_config_sha256: string;
    host_kernel: string;
  };
  environment: {
    environment_class: 'real_server';
    project_name: string;
    led_container_fingerprint_before: string;
    led_container_fingerprint_after: string;
  };
  checks: Record<Goal3AcceptanceCheckId, Goal3AcceptanceCheckInput>;
  optional_capabilities: Record<
    Goal3OptionalCapability,
    Goal3OptionalCapabilityInput
  >;
}

export interface RustPbxMediaGoal3AcceptanceEvidence {
  schema_version: '1.0.0';
  evidence_type: 'rustpbx_media_goal3_acceptance';
  attempt_id: string;
  status: 'passed' | 'failed' | 'incomplete' | 'invalid_identity';
  identity_status: 'passed' | 'failed';
  identity_errors: string[];
  started_at: string;
  finished_at: string;
  generated_at: string;
  source_identity: RustPbxMediaGoal3AcceptanceInput['source_identity'];
  environment: RustPbxMediaGoal3AcceptanceInput['environment'] & {
    led_services_unchanged: boolean;
  };
  profiles: {
    ordinary: Goal3ProfileStatus;
    t1: Goal3ProfileStatus;
  };
  checks: Record<Goal3AcceptanceCheckId, Goal3AcceptanceCheckInput>;
  optional_capabilities: RustPbxMediaGoal3AcceptanceInput['optional_capabilities'];
  not_run: string[];
  capacity_claim: 'none';
  raw_input_sha256: string;
}

interface Goal3Contract {
  sources: Record<
    'rustpbx' | 'rsipstack' | 'rustrtc' | 'rtpengine',
    { repository: string; commit: string }
  >;
  required_patch_ids: string[];
  evidence: {
    retain_invalid_attempts: boolean;
    forbid_secret_material: boolean;
  };
}

export function buildRustPbxMediaGoal3Acceptance(
  rawInput: RustPbxMediaGoal3AcceptanceInput,
  rawContract: Record<string, unknown>
): RustPbxMediaGoal3AcceptanceEvidence {
  const input = structuredClone(rawInput);
  const contract = checkedContract(rawContract);
  validateInput(input);
  const identityErrors = identityErrorsFor(input, contract);
  const identityValid = identityErrors.length === 0;
  const ledServicesUnchanged =
    input.environment.led_container_fingerprint_before ===
    input.environment.led_container_fingerprint_after;
  const profiles = identityValid
    ? {
        ordinary: profileStatus(input, 'ordinary'),
        t1: profileStatus(input, 't1')
      }
    : { ordinary: 'not_run' as const, t1: 'not_run' as const };
  const attemptedFailure = Object.values(input.checks)
    .some((entry) => entry.status === 'failed') ||
    Object.values(input.optional_capabilities)
      .some((entry) => entry.status === 'failed');
  const status = !identityValid
    ? 'invalid_identity'
    : !ledServicesUnchanged || attemptedFailure
      ? 'failed'
      : profiles.ordinary === 'not_run' || profiles.t1 === 'not_run'
        ? 'incomplete'
        : 'passed';
  const notRun = [
    ...Object.entries(input.checks)
      .filter(([, entry]) => entry.status === 'not_run')
      .map(([id]) => id),
    ...Object.entries(input.optional_capabilities)
      .filter(([, entry]) => entry.status === 'not_run')
      .map(([id]) => id)
  ].sort();

  const evidence: RustPbxMediaGoal3AcceptanceEvidence = {
    schema_version: '1.0.0',
    evidence_type: 'rustpbx_media_goal3_acceptance',
    attempt_id: input.attempt_id,
    status,
    identity_status: identityValid ? 'passed' : 'failed',
    identity_errors: identityErrors,
    started_at: input.started_at,
    finished_at: input.finished_at,
    generated_at: input.finished_at,
    source_identity: input.source_identity,
    environment: {
      ...input.environment,
      led_services_unchanged: ledServicesUnchanged
    },
    profiles,
    checks: input.checks,
    optional_capabilities: input.optional_capabilities,
    not_run: notRun,
    capacity_claim: 'none',
    raw_input_sha256: canonicalSha256(input)
  };
  assertBounded(evidence, 'Goal 3 acceptance evidence');
  return evidence;
}

function check<
  Id extends string,
  Profile extends 'ordinary' | 't1'
>(id: Id, profiles: readonly Profile[]) {
  return { id, profiles };
}

function checkedContract(raw: Record<string, unknown>): Goal3Contract {
  const contract = raw as unknown as Goal3Contract;
  if (!contract || typeof contract !== 'object' ||
      !contract.sources || !Array.isArray(contract.required_patch_ids) ||
      contract.evidence?.retain_invalid_attempts !== true ||
      contract.evidence?.forbid_secret_material !== true) {
    throw new Error('Goal 3 contract is invalid');
  }
  for (const component of ['rustpbx', 'rsipstack', 'rustrtc', 'rtpengine'] as const) {
    if (!COMMIT.test(String(contract.sources[component]?.commit || ''))) {
      throw new Error(`Goal 3 contract ${component} identity is invalid`);
    }
  }
  if (contract.required_patch_ids.length < 1 ||
      new Set(contract.required_patch_ids).size !==
        contract.required_patch_ids.length ||
      contract.required_patch_ids.some((id) => !IDENTIFIER.test(id))) {
    throw new Error('Goal 3 contract patch identities are invalid');
  }
  return structuredClone(contract);
}

function validateInput(input: RustPbxMediaGoal3AcceptanceInput): void {
  assertBounded(input, 'Goal 3 acceptance input');
  if (input.schema_version !== '1.0.0') {
    throw new Error('unsupported Goal 3 acceptance schema');
  }
  identifier(input.attempt_id, 'attempt ID');
  const startedAt = canonicalTimestamp(input.started_at, 'started at');
  const finishedAt = canonicalTimestamp(input.finished_at, 'finished at');
  if (finishedAt <= startedAt) {
    throw new Error('Goal 3 acceptance finish must follow start');
  }
  validateSourceIdentity(input.source_identity);
  validateEnvironment(input.environment);

  if (!plainRecord(input.checks) ||
      Object.keys(input.checks).length !== GOAL3_ACCEPTANCE_CHECKS.length) {
    throw new Error('complete Goal 3 acceptance checks are required');
  }
  const knownChecks = new Set(GOAL3_ACCEPTANCE_CHECKS.map(({ id }) => id));
  for (const key of Object.keys(input.checks)) {
    if (!knownChecks.has(key as Goal3AcceptanceCheckId)) {
      throw new Error(`unknown Goal 3 acceptance check: ${key}`);
    }
  }
  for (const { id } of GOAL3_ACCEPTANCE_CHECKS) {
    validateCheck(input.checks[id], id);
  }
  validateMeasurementThreshold(
    input.checks.t1_owner_takeover_under_5000ms,
    'takeover_rto_ms',
    5_000
  );
  validateMeasurementThreshold(
    input.checks.orphan_cleanup_under_60000ms,
    'orphan_cleanup_ms',
    60_000
  );

  const optionalKeys: Goal3OptionalCapability[] = [
    'kernel_forwarding',
    'recording',
    'transcoding',
    'capacity'
  ];
  if (!plainRecord(input.optional_capabilities) ||
      Object.keys(input.optional_capabilities).length !== optionalKeys.length) {
    throw new Error('complete optional capability status is required');
  }
  for (const key of optionalKeys) {
    validateStatusEvidence(input.optional_capabilities[key], `optional ${key}`);
  }
  for (const key of Object.keys(input.optional_capabilities)) {
    if (!optionalKeys.includes(key as Goal3OptionalCapability)) {
      throw new Error(`unknown Goal 3 optional capability: ${key}`);
    }
  }
}

function validateSourceIdentity(
  identity: RustPbxMediaGoal3AcceptanceInput['source_identity']
): void {
  if (!COMMIT.test(identity.opc_commit)) {
    throw new Error('OPC source commit is invalid');
  }
  for (const field of [
    'rustpbx_commit',
    'rsipstack_commit',
    'rustrtc_commit',
    'rtpengine_commit'
  ] as const) {
    if (!COMMIT.test(identity[field])) {
      throw new Error(`${field} is invalid`);
    }
  }
  if (!Array.isArray(identity.rustpbx_patch_ids) ||
      identity.rustpbx_patch_ids.length < 1 ||
      identity.rustpbx_patch_ids.length > 128 ||
      new Set(identity.rustpbx_patch_ids).size !==
        identity.rustpbx_patch_ids.length ||
      identity.rustpbx_patch_ids.some((id) => !IDENTIFIER.test(id))) {
    throw new Error('RustPBX patch identities are invalid');
  }
  for (const field of [
    'rustpbx_patch_set_sha256',
    'rtpengine_patch_set_sha256',
    'runtime_config_sha256'
  ] as const) {
    if (!SHA256.test(identity[field])) {
      throw new Error(`${field} is invalid`);
    }
  }
  for (const field of [
    'opc_image_digest',
    'media_control_image_digest',
    'rustpbx_image_digest',
    'rtpengine_image_digest'
  ] as const) {
    if (!IMAGE_DIGEST.test(identity[field])) {
      throw new Error(`${field} is invalid`);
    }
  }
  const kernel = String(identity.host_kernel || '');
  if (kernel.length < 8 || kernel.length > 256 ||
      /[\r\n\0]/.test(kernel)) {
    throw new Error('host kernel identity is invalid');
  }
}

function validateEnvironment(
  environment: RustPbxMediaGoal3AcceptanceInput['environment']
): void {
  if (environment.environment_class !== 'real_server') {
    throw new Error('Goal 3 acceptance requires a real server');
  }
  if (!/^ivekit-goal3-[a-z0-9][a-z0-9-]{0,62}$/.test(
    environment.project_name
  )) {
    throw new Error('Goal 3 acceptance project name is invalid');
  }
  sha256(
    environment.led_container_fingerprint_before,
    'LED before fingerprint'
  );
  sha256(
    environment.led_container_fingerprint_after,
    'LED after fingerprint'
  );
}

function validateCheck(
  entry: Goal3AcceptanceCheckInput,
  id: Goal3AcceptanceCheckId
): void {
  validateStatusEvidence(entry, `check ${id}`);
  if (!Number.isSafeInteger(entry.duration_ms) ||
      entry.duration_ms < 0 || entry.duration_ms > 86_400_000) {
    throw new Error(`Goal 3 check ${id} duration is invalid`);
  }
  if (!plainRecord(entry.measurements)) {
    throw new Error(`Goal 3 check ${id} measurements are invalid`);
  }
  checkedMeasurements(entry.measurements, 0);
}

function validateStatusEvidence(
  entry: Goal3OptionalCapabilityInput,
  label: string
): void {
  if (!entry || !['passed', 'failed', 'not_run'].includes(entry.status)) {
    throw new Error(`Goal 3 ${label} status is invalid`);
  }
  sha256(entry.evidence_sha256, `${label} evidence`);
  const reason = String(entry.reason || '');
  if (entry.status === 'not_run') {
    if (!SAFE_REASON.test(reason)) {
      throw new Error(`Goal 3 ${label} not_run reason is required`);
    }
  } else if (reason && !SAFE_REASON.test(reason)) {
    throw new Error(`Goal 3 ${label} reason is invalid`);
  }
}

function validateMeasurementThreshold(
  entry: Goal3AcceptanceCheckInput,
  key: string,
  maximum: number
): void {
  if (entry.status !== 'passed') return;
  const value = entry.measurements[key];
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value < 0 || value > maximum) {
    throw new Error(`passed Goal 3 check requires ${key} <= ${maximum}`);
  }
}

function checkedMeasurements(value: Record<string, unknown>, depth: number): void {
  if (depth > 4 || Object.keys(value).length > 128) {
    throw new Error('Goal 3 measurements must remain bounded');
  }
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      throw new Error('Goal 3 measurement key is invalid');
    }
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error('Goal 3 evidence contains secret material or raw payloads');
    }
    if (typeof item === 'string') {
      if (item.length > 512) {
        throw new Error('Goal 3 measurements must remain bounded');
      }
      if (FORBIDDEN_VALUE.test(item)) {
        throw new Error('Goal 3 evidence contains secret material');
      }
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new Error('Goal 3 measurement number is invalid');
      }
    } else if (typeof item === 'boolean' || item === null) {
      continue;
    } else if (Array.isArray(item)) {
      if (item.length > 128) {
        throw new Error('Goal 3 measurements must remain bounded');
      }
      for (const child of item) {
        checkedMeasurements({ value: child }, depth + 1);
      }
    } else if (plainRecord(item)) {
      checkedMeasurements(item, depth + 1);
    } else {
      throw new Error('Goal 3 measurement value is invalid');
    }
  }
}

function identityErrorsFor(
  input: RustPbxMediaGoal3AcceptanceInput,
  contract: Goal3Contract
): string[] {
  const errors: string[] = [];
  for (const component of [
    'rustpbx',
    'rsipstack',
    'rustrtc',
    'rtpengine'
  ] as const) {
    const field = `${component}_commit` as const;
    if (input.source_identity[field] !== contract.sources[component].commit) {
      errors.push(`${field}_mismatch`);
    }
  }
  if (!sameStrings(
    input.source_identity.rustpbx_patch_ids,
    contract.required_patch_ids
  )) {
    errors.push('rustpbx_patch_ids_mismatch');
  }
  return errors.sort();
}

function profileStatus(
  input: RustPbxMediaGoal3AcceptanceInput,
  profile: 'ordinary' | 't1'
): Goal3ProfileStatus {
  const statuses = GOAL3_ACCEPTANCE_CHECKS
    .filter((entry) => entry.profiles.includes(profile as never))
    .map((entry) => input.checks[entry.id].status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('not_run')) return 'not_run';
  return 'passed';
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function canonicalTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Goal 3 ${label} timestamp is invalid`);
  }
  return parsed;
}

function identifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`Goal 3 ${label} is invalid`);
}

function sha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`Goal 3 ${label} SHA-256 is invalid`);
}

function plainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertBounded(value: unknown, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new Error(`${label} exceeds 1 MiB and is not bounded`);
  }
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

function readBoundedJson(path: string): Record<string, unknown> {
  const resolved = realpathSync(resolve(path));
  const metadata = statSync(resolved);
  if (!metadata.isFile() || metadata.size < 2 ||
      metadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error('Goal 3 JSON input must be a bounded regular file');
  }
  return JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, unknown>;
}

function runCli(argv: string[]): void {
  const [inputPath, outputPath, contractPath =
    'docs/capacity/contracts/voice-media-goal3-v1.json'] = argv;
  if (!inputPath || !outputPath) {
    throw new Error(
      'usage: ivekit-rustpbx-media-goal3-acceptance <input.json> <output.json> [contract.json]'
    );
  }
  const input = readBoundedJson(inputPath) as unknown as
    RustPbxMediaGoal3AcceptanceInput;
  const contract = readBoundedJson(contractPath);
  const inputReal = realpathSync(resolve(inputPath));
  const contractReal = realpathSync(resolve(contractPath));
  const output = resolve(outputPath);
  if (output === inputReal || output === contractReal) {
    throw new Error('Goal 3 output must not overwrite an input');
  }
  const evidence = buildRustPbxMediaGoal3Acceptance(input, contract);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status !== 'passed') process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Goal 3 acceptance failed'}\n`
    );
    process.exitCode = 1;
  }
}
