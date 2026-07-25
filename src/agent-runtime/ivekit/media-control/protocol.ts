import { createHash } from 'node:crypto';

export const MEDIA_CONTROL_PROTOCOL_VERSION =
  'ivekit.media-control.v1' as const;

export const MEDIA_CONTROL_ACTIONS = [
  'offer',
  'answer',
  'update',
  'delete',
  'query',
  'block_media',
  'unblock_media',
  'start_forward',
  'stop_forward',
  'start_recording_fork',
  'stop_recording_fork',
  'play_media',
  'stop_media',
  'inject_dtmf',
  'subscribe_quality',
  'drain_node'
] as const;

export type MediaControlAction = typeof MEDIA_CONTROL_ACTIONS[number];

export const MEDIA_CONTROL_RESULT_CLASSES = [
  'committed',
  'replayed',
  'rejected_capacity',
  'rejected_epoch',
  'terminal_error',
  'unknown'
] as const;

export type MediaControlResultClass =
  typeof MEDIA_CONTROL_RESULT_CLASSES[number];

export type MediaSessionState =
  | 'prepared'
  | 'committed'
  | 'cancelled'
  | 'closed'
  | 'expired';

export interface MediaControlCommand {
  protocol_version: typeof MEDIA_CONTROL_PROTOCOL_VERSION;
  action: MediaControlAction;
  command_id: string;
  tenant_id: string;
  call_id: string;
  leg_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  media_reservation_id: string;
  command_sequence: number;
  idempotency_key: string;
  expires_at: string;
  payload: Record<string, unknown>;
  payload_hash: string;
}

export interface MediaSessionSnapshot {
  media_reservation_id: string;
  call_id: string;
  owner_epoch: string;
  last_sequence: number;
  state: MediaSessionState;
  transport_session_id: string;
  effective_sdp: string;
  expires_at: string;
  updated_at: string;
}

export type MediaControlResult =
  | {
      protocol_version: typeof MEDIA_CONTROL_PROTOCOL_VERSION;
      result_class: 'committed' | 'replayed';
      command_id: string;
      session: MediaSessionSnapshot;
    }
  | {
      protocol_version: typeof MEDIA_CONTROL_PROTOCOL_VERSION;
      result_class:
        | 'rejected_capacity'
        | 'rejected_epoch'
        | 'terminal_error';
      command_id: string;
      error_code: string;
      retryable: boolean;
      session?: MediaSessionSnapshot;
    }
  | {
      protocol_version: typeof MEDIA_CONTROL_PROTOCOL_VERSION;
      result_class: 'unknown';
      command_id: string;
      error_code: string;
      retryable: true;
      session?: MediaSessionSnapshot;
    };

