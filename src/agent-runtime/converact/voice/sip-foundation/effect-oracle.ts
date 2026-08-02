import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';

import { canonicalVoicePayloadHash } from '../canonical.js';
import {
  validateBackendRuntimeIdentity
} from './capabilities.js';
import {
  snapshotClosedArray,
  snapshotClosedBytes,
  snapshotClosedRecord,
  snapshotClosedShape,
  snapshotDataRecord
} from './closed-schema.js';
import {
  bindSipRoute,
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256,
  validateBoundSipWireAttemptFacts
} from './route-binding.js';
import {
  SipFoundationError,
  type BackendRuntimeIdentity,
  type BoundSipRouteBinding,
  type BoundSipWireAttemptFacts,
  type PreparedProtocolEffect,
  type PreparedProtocolEffectAuthority
} from './types.js';

export type UInt64Decimal = string;

export type ProtocolEffectState =
  | 'prepared'
  | 'durable_decision'
  | 'send_attempted'
  | 'transport_accepted'
  | 'protocol_observed'
  | 'failed'
  | 'unknown';

export type ProtocolEffectReceiptLevel = Exclude<ProtocolEffectState, 'prepared'>;

export type StoreFailureCode =
  | 'store_timeout'
  | 'store_pool_exhausted'
  | 'store_unavailable'
  | 'store_schema_incompatible';

export type SipEffectErrorCode =
  | 'sip_effect_validation_failed'
  | 'sip_effect_prepared_authority_rejected'
  | 'sip_effect_wire_hash_mismatch'
  | 'sip_effect_idempotency_conflict'
  | 'sip_effect_identity_conflict'
  | 'sip_effect_receipt_conflict'
  | 'sip_effect_not_found'
  | 'sip_effect_transition_conflict'
  | 'sip_effect_terminal'
  | 'sip_effect_payload_expired'
  | 'sip_effect_fence_lost'
  | 'sip_effect_queue_full'
  | 'sip_effect_queue_capacity_invalid'
  | 'sip_effect_repair_limit_invalid'
  | 'sip_effect_retention_limit_invalid'
  | 'sip_effect_boundary_facts_invalid'
  | 'sip_effect_retry_after_input_invalid'
  | StoreFailureCode;

export class SipEffectError extends Error {
  readonly code: SipEffectErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: Readonly<Record<string, any>>;

  constructor(input: {
    code: SipEffectErrorCode;
    message?: string;
    retryable?: boolean;
    status?: number;
    details?: Readonly<Record<string, unknown>>;
    cause?: unknown;
  }) {
    super(
      input.message ?? input.code,
      input.cause === undefined ? undefined : { cause: input.cause }
    );
    this.name = 'SipEffectError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.status = input.status ?? 409;
    this.details = deepFreezeJson(cloneErrorDetails(input.details ?? {}));
  }
}

export type ProtocolEffectReceiptSemanticClass =
  | 'durable_decision'
  | 'send_attempted'
  | 'accepted'
  | 'completed'
  | 'state_observed'
  | 'unknown'
  | 'failed';

export interface ProtocolEffectReceiptSemanticInput {
  level: ProtocolEffectReceiptLevel;
  from_state: ProtocolEffectState;
}

const RECEIPT_SEMANTIC_INPUT_KEYS = ['level', 'from_state'] as const;

/**
 * Projects a persisted receipt tuple into externally meaningful semantics.
 * In particular, local transport acceptance is never promoted to protocol
 * completion, and reconciliation from unknown remains distinguishable from a
 * completion observed on the primary path.
 */
export function classifyProtocolEffectReceipt(
  input: ProtocolEffectReceiptSemanticInput
): ProtocolEffectReceiptSemanticClass {
  const value = snapshotClosedRecord(
    input,
    RECEIPT_SEMANTIC_INPUT_KEYS,
    receiptSemanticError
  );
  const level = value.level as ProtocolEffectReceiptLevel;
  const fromState = value.from_state as ProtocolEffectState;
  if (level === 'durable_decision' && fromState === 'prepared') {
    return 'durable_decision';
  }
  if (level === 'send_attempted' && fromState === 'durable_decision') {
    return 'send_attempted';
  }
  if (level === 'transport_accepted' && fromState === 'send_attempted') {
    return 'accepted';
  }
  if (level === 'protocol_observed' &&
      (fromState === 'send_attempted' ||
       fromState === 'transport_accepted')) {
    return 'completed';
  }
  if (level === 'protocol_observed' && fromState === 'unknown') {
    return 'state_observed';
  }
  if (level === 'unknown' &&
      (fromState === 'send_attempted' ||
       fromState === 'transport_accepted' ||
       fromState === 'unknown')) {
    return 'unknown';
  }
  if (level === 'failed' &&
      (fromState === 'prepared' ||
       fromState === 'durable_decision' ||
       fromState === 'send_attempted' ||
       fromState === 'transport_accepted' ||
       fromState === 'unknown')) {
    return 'failed';
  }
  throw receiptSemanticError();
}

function receiptSemanticError(): SipEffectError {
  return new SipEffectError({
    code: 'sip_effect_validation_failed',
    message: 'illegal persisted SIP effect receipt tuple'
  });
}

export interface DurableProtocolEffectPrepareInput {
  tenant_id: string;
  decision_id: string;
  idempotency_key: string;
  request_hash: string;
  prepared_effect: PreparedProtocolEffect;
  audit_until?: Date;
}

export interface ProtocolEffectIdentity {
  tenant_id: string;
  protocol_effect_id: string;
  protocol_session_id: string;
  protocol_session_generation: string;
  decision_id: string;
  idempotency_key: string;
  request_hash: string;
  command_id: string;
  adapter_identity_hash: string;
  wire_bytes_hash: string;
  wire_length_bytes: number;
  route_binding_hash: string;
  wire_attempt_facts_hash: string;
  wire_freeze_sha256: string;
  owner_epoch: UInt64Decimal;
  command_sequence: UInt64Decimal;
}

export interface ProtocolEffectTombstone {
  receipt_id: string;
  receipt_hash: string;
  state: 'protocol_observed' | 'failed';
  terminal_at: string;
}

export interface ProtocolEffectRecord extends ProtocolEffectIdentity {
  schema_id: typeof SIP_EFFECT_SCHEMA_ID;
  schema_version: typeof SIP_EFFECT_SCHEMA_VERSION;
  schema_hash: typeof SIP_EFFECT_SCHEMA_HASH;
  adapter_identity: BackendRuntimeIdentity;
  canonical_wire_bytes: Uint8Array;
  route_binding: BoundSipRouteBinding;
  wire_attempt_facts: BoundSipWireAttemptFacts;
  state: ProtocolEffectState;
  revision: UInt64Decimal;
  unknown_count: number;
  last_receipt_id: string | null;
  last_receipt_hash: string | null;
  last_receipt_repair_delay_ms: number | null;
  failure_code: string;
  repair_due_at: string | null;
  repair_owner_id: string | null;
  repair_owner_epoch: UInt64Decimal | null;
  repair_epoch_high_watermark: UInt64Decimal;
  repair_claim_token: string | null;
  repair_claim_revision: UInt64Decimal | null;
  repair_lease_until: string | null;
  repair_attempts: number;
  repair_exhausted_at: string | null;
  repair_exhaustion_receipt_hash: string | null;
  operator_attention_required: boolean;
  repair_compacted_at: string | null;
  retention_reference_count: number;
  rollback_reference_count: number;
  audit_until: string;
  payload_retained: boolean;
  terminal_tombstone: ProtocolEffectTombstone | null;
  prepared_at: string;
  updated_at: string;
}

export interface EffectRepairFence {
  repair_owner_id: string;
  repair_owner_epoch: UInt64Decimal;
  repair_claim_token: string;
  repair_claim_revision: UInt64Decimal;
}

export interface EffectTransition {
  identity: ProtocolEffectIdentity;
  receipt_id: string;
  receipt_hash: string;
  level: ProtocolEffectReceiptLevel;
  allowed_from: readonly ProtocolEffectState[];
  observed_at: string;
  failure_code: string;
  repair_delay_ms: number | null;
  terminal: boolean;
  repair_fence: EffectRepairFence | null;
}

export interface EffectRepairClaim {
  tenant_id: string;
  repair_owner_id: string;
  repair_owner_epoch: UInt64Decimal;
  claim_token_prefix: string;
  claimed_at: Date;
  lease_until: Date;
  limit: number;
}

export interface EffectRepairBatch {
  effects: ProtocolEffectRecord[];
  exhausted_count: number;
}

export interface EffectRepairReleaseRequest {
  identity: ProtocolEffectIdentity;
  fence: EffectRepairFence;
  released_at: Date;
  next_repair_at: Date;
}

export interface EffectRepairCompactRequest {
  tenant_id: string;
  cutoff: Date;
  limit: number;
}

export interface EffectRetentionRequest {
  tenant_id: string;
  cutoff: Date;
  limit: number;
}

export type DurableBoundaryKind =
  | 'call_admission'
  | 'media_generation'
  | 'bridge_head'
  | 'recording';

export type AtomicBoundaryFactType =
  | 'call_session'
  | 'protocol_effect'
  | 'effect_wal'
  | 'capacity_reservation_receipt'
  | 'idempotency_record'
  | 'media_plan'
  | 'directed_media_edges'
  | 'backend_binding_groups'
  | 'bridge_command'
  | 'bridge_decision'
  | 'bridge_receipt'
  | 'head_compare_and_swap'
  | 'recording_intent'
  | 'root_recording_manifest'
  | 'source_chain'
  | 'segment_reference';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AtomicBoundaryWriteReceipt {
  fact_type: AtomicBoundaryFactType;
  receipt_id: string;
  aggregate_id: string;
  aggregate_revision: UInt64Decimal;
  applied: true;
  payload: JsonObject;
  expected_revision?: UInt64Decimal;
  committed_revision?: UInt64Decimal;
  expected_owner_epoch?: UInt64Decimal;
  committed_owner_epoch?: UInt64Decimal;
  expected_state?: string;
  committed_state?: string;
  cas_applied?: true;
}

export interface AtomicBoundaryResult {
  boundary_kind: DurableBoundaryKind;
  writes: readonly AtomicBoundaryWriteReceipt[];
}

export interface AtomicBoundaryMetadata {
  tenant_id: string;
  boundary_id: string;
  boundary_kind: DurableBoundaryKind;
  decision_id: string;
  idempotency_key: string;
  request_hash: string;
  owner_epoch: UInt64Decimal;
  command_sequence: UInt64Decimal;
  committed_at: Date;
}

export interface AtomicBoundaryFactRecord {
  fact_type: AtomicBoundaryFactType;
  receipt_id: string;
  aggregate_id: string;
  aggregate_revision: UInt64Decimal;
  fact_hash: string;
  payload: JsonValue;
}

export interface AtomicBoundaryCommit {
  metadata: Omit<AtomicBoundaryMetadata, 'committed_at'> & {
    committed_at: string;
  };
  result: AtomicBoundaryResult;
  facts: AtomicBoundaryFactRecord[];
  facts_hash: string;
  boundary_hash: string;
}

export interface AtomicBoundaryCommitResult {
  replayed: boolean;
  facts_hash: string;
  boundary_hash: string;
}

