export type KeyState =
  | 'generated'
  | 'staged'
  | 'active'
  | 'retiring'
  | 'revoked'
  | 'expired'
  | 'destroyed';

export type KeyPurpose = 'signing' | 'encryption' | 'mtls' | 'provider_credential';

export interface KeyVersion {
  key_ring_id: string;
  key_id: string;
  key_version: number;
  purpose: KeyPurpose;
  state: KeyState;
  material_ref: string;
  revision: number;
  writer_id: string;
  writer_epoch: number;
  not_before: string;
  expires_at: string;
  state_changed_at: string;
  overlap_until: string | null;
  last_command_id: string | null;
  last_command_digest: string | null;
}

export interface KeyTransitionCommand {
  command_id: string;
  command_digest: string;
  expected_revision: number;
  target_state: KeyState;
  writer_id: string;
  writer_epoch: number;
  effective_at: string;
  overlap_until: string | null;
  kms_available: boolean;
  pki_available: boolean;
  plaintext_fallback_requested: boolean;
}

export type SecretSink =
  | 'kms'
  | 'locked_memory'
  | 'database'
  | 'event'
  | 'log'
  | 'metric'
  | 'prompt'
  | 'evidence'
  | 'core_dump';

export interface CertificateBindingInput {
  ca_trusted: boolean;
  san_service_id: string;
  expected_san_service_id: string;
  service_identity: string;
  expected_service_identity: string;
  audience: readonly string[];
  required_audience: string;
  key_version: number;
  minimum_key_version: number;
  not_before: string;
  expires_at: string;
  revoked: boolean;
  wall_now: Date;
}

export interface NativeSourceGateInput {
  source_sha256: string;
  expected_source_sha256: string;
  abi_reviewed: boolean;
  bounded_memory: boolean;
  zeroize: boolean;
  core_dump_disabled: boolean;
  fuzz_or_sanitizer_evidence: boolean;
  independent_fault_isolation: boolean;
}

const KEY_FIELDS = [
  'key_ring_id', 'key_id', 'key_version', 'purpose', 'state', 'material_ref',
  'revision', 'writer_id', 'writer_epoch', 'not_before', 'expires_at',
  'state_changed_at', 'overlap_until', 'last_command_id', 'last_command_digest'
] as const;
const COMMAND_FIELDS = [
  'command_id', 'command_digest', 'expected_revision', 'target_state', 'writer_id',
  'writer_epoch', 'effective_at', 'overlap_until', 'kms_available', 'pki_available',
  'plaintext_fallback_requested'
] as const;
const KEY_STATES: readonly KeyState[] = [
  'generated', 'staged', 'active', 'retiring', 'revoked', 'expired', 'destroyed'
];
const KEY_PURPOSES: readonly KeyPurpose[] = ['signing', 'encryption', 'mtls', 'provider_credential'];
const SECRET_SINKS: readonly SecretSink[] = [
  'kms', 'locked_memory', 'database', 'event', 'log', 'metric', 'prompt', 'evidence', 'core_dump'
];
const MAX_TRANSITION_OVERLAP_MS = 24 * 60 * 60 * 1_000;
const TRANSITIONS: Readonly<Record<KeyState, readonly KeyState[]>> = {
  generated: ['staged', 'revoked'],
  staged: ['active', 'revoked'],
  active: ['retiring', 'revoked'],
  retiring: ['expired', 'revoked'],
  revoked: ['destroyed'],
  expired: ['destroyed'],
  destroyed: []
};

