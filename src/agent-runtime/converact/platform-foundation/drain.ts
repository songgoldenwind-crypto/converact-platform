import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto';

import {
  createPlatformDeadline,
  platformDeadlineState,
  type PlatformClock,
  type PlatformDeadline
} from './clock.js';

export const PLATFORM_DRAIN_AUTHORITIES = Object.freeze([
  'platform_worker_leases',
  'domain_event_inflight',
  'communication_attached_generations',
  'recording_attached_generations',
  'ai_attached_generations',
  'unobserved_effect_receipts',
  'billing_projection_conflicts'
] as const);

export type PlatformDrainAuthority = typeof PLATFORM_DRAIN_AUTHORITIES[number];

export type PlatformDrainPhase =
  | 'accepting'
  | 'route_draining'
  | 'worker_draining'
  | 'authority_draining'
  | 'active_zero_verified'
  | 'quiesced'
  | 'stopped'
  | 'drain_failed';

export interface PlatformDrainReceiptBody {
  schema_version: '1.0.0';
  drain_id: string;
  node_id: string;
  owner_epoch: string;
  authority: PlatformDrainAuthority;
  receipt_revision: number;
  active_count: string;
  active_id_digest: string;
  observed_at: string;
  expires_at: string;
}

export interface SignedPlatformDrainReceipt {
  key_id: string;
  body: PlatformDrainReceiptBody;
  signature: string;
}

export interface PlatformDrainSnapshot {
  drain_id: string;
  node_id: string;
  owner_epoch: string;
  phase: PlatformDrainPhase;
  phase_sequence: number;
  drain_started_at: string;
  receipt_count: number;
  missing_authorities: PlatformDrainAuthority[];
  nonzero_authorities: PlatformDrainAuthority[];
  failure_code: string;
  active_id_digest: string;
}

type KeyInput = KeyObject | string | Buffer;

const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_DRAIN_MS = 24 * 60 * 60 * 1_000;
const MAX_RECEIPT_AGE_MS = 300_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_ACTIVE_IDS = 256;
const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const RECEIPT_FIELDS = [
  'schema_version', 'drain_id', 'node_id', 'owner_epoch', 'authority',
  'receipt_revision', 'active_count', 'active_id_digest', 'observed_at', 'expires_at'
] as const;

export class PlatformDrainError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PlatformDrainError';
  }
}

export function signPlatformDrainReceipt(input: {
  key_id: string;
  private_key: KeyInput;
  body: PlatformDrainReceiptBody;
}): SignedPlatformDrainReceipt {
  if (!plainRecord(input) || !token(input.key_id)) fail('drain_receipt_signing_input_invalid');
  const body = checkedBody(input.body);
  const privateKey = ed25519PrivateKey(input.private_key);
  const signature = cryptoSign(null, Buffer.from(canonicalBody(body), 'utf8'), privateKey)
    .toString('base64url');
  return deepFreeze({ key_id: input.key_id, body, signature });
}