export interface ProtocolEffectStore {
  prepare(effect: ProtocolEffectRecord): Promise<{
    effect: ProtocolEffectRecord;
    replayed: boolean;
  }>;
  transition(input: EffectTransition): Promise<ProtocolEffectRecord>;
  query(identity: ProtocolEffectIdentity): Promise<ProtocolEffectRecord | null>;
  claimUnknownForRepair(input: EffectRepairClaim): Promise<EffectRepairBatch>;
  releaseRepairClaim(input: EffectRepairReleaseRequest): Promise<void>;
  compactExhaustedRepairs(input: EffectRepairCompactRequest): Promise<number>;
  pruneTerminalPayloads(input: EffectRetentionRequest): Promise<number>;
}

const MAX_CANONICAL_JSON_UTF8_BYTES = 65_536;
const MAX_ERROR_DETAILS_UTF8_BYTES = 8_192;
const MAX_ERROR_DETAIL_STRING_UTF8_BYTES = 1_024;
const MAX_ERROR_DETAIL_KEY_UTF8_BYTES = 128;

export const SIP_EFFECT_SCHEMA_ID = 'ivekit.sip-effect-oracle' as const;
export const SIP_EFFECT_SCHEMA_VERSION = 1 as const;
export const SIP_EFFECT_MACHINE_SCHEMA_DESCRIPTOR = deepFreezeJson({
  schema_id: SIP_EFFECT_SCHEMA_ID,
  schema_version: SIP_EFFECT_SCHEMA_VERSION,
  closedness: {
    records: 'exact-enumerable-own-data-properties-only',
    arrays: 'dense-exact-array-prototype-no-symbols-or-extra-keys',
    bytes: 'exact-buffer-or-uint8array-native-bulk-copy',
    rejected: ['accessor', 'non-enumerable', 'symbol', 'proxy', 'shared-array-buffer']
  },
  scalar_contracts: {
    uint64: 'canonical-decimal-string:0..18446744073709551615',
    positive_uint64: 'canonical-decimal-string:1..18446744073709551615',
    sha256: 'lowercase-hex-64',
    identifier: 'printable-ascii:1..200',
    timestamp: 'finite-iso8601',
    wire_bytes: 'immutable:1..65535',
    canonical_json_utf8_bytes: '0..65536'
  },
  foundation_preparation_authority: {
    adapter_runtime_identity: [
      'backend_id',
      'source_digest',
      'binary_digest',
      'config_digest',
      'capability_set_digest',
      'runtime_attestation_verification',
      'production_eligible'
    ],
    prepared_wire_identity: [
      'protocol_session_id',
      'protocol_session_generation',
      'effect_id',
      'command_id',
      'owner_epoch',
      'command_sequence',
      'wire_sha256',
      'route_binding_sha256',
      'wire_attempt_facts_sha256',
      'wire_freeze_sha256',
      'wire_length_bytes'
    ],
    route_binding_v1: [
      'schema_id',
      'schema_version',
      'route.id',
      'route.revision',
      'rfc3263_candidate',
      'route_set',
      'transport.id',
      'transport.protocol',
      'transport.next_hop.address',
      'transport.next_hop.port',
      'local_endpoint.address',
      'local_endpoint.port',
      'advertised_via_sent_by.host',
      'advertised_via_sent_by.port',
      'tls_sni',
      'authorization_identity',
      'authorization_headers_sha256'
    ],
    wire_attempt_facts_v1: [
      'schema_id',
      'schema_version',
      'attempt_id',
      'transaction_lineage_id',
      'semantic_intent_sha256',
      'parent_attempt_id',
      'lineage_reason',
      'via_branch'
    ]
  },
  protocol_effect_identity_fields: [
    'tenant_id',
    'protocol_effect_id',
    'protocol_session_id',
    'protocol_session_generation',
    'decision_id',
    'idempotency_key',
    'request_hash',
    'command_id',
    'adapter_identity_hash',
    'wire_bytes_hash',
    'wire_length_bytes',
    'route_binding_hash',
    'wire_attempt_facts_hash',
    'wire_freeze_sha256',
    'owner_epoch',
    'command_sequence'
  ],
  protocol_effect_record_fields: [
    'protocol_effect_identity_fields',
    'schema_id',
    'schema_version',
    'schema_hash',
    'adapter_identity',
    'canonical_wire_bytes',
    'route_binding',
    'wire_attempt_facts',
    'state',
    'revision',
    'unknown_count',
    'last_receipt_id',
    'last_receipt_hash',
    'last_receipt_repair_delay_ms',
    'failure_code',
    'repair_due_at',
    'repair_owner_id',
    'repair_owner_epoch',
    'repair_epoch_high_watermark',
    'repair_claim_token',
    'repair_claim_revision',
    'repair_lease_until',
    'repair_attempts',
    'repair_exhausted_at',
    'repair_exhaustion_receipt_hash',
    'operator_attention_required',
    'repair_compacted_at',
    'retention_reference_count',
    'rollback_reference_count',
    'audit_until',
    'payload_retained',
    'terminal_tombstone',
    'prepared_at',
    'updated_at'
  ],
  receipt_record_fields: [
    'receipt_id',
    'protocol_effect_identity_fields',
    'receipt_hash',
    'level',
    'from_state',
    'failure_code',
    'repair_delay_ms',
    'observed_at:database-clock',
    'schema_id',
    'schema_version',
    'schema_hash',
    'writer_identity'
  ],
  states: [
    'prepared',
    'durable_decision',
    'send_attempted',
    'transport_accepted',
    'protocol_observed',
    'failed',
    'unknown'
  ],
  transition_graph: {
    prepared: ['durable_decision', 'failed'],
    durable_decision: ['send_attempted', 'failed'],
    send_attempted: [
      'transport_accepted',
      'protocol_observed',
      'failed',
      'unknown'
    ],
    transport_accepted: ['protocol_observed', 'failed', 'unknown'],
    unknown: ['unknown', 'protocol_observed', 'failed'],
    protocol_observed: [],
    failed: []
  },
  receipt_hash_fields: [
    'identity',
    'receipt_id',
    'level',
    'failure_code',
    'repair_delay_ms'
  ],
  wire_freeze: {
    immutable_after_prepare: [
      'protocol_session_id',
      'protocol_session_generation',
      'adapter_identity',
      'adapter_identity_hash',
      'canonical_wire_bytes',
      'wire_bytes_hash',
      'wire_length_bytes',
      'route_binding',
      'route_binding_hash',
      'wire_attempt_facts',
      'wire_attempt_facts_hash',
      'wire_freeze_sha256',
      'effect_identity_hash',
      'owner_epoch',
      'command_sequence'
    ],
    retransmit_states: [
      'durable_decision',
      'send_attempted',
      'transport_accepted'
    ],
    unknown_requires_repair_fence: true
  },
  repair: {
    delay_ms: '0..86400000',
    lease_ms: '1..30000:database-clock',
    attempts: '0..8',
    batch_size: '1..100',
    fence: [
      'repair_owner_id',
      'repair_owner_epoch',
      'repair_claim_token',
      'repair_claim_revision',
      'live_database_lease'
    ]
  },
  retention: {
    default_wire_audit_ms: 604800000,
    terminal_payload_prune_requires: [
      'audit_until_elapsed',
      'retention_reference_count=0',
      'rollback_reference_count=0'
    ],
    row_gc: 'not_run'
  },
  atomic_boundaries: {
    call_admission: [
      'call_session',
      'protocol_effect',
      'effect_wal',
      'capacity_reservation_receipt',
      'idempotency_record'
    ],
    media_generation: [
      'media_plan',
      'directed_media_edges',
      'backend_binding_groups',
      'capacity_reservation_receipt'
    ],
    bridge_head: [
      'bridge_command',
      'bridge_decision',
      'bridge_receipt',
      'head_compare_and_swap'
    ],
    recording: [
      'recording_intent',
      'root_recording_manifest',
      'source_chain',
      'segment_reference'
    ],
    fact_payload_shape: 'closed-json-object',
    fact_payload_utf8_bytes: '0..65536'
  },
  writer_governance: {
    schema_slots: ['N', 'N+1'],
    default_enabled: false,
    activation_requires_receipt: true,
    one_elected_writer_per_transaction: true,
    producer_reader_compatibility: 'not_run'
  }
});
export const SIP_EFFECT_SCHEMA_HASH = canonicalSipEffectHash(
  SIP_EFFECT_MACHINE_SCHEMA_DESCRIPTOR
);

export const SIP_EFFECT_ATOMIC_DOMAIN_WRITES_STATUS = Object.freeze({
  status: 'not_wired_not_production' as const,
  production_eligible: false as const
});

export const SIP_EFFECT_PHYSICAL_POSTGRES_VERIFICATION = Object.freeze({
  rls_cross_tenant: 'not_run' as const,
  skip_locked_concurrency: 'not_run' as const,
  statement_timeout: 'not_run' as const,
  lock_timeout: 'not_run' as const,
  transaction_rollback: 'not_run' as const,
  writer_activation_receipt: 'not_run' as const,
  direct_dml_state_graph: 'not_run' as const,
  producer_reader_compatibility: 'not_run' as const,
  cross_lineage_owner_high_watermark: 'not_run' as const,
  artifact_row_gc: 'not_run' as const,
  production_eligible: false as const
});

type MetricOperation =
  | 'prepare'
  | 'query'
  | 'transition'
  | 'retransmit'
  | 'repair'
  | 'retention';

type MetricResult = 'succeeded' | 'conflict' | 'failed' | 'unknown' | 'empty';
type RepairMetricResult = 'claimed' | 'exhausted' | 'empty' | 'released' | 'failed';
type RepairMetricUnit = 'batches' | 'effects';

interface MutableOperationMetric {
  operation: MetricOperation;
  result: MetricResult;
  count: number;
  total_latency_ms: number;
  max_latency_ms: number;
}

interface MutableRepairMetric {
  result: RepairMetricResult;
  unit: RepairMetricUnit;
  count: number;
}

export interface SipEffectMetricSnapshot {
  operations: MutableOperationMetric[];
  queue_depth: {
    current: number;
    high_watermark: number;
  };
  unknown_total: number;
  repairs: MutableRepairMetric[];
}

const METRIC_OPERATIONS: readonly MetricOperation[] = [
  'prepare',
  'query',
  'transition',
  'retransmit',
  'repair',
  'retention'
];
const METRIC_RESULTS: readonly MetricResult[] = [
  'succeeded',
  'conflict',
  'failed',
  'unknown',
  'empty'
];
const REPAIR_RESULTS: readonly RepairMetricResult[] = [
  'claimed',
  'exhausted',
  'empty',
  'released',
  'failed'
];
const REPAIR_UNITS: readonly RepairMetricUnit[] = ['batches', 'effects'];

export class SipEffectMetricBook {
  readonly #operations = new Map<string, MutableOperationMetric>();
  readonly #repairs = new Map<string, MutableRepairMetric>();
  #queueDepth = 0;
  #queueHighWatermark = 0;
  #unknownTotal = 0;