export interface MediaControlReconcileInput {
  protocol_version: typeof MEDIA_CONTROL_PROTOCOL_VERSION;
  action: 'reconcile';
  command: MediaControlCommand;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/;
const OWNER_EPOCH_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_SDP_BYTES = 16 * 1024;

export function checkedMediaControlCommand(
  input: MediaControlCommand
): MediaControlCommand {
  if (!input || typeof input !== 'object') {
    throw new Error('media_control_command_invalid');
  }
  if (!hasExactKeys(input as unknown as Record<string, unknown>, [
    'protocol_version',
    'action',
    'command_id',
    'tenant_id',
    'call_id',
    'leg_id',
    'cell_id',
    'owner_node_id',
    'owner_epoch',
    'media_reservation_id',
    'command_sequence',
    'idempotency_key',
    'expires_at',
    'payload',
    'payload_hash'
  ])) {
    throw new Error('media_control_command_invalid');
  }
  if (input.protocol_version !== MEDIA_CONTROL_PROTOCOL_VERSION) {
    throw new Error('media_control_protocol_unsupported');
  }
  if (!MEDIA_CONTROL_ACTIONS.includes(input.action)) {
    throw new Error('media_control_action_invalid');
  }
  for (const [name, value] of [
    ['command_id', input.command_id],
    ['tenant_id', input.tenant_id],
    ['call_id', input.call_id],
    ['leg_id', input.leg_id],
    ['cell_id', input.cell_id],
    ['owner_node_id', input.owner_node_id],
    ['media_reservation_id', input.media_reservation_id],
    ['idempotency_key', input.idempotency_key]
  ] as const) {
    if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
      throw new Error(`media_control_${name}_invalid`);
    }
  }
  checkedOwnerEpoch(input.owner_epoch);
  if (!Number.isInteger(input.command_sequence) ||
      input.command_sequence < 1 ||
      input.command_sequence > 0xffff_ffff) {
    throw new Error('media_control_sequence_invalid');
  }
  const leaseExpiresAt = typeof input.expires_at === 'string'
    ? Date.parse(input.expires_at)
    : Number.NaN;
  if (!Number.isFinite(leaseExpiresAt) ||
      new Date(leaseExpiresAt).toISOString() !== input.expires_at) {
    throw new Error('media_control_lease_expires_at_invalid');
  }
  if (!isPlainRecord(input.payload)) {
    throw new Error('media_control_payload_invalid');
  }
  checkedJsonValue(input.payload);
  const payloadJson = JSON.stringify(input.payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('media_control_payload_too_large');
  }
  if (!/^[a-f0-9]{64}$/.test(input.payload_hash) ||
      input.payload_hash !== mediaControlPayloadHash(input.payload)) {
    throw new Error('media_control_payload_hash_invalid');
  }
  if (input.action === 'offer') {
    const offerSdp = input.payload.offer_sdp;
    const profileId = input.payload.media_profile_id;
    if (typeof offerSdp !== 'string' ||
        Buffer.byteLength(offerSdp, 'utf8') > MAX_SDP_BYTES) {
      throw new Error('media_control_offer_sdp_invalid');
    }
    if (typeof profileId !== 'string' || !IDENTIFIER_PATTERN.test(profileId)) {
      throw new Error('media_control_media_profile_id_invalid');
    }
  }
  return structuredClone(input);
}

export function checkedMediaControlReconcileInput(
  input: MediaControlReconcileInput
): MediaControlReconcileInput {
  if (!input || typeof input !== 'object') {
    throw new Error('media_control_reconcile_invalid');
  }
  if (!hasExactKeys(input as unknown as Record<string, unknown>, [
    'protocol_version',
    'action',
    'command'
  ])) {
    throw new Error('media_control_reconcile_invalid');
  }
  if (input.protocol_version !== MEDIA_CONTROL_PROTOCOL_VERSION ||
      input.action !== 'reconcile') {
    throw new Error('media_control_protocol_unsupported');
  }
  return {
    protocol_version: input.protocol_version,
    action: input.action,
    command: checkedMediaControlCommand(input.command)
  };
}

export function mediaControlCommandHash(command: MediaControlCommand): string {
  return createHash('sha256')
    .update(canonicalJson(checkedMediaControlCommand(command)), 'utf8')
    .digest('hex');
}

export function mediaControlIdempotencyHash(
  command: MediaControlCommand
): string {
  const { command_id: _commandId, ...idempotentFacts } = command;
  return createHash('sha256')
    .update(canonicalJson(idempotentFacts), 'utf8')
    .digest('hex');
}