export class PlatformDrainCoordinator {
  readonly #config: {
    drain_id: string;
    node_id: string;
    owner_epoch: string;
    required_authorities: readonly PlatformDrainAuthority[];
    authority_key_ids: Readonly<Record<PlatformDrainAuthority, string>>;
    public_keys: ReadonlyMap<string, KeyObject>;
    clock: PlatformClock;
    timeout_ms: number;
    receipt_max_age_ms: number;
    max_clock_skew_ms: number;
  };
  readonly #receipts = new Map<PlatformDrainAuthority, SignedPlatformDrainReceipt>();
  #phase: PlatformDrainPhase = 'accepting';
  #phaseSequence = 0;
  #drainStartedAt = '';
  #deadline: PlatformDeadline | null = null;
  #failureCode = '';
  #activeIdDigest = '';

  constructor(input: {
    drain_id: string;
    node_id: string;
    owner_epoch: string;
    required_authorities: readonly PlatformDrainAuthority[];
    authority_key_ids: Record<PlatformDrainAuthority, string>;
    public_keys: Record<string, KeyInput>;
    clock: PlatformClock;
    timeout_ms: number;
    receipt_max_age_ms: number;
    max_clock_skew_ms: number;
  }) {
    if (!plainRecord(input) || !token(input.drain_id) || !token(input.node_id)
      || !positiveU64(input.owner_epoch) || !validClock(input.clock)
      || !boundedInteger(input.timeout_ms, 1, MAX_DRAIN_MS)
      || !boundedInteger(input.receipt_max_age_ms, 1, MAX_RECEIPT_AGE_MS)
      || !boundedInteger(input.max_clock_skew_ms, 0, MAX_CLOCK_SKEW_MS)) {
      fail('drain_config_invalid');
    }
    const requiredAuthorities = checkedAuthorities(input.required_authorities);
    if (!plainRecord(input.authority_key_ids) || !plainRecord(input.public_keys)) {
      fail('drain_key_config_invalid');
    }
    const authorityKeyIds = {} as Record<PlatformDrainAuthority, string>;
    const publicKeys = new Map<string, KeyObject>();
    for (const authority of requiredAuthorities) {
      const keyId = input.authority_key_ids[authority];
      if (!token(keyId) || !Object.prototype.hasOwnProperty.call(input.public_keys, keyId)) {
        fail('drain_key_config_invalid');
      }
      authorityKeyIds[authority] = keyId;
      if (!publicKeys.has(keyId)) publicKeys.set(keyId, ed25519PublicKey(input.public_keys[keyId]));
    }
    if (new Set(Object.values(authorityKeyIds)).size !== requiredAuthorities.length) {
      fail('drain_authority_key_reuse_forbidden');
    }
    const publicKeyFingerprints = [...publicKeys.values()].map(publicKeyFingerprint);
    if (new Set(publicKeyFingerprints).size !== requiredAuthorities.length) {
      fail('drain_authority_key_material_reuse_forbidden');
    }
    this.#config = {
      drain_id: input.drain_id,
      node_id: input.node_id,
      owner_epoch: input.owner_epoch,
      required_authorities: Object.freeze([...requiredAuthorities]),
      authority_key_ids: Object.freeze(authorityKeyIds),
      public_keys: publicKeys,
      clock: input.clock,
      timeout_ms: input.timeout_ms,
      receipt_max_age_ms: input.receipt_max_age_ms,
      max_clock_skew_ms: input.max_clock_skew_ms
    };
  }

  startRouteDrain(): PlatformDrainSnapshot {
    this.#assertPhase('accepting');
    try {
      this.#deadline = createPlatformDeadline(
        this.#config.clock,
        this.#config.timeout_ms,
        MAX_DRAIN_MS
      );
    } catch {
      this.#fail('drain_clock_invalid', []);
      fail('drain_clock_invalid');
    }
    this.#transition('accepting', 'route_draining');
    this.#drainStartedAt = this.#deadline.started_wall_at;
    return this.snapshot();
  }

  stopWorkerClaims(): PlatformDrainSnapshot {
    this.#assertDeadline();
    this.#transition('route_draining', 'worker_draining');
    return this.snapshot();
  }

  beginAuthorityDrain(): PlatformDrainSnapshot {
    this.#assertDeadline();
    this.#transition('worker_draining', 'authority_draining');
    return this.snapshot();
  }

  observeReceipt(receipt: SignedPlatformDrainReceipt): PlatformDrainReceiptBody {
    this.#assertPhase('authority_draining');
    this.#assertDeadline();
    const verified = this.#verifyReceipt(receipt);
    const existing = this.#receipts.get(verified.body.authority);
    if (existing) {
      if (verified.body.receipt_revision < existing.body.receipt_revision) {
        fail('drain_receipt_revision_stale');
      }
      if (verified.body.receipt_revision === existing.body.receipt_revision) {
        if (canonicalReceipt(verified) !== canonicalReceipt(existing)) {
          fail('drain_receipt_revision_conflict');
        }
        return structuredClone(existing.body);
      }
    }
    this.#receipts.set(verified.body.authority, verified);
    return structuredClone(verified.body);
  }

  verifyActiveZero(): {
    verified: boolean;
    missing_authorities: PlatformDrainAuthority[];
    nonzero_authorities: PlatformDrainAuthority[];
  } {
    this.#assertPhase('authority_draining');
    this.#assertDeadline();
    for (const receipt of this.#receipts.values()) this.#verifyReceipt(receipt);
    const missing = this.#missingAuthorities();
    const nonzero = this.#nonzeroAuthorities();
    if (missing.length === 0 && nonzero.length === 0) {
      this.#transition('authority_draining', 'active_zero_verified');
    }
    return {
      verified: missing.length === 0 && nonzero.length === 0,
      missing_authorities: missing,
      nonzero_authorities: nonzero
    };
  }

  quiesce(): PlatformDrainSnapshot {
    this.#assertDeadline();
    this.#transition('active_zero_verified', 'quiesced');
    return this.snapshot();
  }

  stop(): PlatformDrainSnapshot {
    this.#assertDeadline();
    this.#transition('quiesced', 'stopped');
    return this.snapshot();
  }

  pollDeadline(activeIds: readonly string[]): PlatformDrainSnapshot {
    if (this.#phase === 'stopped' || this.#phase === 'drain_failed' || this.#phase === 'accepting') {
      return this.snapshot();
    }
    const state = platformDeadlineState(this.#config.clock, this.#deadline!);
    if (state === 'active') return this.snapshot();
    const code = state === 'expired'
      ? 'drain_deadline_exceeded'
      : state === 'restart_reauthorization_required'
        ? 'drain_restart_reauthorization_required'
        : 'drain_clock_invalid';
    this.#fail(code, activeIds);
    return this.snapshot();
  }

  snapshot(): PlatformDrainSnapshot {
    return structuredClone({
      drain_id: this.#config.drain_id,
      node_id: this.#config.node_id,
      owner_epoch: this.#config.owner_epoch,
      phase: this.#phase,
      phase_sequence: this.#phaseSequence,
      drain_started_at: this.#drainStartedAt,
      receipt_count: this.#receipts.size,
      missing_authorities: this.#missingAuthorities(),
      nonzero_authorities: this.#nonzeroAuthorities(),
      failure_code: this.#failureCode,
      active_id_digest: this.#activeIdDigest
    });
  }

  #verifyReceipt(receipt: SignedPlatformDrainReceipt): SignedPlatformDrainReceipt {
    if (!plainRecord(receipt) || Object.keys(receipt).length !== 3
      || !token(receipt.key_id) || typeof receipt.signature !== 'string') {
      fail('drain_receipt_invalid');
    }
    const body = checkedBody(receipt.body);
    if (body.drain_id !== this.#config.drain_id || body.node_id !== this.#config.node_id
      || body.owner_epoch !== this.#config.owner_epoch) {
      fail('drain_receipt_scope_mismatch');
    }
    const expectedKeyId = this.#config.authority_key_ids[body.authority];
    if (receipt.key_id !== expectedKeyId) fail('drain_receipt_authority_key_mismatch');
    const publicKey = this.#config.public_keys.get(receipt.key_id);
    if (!publicKey || !validSignature(receipt.signature)
      || !cryptoVerify(
        null,
        Buffer.from(canonicalBody(body), 'utf8'),
        publicKey,
        Buffer.from(receipt.signature, 'base64url')
      )) {
      fail('drain_receipt_signature_invalid');
    }
    const now = this.#config.clock.wallNow().getTime();
    const observedAt = Date.parse(body.observed_at);
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(now)
      || observedAt > now + this.#config.max_clock_skew_ms
      || now >= expiresAt
      || now - observedAt > this.#config.receipt_max_age_ms
      || expiresAt - observedAt > this.#config.receipt_max_age_ms) {
      fail('drain_receipt_stale');
    }
    return deepFreeze({ key_id: receipt.key_id, body, signature: receipt.signature });
  }

  #assertDeadline(): void {
    if (!this.#deadline) return;
    const state = platformDeadlineState(this.#config.clock, this.#deadline);
    if (state === 'active') return;
    const code = state === 'expired'
      ? 'drain_deadline_exceeded'
      : state === 'restart_reauthorization_required'
        ? 'drain_restart_reauthorization_required'
        : 'drain_clock_invalid';
    this.#fail(code, []);
    fail(code);
  }

  #transition(expected: PlatformDrainPhase, next: PlatformDrainPhase): void {
    this.#assertPhase(expected);
    this.#phase = next;
    this.#phaseSequence += 1;
  }

  #assertPhase(expected: PlatformDrainPhase): void {
    if (this.#phase !== expected) fail('drain_transition_invalid');
  }

  #missingAuthorities(): PlatformDrainAuthority[] {
    return this.#config.required_authorities.filter((authority) => !this.#receipts.has(authority));
  }

  #nonzeroAuthorities(): PlatformDrainAuthority[] {
    return this.#config.required_authorities.filter((authority) => {
      const receipt = this.#receipts.get(authority);
      return receipt ? BigInt(receipt.body.active_count) !== 0n : false;
    });
  }

  #fail(code: string, activeIds: readonly string[]): void {
    if (!Array.isArray(activeIds) || activeIds.length > MAX_ACTIVE_IDS
      || activeIds.some((id) => !token(id))) fail('drain_active_ids_invalid');
    this.#phase = 'drain_failed';
    this.#phaseSequence += 1;
    this.#failureCode = code;
    this.#activeIdDigest = sha256(JSON.stringify([...new Set(activeIds)].sort()));
  }
}

