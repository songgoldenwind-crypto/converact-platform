import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 24 * 1024;
const PAYLOAD_KEYS = [
  'call_session_ref',
  'interaction_id',
  'cdr_sequence',
  'dialog_id',
  'dialog_role',
  'from_uri',
  'leg',
  'local_contact_uri',
  'local_cseq',
  'local_tag',
  'media_reservation_id',
  'peer_dialog_id',
  'raw_call_id',
  'remote_contact_uri',
  'remote_cseq',
  'remote_tag',
  'remote_uri',
  'route_set',
  'schema_version',
  'supports_100rel',
  'to_uri'
].sort();
const PAYLOAD_OPTIONAL_KEYS = [
  'answered_at',
  'route_snapshot_revision',
  'started_at'
].sort();
const ENVELOPE_KEYS = [
  'algorithm',
  'auth_tag',
  'ciphertext',
  'key_id',
  'nonce',
  'schema_version'
].sort();

export interface DialogRecoveryCapsuleBinding {
  tenant_id: string;
  cell_id: string;
  dialog_id: string;
  owner_epoch: number;
  sequence: number;
}

export interface DialogRecoveryCapsulePayload {
  schema_version: 1;
  call_session_ref: string;
  interaction_id: string;
  dialog_id: string;
  peer_dialog_id: string;
  leg: 'caller' | 'callee';
  dialog_role: 'uac' | 'uas';
  raw_call_id: string;
  local_tag: string;
  remote_tag: string;
  from_uri: string;
  to_uri: string;
  local_contact_uri: string;
  remote_uri: string;
  remote_contact_uri: string | null;
  route_set: string[];
  local_cseq: number;
  remote_cseq: number;
  supports_100rel: boolean;
  media_reservation_id: string;
  started_at?: string | null;
  answered_at?: string | null;
  cdr_sequence: number;
  route_snapshot_revision?: number;
}

export interface DialogRecoveryCapsuleEnvelope {
  schema_version: 1;
  algorithm: 'A256GCM';
  key_id: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

export interface DialogRecoveryCapsuleKey {
  key_id: string;
  key: Buffer | string;
}

export class DialogRecoveryCapsuleCodec {
  readonly #currentKeyId: string;
  readonly #keys: Map<string, Buffer>;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(input: {
    current: DialogRecoveryCapsuleKey;
    previous?: DialogRecoveryCapsuleKey;
    random_bytes?: (size: number) => Buffer;
  }) {
    const current = checkedKey(input.current);
    const previous = input.previous ? checkedKey(input.previous) : null;
    if (previous?.key_id === current.key_id) {
      throw new DialogRecoveryCapsuleError(
        'dialog_recovery_capsule_key_invalid',
        'recovery capsule key rotation requires distinct key ids'
      );
    }
    this.#currentKeyId = current.key_id;
    this.#keys = new Map([[current.key_id, current.key]]);
    if (previous) this.#keys.set(previous.key_id, previous.key);
    this.#randomBytes = input.random_bytes ?? randomBytes;
  }

  seal(
    value: DialogRecoveryCapsulePayload,
    binding: DialogRecoveryCapsuleBinding
  ): DialogRecoveryCapsuleEnvelope {
    const payload = assertDialogRecoveryCapsulePayload(value);
    const checkedBinding = assertDialogRecoveryCapsuleBinding(binding);
    const plaintext = Buffer.from(canonicalJson(payload), 'utf8');
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) invalid();
    const nonce = this.#randomBytes(NONCE_BYTES);
    if (!Buffer.isBuffer(nonce) || nonce.byteLength !== NONCE_BYTES) {
      throw new DialogRecoveryCapsuleError(
        'dialog_recovery_capsule_random_invalid',
        'recovery capsule nonce source returned invalid bytes'
      );
    }
    const cipher = createCipheriv(
      ALGORITHM,
      this.#keys.get(this.#currentKeyId)!,
      nonce,
      { authTagLength: AUTH_TAG_BYTES }
    );
    cipher.setAAD(aad(checkedBinding));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      schema_version: 1,
      algorithm: 'A256GCM',
      key_id: this.#currentKeyId,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      auth_tag: cipher.getAuthTag().toString('base64url')
    };
  }

  open(
    value: DialogRecoveryCapsuleEnvelope,
    binding: DialogRecoveryCapsuleBinding
  ): DialogRecoveryCapsulePayload {
    const envelope = assertDialogRecoveryCapsuleEnvelope(value);
    const checkedBinding = assertDialogRecoveryCapsuleBinding(binding);
    const key = this.#keys.get(envelope.key_id);
    if (!key) {
      throw new DialogRecoveryCapsuleError(
        'dialog_recovery_capsule_key_unknown',
        'recovery capsule key is unavailable'
      );
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        decodeBase64Url(envelope.nonce, NONCE_BYTES),
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(aad(checkedBinding));
      decipher.setAuthTag(decodeBase64Url(envelope.auth_tag, AUTH_TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64Url(envelope.ciphertext)),
        decipher.final()
      ]);
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) invalid();
      const text = plaintext.toString('utf8');
      const decoded = assertDialogRecoveryCapsulePayload(
        JSON.parse(text) as DialogRecoveryCapsulePayload
      );
      if (canonicalJson(decoded) !== text) invalid();
      return decoded;
    } catch (error) {
      if (error instanceof DialogRecoveryCapsuleError) throw error;
      throw new DialogRecoveryCapsuleError(
        'dialog_recovery_capsule_authentication_failed',
        'recovery capsule authentication failed',
        error
      );
    }
  }
}