export function decideKeyTransition(
  current: KeyVersion,
  command: KeyTransitionCommand
): 'apply' | 'replay' | 'conflict' | 'invalid_transition' {
  if (!validKeyVersion(current) || !validTransitionCommand(command)) return 'invalid_transition';
  if (current.last_command_id === command.command_id) {
    return current.last_command_digest === command.command_digest ? 'replay' : 'conflict';
  }
  if (command.expected_revision !== current.revision || command.writer_epoch < current.writer_epoch) {
    return 'conflict';
  }
  if (command.writer_epoch === current.writer_epoch && command.writer_id !== current.writer_id) return 'conflict';
  if (command.plaintext_fallback_requested) return 'invalid_transition';
  if (!TRANSITIONS[current.state].includes(command.target_state)) return 'invalid_transition';

  const effectiveAt = Date.parse(command.effective_at);
  if (effectiveAt < Date.parse(current.state_changed_at)) return 'invalid_transition';
  if (command.target_state === 'retiring') {
    const overlapUntil = command.overlap_until === null ? Number.NaN : Date.parse(command.overlap_until);
    if (!Number.isFinite(overlapUntil) || overlapUntil <= effectiveAt
      || overlapUntil - effectiveAt > MAX_TRANSITION_OVERLAP_MS) return 'invalid_transition';
  } else if (command.overlap_until !== null) {
    return 'invalid_transition';
  }
  if (command.target_state === 'expired' && effectiveAt < Date.parse(current.expires_at)) {
    return 'invalid_transition';
  }
  if (requiresKeyMaterial(command.target_state) && !command.kms_available) return 'invalid_transition';
  if ((command.target_state === 'staged' || command.target_state === 'active')
    && current.purpose === 'mtls' && !command.pki_available) return 'invalid_transition';
  return 'apply';
}

export function resolveKeyUsage(input: {
  keys: readonly KeyVersion[];
  wall_now: Date;
  max_overlap_ms: number;
}): { write_key_id: string; read_key_ids: string[] } {
  if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 64
    || !validDate(input.wall_now) || !positiveInteger(input.max_overlap_ms)
    || input.max_overlap_ms > MAX_TRANSITION_OVERLAP_MS || !input.keys.every(validKeyVersion)) {
    throw new Error('key_set_invalid');
  }
  const first = input.keys[0];
  if (input.keys.some((item) => item.key_ring_id !== first.key_ring_id || item.purpose !== first.purpose)) {
    throw new Error('key_set_invalid');
  }
  if (new Set(input.keys.map((item) => item.key_id)).size !== input.keys.length
    || new Set(input.keys.map((item) => item.key_version)).size !== input.keys.length) {
    throw new Error('key_set_invalid');
  }

  const now = input.wall_now.getTime();
  const active = input.keys.filter((item) => item.state === 'active'
    && Date.parse(item.not_before) <= now && now < Date.parse(item.expires_at));
  if (active.length !== 1) throw new Error('key_write_authority_invalid');
  const retiring = input.keys.filter((item) => {
    if (item.state !== 'retiring') return false;
    const changedAt = Date.parse(item.state_changed_at);
    const overlapUntil = Date.parse(item.overlap_until!);
    if (overlapUntil <= changedAt || overlapUntil - changedAt > input.max_overlap_ms) {
      throw new Error('key_overlap_invalid');
    }
    return Date.parse(item.not_before) <= now
      && now < Date.parse(item.expires_at)
      && now < overlapUntil;
  }).sort((left, right) => right.key_version - left.key_version);
  return {
    write_key_id: active[0].key_id,
    read_key_ids: [active[0].key_id, ...retiring.map((item) => item.key_id)]
  };
}

export function assertSafeSecretSink(input: {
  sink: SecretSink;
  contains_raw_material: boolean;
}): void {
  if (!plainRecord(input) || Object.keys(input).length !== 2 || !SECRET_SINKS.includes(input.sink)
    || typeof input.contains_raw_material !== 'boolean') throw new Error('secret_sink_invalid');
  if (input.contains_raw_material && input.sink !== 'kms' && input.sink !== 'locked_memory') {
    throw new Error('raw_secret_sink_forbidden');
  }
}

export function evaluateCertificateBinding(input: CertificateBindingInput):
  { allowed: true } | { allowed: false; reason: string } {
  if (!validCertificateInput(input)) return denied('certificate_binding_invalid');
  if (!input.ca_trusted) return denied('ca_untrusted');
  if (input.san_service_id !== input.expected_san_service_id) return denied('san_mismatch');
  if (input.service_identity !== input.expected_service_identity) return denied('service_mismatch');
  if (!input.audience.includes(input.required_audience)) return denied('audience_mismatch');
  if (input.key_version < input.minimum_key_version) return denied('key_version_stale');
  if (input.revoked) return denied('certificate_revoked');
  const now = input.wall_now.getTime();
  if (now < Date.parse(input.not_before)) return denied('certificate_not_yet_valid');
  if (now >= Date.parse(input.expires_at)) return denied('certificate_expired');
  return { allowed: true };
}

