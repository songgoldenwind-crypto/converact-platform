import { canonicalVoicePayloadHash } from './canonical.js';
import { VoiceError } from './errors.js';

export type VoiceCdrLegRole = 'caller' | 'callee';
export type VoiceCdrState = 'pending_unacknowledged' | 'committed';
export type VoiceAvailabilityProfile = 'VOICE-ORDINARY' | 'VOICE-HA-T1';
export type VoiceCdrMediaResult =
  | 'not_started'
  | 'relayed'
  | 'bypassed'
  | 'transcoded'
  | 'timeout'
  | 'failed';

export interface VoiceCdrCallSummary {
  winning_branch_hash: string | null;
  early_media: boolean;
  transfer_chain_hashes: string[];
  media_timeout: boolean;
  started_at: string;
  answered_at: string | null;
  ended_at: string;
}

export interface VoiceCdrLeg {
  role: VoiceCdrLegRole;
  dialog_id_hash: string;
  direction: 'inbound' | 'outbound';
  sip_final_code: number;
  hangup_cause: string;
  answered_at: string | null;
  ended_at: string;
  media_result: VoiceCdrMediaResult;
  reservation_ref: string | null;
  owner_epoch: string;
  route_snapshot_revision: string;
}

export interface VoiceDualLegCdr {
  schema_version: '1.0.0';
  state: 'pending_unacknowledged';
  interaction_id: string;
  provider_call_id: string;
  cell_id: string;
  owner_node_id: string;
  expected_region_id: string;
  availability_profile: VoiceAvailabilityProfile;
  owner_epoch: string;
  sequence: string;
  call: VoiceCdrCallSummary;
  legs: VoiceCdrLeg[];
  payload_hash: string;
}

export interface VoiceCdrDurabilityContract {
  id: string;
  region_id: string;
  fault_domains: string[];
  quorum_size: number;
  status: 'active' | 'unavailable' | 'disabled';
}

export interface VoiceCdrProjectedLeg extends VoiceCdrLeg {
  sequence: string;
}

export interface VoiceCdrProjection {
  interaction_id: string;
  provider_call_id: string;
  cell_id: string;
  owner_node_id: string;
  availability_profile: VoiceAvailabilityProfile;
  owner_epoch: string;
  highest_sequence: string;
  latest_payload_hash: string;
  state: VoiceCdrState;
  call: VoiceCdrCallSummary;
  legs: Partial<Record<VoiceCdrLegRole, VoiceCdrProjectedLeg>>;
  durability_contract_id: string | null;
  durability_region_id: string | null;
  billing_event_id: string | null;
}

export interface VoiceCdrMergeResult {
  outcome: 'accepted' | 'replayed' | 'stale';
  projection: VoiceCdrProjection;
  emit_billing_event: boolean;
}

export interface VoiceCdrDurableReceipt {
  schema_version: '1.0.0';
  state: VoiceCdrState;
  receipt_id: string | null;
  interaction_id: string;
  provider_call_id: string;
  acknowledged_sequence: string;
  committed_sequence: string | null;
  acknowledged_payload_hash: string;
  region_id: string | null;
  durability_contract_id: string | null;
  committed_at: string | null;
  replayed: boolean;
}

export interface VoiceCdrConvergencePort {
  converge(input: {
    tenant_id: string;
    profile_id: string;
    authoritative_availability_profile: VoiceAvailabilityProfile;
    envelope: VoiceDualLegCdr;
  }): Promise<VoiceCdrDurableReceipt>;
}

const TOP_LEVEL_KEYS = [
  'availability_profile',
  'call',
  'cell_id',
  'expected_region_id',
  'interaction_id',
  'legs',
  'owner_epoch',
  'owner_node_id',
  'provider_call_id',
  'schema_version',
  'sequence',
  'state'
] as const;
const CALL_KEYS = [
  'answered_at',
  'early_media',
  'ended_at',
  'media_timeout',
  'started_at',
  'transfer_chain_hashes',
  'winning_branch_hash'
] as const;
const LEG_KEYS = [
  'answered_at',
  'dialog_id_hash',
  'direction',
  'ended_at',
  'hangup_cause',
  'media_result',
  'owner_epoch',
  'reservation_ref',
  'role',
  'route_snapshot_revision',
  'sip_final_code'
] as const;
const MEDIA_RESULTS = new Set<VoiceCdrMediaResult>([
  'not_started',
  'relayed',
  'bypassed',
  'transcoded',
  'timeout',
  'failed'
]);
const MAX_SAFE_DECIMAL = 9_007_199_254_740_991n;
const MAX_T1_OWNER_EPOCH = 4_294_967_295n;