  constructor() {
    for (const operation of METRIC_OPERATIONS) {
      for (const result of METRIC_RESULTS) {
        this.#operations.set(`${operation}:${result}`, {
          operation,
          result,
          count: 0,
          total_latency_ms: 0,
          max_latency_ms: 0
        });
      }
    }
    for (const result of REPAIR_RESULTS) {
      for (const unit of REPAIR_UNITS) {
        this.#repairs.set(`${result}:${unit}`, { result, unit, count: 0 });
      }
    }
  }

  observeOperation(
    operation: MetricOperation,
    result: MetricResult,
    latencyMs: number
  ): void {
    const metric = this.#operations.get(`${operation}:${result}`)!;
    const latency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0;
    metric.count += 1;
    metric.total_latency_ms += latency;
    metric.max_latency_ms = Math.max(metric.max_latency_ms, latency);
  }

  observeRepair(
    result: RepairMetricResult,
    batches: number,
    effects: number
  ): void {
    this.#repairs.get(`${result}:batches`)!.count += batches;
    this.#repairs.get(`${result}:effects`)!.count += effects;
  }

  incrementUnknown(): void {
    this.#unknownTotal += 1;
  }

  setQueueDepth(depth: number): void {
    if (!Number.isSafeInteger(depth) || depth < 0 ||
        depth > EFFECT_QUEUE_DEPTH_CEILING) {
      throw new SipEffectError({
        code: 'sip_effect_queue_capacity_invalid',
        status: 422
      });
    }
    this.#queueDepth = depth;
    this.#queueHighWatermark = Math.max(this.#queueHighWatermark, depth);
  }

  snapshot(): SipEffectMetricSnapshot {
    return {
      operations: [...this.#operations.values()].map((entry) => ({ ...entry })),
      queue_depth: {
        current: this.#queueDepth,
        high_watermark: this.#queueHighWatermark
      },
      unknown_total: this.#unknownTotal,
      repairs: [...this.#repairs.values()].map((entry) => ({ ...entry }))
    };
  }
}

export class BoundedEffectQueue<T> {
  readonly #items: Array<T | undefined>;
  #head = 0;
  #tail = 0;
  #size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 ||
        capacity > EFFECT_QUEUE_DEPTH_CEILING) {
      throw new SipEffectError({
        code: 'sip_effect_queue_capacity_invalid',
        status: 422
      });
    }
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  enqueue(item: T): void {
    if (this.#size === this.capacity) {
      throw new SipEffectError({
        code: 'sip_effect_queue_full',
        status: 503,
        retryable: true,
        details: { queue_depth: this.#size }
      });
    }
    this.#items[this.#tail] = item;
    this.#tail = (this.#tail + 1) % this.capacity;
    this.#size += 1;
  }

  dequeue(): T | undefined {
    if (this.#size === 0) return undefined;
    const item = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.capacity;
    this.#size -= 1;
    return item;
  }
}

/**
 * Durable SIP protocol-effect authority.
 *
 * "Oracle" here means a fact arbiter in the distributed-systems sense. It is
 * not Oracle Database; the production persistence adapter is PostgreSQL.
 */
export class SipEffectOracle {
  readonly #store: ProtocolEffectStore;
  readonly #preparedEffectAuthority: PreparedProtocolEffectAuthority;
  readonly #metrics: SipEffectMetricBook;
  readonly #now: () => Date;
  readonly #monotonicNowMs: () => number;

  constructor(input: {
    store: ProtocolEffectStore;
    prepared_effect_authority: PreparedProtocolEffectAuthority;
    metrics?: SipEffectMetricBook;
    now?: () => Date;
    monotonic_now_ms?: () => number;
  }) {
    const record = snapshotOptionalRecord(
      input,
      ['store', 'prepared_effect_authority'],
      ['metrics', 'now', 'monotonic_now_ms'],
      'oracle'
    );
    this.#store = record.store as ProtocolEffectStore;
    this.#preparedEffectAuthority = checkedPreparedEffectAuthority(
      record.prepared_effect_authority
    );
    this.#metrics =
      (record.metrics as SipEffectMetricBook | undefined) ??
      new SipEffectMetricBook();
    this.#now = (record.now as (() => Date) | undefined) ?? (() => new Date());
    this.#monotonicNowMs =
      (record.monotonic_now_ms as (() => number) | undefined) ??
      (() => performance.now());
  }

  async prepare(input: DurableProtocolEffectPrepareInput): Promise<{
    effect: ProtocolEffectRecord;
    replayed: boolean;
  }> {
    const startedAt = this.#monotonicNowMs();
    try {
      const effect = preparedEffect(
        input,
        this.#preparedEffectAuthority,
        validDate(this.#now(), 'now')
      );
      const storeResult = await this.#store.prepare(effect);
      const result = snapshotExactRecord(
        storeResult,
        ['effect', 'replayed'],
        'store_prepare_result'
      );
      if (typeof result.replayed !== 'boolean') {
        storeUnavailable('invalid_prepare_result');
      }
      this.#metrics.observeOperation(
        'prepare',
        'succeeded',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      return {
        effect: cloneProtocolEffect(result.effect as ProtocolEffectRecord),
        replayed: result.replayed
      };
    } catch (error) {
      const mappedError = error instanceof SipFoundationError
        ? new SipEffectError({
            code: 'sip_effect_prepared_authority_rejected',
            status: 422,
            cause: error
          })
        : error;
      this.#metrics.observeOperation(
        'prepare',
        mappedError instanceof SipEffectError &&
          mappedError.code === 'sip_effect_idempotency_conflict'
          ? 'conflict'
          : 'failed',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      throw mappedError;
    }
  }

  recordDurableDecision(
    identity: ProtocolEffectIdentity,
    receiptId: string
  ): Promise<ProtocolEffectRecord> {
    return this.#transition(
      identity,
      receiptId,
      'durable_decision',
      ['prepared']
    );
  }

  recordSendAttempted(
    identity: ProtocolEffectIdentity,
    receiptId: string
  ): Promise<ProtocolEffectRecord> {
    return this.#transition(
      identity,
      receiptId,
      'send_attempted',
      ['durable_decision']
    );
  }

  recordTransportAccepted(
    identity: ProtocolEffectIdentity,
    receiptId: string
  ): Promise<ProtocolEffectRecord> {
    return this.#transition(
      identity,
      receiptId,
      'transport_accepted',
      ['send_attempted']
    );
  }

  recordProtocolObserved(
    identity: ProtocolEffectIdentity,
    receiptId: string
  ): Promise<ProtocolEffectRecord> {
    return this.#transition(
      identity,
      receiptId,
      'protocol_observed',
      ['send_attempted', 'transport_accepted'],
      { terminal: true }
    );
  }

  recordFailed(
    identity: ProtocolEffectIdentity,
    receiptId: string,
    failureCode: string
  ): Promise<ProtocolEffectRecord> {
    return this.#transition(
      identity,
      receiptId,
      'failed',
      ['prepared', 'durable_decision', 'send_attempted', 'transport_accepted'],
      {
        terminal: true,
        failure_code: boundedText(failureCode, 'failure_code', 128)
      }
    );
  }

  recordUnknown(
    identity: ProtocolEffectIdentity,
    receiptId: string,
    options: { repair_after_ms?: number } = {}
  ): Promise<ProtocolEffectRecord> {
    const record = snapshotOptionalRecord(
      options,
      [],
      ['repair_after_ms'],
      'unknown_options'
    );
    const repairDelay = record.repair_after_ms === undefined
      ? DEFAULT_REPAIR_DELAY_MS
      : boundedInteger(
          record.repair_after_ms,
          0,
          MAX_REPAIR_DELAY_MS,
          'repair_after_ms'
        );
    const now = validDate(this.#now(), 'now');
    return this.#transition(
      identity,
      receiptId,
      'unknown',
      ['send_attempted', 'transport_accepted'],
      {
        now,
        repair_delay_ms: repairDelay
      }
    );
  }

  async query(identity: ProtocolEffectIdentity): Promise<ProtocolEffectRecord | null> {
    const startedAt = this.#monotonicNowMs();
    try {
      const checked = validateProtocolEffectIdentity(identity);
      const effect = await this.#store.query(checked);
      this.#metrics.observeOperation(
        'query',
        effect ? 'succeeded' : 'empty',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      return effect ? cloneProtocolEffect(effect) : null;
    } catch (error) {
      this.#metrics.observeOperation(
        'query',
        error instanceof SipEffectError &&
          error.code === 'sip_effect_identity_conflict'
          ? 'conflict'
          : 'failed',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      throw error;
    }
  }

  async wireBytesForRetransmission(
    identity: ProtocolEffectIdentity
  ): Promise<Uint8Array> {
    const startedAt = this.#monotonicNowMs();
    try {
      const effect = await this.#required(identity);
      if (effect.terminal_tombstone) {
        throw new SipEffectError({ code: 'sip_effect_terminal', status: 409 });
      }
      if (!effect.payload_retained) {
        throw new SipEffectError({
          code: 'sip_effect_payload_expired',
          status: 410
        });
      }
      if (effect.state === 'prepared') transitionConflict();
      if (effect.state === 'unknown') {
        throw new SipEffectError({
          code: 'sip_effect_fence_lost',
          status: 409
        });
      }
      const bytes = Buffer.from(effect.canonical_wire_bytes);
      if (sha256(bytes) !== effect.wire_bytes_hash) {
        throw new SipEffectError({
          code: 'sip_effect_wire_hash_mismatch',
          status: 409
        });
      }
      this.#metrics.observeOperation(
        'retransmit',
        'succeeded',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      return bytes;
    } catch (error) {
      this.#metrics.observeOperation(
        'retransmit',
        'failed',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      throw error;
    }
  }

  reconcile(
    identity: ProtocolEffectIdentity,
    fence: EffectRepairFence,
    input: {
      receipt_id: string;
      outcome: 'protocol_observed' | 'failed' | 'unknown';
      failure_code?: string;
      repair_after_ms?: number;
    }
  ): Promise<ProtocolEffectRecord> {
    const record = snapshotOptionalRecord(
      input,
      ['receipt_id', 'outcome'],
      ['failure_code', 'repair_after_ms'],
      'reconcile'
    );
    const checkedFence = validateEffectRepairFence(fence);
    const now = validDate(this.#now(), 'now');
    if (record.outcome === 'protocol_observed') {
      if (record.failure_code !== undefined ||
          record.repair_after_ms !== undefined) {
        validation('reconcile');
      }
      return this.#transition(
        identity,
        identifier(record.receipt_id, 'receipt_id'),
        'protocol_observed',
        ['unknown'],
        { terminal: true, repair_fence: checkedFence, now }
      );
    }
    if (record.outcome === 'failed') {
      if (record.repair_after_ms !== undefined) {
        validation('reconcile.repair_after_ms');
      }
      return this.#transition(
        identity,
        identifier(record.receipt_id, 'receipt_id'),
        'failed',
        ['unknown'],
        {
          terminal: true,
          repair_fence: checkedFence,
          now,
          failure_code: boundedText(
            record.failure_code ?? 'reconciliation_failed',
            'failure_code',
            128
          )
        }
      );
    }
    if (record.outcome !== 'unknown') validation('reconcile.outcome');
    if (record.failure_code !== undefined) validation('reconcile.failure_code');
    const repairDelay = record.repair_after_ms === undefined
      ? DEFAULT_REPAIR_DELAY_MS
      : boundedInteger(
          record.repair_after_ms,
          0,
          MAX_REPAIR_DELAY_MS,
          'repair_after_ms'
        );
    return this.#transition(
      identity,
      identifier(record.receipt_id, 'receipt_id'),
      'unknown',
      ['unknown'],
      {
        repair_fence: checkedFence,
        now,
        repair_delay_ms: repairDelay
      }
    );
  }

  async claimRepairBatch(input: EffectRepairClaim): Promise<EffectRepairBatch> {
    const startedAt = this.#monotonicNowMs();
    const checked = validateEffectRepairClaim(input);
    try {
      const storeBatch = await this.#store.claimUnknownForRepair(checked);
      const batch = snapshotExactRecord(
        storeBatch,
        ['effects', 'exhausted_count'],
        'repair_batch'
      );
      const effects = snapshotClosedArray(
        batch.effects,
        checked.limit,
        () => validationError('repair_batch.effects')
      );
      if (!Number.isSafeInteger(batch.exhausted_count) ||
          (batch.exhausted_count as number) < 0 ||
          (batch.exhausted_count as number) > checked.limit ||
          effects.length + (batch.exhausted_count as number) > checked.limit) {
        storeUnavailable('repair_store_exceeded_requested_limit');
      }
      const result: RepairMetricResult = effects.length
        ? 'claimed'
        : batch.exhausted_count as number
          ? 'exhausted'
          : 'empty';
      this.#metrics.observeRepair(
        result,
        1,
        effects.length + (batch.exhausted_count as number)
      );
      this.#metrics.observeOperation(
        'repair',
        result === 'empty' ? 'empty' : 'succeeded',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      const cloned: ProtocolEffectRecord[] = [];
      for (let index = 0; index < effects.length; index += 1) {
        cloned.push(cloneProtocolEffect(effects[index] as ProtocolEffectRecord));
      }
      return {
        effects: cloned,
        exhausted_count: batch.exhausted_count as number
      };
    } catch (error) {
      this.#metrics.observeRepair('failed', 1, 0);
      this.#metrics.observeOperation(
        'repair',
        'failed',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      throw error;
    }
  }

  async releaseRepairClaim(input: {
    identity: ProtocolEffectIdentity;
    fence: EffectRepairFence;
    next_repair_at: Date;
  }): Promise<void> {
    const record = snapshotExactRecord(
      input,
      ['identity', 'fence', 'next_repair_at'],
      'repair_release'
    );
    const now = validDate(this.#now(), 'now');
    const request = validateEffectRepairReleaseRequest({
      identity: record.identity as ProtocolEffectIdentity,
      fence: record.fence as EffectRepairFence,
      released_at: now,
      next_repair_at: record.next_repair_at as Date
    });
    await this.#store.releaseRepairClaim(request);
    this.#metrics.observeRepair('released', 1, 1);
  }

  async compactExhaustedRepairs(
    input: EffectRepairCompactRequest
  ): Promise<number> {
    const checked = validateEffectRepairCompactRequest(input);
    const count = await this.#store.compactExhaustedRepairs(checked);
    if (!Number.isSafeInteger(count) || count < 0 || count > checked.limit) {
      storeUnavailable('repair_compaction_exceeded_requested_limit');
    }
    return count;
  }

  async pruneTerminalPayloads(input: EffectRetentionRequest): Promise<number> {
    const startedAt = this.#monotonicNowMs();
    const checked = validateEffectRetentionRequest(input);
    try {
      const count = await this.#store.pruneTerminalPayloads(checked);
      if (!Number.isSafeInteger(count) || count < 0 || count > checked.limit) {
        storeUnavailable('retention_store_exceeded_requested_limit');
      }
      this.#metrics.observeOperation(
        'retention',
        count ? 'succeeded' : 'empty',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      return count;
    } catch (error) {
      this.#metrics.observeOperation(
        'retention',
        'failed',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      throw error;
    }
  }

  async #required(identity: ProtocolEffectIdentity): Promise<ProtocolEffectRecord> {
    const checked = validateProtocolEffectIdentity(identity);
    const effect = await this.#store.query(checked);
    if (!effect) {
      throw new SipEffectError({ code: 'sip_effect_not_found', status: 404 });
    }
    return cloneProtocolEffect(effect);
  }

  async #transition(
    identity: ProtocolEffectIdentity,
    receiptId: string,
    level: ProtocolEffectReceiptLevel,
    allowedFrom: readonly ProtocolEffectState[],
    options: {
      terminal?: boolean;
      failure_code?: string;
      now?: Date;
      repair_delay_ms?: number;
      repair_fence?: EffectRepairFence;
    } = {}
  ): Promise<ProtocolEffectRecord> {
    const startedAt = this.#monotonicNowMs();
    try {
      const checked = validateProtocolEffectIdentity(identity);
      const observedAt = validDate(options.now ?? this.#now(), 'now').toISOString();
      const checkedReceiptId = identifier(receiptId, 'receipt_id');
      const failureCode = options.failure_code ?? '';
      const repairDelayMs = options.repair_delay_ms ?? null;
      const repairFence = options.repair_fence
        ? validateEffectRepairFence(options.repair_fence)
        : null;
      const receiptHash = canonicalSipEffectHash({
        identity: checked,
        receipt_id: checkedReceiptId,
        level,
        failure_code: failureCode,
        repair_delay_ms: repairDelayMs
      });
      const result = await this.#store.transition({
        identity: checked,
        receipt_id: checkedReceiptId,
        receipt_hash: receiptHash,
        level,
        allowed_from: allowedFrom,
        observed_at: observedAt,
        failure_code: failureCode,
        repair_delay_ms: repairDelayMs,
        terminal: options.terminal ?? false,
        repair_fence: repairFence
      });
      if (level === 'unknown') this.#metrics.incrementUnknown();
      this.#metrics.observeOperation(
        'transition',
        level === 'unknown' ? 'unknown' : 'succeeded',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      return cloneProtocolEffect(result);
    } catch (error) {
      this.#metrics.observeOperation(
        'transition',
        error instanceof SipEffectError &&
          (error.code === 'sip_effect_transition_conflict' ||
           error.code === 'sip_effect_terminal' ||
           error.code === 'sip_effect_identity_conflict' ||
           error.code === 'sip_effect_receipt_conflict' ||
           error.code === 'sip_effect_fence_lost')
          ? 'conflict'
          : 'failed',
        elapsed(startedAt, this.#monotonicNowMs())
      );
      throw error;
    }
  }
}