export function assertDialogRecoveryCapsuleEnvelope(
  value: DialogRecoveryCapsuleEnvelope
): DialogRecoveryCapsuleEnvelope {
  try {
    exactKeys(value, ENVELOPE_KEYS);
    if (value.schema_version !== 1 || value.algorithm !== 'A256GCM') invalid();
    const result = {
      schema_version: 1 as const,
      algorithm: 'A256GCM' as const,
      key_id: identifier(value.key_id, 128),
      nonce: canonicalBase64Url(value.nonce, NONCE_BYTES),
      ciphertext: canonicalBase64Url(value.ciphertext),
      auth_tag: canonicalBase64Url(value.auth_tag, AUTH_TAG_BYTES)
    };
    const ciphertextBytes = Buffer.from(result.ciphertext, 'base64url').byteLength;
    if (ciphertextBytes < 2 || ciphertextBytes > MAX_PLAINTEXT_BYTES) invalid();
    return result;
  } catch (error) {
    if (error instanceof DialogRecoveryCapsuleError) throw error;
    throw new DialogRecoveryCapsuleError(
      'dialog_recovery_capsule_invalid',
      'recovery capsule envelope is invalid',
      error
    );
  }
}

export function assertDialogRecoveryCapsulePayload(
  value: DialogRecoveryCapsulePayload
): DialogRecoveryCapsulePayload {
  try {
    exactKeys(value, PAYLOAD_KEYS, PAYLOAD_OPTIONAL_KEYS);
    if (value.schema_version !== 1) invalid();
    const result: DialogRecoveryCapsulePayload = {
      schema_version: 1,
      call_session_ref: identifier(value.call_session_ref, 128),
      interaction_id: identifier(value.interaction_id, 128),
      dialog_id: identifier(value.dialog_id, 128),
      peer_dialog_id: identifier(value.peer_dialog_id, 128),
      leg: oneOf(value.leg, ['caller', 'callee']),
      dialog_role: oneOf(value.dialog_role, ['uac', 'uas']),
      raw_call_id: boundedText(value.raw_call_id, 512),
      local_tag: sipTag(value.local_tag),
      remote_tag: sipTag(value.remote_tag),
      from_uri: sipUri(value.from_uri),
      to_uri: sipUri(value.to_uri),
      local_contact_uri: sipUri(value.local_contact_uri),
      remote_uri: sipUri(value.remote_uri),
      remote_contact_uri: value.remote_contact_uri === null
        ? null
        : sipUri(value.remote_contact_uri),
      route_set: rawRouteSet(value.route_set),
      local_cseq: integer(value.local_cseq, 0, 0x7fff_ffff),
      remote_cseq: integer(value.remote_cseq, 0, 0x7fff_ffff),
      supports_100rel: boolean(value.supports_100rel),
      media_reservation_id: mediaReservationId(value.media_reservation_id),
      cdr_sequence: integer(value.cdr_sequence, 0, Number.MAX_SAFE_INTEGER)
    };
    if (hasOwn(value, 'started_at')) {
      result.started_at = optionalTimestamp(value.started_at);
    }
    if (hasOwn(value, 'answered_at')) {
      result.answered_at = optionalTimestamp(value.answered_at);
    }
    if (hasOwn(value, 'route_snapshot_revision')) {
      result.route_snapshot_revision = integer(
        value.route_snapshot_revision,
        1,
        Number.MAX_SAFE_INTEGER
      );
    }
    if (result.dialog_id === result.peer_dialog_id) invalid();
    if (result.answered_at !== undefined && result.answered_at !== null) {
      if (result.started_at === undefined || result.started_at === null ||
          Date.parse(result.answered_at) < Date.parse(result.started_at)) {
        invalid();
      }
    }
    if (Buffer.byteLength(canonicalJson(result), 'utf8') > MAX_PLAINTEXT_BYTES) {
      invalid();
    }
    return result;
  } catch (error) {
    if (error instanceof DialogRecoveryCapsuleError) throw error;
    throw new DialogRecoveryCapsuleError(
      'dialog_recovery_capsule_invalid',
      'recovery capsule payload is invalid',
      error
    );
  }
}

