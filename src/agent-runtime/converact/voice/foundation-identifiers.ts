import { createHash } from 'node:crypto';

declare const VOICE_FOUNDATION_ID: unique symbol;

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
const MAX_COMPONENTS = 16;
const MAX_COMPONENT_UTF8_BYTES = 4_096;

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