function checkedAuthorities(value: readonly PlatformDrainAuthority[]): PlatformDrainAuthority[] {
  if (!Array.isArray(value) || value.length !== PLATFORM_DRAIN_AUTHORITIES.length
    || new Set(value).size !== value.length
    || PLATFORM_DRAIN_AUTHORITIES.some((authority) => !value.includes(authority))) {
    fail('drain_authorities_invalid');
  }
  return [...value];
}

function checkedBody(value: PlatformDrainReceiptBody): PlatformDrainReceiptBody {
  if (!plainRecord(value) || Object.keys(value).length !== RECEIPT_FIELDS.length
    || !RECEIPT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field))
    || value.schema_version !== '1.0.0' || !token(value.drain_id) || !token(value.node_id)
    || !positiveU64(value.owner_epoch) || !PLATFORM_DRAIN_AUTHORITIES.includes(value.authority)
    || !boundedInteger(value.receipt_revision, 1, Number.MAX_SAFE_INTEGER)
    || !u64(value.active_count) || !SHA256.test(value.active_id_digest)
    || canonicalTimestamp(value.observed_at) === null
    || canonicalTimestamp(value.expires_at) === null
    || Date.parse(value.expires_at) <= Date.parse(value.observed_at)
    || Date.parse(value.expires_at) - Date.parse(value.observed_at) > MAX_RECEIPT_AGE_MS) {
    const code = plainRecord(value) && !u64(value.active_count)
      ? 'drain_receipt_active_count_invalid'
      : 'drain_receipt_body_invalid';
    fail(code);
  }
  return deepFreeze(structuredClone(value));
}