export class DialogRecoveryCapsuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DialogRecoveryCapsuleError';
  }
}

function assertDialogRecoveryCapsuleBinding(
  value: DialogRecoveryCapsuleBinding
): DialogRecoveryCapsuleBinding {
  try {
    exactKeys(value, [
      'cell_id',
      'dialog_id',
      'owner_epoch',
      'sequence',
      'tenant_id'
    ]);
    return {
      tenant_id: identifier(value.tenant_id, 128),
      cell_id: identifier(value.cell_id, 128),
      dialog_id: identifier(value.dialog_id, 128),
      owner_epoch: integer(value.owner_epoch, 1, 0xffff_ffff),
      sequence: integer(value.sequence, 1, 0xffff_ffff)
    };
  } catch (error) {
    throw new DialogRecoveryCapsuleError(
      'dialog_recovery_capsule_binding_invalid',
      'recovery capsule binding is invalid',
      error
    );
  }
}

function checkedKey(value: DialogRecoveryCapsuleKey): {
  key_id: string;
  key: Buffer;
} {
  try {
    const keyId = identifier(value?.key_id, 128);
    const key = Buffer.isBuffer(value?.key)
      ? Buffer.from(value.key)
      : decodeCanonicalBase64(String(value?.key || ''));
    if (key.byteLength !== 32) throw new Error('key must be 32 bytes');
    return { key_id: keyId, key };
  } catch (error) {
    throw new DialogRecoveryCapsuleError(
      'dialog_recovery_capsule_key_invalid',
      'recovery capsule key is invalid',
      error
    );
  }
}

function aad(value: DialogRecoveryCapsuleBinding): Buffer {
  return Buffer.from(
    `ivekit-dialog-recovery-v1\0${canonicalJson(value)}`,
    'utf8'
  );
}

function exactKeys(
  value: unknown,
  expected: string[],
  optional: string[] = []
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    invalid();
  }
  const actual = Object.keys(value);
  if (expected.some((key) => !actual.includes(key)) ||
      actual.some((key) => !expected.includes(key) && !optional.includes(key))) {
    invalid();
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    invalid();
  }
  return value;
}

function identifier(value: unknown, maximum: number): string {
  const result = String(value || '');
  if (result.length > maximum ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    invalid();
  }
  return result;
}

function mediaReservationId(value: unknown): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(result)) invalid();
  return result;
}

function sipTag(value: unknown): string {
  const result = String(value || '');
  if (result.length > 256 || !/^[A-Za-z0-9.!%*_+`'~-]+$/.test(result)) {
    invalid();
  }
  return result;
}

function boundedText(value: unknown, maximum: number): string {
  const result = String(value || '');
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    invalid();
  }
  return result;
}

function sipUri(value: unknown): string {
  const result = boundedText(value, 1_024);
  if (!/^sips?:[^\s]+$/i.test(result)) invalid();
  return result;
}

function rawRouteSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) invalid();
  return value.map(sipUri);
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) {
    invalid();
  }
  return Number(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) invalid();
  return value as T;
}

function canonicalBase64Url(value: unknown, exactBytes?: number): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid();
  const decoded = Buffer.from(result, 'base64url');
  if (decoded.toString('base64url') !== result ||
      (exactBytes !== undefined && decoded.byteLength !== exactBytes)) {
    invalid();
  }
  return result;
}

function decodeBase64Url(value: string, exactBytes?: number): Buffer {
  canonicalBase64Url(value, exactBytes);
  return Buffer.from(value, 'base64url');
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (!value ||
      decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('key is not canonical base64');
  }
  return decoded;
}

function invalid(): never {
  throw new Error('invalid recovery capsule');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}