export function evaluateNativeSourceGate(input: NativeSourceGateInput):
  { enabled: true } | { enabled: false; reason: string } {
  if (!plainRecord(input) || !sha256(input.source_sha256) || !sha256(input.expected_source_sha256)) {
    return nativeDenied('native_gate_invalid');
  }
  if (input.source_sha256 !== input.expected_source_sha256) return nativeDenied('source_mismatch');
  for (const [field, reason] of [
    ['abi_reviewed', 'abi_review_required'],
    ['bounded_memory', 'bounded_memory_required'],
    ['zeroize', 'zeroize_required'],
    ['core_dump_disabled', 'core_dump_must_be_disabled'],
    ['fuzz_or_sanitizer_evidence', 'fuzz_or_sanitizer_evidence_required'],
    ['independent_fault_isolation', 'fault_isolation_required']
  ] as const) {
    if (input[field] !== true) return nativeDenied(reason);
  }
  if (Object.keys(input).length !== 8) return nativeDenied('native_gate_invalid');
  return { enabled: true };
}

function validKeyVersion(value: KeyVersion): boolean {
  if (!exactRecord(value, KEY_FIELDS) || !keyPart(value.key_ring_id) || !keyPart(value.key_id)
    || !positiveInteger(value.key_version) || !KEY_PURPOSES.includes(value.purpose)
    || !KEY_STATES.includes(value.state) || !materialReference(value.material_ref)
    || !positiveInteger(value.revision) || !keyPart(value.writer_id)
    || !nonNegativeInteger(value.writer_epoch)) return false;
  const notBefore = canonicalTimestamp(value.not_before);
  const expiresAt = canonicalTimestamp(value.expires_at);
  if (notBefore === null || expiresAt === null || notBefore >= expiresAt
    || canonicalTimestamp(value.state_changed_at) === null) return false;
  if (value.state === 'retiring') {
    if (canonicalTimestamp(value.overlap_until) === null) return false;
  } else if (value.overlap_until !== null) return false;
  if ((value.last_command_id === null) !== (value.last_command_digest === null)) return false;
  return value.last_command_id === null
    || (keyPart(value.last_command_id) && sha256(value.last_command_digest));
}

function validTransitionCommand(value: KeyTransitionCommand): boolean {
  return exactRecord(value, COMMAND_FIELDS) && keyPart(value.command_id) && sha256(value.command_digest)
    && positiveInteger(value.expected_revision) && KEY_STATES.includes(value.target_state)
    && keyPart(value.writer_id) && nonNegativeInteger(value.writer_epoch)
    && canonicalTimestamp(value.effective_at) !== null
    && (value.overlap_until === null || canonicalTimestamp(value.overlap_until) !== null)
    && typeof value.kms_available === 'boolean' && typeof value.pki_available === 'boolean'
    && typeof value.plaintext_fallback_requested === 'boolean';
}

function validCertificateInput(value: CertificateBindingInput): boolean {
  if (!plainRecord(value) || Object.keys(value).length !== 13 || typeof value.ca_trusted !== 'boolean'
    || !boundedText(value.san_service_id, 512) || !boundedText(value.expected_san_service_id, 512)
    || !keyPart(value.service_identity) || !keyPart(value.expected_service_identity)
    || !boundedStringSet(value.audience) || !keyPart(value.required_audience)
    || !positiveInteger(value.key_version) || !positiveInteger(value.minimum_key_version)
    || typeof value.revoked !== 'boolean' || !validDate(value.wall_now)) return false;
  const notBefore = canonicalTimestamp(value.not_before);
  const expiresAt = canonicalTimestamp(value.expires_at);
  return notBefore !== null && expiresAt !== null && notBefore < expiresAt;
}

function requiresKeyMaterial(target: KeyState): boolean {
  return target === 'staged' || target === 'active' || target === 'destroyed';
}

function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, any> {
  if (!plainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function materialReference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^(?:kms|pki):\/\/[A-Za-z0-9/_.-]+$/u.test(value);
}

function keyPart(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedStringSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64
    && value.every(keyPart) && new Set(value).size === value.length;
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function denied(reason: string): { allowed: false; reason: string } {
  return { allowed: false, reason };
}

function nativeDenied(reason: string): { enabled: false; reason: string } {
  return { enabled: false, reason };
}