export function createStoreFailureSip503(input: {
  failure_code: StoreFailureCode;
  pool_wait_ms: number;
  queue_depth: number;
  retry_attempt: number;
}): {
  failure_code: StoreFailureCode;
  sip_status: 503;
  retry_after_seconds: number;
} {
  const record = snapshotExactRecord(
    input,
    ['failure_code', 'pool_wait_ms', 'queue_depth', 'retry_attempt'],
    'store_failure'
  );
  if (!STORE_FAILURE_CODES.has(record.failure_code as StoreFailureCode)) {
    invalidRetryAfter();
  }
  const poolWaitMs = checkedRetryInteger(
    record.pool_wait_ms,
    STORE_POOL_WAIT_CEILING_MS
  );
  const queueDepth = checkedRetryInteger(
    record.queue_depth,
    EFFECT_QUEUE_DEPTH_CEILING
  );
  const retryAttempt = checkedRetryInteger(
    record.retry_attempt,
    STORE_RETRY_ATTEMPT_CEILING
  );
  return {
    failure_code: record.failure_code as StoreFailureCode,
    sip_status: 503,
    retry_after_seconds: Math.min(
      30,
      Math.max(
        1,
        1 + ceilDiv(poolWaitMs, 1_000) +
          ceilDiv(queueDepth, 256) + retryAttempt
      )
    )
  };
}

export function canonicalSipEffectHash(value: unknown): string {
  try {
    return canonicalVoicePayloadHash(cloneJson(value as JsonValue));
  } catch (cause) {
    throw new SipEffectError({
      code: 'sip_effect_validation_failed',
      status: 422,
      details: { field: 'canonical_json' },
      cause
    });
  }
}

export function validateProtocolEffectIdentity(
  input: ProtocolEffectIdentity
): ProtocolEffectIdentity {
  const record = snapshotExactRecord(input, IDENTITY_KEYS, 'identity');
  return {
    tenant_id: identifier(record.tenant_id, 'tenant_id'),
    protocol_effect_id: identifier(
      record.protocol_effect_id,
      'protocol_effect_id'
    ),
    protocol_session_id: identifier(
      record.protocol_session_id,
      'protocol_session_id'
    ),
    protocol_session_generation: identifier(
      record.protocol_session_generation,
      'protocol_session_generation'
    ),
    decision_id: identifier(record.decision_id, 'decision_id'),
    idempotency_key: identifier(record.idempotency_key, 'idempotency_key'),
    request_hash: hash(record.request_hash, 'request_hash'),
    command_id: identifier(record.command_id, 'command_id'),
    adapter_identity_hash: hash(
      record.adapter_identity_hash,
      'adapter_identity_hash'
    ),
    wire_bytes_hash: hash(record.wire_bytes_hash, 'wire_bytes_hash'),
    wire_length_bytes: boundedInteger(
      record.wire_length_bytes,
      1,
      MAX_WIRE_BYTES,
      'wire_length_bytes'
    ),
    route_binding_hash: hash(
      record.route_binding_hash,
      'route_binding_hash'
    ),
    wire_attempt_facts_hash: hash(
      record.wire_attempt_facts_hash,
      'wire_attempt_facts_hash'
    ),
    wire_freeze_sha256: hash(
      record.wire_freeze_sha256,
      'wire_freeze_sha256'
    ),
    owner_epoch: uint64Decimal(record.owner_epoch, 'owner_epoch', true),
    command_sequence: uint64Decimal(
      record.command_sequence,
      'command_sequence',
      true
    )
  };
}

export function protocolEffectIdentityHash(
  input: ProtocolEffectIdentity | ProtocolEffectRecord
): string {
  return canonicalSipEffectHash(validatedIdentityProjection(input));
}

export function validateEffectRepairClaim(
  input: EffectRepairClaim
): EffectRepairClaim {
  const record = snapshotExactRecord(
    input,
    [
      'tenant_id',
      'repair_owner_id',
      'repair_owner_epoch',
      'claim_token_prefix',
      'claimed_at',
      'lease_until',
      'limit'
    ],
    'repair_claim'
  );
  const claimedAt = validDate(record.claimed_at, 'claimed_at');
  const leaseUntil = validDate(record.lease_until, 'lease_until');
  const leaseDurationMs = leaseUntil.getTime() - claimedAt.getTime();
  if (leaseDurationMs < 1 || leaseDurationMs > MAX_REPAIR_LEASE_MS) {
    validation('lease_until');
  }
  return {
    tenant_id: identifier(record.tenant_id, 'tenant_id'),
    repair_owner_id: identifier(record.repair_owner_id, 'repair_owner_id'),
    repair_owner_epoch: uint64Decimal(
      record.repair_owner_epoch,
      'repair_owner_epoch',
      true
    ),
    claim_token_prefix: boundedAsciiToken(
      record.claim_token_prefix,
      'claim_token_prefix',
      128
    ),
    claimed_at: claimedAt,
    lease_until: leaseUntil,
    limit: checkedBatchLimit(
      record.limit as number,
      'sip_effect_repair_limit_invalid'
    )
  };
}