export function parseVoiceDualLegCdr(input: unknown): VoiceDualLegCdr {
  const value = exactRecord(input, TOP_LEVEL_KEYS);
  if (value.schema_version !== '1.0.0' || value.state !== 'pending_unacknowledged') {
    throw protocolMismatch();
  }
  const availabilityProfile = availabilityProfileValue(value.availability_profile);
  const ownerEpoch = positiveDecimal(
    value.owner_epoch,
    'owner_epoch',
    availabilityProfile === 'VOICE-HA-T1'
      ? MAX_T1_OWNER_EPOCH
      : MAX_SAFE_DECIMAL
  );
  const sequence = positiveDecimal(value.sequence, 'sequence', MAX_SAFE_DECIMAL);
  const call = parseCall(value.call);
  if (!Array.isArray(value.legs) || value.legs.length < 1 || value.legs.length > 2) {
    throw protocolMismatch();
  }
  const legs = value.legs.map((leg) => parseLeg(
    leg,
    availabilityProfile === 'VOICE-HA-T1'
      ? MAX_T1_OWNER_EPOCH
      : MAX_SAFE_DECIMAL
  ));
  if (new Set(legs.map((leg) => leg.role)).size !== legs.length) {
    throw protocolMismatch();
  }
  if (legs.some((leg) => leg.owner_epoch !== ownerEpoch)) throw protocolMismatch();
  const normalized = {
    schema_version: '1.0.0' as const,
    state: 'pending_unacknowledged' as const,
    interaction_id: identifier(value.interaction_id),
    provider_call_id: providerCallId(value.provider_call_id),
    cell_id: identifier(value.cell_id),
    owner_node_id: identifier(value.owner_node_id),
    expected_region_id: identifier(value.expected_region_id),
    availability_profile: availabilityProfile,
    owner_epoch: ownerEpoch,
    sequence,
    call,
    legs
  };
  return {
    ...normalized,
    payload_hash: canonicalVoicePayloadHash(normalized)
  };
}

export function mergeVoiceCdrProjection(
  previous: VoiceCdrProjection | null,
  incoming: VoiceDualLegCdr,
  durability: VoiceCdrDurabilityContract | null,
  options: { journaled_replay?: boolean } = {}
): VoiceCdrMergeResult {
  if (previous) assertSameCall(previous, incoming);
  if (previous && !options.journaled_replay) {
    assertAuthorityProgression(previous, incoming);
  }
  const incomingSequence = BigInt(incoming.sequence);
  const previousSequence = previous ? BigInt(previous.highest_sequence) : null;

  if (previousSequence !== null && incomingSequence < previousSequence) {
    const projection = cloneProjection(previous);
    let filledMissingLeg = false;
    for (const leg of incoming.legs) {
      if (projection.legs[leg.role]) continue;
      projection.legs[leg.role] = { ...leg, sequence: incoming.sequence };
      filledMissingLeg = true;
    }
    if (filledMissingLeg && projection.state === 'pending_unacknowledged' &&
        hasBothLegs(projection.legs) && isDurable(durability)) {
      projection.state = 'committed';
      projection.durability_contract_id = durability.id;
      projection.durability_region_id = durability.region_id;
    }
    return {
      outcome: filledMissingLeg ? 'accepted' : 'stale',
      projection,
      emit_billing_event: filledMissingLeg &&
        projection.state === 'committed' &&
        projection.billing_event_id === null
    };
  }

  if (previousSequence !== null && incomingSequence === previousSequence) {
    if (previous.latest_payload_hash !== incoming.payload_hash) {
      throw new VoiceError({
        code: 'event_sequence_conflict',
        status: 409,
        retryable: false
      });
    }
    const canUpgrade = previous.state === 'pending_unacknowledged' &&
      isDurable(durability) &&
      hasBothLegs(previous.legs);
    if (!canUpgrade) {
      return {
        outcome: 'replayed',
        projection: cloneProjection(previous),
        emit_billing_event: false
      };
    }
    return {
      outcome: 'accepted',
      projection: {
        ...cloneProjection(previous),
        state: 'committed',
        durability_contract_id: durability.id,
        durability_region_id: durability.region_id
      },
      emit_billing_event: previous.billing_event_id === null
    };
  }

  const legs: VoiceCdrProjection['legs'] = previous
    ? cloneLegs(previous.legs)
    : {};
  for (const leg of incoming.legs) {
    legs[leg.role] = { ...leg, sequence: incoming.sequence };
  }
  const committed = hasBothLegs(legs) && isDurable(durability);
  const projection: VoiceCdrProjection = {
    interaction_id: incoming.interaction_id,
    provider_call_id: incoming.provider_call_id,
    cell_id: incoming.cell_id,
    owner_node_id: incoming.owner_node_id,
    availability_profile: incoming.availability_profile,
    owner_epoch: incoming.owner_epoch,
    highest_sequence: incoming.sequence,
    latest_payload_hash: incoming.payload_hash,
    state: committed ? 'committed' : 'pending_unacknowledged',
    call: structuredClone(incoming.call),
    legs,
    durability_contract_id: committed ? durability.id : null,
    durability_region_id: committed ? durability.region_id : null,
    billing_event_id: previous?.billing_event_id ?? null
  };
  return {
    outcome: 'accepted',
    projection,
    emit_billing_event: committed && projection.billing_event_id === null
  };
}