export function mediaControlPayloadHash(
  payload: Record<string, unknown>
): string {
  if (!isPlainRecord(payload)) throw new Error('media_control_payload_invalid');
  checkedJsonValue(payload);
  return createHash('sha256')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

export function checkedMediaControlResult(
  input: MediaControlResult
): MediaControlResult {
  if (!input || typeof input !== 'object' ||
      input.protocol_version !== MEDIA_CONTROL_PROTOCOL_VERSION ||
      !MEDIA_CONTROL_RESULT_CLASSES.includes(input.result_class) ||
      typeof input.command_id !== 'string' ||
      !IDENTIFIER_PATTERN.test(input.command_id)) {
    throw new Error('media_control_result_invalid');
  }
  const baseKeys = ['protocol_version', 'result_class', 'command_id'];
  if (input.result_class === 'committed' ||
      input.result_class === 'replayed') {
    if (!hasExactKeys(input as unknown as Record<string, unknown>, [
      ...baseKeys,
      'session'
    ])) {
      throw new Error('media_control_result_invalid');
    }
    checkedSession(input.session);
  } else {
    const failure = input as Exclude<
      MediaControlResult,
      { result_class: 'committed' | 'replayed' }
    >;
    const expected = [
      ...baseKeys,
      'error_code',
      'retryable',
      ...(failure.session ? ['session'] : [])
    ];
    if (!hasExactKeys(
      input as unknown as Record<string, unknown>,
      expected
    ) ||
        typeof failure.error_code !== 'string' ||
        !IDENTIFIER_PATTERN.test(failure.error_code) ||
        typeof failure.retryable !== 'boolean' ||
        (failure.result_class === 'unknown' && failure.retryable !== true)) {
      throw new Error('media_control_result_invalid');
    }
    if (failure.session) checkedSession(failure.session);
  }
  return structuredClone(input);
}

export function checkedMediaSessionSnapshot(
  input: MediaSessionSnapshot
): MediaSessionSnapshot {
  checkedSession(input);
  return structuredClone(input);
}

export function compareMediaOwnerEpoch(left: string, right: string): -1 | 0 | 1 {
  const leftValue = checkedOwnerEpoch(left);
  const rightValue = checkedOwnerEpoch(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function checkedSession(value: MediaSessionSnapshot): void {
  if (!value || typeof value !== 'object' ||
      !hasExactKeys(value as unknown as Record<string, unknown>, [
        'media_reservation_id',
        'call_id',
        'owner_epoch',
        'last_sequence',
        'state',
        'transport_session_id',
        'effective_sdp',
        'expires_at',
        'updated_at'
      ])) {
    throw new Error('media_control_result_invalid');
  }
  for (const identifier of [
    value.media_reservation_id,
    value.call_id,
    value.transport_session_id
  ]) {
    if (typeof identifier !== 'string' ||
        !IDENTIFIER_PATTERN.test(identifier)) {
      throw new Error('media_control_result_invalid');
    }
  }
  checkedOwnerEpoch(value.owner_epoch);
  if (!Number.isInteger(value.last_sequence) ||
      value.last_sequence < 1 ||
      value.last_sequence > 0xffff_ffff ||
      !['prepared', 'committed', 'cancelled', 'closed', 'expired']
        .includes(value.state) ||
      typeof value.effective_sdp !== 'string' ||
      Buffer.byteLength(value.effective_sdp, 'utf8') > MAX_SDP_BYTES ||
      !isCanonicalDateTime(value.expires_at) ||
      !isCanonicalDateTime(value.updated_at)) {
    throw new Error('media_control_result_invalid');
  }
}

function checkedOwnerEpoch(value: string): bigint {
  if (typeof value !== 'string' || !OWNER_EPOCH_PATTERN.test(value)) {
    throw new Error('media_control_owner_epoch_invalid');
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) {
    throw new Error('media_control_owner_epoch_invalid');
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('media_control_payload_invalid');
  return encoded;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length &&
    actual.every((key, index) => key === required[index]);
}

function isCanonicalDateTime(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function checkedJsonValue(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 }
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > 4_096 || depth > 16) {
      throw new Error('media_control_payload_invalid');
    }
    if (value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error('media_control_payload_invalid');
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 1_024) {
        throw new Error('media_control_payload_invalid');
      }
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isPlainRecord(value) || Object.keys(value).length > 64) {
      throw new Error('media_control_payload_invalid');
    }
    for (const item of Object.values(value)) {
      pending.push({ value: item, depth: depth + 1 });
    }
  }
}