export function validateEffectRepairFence(
  input: EffectRepairFence
): EffectRepairFence {
  const record = snapshotExactRecord(
    input,
    [
      'repair_owner_id',
      'repair_owner_epoch',
      'repair_claim_token',
      'repair_claim_revision'
    ],
    'repair_fence'
  );
  return {
    repair_owner_id: identifier(record.repair_owner_id, 'repair_owner_id'),
    repair_owner_epoch: uint64Decimal(
      record.repair_owner_epoch,
      'repair_owner_epoch',
      true
    ),
    repair_claim_token: boundedAsciiToken(
      record.repair_claim_token,
      'repair_claim_token',
      512
    ),
    repair_claim_revision: uint64Decimal(
      record.repair_claim_revision,
      'repair_claim_revision',
      true
    )
  };
}

export function validateEffectRepairReleaseRequest(
  input: EffectRepairReleaseRequest
): EffectRepairReleaseRequest {
  const record = snapshotExactRecord(
    input,
    ['identity', 'fence', 'released_at', 'next_repair_at'],
    'repair_release'
  );
  const releasedAt = validDate(record.released_at, 'released_at');
  const nextRepairAt = validDate(record.next_repair_at, 'next_repair_at');
  const repairDelayMs = nextRepairAt.getTime() - releasedAt.getTime();
  if (repairDelayMs < 0 || repairDelayMs > MAX_REPAIR_DELAY_MS) {
    validation('next_repair_at');
  }
  return {
    identity: validateProtocolEffectIdentity(
      record.identity as ProtocolEffectIdentity
    ),
    fence: validateEffectRepairFence(record.fence as EffectRepairFence),
    released_at: releasedAt,
    next_repair_at: nextRepairAt
  };
}

export function validateEffectRepairCompactRequest(
  input: EffectRepairCompactRequest
): EffectRepairCompactRequest {
  const record = snapshotExactRecord(
    input,
    ['tenant_id', 'cutoff', 'limit'],
    'repair_compact'
  );
  return {
    tenant_id: identifier(record.tenant_id, 'tenant_id'),
    cutoff: validDate(record.cutoff, 'cutoff'),
    limit: checkedBatchLimit(
      record.limit as number,
      'sip_effect_retention_limit_invalid'
    )
  };
}

export function validateEffectRetentionRequest(
  input: EffectRetentionRequest
): EffectRetentionRequest {
  const record = snapshotExactRecord(
    input,
    ['tenant_id', 'cutoff', 'limit'],
    'retention'
  );
  return {
    tenant_id: identifier(record.tenant_id, 'tenant_id'),
    cutoff: validDate(record.cutoff, 'cutoff'),
    limit: checkedBatchLimit(
      record.limit as number,
      'sip_effect_retention_limit_invalid'
    )
  };
}

export function validateAtomicBoundaryMetadata(
  input: AtomicBoundaryMetadata
): AtomicBoundaryMetadata {
  const record = snapshotExactRecord(
    input,
    [
      'tenant_id',
      'boundary_id',
      'boundary_kind',
      'decision_id',
      'idempotency_key',
      'request_hash',
      'owner_epoch',
      'command_sequence',
      'committed_at'
    ],
    'boundary_metadata'
  );
  if (!BOUNDARY_FACTS[record.boundary_kind as DurableBoundaryKind]) {
    boundaryFactsInvalid();
  }
  return {
    tenant_id: identifier(record.tenant_id, 'tenant_id'),
    boundary_id: identifier(record.boundary_id, 'boundary_id'),
    boundary_kind: record.boundary_kind as DurableBoundaryKind,
    decision_id: identifier(record.decision_id, 'decision_id'),
    idempotency_key: identifier(record.idempotency_key, 'idempotency_key'),
    request_hash: hash(record.request_hash, 'request_hash'),
    owner_epoch: uint64Decimal(record.owner_epoch, 'owner_epoch', true),
    command_sequence: uint64Decimal(
      record.command_sequence,
      'command_sequence',
      true
    ),
    committed_at: validDate(record.committed_at, 'committed_at')
  };
}

export function createAtomicBoundaryCommit(
  metadataInput: AtomicBoundaryMetadata,
  resultInput: AtomicBoundaryResult
): AtomicBoundaryCommit {
  const metadata = validateAtomicBoundaryMetadata(metadataInput);
  const result = validateAtomicBoundaryResult(metadata.boundary_kind, resultInput);
  const facts = result.writes.map((write): AtomicBoundaryFactRecord => ({
    fact_type: write.fact_type,
    receipt_id: write.receipt_id,
    aggregate_id: write.aggregate_id,
    aggregate_revision: write.aggregate_revision,
    fact_hash: canonicalSipEffectHash(write),
    payload: atomicWriteReceiptJson(write)
  }));
  const factsHash = canonicalSipEffectHash(facts);
  const stableMetadata = {
    tenant_id: metadata.tenant_id,
    boundary_id: metadata.boundary_id,
    boundary_kind: metadata.boundary_kind,
    decision_id: metadata.decision_id,
    idempotency_key: metadata.idempotency_key,
    request_hash: metadata.request_hash,
    owner_epoch: metadata.owner_epoch,
    command_sequence: metadata.command_sequence
  };
  return {
    metadata: {
      ...stableMetadata,
      committed_at: metadata.committed_at.toISOString()
    },
    result,
    facts,
    facts_hash: factsHash,
    boundary_hash: canonicalSipEffectHash({
      ...stableMetadata,
      facts_hash: factsHash
    })
  };
}

export function cloneProtocolEffect(
  effect: ProtocolEffectRecord
): ProtocolEffectRecord {
  const record = snapshotExactRecord(
    effect,
    PROTOCOL_EFFECT_RECORD_KEYS,
    'protocol_effect'
  );
  const identity = validateProtocolEffectIdentity(pickIdentity(record));
  if (record.schema_id !== SIP_EFFECT_SCHEMA_ID ||
      record.schema_version !== SIP_EFFECT_SCHEMA_VERSION ||
      record.schema_hash !== SIP_EFFECT_SCHEMA_HASH ||
      !EFFECT_STATES.has(record.state as ProtocolEffectState) ||
      typeof record.payload_retained !== 'boolean') {
    validation('protocol_effect');
  }
  const wireBytes = snapshotClosedBytes(
    record.canonical_wire_bytes,
    record.payload_retained ? 1 : 0,
    MAX_WIRE_BYTES,
    () => validationError('canonical_wire_bytes')
  );
  const adapterIdentity = validateBackendRuntimeIdentity(
    record.adapter_identity
  );
  const routeBinding = bindSipRoute(
    record.route_binding as BoundSipRouteBinding
  );
  const wireAttemptFacts = validateBoundSipWireAttemptFacts(
    record.wire_attempt_facts as BoundSipWireAttemptFacts,
    identity.protocol_effect_id
  );
  if (canonicalSipEffectHash(adapterIdentity) !==
        identity.adapter_identity_hash ||
      sipRouteBindingSha256(routeBinding) !== identity.route_binding_hash ||
      sipWireAttemptFactsSha256(wireAttemptFacts) !==
        identity.wire_attempt_facts_hash ||
      sipWireFreezeSha256({
        route_binding_sha256: identity.route_binding_hash,
        wire_attempt_facts_sha256: identity.wire_attempt_facts_hash,
        wire_sha256: identity.wire_bytes_hash,
        wire_length_bytes: identity.wire_length_bytes
      }) !== identity.wire_freeze_sha256 ||
      wireAttemptFacts.semantic_intent_sha256 !== identity.request_hash ||
      (record.payload_retained &&
       (sha256(wireBytes) !== identity.wire_bytes_hash ||
        wireBytes.byteLength !== identity.wire_length_bytes))) {
    validation('protocol_effect');
  }
  const revision = uint64Decimal(record.revision, 'revision', true);
  const unknownCount = nonNegativeInteger(record.unknown_count, 'unknown_count');
  const lastReceiptId = nullableIdentifier(
    record.last_receipt_id,
    'last_receipt_id'
  );
  const lastReceiptHash = nullableHash(
    record.last_receipt_hash,
    'last_receipt_hash'
  );
  const lastReceiptRepairDelayMs =
    record.last_receipt_repair_delay_ms === null
      ? null
      : boundedInteger(
          record.last_receipt_repair_delay_ms,
          0,
          MAX_REPAIR_DELAY_MS,
          'last_receipt_repair_delay_ms'
        );
  const failureCode = optionalBoundedText(
    record.failure_code,
    'failure_code',
    128
  );
  const repairDueAt = nullableValidTimestamp(
    record.repair_due_at,
    'repair_due_at'
  );
  const repairOwnerId = nullableIdentifier(
    record.repair_owner_id,
    'repair_owner_id'
  );
  const repairOwnerEpoch = nullableU64(
    record.repair_owner_epoch,
    'repair_owner_epoch',
    true
  );
  const repairHighWatermark = uint64Decimal(
    record.repair_epoch_high_watermark,
    'repair_epoch_high_watermark',
    false
  );
  const repairClaimToken = nullableAsciiToken(
    record.repair_claim_token,
    'repair_claim_token',
    512
  );
  const repairClaimRevision = nullableU64(
    record.repair_claim_revision,
    'repair_claim_revision',
    true
  );
  const repairLeaseUntil = nullableValidTimestamp(
    record.repair_lease_until,
    'repair_lease_until'
  );
  const repairGroup = [
    repairOwnerId,
    repairOwnerEpoch,
    repairClaimToken,
    repairClaimRevision,
    repairLeaseUntil
  ];
  const repairGroupPresent = repairGroup[0] !== null;
  for (let index = 1; index < repairGroup.length; index += 1) {
    if ((repairGroup[index] !== null) !== repairGroupPresent) {
      validation('repair_claim');
    }
  }
  if (repairOwnerEpoch !== null &&
      repairOwnerEpoch !== repairHighWatermark) {
    validation('repair_owner_epoch');
  }
  if (repairClaimRevision !== null &&
      repairClaimRevision !== revision) {
    validation('repair_claim_revision');
  }
  const repairAttempts = nonNegativeInteger(
    record.repair_attempts,
    'repair_attempts',
    8
  );
  const repairExhaustedAt = nullableValidTimestamp(
    record.repair_exhausted_at,
    'repair_exhausted_at'
  );
  const repairExhaustionHash = nullableHash(
    record.repair_exhaustion_receipt_hash,
    'repair_exhaustion_receipt_hash'
  );
  const operatorAttention = checkedBoolean(
    record.operator_attention_required,
    'operator_attention_required'
  );
  if ((repairExhaustedAt === null) !== (repairExhaustionHash === null) ||
      operatorAttention !== (repairExhaustedAt !== null)) {
    validation('repair_exhaustion');
  }
  if (repairExhaustionHash !== null &&
      repairExhaustionHash !== canonicalSipEffectHash({
        tenant_id: identity.tenant_id,
        protocol_effect_id: identity.protocol_effect_id,
        repair_attempts: repairAttempts,
        repair_epoch_high_watermark: repairHighWatermark
      })) {
    validation('repair_exhaustion_receipt_hash');
  }
  const repairCompactedAt = nullableValidTimestamp(
    record.repair_compacted_at,
    'repair_compacted_at'
  );
  const retentionReferences = nonNegativeInteger(
    record.retention_reference_count,
    'retention_reference_count'
  );
  const rollbackReferences = nonNegativeInteger(
    record.rollback_reference_count,
    'rollback_reference_count'
  );
  const auditUntil = validTimestamp(record.audit_until, 'audit_until');
  const preparedAt = validTimestamp(record.prepared_at, 'prepared_at');
  const updatedAt = validTimestamp(record.updated_at, 'updated_at');
  const state = record.state as ProtocolEffectState;
  const hasReceipt = lastReceiptId !== null && lastReceiptHash !== null;
  if ((lastReceiptId === null) !== (lastReceiptHash === null) ||
      (state === 'prepared') !== !hasReceipt ||
      (state === 'prepared' && revision !== '1') ||
      (state === 'prepared' && unknownCount !== 0) ||
      (state === 'unknown') !== (lastReceiptRepairDelayMs !== null) ||
      (state === 'failed') !== (failureCode.length > 0) ||
      (state === 'unknown' &&
       repairDueAt === null &&
       !operatorAttention) ||
      (repairGroupPresent && state !== 'unknown') ||
      (repairExhaustedAt !== null &&
       (state !== 'unknown' || repairAttempts !== 8)) ||
      (repairCompactedAt !== null && repairExhaustedAt === null) ||
      Date.parse(auditUntil) <= Date.parse(preparedAt) ||
      Date.parse(updatedAt) < Date.parse(preparedAt) ||
      (repairLeaseUntil !== null &&
       Date.parse(repairLeaseUntil) <= Date.parse(updatedAt)) ||
      (repairCompactedAt !== null &&
       repairExhaustedAt !== null &&
       Date.parse(repairCompactedAt) < Date.parse(repairExhaustedAt))) {
    validation('protocol_effect_state');
  }
  if (lastReceiptId !== null &&
      lastReceiptHash !== canonicalSipEffectHash({
        identity,
        receipt_id: lastReceiptId,
        level: state,
        failure_code: failureCode,
        repair_delay_ms: lastReceiptRepairDelayMs
      })) {
    validation('last_receipt_hash');
  }
  let tombstone: ProtocolEffectTombstone | null = null;
  if (record.terminal_tombstone !== null) {
    const terminal = snapshotExactRecord(
      record.terminal_tombstone,
      ['receipt_id', 'receipt_hash', 'state', 'terminal_at'],
      'terminal_tombstone'
    );
    if (terminal.state !== 'protocol_observed' &&
        terminal.state !== 'failed') {
      validation('terminal_tombstone.state');
    }
    tombstone = {
      receipt_id: identifier(terminal.receipt_id, 'receipt_id'),
      receipt_hash: hash(terminal.receipt_hash, 'receipt_hash'),
      state: terminal.state,
      terminal_at: validTimestamp(terminal.terminal_at, 'terminal_at')
    };
  }
  const terminalState =
    state === 'protocol_observed' || state === 'failed';
  if (terminalState !== (tombstone !== null) ||
      (tombstone && tombstone.state !== state) ||
      (tombstone &&
       (tombstone.receipt_id !== lastReceiptId ||
        tombstone.receipt_hash !== lastReceiptHash ||
        Date.parse(tombstone.terminal_at) < Date.parse(preparedAt) ||
        Date.parse(tombstone.terminal_at) > Date.parse(updatedAt))) ||
      (!record.payload_retained && (!terminalState || wireBytes.byteLength))) {
    validation('terminal_tombstone');
  }
  return {
    ...(record as unknown as ProtocolEffectRecord),
    ...identity,
    adapter_identity: adapterIdentity,
    canonical_wire_bytes: wireBytes,
    route_binding: routeBinding,
    wire_attempt_facts: wireAttemptFacts,
    revision,
    unknown_count: unknownCount,
    last_receipt_id: lastReceiptId,
    last_receipt_hash: lastReceiptHash,
    last_receipt_repair_delay_ms: lastReceiptRepairDelayMs,
    failure_code: failureCode,
    repair_due_at: repairDueAt,
    repair_owner_id: repairOwnerId,
    repair_owner_epoch: repairOwnerEpoch,
    repair_epoch_high_watermark: repairHighWatermark,
    repair_claim_token: repairClaimToken,
    repair_claim_revision: repairClaimRevision,
    repair_lease_until: repairLeaseUntil,
    repair_attempts: repairAttempts,
    repair_exhausted_at: repairExhaustedAt,
    repair_exhaustion_receipt_hash: repairExhaustionHash,
    operator_attention_required: operatorAttention,
    repair_compacted_at: repairCompactedAt,
    retention_reference_count: retentionReferences,
    rollback_reference_count: rollbackReferences,
    audit_until: auditUntil,
    payload_retained: record.payload_retained,
    terminal_tombstone: tombstone,
    prepared_at: preparedAt,
    updated_at: updatedAt
  } as ProtocolEffectRecord;
}