function parseCall(input: unknown): VoiceCdrCallSummary {
  const value = exactRecord(input, CALL_KEYS);
  const startedAt = timestamp(value.started_at);
  const answeredAt = nullableTimestamp(value.answered_at);
  const endedAt = timestamp(value.ended_at);
  if (Date.parse(startedAt) > Date.parse(endedAt) ||
      (answeredAt !== null &&
        (Date.parse(answeredAt) < Date.parse(startedAt) ||
          Date.parse(answeredAt) > Date.parse(endedAt)))) {
    throw protocolMismatch();
  }
  if (!Array.isArray(value.transfer_chain_hashes) || value.transfer_chain_hashes.length > 32) {
    throw protocolMismatch();
  }
  return {
    winning_branch_hash: nullableHash(value.winning_branch_hash),
    early_media: boolean(value.early_media),
    transfer_chain_hashes: value.transfer_chain_hashes.map(hash),
    media_timeout: boolean(value.media_timeout),
    started_at: startedAt,
    answered_at: answeredAt,
    ended_at: endedAt
  };
}

function parseLeg(input: unknown, maxOwnerEpoch: bigint): VoiceCdrLeg {
  const value = exactRecord(input, LEG_KEYS);
  const role = value.role;
  const direction = value.direction;
  const mediaResult = value.media_result;
  if ((role !== 'caller' && role !== 'callee') ||
      (direction !== 'inbound' && direction !== 'outbound') ||
      typeof mediaResult !== 'string' ||
      !MEDIA_RESULTS.has(mediaResult as VoiceCdrMediaResult)) {
    throw protocolMismatch();
  }
  const answeredAt = nullableTimestamp(value.answered_at);
  const endedAt = timestamp(value.ended_at);
  if (answeredAt !== null && Date.parse(answeredAt) > Date.parse(endedAt)) {
    throw protocolMismatch();
  }
  const finalCode = boundedInteger(value.sip_final_code, 0, 699);
  if (finalCode !== 0 && finalCode < 100) throw protocolMismatch();
  return {
    role,
    dialog_id_hash: hash(value.dialog_id_hash),
    direction,
    sip_final_code: finalCode,
    hangup_cause: token(value.hangup_cause, 64),
    answered_at: answeredAt,
    ended_at: endedAt,
    media_result: mediaResult as VoiceCdrMediaResult,
    reservation_ref: nullableIdentifier(value.reservation_ref),
    owner_epoch: positiveDecimal(value.owner_epoch, 'owner_epoch', maxOwnerEpoch),
    route_snapshot_revision: positiveDecimal(
      value.route_snapshot_revision,
      'route_snapshot_revision',
      MAX_SAFE_DECIMAL
    )
  };
}

