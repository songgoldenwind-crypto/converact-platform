import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

declare const VOICE_FOUNDATION_ID: unique symbol;
declare const LEGACY_CALL_ID_AUTHORITY: unique symbol;

type BrandedIdentifier<Name extends string> = string & {
  readonly [VOICE_FOUNDATION_ID]: Name;
};

export type CallId = BrandedIdentifier<'CallId'>;
export type LegId = BrandedIdentifier<'LegId'>;
export type ProtocolDialogId = BrandedIdentifier<'ProtocolDialogId'>;
export type TransactionId = BrandedIdentifier<'TransactionId'>;
export type MediaSessionId = BrandedIdentifier<'MediaSessionId'>;
export type InteractionId = BrandedIdentifier<'InteractionId'>;

export type VoiceFoundationIdentifierErrorCode =
  | 'voice_foundation_identifier_invalid'
  | 'voice_foundation_legacy_call_id_invalid';

export class VoiceFoundationIdentifierError extends Error {
  readonly code: VoiceFoundationIdentifierErrorCode;

  constructor(code: VoiceFoundationIdentifierErrorCode) {
    super(code);
    this.name = 'VoiceFoundationIdentifierError';
    this.code = code;
  }
}

export interface LegacyCallIdAuthorityLookup {
  get(
    tenantId: string,
    callId: string
  ): Promise<Readonly<{ id: string; tenant_id: string }> | null>;
}

export interface LegacyCallIdAuthorityRecord {
  readonly [LEGACY_CALL_ID_AUTHORITY]: true;
  readonly source: 'voice_call_repository';
  readonly tenant_id: string;
  readonly format: 'vcall' | 'uuid';
  readonly value: string;
}

const CANONICAL_DIGEST_PATTERN = '[a-f0-9]{32}';
const ID_SPECS = Object.freeze({
  call: Object.freeze({ namespace: 'call', prefix: 'call_' }),
  leg: Object.freeze({ namespace: 'leg', prefix: 'leg_' }),
  protocolDialog: Object.freeze({ namespace: 'protocol-dialog', prefix: 'pdlg_' }),
  transaction: Object.freeze({ namespace: 'protocol-transaction', prefix: 'ptxn_' }),
  mediaSession: Object.freeze({ namespace: 'media-session', prefix: 'media_' }),
  interaction: Object.freeze({ namespace: 'interaction', prefix: 'interaction_' })
});
const CANONICAL_PATTERNS = Object.freeze({
  call: new RegExp(`^${ID_SPECS.call.prefix}${CANONICAL_DIGEST_PATTERN}$`),
  leg: new RegExp(`^${ID_SPECS.leg.prefix}${CANONICAL_DIGEST_PATTERN}$`),
  protocolDialog: new RegExp(
    `^${ID_SPECS.protocolDialog.prefix}${CANONICAL_DIGEST_PATTERN}$`
  ),
  transaction: new RegExp(
    `^${ID_SPECS.transaction.prefix}${CANONICAL_DIGEST_PATTERN}$`
  ),
  mediaSession: new RegExp(
    `^${ID_SPECS.mediaSession.prefix}${CANONICAL_DIGEST_PATTERN}$`
  ),
  interaction: new RegExp(
    `^${ID_SPECS.interaction.prefix}${CANONICAL_DIGEST_PATTERN}$`
  )
});
const COMMON_INPUT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEGACY_VCALL_PATTERN = /^vcall_[A-Za-z0-9][A-Za-z0-9._:@/-]{0,120}$/;
const LEGACY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMPONENTS = 16;
const MAX_COMPONENT_UTF8_BYTES = 4_096;
const LEGACY_CALL_ID_AUTHORITY_RECORDS = new WeakSet<object>();

export function parseCallId(value: unknown): CallId {
  return parseCanonical(value, CANONICAL_PATTERNS.call) as CallId;
}

export function parseLegId(value: unknown): LegId {
  return parseCanonical(value, CANONICAL_PATTERNS.leg) as LegId;
}

export function parseProtocolDialogId(value: unknown): ProtocolDialogId {
  return parseCanonical(value, CANONICAL_PATTERNS.protocolDialog) as ProtocolDialogId;
}

export function parseTransactionId(value: unknown): TransactionId {
  return parseCanonical(value, CANONICAL_PATTERNS.transaction) as TransactionId;
}

export function parseMediaSessionId(value: unknown): MediaSessionId {
  return parseCanonical(value, CANONICAL_PATTERNS.mediaSession) as MediaSessionId;
}

export function parseInteractionId(value: unknown): InteractionId {
  return parseCanonical(value, CANONICAL_PATTERNS.interaction) as InteractionId;
}

export function deriveCallId(tenantId: string, ...components: string[]): CallId {
  return derive(ID_SPECS.call, tenantId, components) as CallId;
}

export function deriveLegId(tenantId: string, ...components: string[]): LegId {
  return derive(ID_SPECS.leg, tenantId, components) as LegId;
}

export function deriveProtocolDialogId(
  tenantId: string,
  ...components: string[]
): ProtocolDialogId {
  return derive(ID_SPECS.protocolDialog, tenantId, components) as ProtocolDialogId;
}