export function assertSameProtocolEffectIdentity(
  effect: ProtocolEffectRecord,
  identity: ProtocolEffectIdentity
): void {
  const effectRecord = snapshotExactRecord(
    effect,
    PROTOCOL_EFFECT_RECORD_KEYS,
    'protocol_effect'
  );
  const checked = validatedIdentityProjection(identity);
  for (const field of IDENTITY_KEYS) {
    if (effectRecord[field] !== checked[field]) {
      throw new SipEffectError({
        code: 'sip_effect_identity_conflict',
        status: 409,
        details: { field }
      });
    }
  }
}

export function uint64Decimal(
  value: unknown,
  field: string,
  positive: boolean
): UInt64Decimal {
  if (typeof value !== 'string' || !UINT64_PATTERN.test(value)) {
    validation(field);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    validation(field);
  }
  if (parsed! > MAX_U64 || (positive && parsed! === 0n)) validation(field);
  return value;
}

const IDENTITY_KEYS = [
  'tenant_id',
  'protocol_effect_id',
  'protocol_session_id',
  'protocol_session_generation',
  'decision_id',
  'idempotency_key',
  'request_hash',
  'command_id',
  'adapter_identity_hash',
  'wire_bytes_hash',
  'wire_length_bytes',
  'route_binding_hash',
  'wire_attempt_facts_hash',
  'wire_freeze_sha256',
  'owner_epoch',
  'command_sequence'
] as const;
const PROTOCOL_EFFECT_RECORD_KEYS = [
  ...IDENTITY_KEYS,
  'schema_id',
  'schema_version',
  'schema_hash',
  'adapter_identity',
  'canonical_wire_bytes',
  'route_binding',
  'wire_attempt_facts',
  'state',
  'revision',
  'unknown_count',
  'last_receipt_id',
  'last_receipt_hash',
  'last_receipt_repair_delay_ms',
  'failure_code',
  'repair_due_at',
  'repair_owner_id',
  'repair_owner_epoch',
  'repair_epoch_high_watermark',
  'repair_claim_token',
  'repair_claim_revision',
  'repair_lease_until',
  'repair_attempts',
  'repair_exhausted_at',
  'repair_exhaustion_receipt_hash',
  'operator_attention_required',
  'repair_compacted_at',
  'retention_reference_count',
  'rollback_reference_count',
  'audit_until',
  'payload_retained',
  'terminal_tombstone',
  'prepared_at',
  'updated_at'
] as const;
const STORE_FAILURE_CODES = new Set<StoreFailureCode>([
  'store_timeout',
  'store_pool_exhausted',
  'store_unavailable',
  'store_schema_incompatible'
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UINT64_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const IDENTIFIER_PATTERN = /^[\x21-\x7e]{1,200}$/;
const EFFECT_STATES = new Set<ProtocolEffectState>([
  'prepared',
  'durable_decision',
  'send_attempted',
  'transport_accepted',
  'protocol_observed',
  'failed',
  'unknown'
]);
const EFFECT_QUEUE_DEPTH_CEILING = 1_024;
const EFFECT_REPAIR_BATCH_CEILING = 100;
const STORE_POOL_WAIT_CEILING_MS = 250;
const STORE_RETRY_ATTEMPT_CEILING = 3;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_REPAIR_DELAY_MS = 86_400_000;
const MAX_REPAIR_LEASE_MS = 30_000;
const DEFAULT_REPAIR_DELAY_MS = 1_000;
const TRANSACTION_EFFECT_RETENTION_MS = 604_800_000;
const MAX_WIRE_BYTES = 65_535;

const BOUNDARY_FACTS: Record<DurableBoundaryKind, readonly AtomicBoundaryFactType[]> = {
  call_admission: [
    'call_session',
    'protocol_effect',
    'effect_wal',
    'capacity_reservation_receipt',
    'idempotency_record'
  ],
  media_generation: [
    'media_plan',
    'directed_media_edges',
    'backend_binding_groups',
    'capacity_reservation_receipt'
  ],
  bridge_head: [
    'bridge_command',
    'bridge_decision',
    'bridge_receipt',
    'head_compare_and_swap'
  ],
  recording: [
    'recording_intent',
    'root_recording_manifest',
    'source_chain',
    'segment_reference'
  ]
};

const FOUNDATION_PREPARED_EFFECT_KEYS = [
  'adapter_identity',
  'wire_identity',
  'route_binding',
  'wire_attempt_facts',
  'wire_bytes_base64'
] as const;
const FOUNDATION_WIRE_IDENTITY_KEYS = [
  'protocol_session_id',
  'protocol_session_generation',
  'effect_id',
  'command_id',
  'owner_epoch',
  'command_sequence',
  'wire_sha256',
  'route_binding_sha256',
  'wire_attempt_facts_sha256',
  'wire_freeze_sha256',
  'wire_length_bytes'
] as const;

function checkedPreparedEffectAuthority(
  value: unknown
): PreparedProtocolEffectAuthority {
  if ((typeof value !== 'object' && typeof value !== 'function') ||
      value === null ||
      !Object.isFrozen(value)) {
    validation('prepared_effect_authority');
  }
  const authority = value as PreparedProtocolEffectAuthority;
  const own = Object.getOwnPropertyDescriptor(
    authority,
    'verifyPreparedEffect'
  );
  let verifier: PreparedProtocolEffectAuthority['verifyPreparedEffect'];
  if (own) {
    if (!('value' in own) ||
        typeof own.value !== 'function' ||
        own.writable !== false ||
        own.configurable !== false) {
      validation('prepared_effect_authority');
    }
    verifier = own.value as PreparedProtocolEffectAuthority['verifyPreparedEffect'];
  } else {
    const prototype = Object.getPrototypeOf(authority);
    const inherited = prototype && Object.isFrozen(prototype)
      ? Object.getOwnPropertyDescriptor(prototype, 'verifyPreparedEffect')
      : undefined;
    if (!inherited ||
        !('value' in inherited) ||
        typeof inherited.value !== 'function' ||
        inherited.writable !== false ||
        inherited.configurable !== false) {
      validation('prepared_effect_authority');
    }
    verifier =
      inherited.value as PreparedProtocolEffectAuthority['verifyPreparedEffect'];
  }
  return Object.freeze({
    verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array {
      return Reflect.apply(verifier, authority, [prepared]);
    }
  });
}

function preparedAuthorityRejected(): SipEffectError {
  return new SipEffectError({
    code: 'sip_effect_prepared_authority_rejected',
    status: 422
  });
}

function preparedEffect(
  input: DurableProtocolEffectPrepareInput,
  authority: PreparedProtocolEffectAuthority,
  now: Date
): ProtocolEffectRecord {
  const record = snapshotOptionalRecord(
    input,
    [
      'tenant_id',
      'decision_id',
      'idempotency_key',
      'request_hash',
      'prepared_effect'
    ],
    ['audit_until'],
    'prepared_effect'
  );
  const prepared = record.prepared_effect as PreparedProtocolEffect;
  let authoritativeWire: Uint8Array;
  try {
    authoritativeWire = snapshotClosedBytes(
      authority.verifyPreparedEffect(prepared),
      1,
      MAX_WIRE_BYTES,
      preparedAuthorityRejected
    );
  } catch (cause) {
    if (cause instanceof SipEffectError &&
        cause.code === 'sip_effect_prepared_authority_rejected') {
      throw cause;
    }
    throw new SipEffectError({
      code: 'sip_effect_prepared_authority_rejected',
      status: 422,
      cause
    });
  }
  const preparedRecord = snapshotExactRecord(
    prepared,
    FOUNDATION_PREPARED_EFFECT_KEYS,
    'prepared_effect.prepared_effect'
  );
  const adapterIdentity = validateBackendRuntimeIdentity(
    preparedRecord.adapter_identity
  );
  const wireIdentity = snapshotExactRecord(
    preparedRecord.wire_identity,
    FOUNDATION_WIRE_IDENTITY_KEYS,
    'prepared_effect.wire_identity'
  );
  const effectId = identifier(wireIdentity.effect_id, 'protocol_effect_id');
  const routeBinding = bindSipRoute(
    preparedRecord.route_binding as BoundSipRouteBinding
  );
  const wireAttemptFacts = validateBoundSipWireAttemptFacts(
    preparedRecord.wire_attempt_facts as BoundSipWireAttemptFacts,
    effectId
  );
  const wireBytes = snapshotClosedBytes(
    authoritativeWire,
    1,
    MAX_WIRE_BYTES,
    () => validationError('canonical_wire_bytes')
  );
  const wireBytesHash = hash(wireIdentity.wire_sha256, 'wire_bytes_hash');
  const wireLength = boundedInteger(
    wireIdentity.wire_length_bytes,
    1,
    MAX_WIRE_BYTES,
    'wire_length_bytes'
  );
  const routeBindingHash = hash(
    wireIdentity.route_binding_sha256,
    'route_binding_hash'
  );
  const wireAttemptFactsHash = hash(
    wireIdentity.wire_attempt_facts_sha256,
    'wire_attempt_facts_hash'
  );
  const wireFreezeSha256 = hash(
    wireIdentity.wire_freeze_sha256,
    'wire_freeze_sha256'
  );
  if (sha256(wireBytes) !== wireBytesHash ||
      wireBytes.byteLength !== wireLength ||
      sipRouteBindingSha256(routeBinding) !== routeBindingHash ||
      sipWireAttemptFactsSha256(wireAttemptFacts) !== wireAttemptFactsHash ||
      sipWireFreezeSha256({
        route_binding_sha256: routeBindingHash,
        wire_attempt_facts_sha256: wireAttemptFactsHash,
        wire_sha256: wireBytesHash,
        wire_length_bytes: wireLength
      }) !== wireFreezeSha256) {
    throw new SipEffectError({
      code: 'sip_effect_wire_hash_mismatch',
      status: 422
    });
  }
  const requestHash = hash(record.request_hash, 'request_hash');
  if (requestHash !== wireAttemptFacts.semantic_intent_sha256) {
    validation('request_hash');
  }
  const checkedIdentity = validateProtocolEffectIdentity({
    tenant_id: identifier(record.tenant_id, 'tenant_id'),
    protocol_effect_id: effectId,
    protocol_session_id: identifier(
      wireIdentity.protocol_session_id,
      'protocol_session_id'
    ),
    protocol_session_generation: identifier(
      wireIdentity.protocol_session_generation,
      'protocol_session_generation'
    ),
    decision_id: identifier(record.decision_id, 'decision_id'),
    idempotency_key: identifier(record.idempotency_key, 'idempotency_key'),
    request_hash: requestHash,
    command_id: identifier(wireIdentity.command_id, 'command_id'),
    adapter_identity_hash: canonicalSipEffectHash(adapterIdentity),
    wire_bytes_hash: wireBytesHash,
    wire_length_bytes: wireLength,
    route_binding_hash: routeBindingHash,
    wire_attempt_facts_hash: wireAttemptFactsHash,
    wire_freeze_sha256: wireFreezeSha256,
    owner_epoch: uint64Decimal(
      wireIdentity.owner_epoch,
      'owner_epoch',
      true
    ),
    command_sequence: uint64Decimal(
      wireIdentity.command_sequence,
      'command_sequence',
      true
    )
  });
  const auditUntil = record.audit_until === undefined
    ? new Date(now.getTime() + TRANSACTION_EFFECT_RETENTION_MS)
    : validDate(record.audit_until, 'audit_until');
  if (auditUntil.getTime() <= now.getTime()) validation('audit_until');
  const timestamp = now.toISOString();
  return {
    ...checkedIdentity,
    schema_id: SIP_EFFECT_SCHEMA_ID,
    schema_version: SIP_EFFECT_SCHEMA_VERSION,
    schema_hash: SIP_EFFECT_SCHEMA_HASH,
    adapter_identity: adapterIdentity,
    canonical_wire_bytes: wireBytes,
    route_binding: routeBinding,
    wire_attempt_facts: wireAttemptFacts,
    state: 'prepared',
    revision: '1',
    unknown_count: 0,
    last_receipt_id: null,
    last_receipt_hash: null,
    last_receipt_repair_delay_ms: null,
    failure_code: '',
    repair_due_at: null,
    repair_owner_id: null,
    repair_owner_epoch: null,
    repair_epoch_high_watermark: '0',
    repair_claim_token: null,
    repair_claim_revision: null,
    repair_lease_until: null,
    repair_attempts: 0,
    repair_exhausted_at: null,
    repair_exhaustion_receipt_hash: null,
    operator_attention_required: false,
    repair_compacted_at: null,
    retention_reference_count: 0,
    rollback_reference_count: 0,
    audit_until: auditUntil.toISOString(),
    payload_retained: true,
    terminal_tombstone: null,
    prepared_at: timestamp,
    updated_at: timestamp
  };
}

function pickIdentity(
  input: Readonly<Record<string, unknown>>
): ProtocolEffectIdentity {
  return {
    tenant_id: input.tenant_id as string,
    protocol_effect_id: input.protocol_effect_id as string,
    protocol_session_id: input.protocol_session_id as string,
    protocol_session_generation:
      input.protocol_session_generation as string,
    decision_id: input.decision_id as string,
    idempotency_key: input.idempotency_key as string,
    request_hash: input.request_hash as string,
    command_id: input.command_id as string,
    adapter_identity_hash: input.adapter_identity_hash as string,
    wire_bytes_hash: input.wire_bytes_hash as string,
    wire_length_bytes: input.wire_length_bytes as number,
    route_binding_hash: input.route_binding_hash as string,
    wire_attempt_facts_hash: input.wire_attempt_facts_hash as string,
    wire_freeze_sha256: input.wire_freeze_sha256 as string,
    owner_epoch: input.owner_epoch as string,
    command_sequence: input.command_sequence as string
  };
}

function validatedIdentityProjection(value: unknown): ProtocolEffectIdentity {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = snapshotExactRecord(value, IDENTITY_KEYS, 'identity');
  } catch (error) {
    if (!(error instanceof SipEffectError) ||
        error.code !== 'sip_effect_validation_failed') {
      throw error;
    }
    record = snapshotExactRecord(
      value,
      PROTOCOL_EFFECT_RECORD_KEYS,
      'identity'
    );
  }
  return validateProtocolEffectIdentity(pickIdentity(record));
}

function validateAtomicBoundaryResult(
  expectedKind: DurableBoundaryKind,
  input: AtomicBoundaryResult
): AtomicBoundaryResult {
  const record = snapshotExactRecord(
    input,
    ['boundary_kind', 'writes'],
    'boundary_result'
  );
  if (record.boundary_kind !== expectedKind) {
    boundaryFactsInvalid();
  }
  const required = BOUNDARY_FACTS[expectedKind];
  const rawWrites = snapshotClosedArray(
    record.writes,
    required.length,
    () => validationError('boundary_result.writes')
  );
  if (rawWrites.length !== required.length) boundaryFactsInvalid();
  const byType = new Map<AtomicBoundaryFactType, AtomicBoundaryWriteReceipt>();
  for (let index = 0; index < rawWrites.length; index += 1) {
    const write = validateAtomicWriteReceipt(
      rawWrites[index] as AtomicBoundaryWriteReceipt
    );
    if (byType.has(write.fact_type)) boundaryFactsInvalid();
    byType.set(write.fact_type, write);
  }
  if (required.some((factType) => !byType.has(factType))) {
    boundaryFactsInvalid();
  }
  return {
    boundary_kind: expectedKind,
    writes: required.map((factType) => byType.get(factType)!)
  };
}

function validateAtomicWriteReceipt(
  input: AtomicBoundaryWriteReceipt
): AtomicBoundaryWriteReceipt {
  const baseKeys = [
    'fact_type',
    'receipt_id',
    'aggregate_id',
    'aggregate_revision',
    'applied',
    'payload'
  ];
  const casKeys = [
    'expected_revision',
    'committed_revision',
    'expected_owner_epoch',
    'committed_owner_epoch',
    'expected_state',
    'committed_state',
    'cas_applied'
  ];
  const record = snapshotOptionalRecord(
    input,
    baseKeys,
    casKeys,
    'boundary_write'
  );
  const isCas = record.fact_type === 'head_compare_and_swap';
  for (let index = 0; index < casKeys.length; index += 1) {
    const present = Object.hasOwn(record, casKeys[index]!);
    if (present !== isCas) boundaryFactsInvalid();
  }
  if (!ALL_FACT_TYPES.has(record.fact_type as AtomicBoundaryFactType) ||
      record.applied !== true) {
    boundaryFactsInvalid();
  }
  const payload = cloneJson(record.payload as JsonValue);
  if (payload === null || Array.isArray(payload) ||
      typeof payload !== 'object') {
    boundaryFactsInvalid();
  }
  const checkedBase: AtomicBoundaryWriteReceipt = {
    fact_type: record.fact_type as AtomicBoundaryFactType,
    receipt_id: identifier(record.receipt_id, 'receipt_id'),
    aggregate_id: identifier(record.aggregate_id, 'aggregate_id'),
    aggregate_revision: uint64Decimal(
      record.aggregate_revision,
      'aggregate_revision',
      true
    ),
    applied: true,
    payload: payload as JsonObject
  };
  if (!isCas) return checkedBase;
  if (record.cas_applied !== true) boundaryFactsInvalid();
  const expectedRevision = uint64Decimal(
    record.expected_revision,
    'expected_revision',
    true
  );
  const committedRevision = uint64Decimal(
    record.committed_revision,
    'committed_revision',
    true
  );
  if (BigInt(expectedRevision) === MAX_U64 ||
      BigInt(committedRevision) !== BigInt(expectedRevision) + 1n) {
    boundaryFactsInvalid();
  }
  const expectedEpoch = uint64Decimal(
    record.expected_owner_epoch,
    'expected_owner_epoch',
    true
  );
  const committedEpoch = uint64Decimal(
    record.committed_owner_epoch,
    'committed_owner_epoch',
    true
  );
  if (BigInt(committedEpoch) < BigInt(expectedEpoch)) boundaryFactsInvalid();
  const expectedState = identifier(record.expected_state, 'expected_state');
  const committedState = identifier(record.committed_state, 'committed_state');
  if (expectedState === committedState) boundaryFactsInvalid();
  return {
    ...checkedBase,
    expected_revision: expectedRevision,
    committed_revision: committedRevision,
    expected_owner_epoch: expectedEpoch,
    committed_owner_epoch: committedEpoch,
    expected_state: expectedState,
    committed_state: committedState,
    cas_applied: true
  };
}

const ALL_FACT_TYPES = new Set<AtomicBoundaryFactType>(
  Object.values(BOUNDARY_FACTS).flat()
);

function checkedBatchLimit(
  limit: number,
  code: 'sip_effect_repair_limit_invalid' | 'sip_effect_retention_limit_invalid'
): number {
  if (!Number.isSafeInteger(limit) || limit < 1 ||
      limit > EFFECT_REPAIR_BATCH_CEILING) {
    throw new SipEffectError({ code, status: 422 });
  }
  return limit;
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  return snapshotClosedRecord(
    value,
    keys,
    () => validationError(field)
  );
}

function snapshotOptionalRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  return snapshotClosedShape(
    value,
    required,
    optional,
    () => validationError(field)
  );
}