function isDurable(
  contract: VoiceCdrDurabilityContract | null
): contract is VoiceCdrDurabilityContract {
  if (!contract || contract.status !== 'active' ||
      !identifierPattern(contract.id) ||
      !identifierPattern(contract.region_id) ||
      !Number.isSafeInteger(contract.quorum_size) ||
      contract.quorum_size < 2) {
    return false;
  }
  const domains = new Set(
    contract.fault_domains.filter((domain) => identifierPattern(domain))
  );
  return domains.size >= 2 && contract.quorum_size <= domains.size;
}

function hasBothLegs(
  legs: VoiceCdrProjection['legs']
): legs is Record<VoiceCdrLegRole, VoiceCdrProjectedLeg> {
  return Boolean(legs.caller && legs.callee);
}

function assertSameCall(
  previous: VoiceCdrProjection,
  incoming: VoiceDualLegCdr
): void {
  if (previous.interaction_id !== incoming.interaction_id ||
      previous.provider_call_id !== incoming.provider_call_id ||
      previous.cell_id !== incoming.cell_id ||
      previous.availability_profile !== incoming.availability_profile) {
    throw new VoiceError({
      code: 'event_sequence_conflict',
      status: 409,
      retryable: false
    });
  }
}

function assertAuthorityProgression(
  previous: VoiceCdrProjection,
  incoming: VoiceDualLegCdr
): void {
  const previousEpoch = BigInt(previous.owner_epoch);
  const incomingEpoch = BigInt(incoming.owner_epoch);
  const sameOwner = previous.owner_node_id === incoming.owner_node_id;
  if (incomingEpoch < previousEpoch ||
      (incomingEpoch === previousEpoch && !sameOwner) ||
      (!sameOwner && incoming.availability_profile !== 'VOICE-HA-T1') ||
      (!sameOwner && incomingEpoch <= previousEpoch)) {
    throw new VoiceError({
      code: 'event_sequence_conflict',
      status: 409,
      retryable: false
    });
  }
}

function cloneProjection(value: VoiceCdrProjection): VoiceCdrProjection {
  return {
    ...value,
    call: structuredClone(value.call),
    legs: cloneLegs(value.legs)
  };
}

function cloneLegs(
  value: VoiceCdrProjection['legs']
): VoiceCdrProjection['legs'] {
  return {
    ...(value.caller ? { caller: { ...value.caller } } : {}),
    ...(value.callee ? { callee: { ...value.callee } } : {})
  };
}

function exactRecord<const K extends readonly string[]>(
  input: unknown,
  keys: K
): Record<K[number], unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw protocolMismatch();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw protocolMismatch();
  const actualKeys = Object.keys(input as Record<string, unknown>).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw protocolMismatch();
  }
  return input as Record<K[number], unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !identifierPattern(value)) throw protocolMismatch();
  return value;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function identifierPattern(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value);
}

function providerCallId(value: unknown): string {
  if (typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') < 1 ||
      Buffer.byteLength(value, 'utf8') > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw protocolMismatch();
  }
  return value;
}

function positiveDecimal(
  value: unknown,
  _label: string,
  maximum: bigint
): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw protocolMismatch();
  }
  if (BigInt(value) > maximum) throw protocolMismatch();
  return value;
}

function availabilityProfileValue(value: unknown): VoiceAvailabilityProfile {
  if (value !== 'VOICE-ORDINARY' && value !== 'VOICE-HA-T1') {
    throw protocolMismatch();
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw protocolMismatch();
  }
  return value;
}

function nullableHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}

function token(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' ||
      !/^[a-z][a-z0-9_]*$/.test(value) ||
      Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw protocolMismatch();
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw protocolMismatch();
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) {
    throw protocolMismatch();
  }
  return Number(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) throw protocolMismatch();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw protocolMismatch();
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function protocolMismatch(): VoiceError {
  return new VoiceError({
    code: 'protocol_mismatch',
    status: 422,
    retryable: false
  });
}