function canonicalBody(body: PlatformDrainReceiptBody): string {
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

function canonicalReceipt(receipt: SignedPlatformDrainReceipt): string {
  return `${receipt.key_id}.${canonicalBody(receipt.body)}.${receipt.signature}`;
}

function ed25519PrivateKey(value: KeyInput): KeyObject {
  try {
    const key = value instanceof KeyObject ? value : createPrivateKey(value);
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch {
    fail('drain_receipt_private_key_invalid');
  }
}

function ed25519PublicKey(value: KeyInput): KeyObject {
  try {
    const key = value instanceof KeyObject
      ? value.type === 'private' ? createPublicKey(value) : value
      : createPublicKey(value);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch {
    fail('drain_receipt_public_key_invalid');
  }
}

function publicKeyFingerprint(value: KeyObject): string {
  return createHash('sha256')
    .update(value.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function validClock(value: unknown): value is PlatformClock {
  return Boolean(value && typeof value === 'object'
    && typeof (value as PlatformClock).wallNow === 'function'
    && typeof (value as PlatformClock).monotonicNowMs === 'function');
}

function validSignature(value: string): boolean {
  return /^[A-Za-z0-9_-]{86}$/u.test(value);
}

function positiveU64(value: unknown): value is string {
  return u64(value) && BigInt(value) > 0n;
}

function u64(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) return false;
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function token(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

function plainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code: string): never {
  throw new PlatformDrainError(code);
}