function validationError(field: string): SipEffectError {
  return new SipEffectError({
    code: 'sip_effect_validation_failed',
    status: 422,
    details: { field }
  });
}

function boundaryFactsError(): SipEffectError {
  return new SipEffectError({
    code: 'sip_effect_boundary_facts_invalid',
    status: 422
  });
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    validation(field);
  }
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) validation(field);
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum ||
      /[\u0000\r\n]/.test(value)) {
    validation(field);
  }
  return value;
}

function optionalBoundedText(
  value: unknown,
  field: string,
  maximum: number
): string {
  if (typeof value !== 'string' || value.length > maximum ||
      /[\u0000\r\n]/.test(value)) {
    validation(field);
  }
  return value;
}

function boundedAsciiToken(
  value: unknown,
  field: string,
  maximum: number
): string {
  if (typeof value !== 'string' ||
      value.length < 1 ||
      value.length > maximum ||
      !/^[\x21-\x7e]+$/.test(value)) {
    validation(field);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < minimum ||
      (value as number) > maximum) {
    validation(field);
  }
  return value as number;
}

function nonNegativeInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < 0 ||
      (value as number) > maximum) {
    validation(field);
  }
  return value as number;
}

function checkedBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') validation(field);
  return value;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : identifier(value, field);
}