export function deriveTransactionId(
  tenantId: string,
  ...components: string[]
): TransactionId {
  return derive(ID_SPECS.transaction, tenantId, components) as TransactionId;
}

export function deriveMediaSessionId(
  tenantId: string,
  ...components: string[]
): MediaSessionId {
  return derive(ID_SPECS.mediaSession, tenantId, components) as MediaSessionId;
}

export function deriveInteractionId(
  tenantId: string,
  ...components: string[]
): InteractionId {
  return derive(ID_SPECS.interaction, tenantId, components) as InteractionId;
}

/**
 * Loads a legacy identifier from the existing durable VoiceCall authority and
 * issues an in-process, non-forgeable import record. Merely matching the UUID
 * or vcall syntax is never enough to cross the business Call boundary.
 */
export async function attestLegacyCallId(
  lookup: LegacyCallIdAuthorityLookup,
  tenantIdInput: string,
  legacyCallIdInput: string
): Promise<LegacyCallIdAuthorityRecord> {
  const tenantId = legacyTenantId(tenantIdInput);
  const format = legacyCallIdFormat(legacyCallIdInput);
  if (!lookup || typeof lookup.get !== 'function') throw invalidLegacyCallId();
  const stored = await lookup.get(tenantId, legacyCallIdInput);
  if (typeof stored !== 'object' || stored === null || utilTypes.isProxy(stored)) {
    throw invalidLegacyCallId();
  }
  let storedId: unknown;
  let storedTenantId: unknown;
  try {
    storedId = stored.id;
    storedTenantId = stored.tenant_id;
  } catch {
    throw invalidLegacyCallId();
  }
  if (storedId !== legacyCallIdInput || storedTenantId !== tenantId) {
    throw invalidLegacyCallId();
  }
  const record = Object.freeze({
    source: 'voice_call_repository' as const,
    tenant_id: tenantId,
    format,
    value: legacyCallIdInput
  }) as LegacyCallIdAuthorityRecord;
  LEGACY_CALL_ID_AUTHORITY_RECORDS.add(record);
  return record;
}

/**
 * The only supported bridge from attested pre-foundation business Call IDs.
 * A raw SIP Call-ID (including one that happens to be a UUID) is rejected.
 */
export function importLegacyCallId(
  tenantIdInput: string,
  input: LegacyCallIdAuthorityRecord
): CallId {
  const tenantId = legacyTenantId(tenantIdInput);
  if (typeof input !== 'object' || input === null ||
      utilTypes.isProxy(input) ||
      !LEGACY_CALL_ID_AUTHORITY_RECORDS.has(input) ||
      input.tenant_id !== tenantId) throw invalidLegacyCallId();
  return deriveCallId(
    tenantId,
    'legacy-voice-call-repository',
    input.format,
    input.value
  );
}

function legacyTenantId(value: unknown): string {
  if (typeof value !== 'string' || !COMMON_INPUT_PATTERN.test(value)) {
    throw invalidLegacyCallId();
  }
  return value;
}

function legacyCallIdFormat(value: unknown): 'vcall' | 'uuid' {
  if (typeof value !== 'string') throw invalidLegacyCallId();
  if (LEGACY_VCALL_PATTERN.test(value)) return 'vcall';
  if (LEGACY_UUID_PATTERN.test(value)) return 'uuid';
  throw invalidLegacyCallId();
}

function derive(
  spec: Readonly<{ namespace: string; prefix: string }>,
  tenantId: string,
  components: readonly string[]
): string {
  if (!COMMON_INPUT_PATTERN.test(tenantId) ||
      components.length < 1 ||
      components.length > MAX_COMPONENTS) {
    throw invalidIdentifier();
  }
  const hash = createHash('sha256');
  const lengthPrefix = Buffer.allocUnsafe(4);
  appendLengthPrefixed(hash, lengthPrefix, spec.namespace);
  appendLengthPrefixed(hash, lengthPrefix, tenantId);
  for (const component of components) {
    appendLengthPrefixed(hash, lengthPrefix, component);
  }
  return `${spec.prefix}${hash.digest('hex').slice(0, 32)}`;
}

function appendLengthPrefixed(
  hash: ReturnType<typeof createHash>,
  lengthPrefix: Buffer,
  value: unknown
): void {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidIdentifier();
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > MAX_COMPONENT_UTF8_BYTES) throw invalidIdentifier();
  lengthPrefix.writeUInt32BE(byteLength);
  hash.update(lengthPrefix);
  hash.update(value, 'utf8');
}

function parseCanonical(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' ||
      value.length > 128 ||
      !pattern.test(value)) {
    throw invalidIdentifier();
  }
  return value;
}

function invalidIdentifier(): VoiceFoundationIdentifierError {
  return new VoiceFoundationIdentifierError(
    'voice_foundation_identifier_invalid'
  );
}

function invalidLegacyCallId(): VoiceFoundationIdentifierError {
  return new VoiceFoundationIdentifierError(
    'voice_foundation_legacy_call_id_invalid'
  );
}