function nullableHash(value: unknown, field: string): string | null {
  return value === null ? null : hash(value, field);
}

function nullableU64(
  value: unknown,
  field: string,
  positive: boolean
): UInt64Decimal | null {
  return value === null ? null : uint64Decimal(value, field, positive);
}

function nullableAsciiToken(
  value: unknown,
  field: string,
  maximum: number
): string | null {
  return value === null ? null : boundedAsciiToken(value, field, maximum);
}

function validDate(value: unknown, field: string): Date {
  if (utilTypes.isProxy(value) || !(value instanceof Date)) {
    validation(field);
  }
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype ||
        Reflect.ownKeys(value).length !== 0) {
      validation(field);
    }
    const time = Date.prototype.getTime.call(value);
    if (!Number.isFinite(time)) validation(field);
    return new Date(time);
  } catch (error) {
    if (error instanceof SipEffectError) throw error;
    validation(field);
  }
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 64) validation(field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    validation(field);
  }
  return value;
}

function nullableValidTimestamp(
  value: unknown,
  field: string
): string | null {
  return value === null ? null : validTimestamp(value, field);
}

function validation(field: string): never {
  throw validationError(field);
}

function boundaryFactsInvalid(): never {
  throw boundaryFactsError();
}

function transitionConflict(): never {
  throw new SipEffectError({
    code: 'sip_effect_transition_conflict',
    status: 409
  });
}

function storeUnavailable(reason: string): never {
  throw new SipEffectError({
    code: 'store_unavailable',
    status: 503,
    retryable: true,
    details: { reason }
  });
}

function invalidRetryAfter(): never {
  throw new SipEffectError({
    code: 'sip_effect_retry_after_input_invalid',
    status: 422
  });
}

function checkedRetryInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 ||
      (value as number) > maximum) {
    invalidRetryAfter();
  }
  return value as number;
}

function ceilDiv(value: number, divisor: number): number {
  return value === 0 ? 0 : Math.floor((value - 1) / divisor) + 1;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function elapsed(startedAt: number, finishedAt: number): number {
  const value = finishedAt - startedAt;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function atomicWriteReceiptJson(
  write: AtomicBoundaryWriteReceipt
): { [key: string]: JsonValue } {
  const output: { [key: string]: JsonValue } = {
    fact_type: write.fact_type,
    receipt_id: write.receipt_id,
    aggregate_id: write.aggregate_id,
    aggregate_revision: write.aggregate_revision,
    applied: true,
    payload: cloneJson(write.payload)
  };
  if (write.fact_type === 'head_compare_and_swap') {
    output.expected_revision = write.expected_revision!;
    output.committed_revision = write.committed_revision!;
    output.expected_owner_epoch = write.expected_owner_epoch!;
    output.committed_owner_epoch = write.committed_owner_epoch!;
    output.expected_state = write.expected_state!;
    output.committed_state = write.committed_state!;
    output.cas_applied = true;
  }
  return output;
}

function cloneJson<T extends JsonValue>(value: T): T {
  const ancestors = new Set<object>();
  const budget = { nodes: 0, utf8_bytes: 0 };
  return cloneJsonValue(value, ancestors, budget, 0) as T;
}

function cloneJsonValue(
  value: unknown,
  ancestors: Set<object>,
  budget: { nodes: number; utf8_bytes: number },
  depth: number
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > 8_192 || depth > 32) validation('json');
  if (value === null || typeof value === 'string' ||
      typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      validation('json');
    }
    if (typeof value === 'string' && value.length > 65_535) validation('json');
    addCanonicalJsonBytes(
      budget,
      Buffer.byteLength(JSON.stringify(value), 'utf8')
    );
    return value as JsonValue;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value) ||
      ancestors.has(value)) {
    validation('json');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const source = snapshotClosedArray(
        value,
        1_024,
        () => validationError('json')
      );
      addCanonicalJsonBytes(
        budget,
        2 + Math.max(0, source.length - 1)
      );
      const output: JsonValue[] = [];
      for (let index = 0; index < source.length; index += 1) {
        output.push(
          cloneJsonValue(source[index], ancestors, budget, depth + 1)
        );
      }
      return output;
    }
    const source = snapshotDataRecord(
      value,
      256,
      () => validationError('json')
    );
    const output: Record<string, JsonValue> = {};
    const keys = Reflect.ownKeys(source) as string[];
    addCanonicalJsonBytes(
      budget,
      2 + Math.max(0, keys.length - 1)
    );
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (key.length > 256) validation('json');
      addCanonicalJsonBytes(
        budget,
        Buffer.byteLength(JSON.stringify(key), 'utf8') + 1
      );
      Object.defineProperty(output, key, {
        value: cloneJsonValue(
          source[key],
          ancestors,
          budget,
          depth + 1
        ),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function addCanonicalJsonBytes(
  budget: { utf8_bytes: number },
  bytes: number
): void {
  budget.utf8_bytes += bytes;
  if (!Number.isSafeInteger(budget.utf8_bytes) ||
      budget.utf8_bytes > MAX_CANONICAL_JSON_UTF8_BYTES) {
    validation('json');
  }
}

function cloneErrorDetails(
  value: Readonly<Record<string, unknown>>
): Record<string, any> {
  const seen = new Set<object>();
  const budget = { nodes: 0, utf8_bytes: 0 };
  const detailText = (
    input: string,
    maximumBytes = MAX_ERROR_DETAIL_STRING_UTF8_BYTES
  ): string => {
    const available = Math.max(
      0,
      Math.min(
        maximumBytes,
        MAX_ERROR_DETAILS_UTF8_BYTES - budget.utf8_bytes
      )
    );
    let bytes = 0;
    let end = 0;
    while (end < input.length && bytes < available) {
      const codePoint = input.codePointAt(end)!;
      const width = codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
      if (bytes + width > available) break;
      bytes += width;
      end += codePoint > 0xffff ? 2 : 1;
    }
    budget.utf8_bytes += bytes;
    return input.slice(0, end);
  };
  const clone = (input: unknown, depth: number): any => {
    budget.nodes += 1;
    if (budget.nodes > 256 || depth > 8) {
      return detailText('[truncated]');
    }
    if (input === null || typeof input === 'boolean') {
      return input;
    }
    if (typeof input === 'number') {
      return Number.isFinite(input) ? input : detailText('[invalid]');
    }
    if (typeof input === 'string') return detailText(input);
    if (utilTypes.isProxy(input) || typeof input === 'function') {
      return detailText('[invalid]');
    }
    if (typeof input !== 'object') return detailText('[unsupported]');
    if (seen.has(input)) return detailText('[circular]');
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        let source: readonly unknown[];
        try {
          source = snapshotClosedArray(input, 64, () => new Error('invalid'));
        } catch {
          return detailText('[invalid]');
        }
        const output: any[] = [];
        for (let index = 0; index < source.length; index += 1) {
          if (budget.utf8_bytes >= MAX_ERROR_DETAILS_UTF8_BYTES) break;
          output.push(clone(source[index], depth + 1));
        }
        return output;
      }
      if (input instanceof Date) {
        try {
          if (Object.getPrototypeOf(input) !== Date.prototype ||
              Reflect.ownKeys(input).length !== 0) {
            return detailText('[invalid]');
          }
          const time = Date.prototype.getTime.call(input);
          return Number.isFinite(time)
            ? detailText(new Date(time).toISOString())
            : detailText('[invalid]');
        } catch {
          return detailText('[invalid]');
        }
      }
      let source: Readonly<Record<string, unknown>>;
      try {
        source = snapshotDataRecord(input, 64, () => new Error('invalid'));
      } catch {
        return detailText('[invalid]');
      }
      const output: Record<string, any> = {};
      const keys = Reflect.ownKeys(source) as string[];
      for (let index = 0; index < keys.length; index += 1) {
        if (budget.utf8_bytes >= MAX_ERROR_DETAILS_UTF8_BYTES) break;
        const sourceKey = keys[index]!;
        const key = sourceKey.length > MAX_ERROR_DETAIL_KEY_UTF8_BYTES
          ? detailText(
              `[truncated-key-${index}]`,
              MAX_ERROR_DETAIL_KEY_UTF8_BYTES
            )
          : detailText(sourceKey, MAX_ERROR_DETAIL_KEY_UTF8_BYTES);
        if (!key) break;
        Object.defineProperty(output, key, {
          value: clone(source[sourceKey], depth + 1),
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return output;
    } finally {
      seen.delete(input);
    }
  };
  const output = clone(value, 0);
  return output && typeof output === 'object' && !Array.isArray(output)
    ? output
    : {};
}

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}
