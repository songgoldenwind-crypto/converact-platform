import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  readPostgresMigrationPlan,
  runPostgresMigrationsOnClient,
  type MigrationQueryable
} from '../src/postgres-migrations.js';
import {
  BoundedEffectQueue,
  SIP_EFFECT_ATOMIC_DOMAIN_WRITES_STATUS,
  SIP_EFFECT_MACHINE_SCHEMA_DESCRIPTOR,
  SIP_EFFECT_PHYSICAL_POSTGRES_VERIFICATION,
  SIP_EFFECT_SCHEMA_HASH,
  SIP_EFFECT_SCHEMA_ID,
  SIP_EFFECT_SCHEMA_VERSION,
  SIP_EFFECT_SCHEMA_V1_HASH,
  SIP_EFFECT_SCHEMA_V1_VERSION,
  SipEffectError,
  SipEffectMetricBook,
  SipEffectOracle,
  canonicalSipEffectHash,
  classifyProtocolEffectReceipt,
  cloneProtocolEffect,
  createAtomicBoundaryCommit,
  createStoreFailureSip503,
  protocolEffectIdentityHash,
  type AtomicBoundaryMetadata,
  type AtomicBoundaryResult,
  type AtomicBoundaryWriteReceipt,
  type EffectRepairBatch,
  type EffectRepairClaim,
  type EffectRepairCompactRequest,
  type EffectRepairFence,
  type EffectRepairReleaseRequest,
  type EffectRetentionRequest,
  type EffectTransition,
  type DurableProtocolEffectPrepareInput,
  type ProtocolEffectIdentity,
  type ProtocolEffectRecord,
  type ProtocolEffectStore,
  type StoreFailureCode
} from '../src/agent-runtime/converact/voice/sip-foundation/effect-oracle.js';
import {
  PostgresEffectStore
} from '../src/agent-runtime/converact/voice/sip-foundation/postgres-effect-store.js';
import {
  SIP_FOUNDATION_CAPABILITY_IDS,
  computeBackendCapabilitySetDigest,
  createBackendCapabilitySet
} from '../src/agent-runtime/converact/voice/sip-foundation/capabilities.js';
import {
  RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES,
  RsipstackFoundationAdapter
} from '../src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.js';
import {
  SIP_WIRE_BRANCH_PLACEHOLDER,
  finalizeSipWireAttemptFacts,
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256
} from '../src/agent-runtime/converact/voice/sip-foundation/route-binding.js';
import {
  SipFoundationSessionRegistry
} from '../src/agent-runtime/converact/voice/sip-foundation/session-registry.js';
import type {
  BackendCapabilitySetInput,
  BackendRuntimeIdentity,
  BoundSipRouteBinding,
  BoundSipWireAttemptFacts,
  PreparedProtocolEffect,
  PreparedProtocolEffectAuthority,
  SipFoundationCapabilityId,
  SipRouteBinding
} from '../src/agent-runtime/converact/voice/sip-foundation/types.js';

const ORIGINAL_WIRE_BYTES = Buffer.from(
  'OPTIONS sip:service.example.test SIP/2.0\r\n' +
  'Via: SIP/2.0/UDP 10.0.0.10:5060;branch=z9hG4bK-effect-1\r\n' +
  'Call-ID: effect-call-1\r\n' +
  'CSeq: 1 OPTIONS\r\n' +
  'Content-Length: 0\r\n\r\n'
);
const MAX_U64 = '18446744073709551615';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function effectCapabilitySetInput(): BackendCapabilitySetInput {
  const supported = new Set<SipFoundationCapabilityId>(
    RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES
  );
  const payload = {
    schema_id: 'sip-foundation-backend-capability-set-v1' as const,
    schema_version: '1.0.0' as const,
    backend_id: 'rsipstack' as const,
    runtime_attestation_verification: 'not_run' as const,
    production_eligible: false as const,
    capabilities: Object.fromEntries(
      SIP_FOUNDATION_CAPABILITY_IDS.map((capability) => [
        capability,
        supported.has(capability)
          ? { support: 'supported', verification: 'passed' }
          : { support: 'unsupported', verification: 'not_run' }
      ])
    ) as BackendCapabilitySetInput['capabilities']
  };
  return {
    ...payload,
    source_digest: 'a'.repeat(64),
    binary_digest: 'b'.repeat(64),
    config_digest: 'c'.repeat(64),
    capability_set_digest: computeBackendCapabilitySetDigest(payload)
  };
}

function effectFoundationRoute(): SipRouteBinding {
  return {
    schema_id: 'sip-foundation-route-binding-v1',
    schema_version: '1.0.0',
    route: { id: 'route-effect-oracle', revision: 1 },
    rfc3263_candidate: 'candidate-effect-oracle',
    route_set: ['sip:edge.example.test;lr'],
    transport: {
      id: 'transport-effect-oracle',
      protocol: 'udp',
      next_hop: { address: '203.0.113.10', port: 5060 }
    },
    local_endpoint: { address: '10.0.0.10', port: 5060 },
    advertised_via_sent_by: {
      host: 'voice.example.test',
      port: 5060
    },
    tls_sni: null,
    authorization_identity: 'trunk-a',
    authorization_headers_sha256: []
  };
}

function effectFoundationWire(route: SipRouteBinding): Buffer {
  return Buffer.from([
    'OPTIONS sip:service.example.test SIP/2.0',
    `Via: SIP/2.0/${route.transport.protocol.toUpperCase()} ` +
      `${route.advertised_via_sent_by.host}:` +
      `${route.advertised_via_sent_by.port};` +
      `branch=${SIP_WIRE_BRANCH_PLACEHOLDER}`,
    ...route.route_set.map((value) => `Route: <${value}>`),
    'Call-ID: effect-call-authoritative-1',
    'CSeq: 1 OPTIONS',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n'), 'utf8');
}

interface PreparedFixtureOverrides {
  tenant_id?: string;
  protocol_effect_id?: string;
  protocol_session_id?: string;
  protocol_session_generation?: string;
  decision_id?: string;
  idempotency_key?: string;
  request_hash?: string;
  command_id?: string;
  wire_bytes_hash?: string;
  canonical_wire_bytes?: Uint8Array;
  route_binding?: BoundSipRouteBinding;
  owner_epoch?: string;
  command_sequence?: string;
  audit_until?: Date;
  wire_attempt_version?: 1 | 2;
  completion_scope?:
    | 'transaction_peer_observation'
    | 'transport_accepted_terminal'
    | 'uas_core_deferred';
}

const TEST_ADAPTER_IDENTITY: BackendRuntimeIdentity = Object.freeze({
  backend_id: 'rsipstack',
  source_digest: 'a'.repeat(64),
  binary_digest: 'b'.repeat(64),
  config_digest: 'c'.repeat(64),
  capability_set_digest: 'd'.repeat(64),
  runtime_attestation_verification: 'not_run',
  production_eligible: false
});
const TEST_PREPARED_BYTES = new WeakMap<PreparedProtocolEffect, Uint8Array>();
const TEST_PREPARED_EFFECT_AUTHORITY: PreparedProtocolEffectAuthority =
  Object.freeze({
    verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array {
      const bytes = TEST_PREPARED_BYTES.get(prepared);
      if (!bytes) throw new Error('untrusted prepared effect');
      return bytes;
    }
  });

function testSipEffectOracle(
  input: Omit<
    ConstructorParameters<typeof SipEffectOracle>[0],
    'prepared_effect_authority'
  >
): SipEffectOracle {
  return new SipEffectOracle({
    ...input,
    prepared_effect_authority: TEST_PREPARED_EFFECT_AUTHORITY
  });
}

function preparedInput(
  overrides: PreparedFixtureOverrides = {}
): DurableProtocolEffectPrepareInput {
  const effectId = overrides.protocol_effect_id ?? 'effect-1';
  const requestHash = overrides.request_hash ?? sha256('request-1');
  const wireBytes = overrides.canonical_wire_bytes ??
    Buffer.from(ORIGINAL_WIRE_BYTES);
  const wireHash = overrides.wire_bytes_hash ?? sha256(wireBytes);
  const route = overrides.route_binding ?? effectFoundationRoute();
  const routeHash = sipRouteBindingSha256(route);
  const legacyAttempt = Object.freeze({
    schema_id: 'sip-foundation-wire-attempt-v1',
    schema_version: '1.0.0',
    attempt_id: effectId,
    transaction_lineage_id: effectId,
    semantic_intent_sha256: requestHash,
    parent_attempt_id: null,
    lineage_reason: 'transaction_root',
    via_branch: `z9hG4bK-opc-${sha256(effectId).slice(0, 40)}`
  });
  const attempt: BoundSipWireAttemptFacts =
    overrides.wire_attempt_version === 1
      ? legacyAttempt
      : finalizeSipWireAttemptFacts(legacyAttempt, {
          canonical_destination: {
            transport_id: route.transport.id,
            protocol: route.transport.protocol,
            address: route.transport.next_hop.address,
            port: route.transport.next_hop.port,
            selection_kind: 'route_candidate',
            flow_id: null,
            flow_generation: null
          },
          transaction_binding_sha256: sha256(
            `${effectId}:${legacyAttempt.via_branch}`
          ),
          completion_scope:
            overrides.completion_scope ?? 'transaction_peer_observation'
        });
  const attemptHash = sipWireAttemptFactsSha256(attempt);
  const prepared: PreparedProtocolEffect = {
    adapter_identity: TEST_ADAPTER_IDENTITY,
    wire_identity: {
      protocol_session_id:
        overrides.protocol_session_id ?? 'protocol-session-effect-1',
      protocol_session_generation:
        overrides.protocol_session_generation ??
        '11111111-1111-4111-8111-111111111111',
      effect_id: effectId,
      command_id: overrides.command_id ?? 'command-1',
      owner_epoch: overrides.owner_epoch ?? '7',
      command_sequence: overrides.command_sequence ?? '11',
      wire_sha256: wireHash,
      route_binding_sha256: routeHash,
      wire_attempt_facts_sha256: attemptHash,
      wire_freeze_sha256: sipWireFreezeSha256({
        route_binding_sha256: routeHash,
        wire_attempt_facts_sha256: attemptHash,
        wire_sha256: wireHash,
        wire_length_bytes: wireBytes.byteLength
      }),
      wire_length_bytes: wireBytes.byteLength
    },
    route_binding: route,
    wire_attempt_facts: attempt,
    wire_bytes_base64: Buffer.from(wireBytes).toString('base64')
  };
  TEST_PREPARED_BYTES.set(prepared, wireBytes);
  return {
    tenant_id: overrides.tenant_id ?? 'tenant-a',
    decision_id: overrides.decision_id ?? 'decision-1',
    idempotency_key:
      overrides.idempotency_key ?? 'effect-idempotency-1',
    request_hash: requestHash,
    prepared_effect: prepared,
    ...(overrides.audit_until === undefined
      ? {}
      : { audit_until: overrides.audit_until })
  };
}

function identity(
  input: DurableProtocolEffectPrepareInput = preparedInput()
): ProtocolEffectIdentity {
  const prepared = input.prepared_effect;
  return {
    tenant_id: input.tenant_id,
    protocol_effect_id: prepared.wire_identity.effect_id,
    protocol_session_id: prepared.wire_identity.protocol_session_id,
    protocol_session_generation:
      prepared.wire_identity.protocol_session_generation,
    decision_id: input.decision_id,
    idempotency_key: input.idempotency_key,
    request_hash: input.request_hash,
    command_id: prepared.wire_identity.command_id,
    adapter_identity_hash: canonicalSipEffectHash(
      prepared.adapter_identity
    ),
    wire_bytes_hash: prepared.wire_identity.wire_sha256,
    wire_length_bytes: prepared.wire_identity.wire_length_bytes,
    route_binding_hash: prepared.wire_identity.route_binding_sha256,
    wire_attempt_facts_hash:
      prepared.wire_identity.wire_attempt_facts_sha256,
    wire_freeze_sha256: prepared.wire_identity.wire_freeze_sha256,
    owner_epoch: prepared.wire_identity.owner_epoch,
    command_sequence: prepared.wire_identity.command_sequence
  };
}

class MemoryEffectStore implements ProtocolEffectStore {
  readonly effects = new Map<string, ProtocolEffectRecord>();
  readonly idempotency = new Map<string, string>();
  readonly receipts = new Map<string, {
    protocol_effect_id: string;
    receipt_hash: string;
    level: string;
  }>();

  async prepare(effect: ProtocolEffectRecord): Promise<{
    effect: ProtocolEffectRecord;
    replayed: boolean;
  }> {
    const idempotencyKey = `${effect.tenant_id}:${effect.idempotency_key}`;
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = this.effects.get(existingId)!;
      if (!samePreparedEffect(existing, effect)) idempotencyConflict();
      return { effect: cloneEffect(existing), replayed: true };
    }
    const key = effectKey(effect);
    const byId = this.effects.get(key);
    if (byId && !samePreparedEffect(byId, effect)) idempotencyConflict();
    this.effects.set(key, cloneEffect(effect));
    this.idempotency.set(idempotencyKey, key);
    return { effect: cloneEffect(effect), replayed: false };
  }

  async transition(input: EffectTransition): Promise<ProtocolEffectRecord> {
    const key = effectKey(input.identity);
    const current = this.effects.get(key);
    if (!current) notFound();
    assertIdentity(current!, input.identity);
    const receiptKey = `${input.identity.tenant_id}:${input.receipt_id}`;
    const receipt = this.receipts.get(receiptKey);
    if (receipt) {
      if (receipt.protocol_effect_id !== input.identity.protocol_effect_id ||
          receipt.receipt_hash !== input.receipt_hash ||
          receipt.level !== input.level) {
        throw new SipEffectError({
          code: 'sip_effect_receipt_conflict',
          status: 409
        });
      }
      return cloneEffect(current!);
    }
    if (current!.terminal_tombstone) {
      throw new SipEffectError({ code: 'sip_effect_terminal', status: 409 });
    }
    if (!input.allowed_from.includes(current!.state)) {
      throw new SipEffectError({
        code: 'sip_effect_transition_conflict',
        status: 409
      });
    }
    if (current!.state === 'unknown') {
      assertRepairFence(current!, input.repair_fence, input.observed_at);
    } else if (input.repair_fence !== null) {
      throw new SipEffectError({ code: 'sip_effect_fence_lost', status: 409 });
    }
    this.receipts.set(receiptKey, {
      protocol_effect_id: input.identity.protocol_effect_id,
      receipt_hash: input.receipt_hash,
      level: input.level
    });
    const nextRevision = addU64(current!.revision, 1);
    const next: ProtocolEffectRecord = {
      ...cloneEffect(current!),
      state: input.level,
      revision: nextRevision,
      updated_at: input.observed_at,
      unknown_count: input.level === 'unknown'
        ? current!.unknown_count + 1
        : current!.unknown_count,
      repair_due_at: input.level === 'unknown'
        ? new Date(
            Date.parse(input.observed_at) + input.repair_delay_ms!
          ).toISOString()
        : current!.repair_due_at,
      repair_owner_id: input.repair_fence ? null : current!.repair_owner_id,
      repair_owner_epoch: input.repair_fence ? null : current!.repair_owner_epoch,
      repair_claim_token: input.repair_fence ? null : current!.repair_claim_token,
      repair_claim_revision: input.repair_fence ? null : current!.repair_claim_revision,
      repair_lease_until: input.repair_fence ? null : current!.repair_lease_until,
      last_receipt_id: input.receipt_id,
      last_receipt_hash: input.receipt_hash,
      last_receipt_repair_delay_ms: input.repair_delay_ms,
      failure_code: input.failure_code,
      terminal_tombstone: input.terminal
        ? {
            receipt_id: input.receipt_id,
            receipt_hash: input.receipt_hash,
            state: input.level as
              'transport_completed' | 'protocol_observed' | 'failed',
            terminal_at: input.observed_at
          }
        : current!.terminal_tombstone
    };
    this.effects.set(key, next);
    return cloneEffect(next);
  }

  async query(effectIdentity: ProtocolEffectIdentity): Promise<ProtocolEffectRecord | null> {
    const effect = this.effects.get(effectKey(effectIdentity));
    if (!effect) return null;
    assertIdentity(effect, effectIdentity);
    return cloneEffect(effect);
  }

  async claimUnknownForRepair(input: EffectRepairClaim): Promise<EffectRepairBatch> {
    const due = [...this.effects.values()]
      .filter((effect) =>
        effect.tenant_id === input.tenant_id &&
        effect.state === 'unknown' &&
        !effect.operator_attention_required &&
        Date.parse(effect.repair_due_at || effect.updated_at) <= input.claimed_at.getTime() &&
        (!effect.repair_lease_until ||
          Date.parse(effect.repair_lease_until) <= input.claimed_at.getTime()) &&
        BigInt(input.repair_owner_epoch) > BigInt(effect.repair_epoch_high_watermark)
      )
      .sort((left, right) =>
        String(left.repair_due_at).localeCompare(String(right.repair_due_at)) ||
        left.protocol_effect_id.localeCompare(right.protocol_effect_id)
      )
      .slice(0, input.limit);
    let exhausted = 0;
    const claimed: ProtocolEffectRecord[] = [];
    for (const effect of due) {
      if (effect.repair_attempts >= 8) {
        effect.repair_exhausted_at = input.claimed_at.toISOString();
        effect.repair_exhaustion_receipt_hash = canonicalSipEffectHash({
          tenant_id: effect.tenant_id,
          protocol_effect_id: effect.protocol_effect_id,
          repair_attempts: effect.repair_attempts,
          repair_epoch_high_watermark: effect.repair_epoch_high_watermark
        });
        effect.operator_attention_required = true;
        effect.repair_due_at = null;
        effect.revision = addU64(effect.revision, 1);
        exhausted += 1;
        continue;
      }
      effect.repair_owner_id = input.repair_owner_id;
      effect.repair_owner_epoch = input.repair_owner_epoch;
      effect.repair_epoch_high_watermark = input.repair_owner_epoch;
      effect.repair_claim_token =
        `${input.claim_token_prefix}:${effect.protocol_effect_id}:` +
        `${input.repair_owner_epoch}:${addU64(effect.revision, 1)}`;
      effect.repair_lease_until = input.lease_until.toISOString();
      effect.repair_attempts += 1;
      effect.revision = addU64(effect.revision, 1);
      effect.repair_claim_revision = effect.revision;
      claimed.push(cloneEffect(effect));
    }
    return { effects: claimed, exhausted_count: exhausted };
  }

  async releaseRepairClaim(input: EffectRepairReleaseRequest): Promise<void> {
    const effect = this.effects.get(effectKey(input.identity));
    if (!effect) notFound();
    assertIdentity(effect!, input.identity);
    assertRepairFence(effect!, input.fence, input.released_at.toISOString());
    effect!.repair_owner_id = null;
    effect!.repair_owner_epoch = null;
    effect!.repair_claim_token = null;
    effect!.repair_claim_revision = null;
    effect!.repair_lease_until = null;
    effect!.repair_due_at = input.next_repair_at.toISOString();
    effect!.revision = addU64(effect!.revision, 1);
  }

  async compactExhaustedRepairs(input: EffectRepairCompactRequest): Promise<number> {
    let count = 0;
    for (const effect of [...this.effects.values()]
      .sort((left, right) => left.protocol_effect_id.localeCompare(right.protocol_effect_id))) {
      if (count >= input.limit) break;
      if (effect.tenant_id !== input.tenant_id ||
          !effect.operator_attention_required ||
          effect.repair_compacted_at ||
          !effect.repair_exhausted_at ||
          Date.parse(effect.repair_exhausted_at) > input.cutoff.getTime()) continue;
      effect.repair_owner_id = null;
      effect.repair_owner_epoch = null;
      effect.repair_claim_token = null;
      effect.repair_claim_revision = null;
      effect.repair_lease_until = null;
      effect.repair_due_at = null;
      effect.repair_compacted_at = input.cutoff.toISOString();
      effect.revision = addU64(effect.revision, 1);
      count += 1;
    }
    return count;
  }

  async pruneTerminalPayloads(input: EffectRetentionRequest): Promise<number> {
    let pruned = 0;
    for (const effect of [...this.effects.values()]
      .sort((left, right) => left.protocol_effect_id.localeCompare(right.protocol_effect_id))) {
      if (pruned >= input.limit) break;
      if (effect.tenant_id !== input.tenant_id ||
          !effect.terminal_tombstone ||
          !effect.payload_retained ||
          effect.retention_reference_count !== 0 ||
          effect.rollback_reference_count !== 0 ||
          Date.parse(effect.audit_until) > input.cutoff.getTime()) continue;
      effect.canonical_wire_bytes = Buffer.alloc(0);
      effect.payload_retained = false;
      effect.revision = addU64(effect.revision, 1);
      pruned += 1;
    }
    return pruned;
  }
}

test('canonical hashes are key-order invariant and reject every non-JSON value', () => {
  assert.equal(
    canonicalSipEffectHash({ z: [3, { b: true, a: 'x' }], a: 1 }),
    canonicalSipEffectHash({ a: 1, z: [3, { a: 'x', b: true }] })
  );
  const prototypeNamedKey: Record<string, unknown> = {};
  Object.defineProperty(prototypeNamedKey, '__proto__', {
    enumerable: true,
    value: { stable: true }
  });
  assert.notEqual(
    canonicalSipEffectHash(prototypeNamedKey),
    canonicalSipEffectHash({})
  );
  assert.match(
    canonicalSipEffectHash({ value: 'x'.repeat(60_000) }),
    /^[a-f0-9]{64}$/
  );
  assert.throws(
    () => canonicalSipEffectHash({
      left: 'x'.repeat(40_000),
      right: 'y'.repeat(40_000)
    }),
    isValidationError
  );
  const oversizedKeys: Record<string, string> = {};
  for (let index = 0; index < 256; index += 1) {
    oversizedKeys[
      `${String(index).padStart(3, '0')}-${'k'.repeat(245)}`
    ] = 'v';
  }
  assert.throws(
    () => canonicalSipEffectHash(oversizedKeys),
    isValidationError
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const invalid of [
    { value: undefined },
    { value: () => undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: new Date() },
    { value: new Map() },
    circular
  ]) {
    assert.throws(
      () => canonicalSipEffectHash(invalid),
      (error: unknown) =>
        error instanceof SipEffectError &&
        error.code === 'sip_effect_validation_failed'
    );
  }
});

test('SipEffectError details are detached and recursively immutable', () => {
  const details = { outer: { value: 'original' }, items: [{ n: 1 }] };
  const error = new SipEffectError({
    code: 'sip_effect_validation_failed',
    details
  });
  details.outer.value = 'mutated';
  details.items[0]!.n = 9;
  assert.deepEqual(error.details, {
    outer: { value: 'original' },
    items: [{ n: 1 }]
  });
  assert.equal(Object.isFrozen(error.details), true);
  assert.equal(Object.isFrozen(error.details.outer), true);
  assert.equal(Object.isFrozen(error.details.items), true);
  assert.equal(Object.isFrozen(error.details.items[0]), true);
});

test('canonical fact payload and error details have cumulative UTF-8 budgets', () => {
  const result = callAdmissionResult();
  result.writes[0]!.payload = {
    segments: ['x'.repeat(33_000), 'y'.repeat(33_000)]
  };
  assert.throws(
    () => createAtomicBoundaryCommit(
      boundaryMetadata('call_admission'),
      result
    ),
    isValidationError
  );

  let getterReads = 0;
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, 'secret', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'must-not-run';
    }
  });
  const error = new SipEffectError({
    code: 'sip_effect_validation_failed',
    details: {
      first: '界'.repeat(10_000),
      second: 'y'.repeat(10_000),
      nested
    }
  });
  assert.equal(getterReads, 0);
  assert.ok(Buffer.byteLength(String(error.details.first), 'utf8') <= 1_024);
  assert.ok(Buffer.byteLength(String(error.details.second), 'utf8') <= 1_024);
  assert.ok(Buffer.byteLength(JSON.stringify(error.details), 'utf8') < 8_500);
  assert.deepEqual(error.details.nested, '[invalid]');
  assert.equal(Object.isFrozen(error.details), true);
});

test('prepare freezes exact identity, accepts full uint64 and enforces a 65535-byte wire ceiling', async () => {
  const store = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const mutableBytes = Buffer.from(ORIGINAL_WIRE_BYTES);
  const mutableRoutes = ['sip:edge.example.test;lr'];
  const mutableRoute = {
    ...effectFoundationRoute(),
    route_set: mutableRoutes
  } as BoundSipRouteBinding;
  const input = preparedInput({
    owner_epoch: MAX_U64,
    command_sequence: MAX_U64,
    canonical_wire_bytes: mutableBytes,
    route_binding: mutableRoute
  });
  const first = await oracle.prepare(input);
  mutableBytes.fill(0);
  mutableRoutes[0] = 'sip:mutated.invalid;lr';
  assert.equal(first.effect.owner_epoch, MAX_U64);
  assert.equal(first.effect.command_sequence, MAX_U64);
  assert.equal(first.effect.revision, '1');
  assert.deepEqual(first.effect.canonical_wire_bytes, ORIGINAL_WIRE_BYTES);
  assert.deepEqual(first.effect.route_binding.route_set, ['sip:edge.example.test;lr']);
  assert.equal((await oracle.prepare(preparedInput({
    owner_epoch: MAX_U64,
    command_sequence: MAX_U64
  }))).replayed, true);

  for (const owner_epoch of ['0', '00', '01', '18446744073709551616', 1]) {
    await assert.rejects(
      oracle.prepare(preparedInput({ owner_epoch } as never)),
      isValidationError
    );
  }
  const maximumWire = Buffer.alloc(65_535, 1);
  await testSipEffectOracle({ store: new MemoryEffectStore() }).prepare(
    preparedInput({
      canonical_wire_bytes: maximumWire,
      wire_bytes_hash: sha256(maximumWire)
    })
  );
  const tooLarge = Buffer.alloc(65_536, 1);
  await assert.rejects(
    testSipEffectOracle({ store: new MemoryEffectStore() }).prepare(
      preparedInput({
        canonical_wire_bytes: tooLarge,
        wire_bytes_hash: sha256(tooLarge)
      })
    ),
    isValidationError
  );
});

test('oracle durably accepts only an authority-verified Foundation prepared effect', async () => {
  const capabilityInput = effectCapabilitySetInput();
  const adapter = new RsipstackFoundationAdapter(
    createBackendCapabilitySet(capabilityInput)
  );
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 2,
    maximum_attempts: 4
  });
  const route = effectFoundationRoute();
  const session = registry.openProtocolSession(adapter, {
    protocol_session_id: 'protocol-session-effect-oracle-1',
    session_binding: {
      schema_id: 'sip-foundation-session-binding-v1',
      schema_version: '1.0.0',
      route: { ...route.route },
      authorization_identity: route.authorization_identity
    }
  });
  const semanticIntent = sha256('effect-oracle-authoritative-intent');
  const prepared = session.prepareEffect({
    effect_id: 'effect-authoritative-1',
    command_id: 'command-authoritative-1',
    owner_epoch: '7',
    command_sequence: '11',
    route_binding: route,
    wire_attempt_facts: {
      schema_id: 'sip-foundation-wire-attempt-v1',
      schema_version: '1.0.0',
      attempt_id: 'effect-authoritative-1',
      transaction_lineage_id: 'effect-authoritative-1',
      semantic_intent_sha256: semanticIntent,
      parent_attempt_id: null,
      lineage_reason: 'transaction_root'
    },
    canonical_wire_template: effectFoundationWire(route)
  });
  const oracle = new SipEffectOracle({
    store: new MemoryEffectStore(),
    prepared_effect_authority: registry
  });
  const result = await oracle.prepare({
    tenant_id: 'tenant-a',
    decision_id: 'decision-authoritative-1',
    idempotency_key: 'idempotency-authoritative-1',
    request_hash: semanticIntent,
    prepared_effect: prepared
  });
  const durable = result.effect as unknown as Record<string, any>;
  assert.equal(
    durable.protocol_session_id,
    prepared.wire_identity.protocol_session_id
  );
  assert.equal(
    durable.protocol_session_generation,
    prepared.wire_identity.protocol_session_generation
  );
  assert.deepEqual(durable.adapter_identity, prepared.adapter_identity);
  assert.deepEqual(durable.route_binding, prepared.route_binding);
  assert.deepEqual(durable.wire_attempt_facts, prepared.wire_attempt_facts);
  assert.equal(
    durable.wire_freeze_sha256,
    prepared.wire_identity.wire_freeze_sha256
  );
  assert.equal(
    durable.wire_attempt_facts_hash,
    prepared.wire_identity.wire_attempt_facts_sha256
  );
  assert.equal(
    durable.route_binding_hash,
    prepared.wire_identity.route_binding_sha256
  );
  assert.equal(
    durable.wire_length_bytes,
    prepared.wire_identity.wire_length_bytes
  );

  await assert.rejects(
    oracle.prepare({
      tenant_id: 'tenant-a',
      decision_id: 'decision-forged-1',
      idempotency_key: 'idempotency-forged-1',
      request_hash: semanticIntent,
      prepared_effect: structuredClone(prepared)
    }),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'sip_effect_prepared_authority_rejected'
  );

  registry.release(session);
  await assert.rejects(
    oracle.prepare({
      tenant_id: 'tenant-a',
      decision_id: 'decision-released-1',
      idempotency_key: 'idempotency-released-1',
      request_hash: semanticIntent,
      prepared_effect: prepared
    }),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'sip_effect_prepared_authority_rejected'
  );
});

test('all public protocol, repair, retention and retry inputs are closed objects', async () => {
  const oracle = testSipEffectOracle({ store: new MemoryEffectStore() });
  const cases: Array<() => unknown | Promise<unknown>> = [
    () => oracle.prepare({ ...preparedInput(), surprise: true } as never),
    () => oracle.prepare(preparedInput({
      route_binding: {
        ...preparedInput().prepared_effect.route_binding,
        surprise: true
      } as never
    })),
    () => oracle.query({ ...identity(), surprise: true } as never),
    () => oracle.claimRepairBatch({
      tenant_id: 'tenant-a',
      repair_owner_id: 'worker-a',
      repair_owner_epoch: '1',
      claim_token_prefix: 'claim-a',
      claimed_at: new Date(),
      lease_until: new Date(Date.now() + 1_000),
      limit: 1,
      surprise: true
    } as never),
    () => oracle.pruneTerminalPayloads({
      tenant_id: 'tenant-a',
      cutoff: new Date(),
      limit: 1,
      surprise: true
    } as never),
    () => oracle.recordUnknown(identity(), 'receipt', {
      repair_after_ms: 1,
      surprise: true
    } as never),
    () => createStoreFailureSip503({
      failure_code: 'store_timeout',
      pool_wait_ms: 1,
      queue_depth: 1,
      retry_attempt: 1,
      surprise: true
    } as never)
  ];
  for (const invoke of cases) {
    await assert.rejects(Promise.resolve().then(invoke), isValidationError);
  }
});

test('public effect boundaries reject accessors, symbols, non-enumerable data and proxies without reads', async () => {
  const oracle = testSipEffectOracle({ store: new MemoryEffectStore() });
  let requestHashReads = 0;
  const accessorInput = { ...preparedInput() } as Record<string, unknown>;
  Object.defineProperty(accessorInput, 'request_hash', {
    enumerable: true,
    get() {
      requestHashReads += 1;
      return requestHashReads === 1
        ? sha256('request-1')
        : sha256('changed-request');
    }
  });
  await assert.rejects(
    oracle.prepare(accessorInput as unknown as DurableProtocolEffectPrepareInput),
    isValidationError
  );
  assert.equal(requestHashReads, 0);

  const symbolInput = preparedInput() as DurableProtocolEffectPrepareInput & {
    [key: symbol]: unknown;
  };
  symbolInput[Symbol('shadow')] = true;
  await assert.rejects(oracle.prepare(symbolInput), isValidationError);

  const nonEnumerableInput = preparedInput();
  Object.defineProperty(nonEnumerableInput, 'prepared_effect', {
    enumerable: false,
    value: nonEnumerableInput.prepared_effect
  });
  await assert.rejects(oracle.prepare(nonEnumerableInput), isValidationError);
  await assert.rejects(
    oracle.prepare(new Proxy(preparedInput(), {})),
    isValidationError
  );
});

test('external route/fact arrays never execute attacker iterators or methods', async () => {
  const oracle = testSipEffectOracle({ store: new MemoryEffectStore() });
  let routeIteratorCalls = 0;
  const routeSet = ['sip:edge.example.test;lr'];
  Object.defineProperty(routeSet, Symbol.iterator, {
    value() {
      routeIteratorCalls += 1;
      return { next: () => ({ done: false, value: 'sip:loop.invalid;lr' }) };
    }
  });
  await assert.rejects(
    oracle.prepare(preparedInput({
      route_binding: {
        ...preparedInput().prepared_effect.route_binding,
        route_set: routeSet
      } as BoundSipRouteBinding
    })),
    isValidationError
  );
  assert.equal(routeIteratorCalls, 0);

  let writesIteratorCalls = 0;
  const writes = [...callAdmissionResult().writes];
  Object.defineProperty(writes, Symbol.iterator, {
    value() {
      writesIteratorCalls += 1;
      let count = 0;
      return {
        next() {
          count += 1;
          if (count > 4) throw new Error('infinite iterator invoked');
          return { done: false, value: writes[0] };
        }
      };
    }
  });
  assert.throws(
    () => createAtomicBoundaryCommit(
      boundaryMetadata('call_admission'),
      { boundary_kind: 'call_admission', writes }
    ),
    isValidationError
  );
  assert.equal(writesIteratorCalls, 0);
});

test('wire snapshot rejects accessor size switching and custom iteration before reading bytes', async () => {
  const oracle = testSipEffectOracle({ store: new MemoryEffectStore() });
  let wireReads = 0;
  const switchingWire = { ...preparedInput() } as Record<string, unknown>;
  Object.defineProperty(switchingWire, 'canonical_wire_bytes', {
    enumerable: true,
    get() {
      wireReads += 1;
      return wireReads === 1
        ? new Uint8Array(1)
        : new Uint8Array(65_536);
    }
  });
  await assert.rejects(
    oracle.prepare(
      switchingWire as unknown as DurableProtocolEffectPrepareInput
    ),
    isValidationError
  );
  assert.equal(wireReads, 0);

  let iteratorCalls = 0;
  const wire = Buffer.from(ORIGINAL_WIRE_BYTES);
  Object.defineProperty(wire, Symbol.iterator, {
    value() {
      iteratorCalls += 1;
      return { next: () => ({ done: false, value: 0 }) };
    }
  });
  await assert.rejects(
    oracle.prepare(preparedInput({ canonical_wire_bytes: wire })),
    isValidationError
  );
  assert.equal(iteratorCalls, 0);

  let byteLengthReads = 0;
  const shadowedWire = Buffer.from(ORIGINAL_WIRE_BYTES);
  Object.defineProperty(shadowedWire, 'byteLength', {
    get() {
      byteLengthReads += 1;
      return byteLengthReads === 1 ? shadowedWire.length : 65_536;
    }
  });
  const shadowedInput = preparedInput();
  TEST_PREPARED_BYTES.set(shadowedInput.prepared_effect, shadowedWire);
  await assert.rejects(
    oracle.prepare(shadowedInput),
    isValidationError
  );
  assert.equal(byteLengthReads, 0);

  const shared = new SharedArrayBuffer(ORIGINAL_WIRE_BYTES.length);
  const sharedWire = new Uint8Array(shared);
  sharedWire.set(ORIGINAL_WIRE_BYTES);
  const sharedInput = preparedInput();
  TEST_PREPARED_BYTES.set(sharedInput.prepared_effect, sharedWire);
  await assert.rejects(
    oracle.prepare(sharedInput),
    isValidationError
  );
});

test('Postgres effect inputs snapshot options, records and transition arrays without attacker reads', async () => {
  let optionReads = 0;
  const options: Record<string, unknown> = {};
  Object.defineProperty(options, 'max_in_flight', {
    enumerable: true,
    get() {
      optionReads += 1;
      return 1;
    }
  });
  assert.throws(
    () => new PostgresEffectStore(
      new RecordingPg(),
      options as never
    ),
    isValidationError
  );
  assert.equal(optionReads, 0);

  const seed = (
    await testSipEffectOracle({
      store: new MemoryEffectStore(),
      now: () => new Date('2026-07-30T00:00:00.000Z')
    }).prepare(preparedInput())
  ).effect;
  let stateReads = 0;
  const hostileEffect = { ...seed } as Record<string, unknown>;
  Object.defineProperty(hostileEffect, 'state', {
    enumerable: true,
    get() {
      stateReads += 1;
      return stateReads === 1 ? 'prepared' : 'failed';
    }
  });
  await assert.rejects(
    Promise.resolve().then(() =>
      new PostgresEffectStore(new RecordingPg()).prepare(
        hostileEffect as unknown as ProtocolEffectRecord
      )
    ),
    isValidationError
  );
  assert.equal(stateReads, 0);

  let allowedIteratorCalls = 0;
  const allowedFrom: Array<'prepared'> = ['prepared'];
  Object.defineProperty(allowedFrom, Symbol.iterator, {
    value() {
      allowedIteratorCalls += 1;
      return { next: () => ({ done: false, value: 'prepared' }) };
    }
  });
  await assert.rejects(
    Promise.resolve().then(() =>
      new PostgresEffectStore(new RecordingPg()).transition({
        identity: identity(),
        receipt_id: 'receipt-direct',
        receipt_hash: sha256('receipt-direct'),
        level: 'durable_decision',
        allowed_from: allowedFrom,
        observed_at: '2026-07-30T00:00:00.000Z',
        failure_code: '',
        repair_delay_ms: null,
        terminal: false,
        repair_fence: null
      })
    ),
    isValidationError
  );
  assert.equal(allowedIteratorCalls, 0);
});

test('Postgres store enforces the closed effect transition policy', async () => {
  const store = new PostgresEffectStore(new RecordingPg());
  const effectIdentity = identity();
  const base: EffectTransition = {
    identity: effectIdentity,
    receipt_id: 'receipt-direct',
    receipt_hash: canonicalSipEffectHash({
      identity: effectIdentity,
      receipt_id: 'receipt-direct',
      level: 'durable_decision',
      failure_code: '',
      repair_delay_ms: null
    }),
    level: 'durable_decision',
    allowed_from: ['prepared'],
    observed_at: '2026-07-30T00:00:00.000Z',
    failure_code: '',
    repair_delay_ms: null,
    terminal: false,
    repair_fence: null
  };

  for (const forged of [
    { ...base, allowed_from: ['send_attempted'] },
    { ...base, allowed_from: ['prepared', 'send_attempted'] },
    { ...base, terminal: true },
    { ...base, failure_code: 'forged' },
    {
      ...base,
      repair_delay_ms: 1_000
    },
    {
      ...base,
      repair_fence: {
        repair_owner_id: 'worker-a',
        repair_owner_epoch: '1',
        repair_claim_token: 'claim-a',
        repair_claim_revision: '1'
      }
    }
  ] satisfies EffectTransition[]) {
    await assert.rejects(
      Promise.resolve().then(() => store.transition(forged)),
      isValidationError
    );
  }
});

test('Postgres result rows reject accessors and infinite iterators before decoding persisted facts', async () => {
  const seed = (
    await testSipEffectOracle({
      store: new MemoryEffectStore(),
      now: () => new Date('2026-07-30T00:00:00.000Z')
    }).prepare(preparedInput())
  ).effect;
  const row = effectRow(seed);
  let persistedStateReads = 0;
  Object.defineProperty(row, 'state', {
    enumerable: true,
    get() {
      persistedStateReads += 1;
      return persistedStateReads === 1 ? 'prepared' : 'failed';
    }
  });
  await assert.rejects(
    new PostgresEffectStore(new DirectPreparedReplayPg(row)).prepare(seed),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_schema_incompatible'
  );
  assert.equal(persistedStateReads, 0);

  let rowsIteratorCalls = 0;
  const hostileRows: Record<string, unknown>[] = [];
  Object.defineProperty(hostileRows, Symbol.iterator, {
    value() {
      rowsIteratorCalls += 1;
      return {
        next: () => ({
          done: false,
          value: row
        })
      };
    }
  });
  await assert.rejects(
    new PostgresEffectStore(new HostileRepairRowsPg(hostileRows))
      .claimUnknownForRepair({
        tenant_id: 'tenant-a',
        repair_owner_id: 'worker-a',
        repair_owner_epoch: '1',
        claim_token_prefix: 'claim-a',
        claimed_at: new Date('2026-07-30T00:00:00.000Z'),
        lease_until: new Date('2026-07-30T00:00:01.000Z'),
        limit: 1
      }),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_schema_incompatible'
  );
  assert.equal(rowsIteratorCalls, 0);
});

test('Postgres replay rows require the configured writer and exact schema identity', async () => {
  const memory = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store: memory,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const prepared = (await oracle.prepare(preparedInput())).effect;
  const wrongWriterRow = effectRow(prepared);
  wrongWriterRow.writer_identity = 'forged-writer';
  await assert.rejects(
    new PostgresEffectStore(
      new PreparedReplayPg(wrongWriterRow)
    ).prepare(prepared),
    isStoreSchemaError
  );
  const corruptPreparedRow = effectRow(prepared);
  corruptPreparedRow.last_receipt_id = 'forged-receipt';
  corruptPreparedRow.last_receipt_hash = sha256('forged-receipt');
  await assert.rejects(
    new PostgresEffectStore(
      new PreparedReplayPg(corruptPreparedRow)
    ).prepare(prepared),
    isStoreSchemaError
  );

  const receiptId = 'receipt-replay';
  const receiptHash = canonicalSipEffectHash({
    identity: identity(),
    receipt_id: receiptId,
    level: 'durable_decision',
    failure_code: '',
    repair_delay_ms: null
  });
  await assert.rejects(
    new PostgresEffectStore(new ReceiptReplayPg(
      effectRow(prepared),
      {
        protocol_effect_id: prepared.protocol_effect_id,
        receipt_hash: receiptHash,
        level: 'durable_decision'
      }
    )).transition({
      identity: identity(),
      receipt_id: receiptId,
      receipt_hash: receiptHash,
      level: 'durable_decision',
      allowed_from: ['prepared'],
      observed_at: '2026-07-30T00:00:01.000Z',
      failure_code: '',
      repair_delay_ms: null,
      terminal: false,
      repair_fence: null
    }),
    isStoreSchemaError
  );

});

test('receipt replay is time-invariant and a receipt id cannot cross effects', async () => {
  const store = new MemoryEffectStore();
  const early = testSipEffectOracle({
    store,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const late = testSipEffectOracle({
    store,
    now: () => new Date('2026-07-30T00:05:00.000Z')
  });
  await early.prepare(preparedInput());
  const first = await early.recordDurableDecision(identity(), 'receipt-stable');
  const replay = await late.recordDurableDecision(identity(), 'receipt-stable');
  assert.equal(replay.last_receipt_hash, first.last_receipt_hash);
  assert.equal(replay.updated_at, first.updated_at);

  const secondInput = preparedInput({
    protocol_effect_id: 'effect-2',
    decision_id: 'decision-2',
    idempotency_key: 'effect-idempotency-2',
    request_hash: sha256('request-2'),
    command_id: 'command-2'
  });
  await early.prepare(secondInput);
  await assert.rejects(
    early.recordDurableDecision(identity(secondInput), 'receipt-stable'),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'sip_effect_receipt_conflict'
  );
});

test('unknown receipt identity binds the repair delay policy', async () => {
  const store = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(identity(), 'receipt-durable');
  await oracle.recordSendAttempted(identity(), 'receipt-send');
  await oracle.recordUnknown(identity(), 'receipt-unknown-policy', {
    repair_after_ms: 1_000
  });

  await assert.rejects(
    oracle.recordUnknown(identity(), 'receipt-unknown-policy', {
      repair_after_ms: 30_000
    }),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'sip_effect_receipt_conflict'
  );
});

test('transport completion is terminal local evidence and never peer protocol evidence', async () => {
  const oracle = testSipEffectOracle({
    store: new MemoryEffectStore(),
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const input = preparedInput({
    audit_until: new Date('2026-07-30T00:00:01.000Z'),
    completion_scope: 'transport_accepted_terminal'
  });
  const effectIdentity = identity(input);
  await oracle.prepare(input);
  await oracle.recordDurableDecision(effectIdentity, 'receipt-durable');
  await oracle.recordSendAttempted(effectIdentity, 'receipt-send');
  await oracle.recordTransportAccepted(effectIdentity, 'receipt-accepted');

  const completed = await oracle.recordTransportCompleted(
    effectIdentity,
    'receipt-transport-completed'
  );
  assert.equal(completed.state, 'transport_completed');
  assert.equal(completed.terminal_tombstone?.state, 'transport_completed');
  assert.equal(classifyProtocolEffectReceipt({
    level: 'transport_completed',
    from_state: 'transport_accepted'
  }), 'transport_completed');
  assert.notEqual(completed.state, 'protocol_observed');
  await assert.rejects(
    oracle.recordProtocolObserved(effectIdentity, 'receipt-peer-observed'),
    (error: unknown) =>
      error instanceof SipEffectError && error.code === 'sip_effect_terminal'
  );
  assert.equal(await oracle.pruneTerminalPayloads({
    tenant_id: 'tenant-a',
    cutoff: new Date('2026-07-30T00:00:02.000Z'),
    limit: 1
  }), 1);
});

test('rolling readers keep v1 effects drainable without granting them v2 transport completion', async () => {
  const oracle = testSipEffectOracle({
    store: new MemoryEffectStore(),
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const legacyInput = preparedInput({ wire_attempt_version: 1 });
  const legacyIdentity = identity(legacyInput);
  await oracle.prepare(legacyInput);
  await oracle.recordDurableDecision(
    legacyIdentity,
    'receipt-durable-v1'
  );
  const attempted = await oracle.recordSendAttempted(
    legacyIdentity,
    'receipt-send-v1'
  );
  const legacy = cloneEffect(attempted);
  legacy.schema_version = SIP_EFFECT_SCHEMA_V1_VERSION;
  legacy.schema_hash = SIP_EFFECT_SCHEMA_V1_HASH;
  assert.equal(cloneProtocolEffect(legacy).schema_version, 1);

  const pg = new TransitionCapturePg(effectRow(legacy));
  const store = new PostgresEffectStore(pg);
  const receiptId = 'receipt-unknown-v1-drain';
  await assert.rejects(store.transition({
    identity: legacyIdentity,
    receipt_id: receiptId,
    receipt_hash: canonicalSipEffectHash({
      identity: legacyIdentity,
      receipt_id: receiptId,
      level: 'unknown',
      failure_code: '',
      repair_delay_ms: 1_000
    }),
    level: 'unknown',
    allowed_from: ['send_attempted', 'transport_accepted'],
    observed_at: '2026-07-30T00:00:01.000Z',
    failure_code: '',
    repair_delay_ms: 1_000,
    terminal: false,
    repair_fence: null
  }), isFenceLost);
  const receiptInsert = pg.queries.find((query) =>
    query.text.includes('receipt-insert')
  )!;
  assert.equal(receiptInsert.params[16], SIP_EFFECT_SCHEMA_ID);
  assert.equal(receiptInsert.params[17], SIP_EFFECT_SCHEMA_V1_VERSION);
  assert.equal(receiptInsert.params[18], SIP_EFFECT_SCHEMA_V1_HASH);

  const forgedV1Terminal = cloneEffect(legacy);
  forgedV1Terminal.state = 'transport_completed';
  forgedV1Terminal.terminal_tombstone = {
    receipt_id: forgedV1Terminal.last_receipt_id!,
    receipt_hash: forgedV1Terminal.last_receipt_hash!,
    state: 'transport_completed',
    terminal_at: forgedV1Terminal.updated_at
  };
  assert.throws(() => cloneProtocolEffect(forgedV1Terminal), isValidationError);
});

test('persisted effects reject inconsistent receipt, repair and timestamp groups', async () => {
  const store = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const prepared = (await oracle.prepare(preparedInput())).effect;
  const preparedWithReceipt = cloneEffect(prepared);
  preparedWithReceipt.last_receipt_id = 'forged-receipt';
  preparedWithReceipt.last_receipt_hash = sha256('forged-receipt');

  const durable = await oracle.recordDurableDecision(
    identity(),
    'receipt-durable'
  );
  const durableWithoutReceipt = cloneEffect(durable);
  durableWithoutReceipt.last_receipt_id = null;
  durableWithoutReceipt.last_receipt_hash = null;
  const durableWithForgedReceiptHash = cloneEffect(durable);
  durableWithForgedReceiptHash.last_receipt_hash =
    sha256('forged-durable-receipt');
  const durableWithFailure = cloneEffect(durable);
  durableWithFailure.failure_code = 'forged-failure';

  await oracle.recordSendAttempted(identity(), 'receipt-send');
  const unknown = await oracle.recordUnknown(identity(), 'receipt-unknown', {
    repair_after_ms: 0
  });
  const unknownWithoutRecovery = cloneEffect(unknown);
  unknownWithoutRecovery.repair_due_at = null;
  const compactedBeforeExhaustion = cloneEffect(unknown);
  compactedBeforeExhaustion.repair_exhausted_at =
    '2026-07-30T00:00:02.000Z';
  compactedBeforeExhaustion.repair_exhaustion_receipt_hash =
    sha256('repair-exhausted');
  compactedBeforeExhaustion.operator_attention_required = true;
  compactedBeforeExhaustion.repair_compacted_at =
    '2026-07-30T00:00:01.000Z';
  const [claimed] = (await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker',
    repair_owner_epoch: '1',
    claim_token_prefix: 'claim',
    claimed_at: new Date('2026-07-30T00:00:00.000Z'),
    lease_until: new Date('2026-07-30T00:00:10.000Z'),
    limit: 1
  })).effects;
  assert.ok(claimed);
  const mismatchedClaimRevision = cloneEffect(claimed);
  mismatchedClaimRevision.repair_claim_revision = addU64(
    claimed.repair_claim_revision!,
    1
  );

  const invalidAuditWindow = cloneEffect(prepared);
  invalidAuditWindow.audit_until = invalidAuditWindow.prepared_at;
  const updatedBeforePrepared = cloneEffect(prepared);
  updatedBeforePrepared.updated_at = '2026-07-29T23:59:59.999Z';

  const terminalStore = new MemoryEffectStore();
  const terminalOracle = testSipEffectOracle({
    store: terminalStore,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  await terminalOracle.prepare(preparedInput());
  const terminal = await terminalOracle.recordFailed(
    identity(),
    'receipt-failed',
    'transport_failed'
  );
  const mismatchedTombstoneReceipt = cloneEffect(terminal);
  mismatchedTombstoneReceipt.last_receipt_id = 'forged-terminal-receipt';
  mismatchedTombstoneReceipt.last_receipt_hash =
    sha256('forged-terminal-receipt');

  for (const invalid of [
    preparedWithReceipt,
    durableWithoutReceipt,
    durableWithForgedReceiptHash,
    durableWithFailure,
    unknownWithoutRecovery,
    compactedBeforeExhaustion,
    mismatchedClaimRevision,
    invalidAuditWindow,
    updatedBeforePrepared,
    mismatchedTombstoneReceipt
  ]) {
    assert.throws(
      () => cloneProtocolEffect(invalid),
      isValidationError
    );
  }
});

test('unknown repair requires non-regressing epochs and an exact live token/revision fence', async () => {
  const store = new MemoryEffectStore();
  let now = new Date('2026-07-30T00:00:00.000Z');
  const oracle = testSipEffectOracle({ store, now: () => new Date(now) });
  const effectIdentity = identity();
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(effectIdentity, 'receipt-durable');
  await oracle.recordSendAttempted(effectIdentity, 'receipt-send');
  await oracle.recordUnknown(effectIdentity, 'receipt-unknown', {
    repair_after_ms: 1
  });
  const batch = await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker-1',
    repair_owner_epoch: '4',
    claim_token_prefix: 'claim-4',
    claimed_at: new Date('2026-07-30T00:00:01.000Z'),
    lease_until: new Date('2026-07-30T00:00:11.000Z'),
    limit: 1
  });
  assert.equal(batch.effects.length, 1);
  const claimed = batch.effects[0]!;
  assert.match(claimed.repair_claim_token!, /:4:\d+$/);
  const fence: EffectRepairFence = {
    repair_owner_id: claimed.repair_owner_id!,
    repair_owner_epoch: claimed.repair_owner_epoch!,
    repair_claim_token: claimed.repair_claim_token!,
    repair_claim_revision: claimed.repair_claim_revision!
  };
  await assert.rejects(
    oracle.reconcile(effectIdentity, {
      ...fence,
      repair_claim_token: 'stale-token'
    }, {
      receipt_id: 'receipt-reconciled',
      outcome: 'protocol_observed'
    }),
    isFenceLost
  );
  now = new Date('2026-07-30T00:00:12.000Z');
  await assert.rejects(
    oracle.reconcile(effectIdentity, fence, {
      receipt_id: 'receipt-reconciled',
      outcome: 'protocol_observed'
    }),
    isFenceLost
  );
  assert.equal((await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker-2',
    repair_owner_epoch: '4',
    claim_token_prefix: 'claim-repeat',
    claimed_at: now,
    lease_until: new Date('2026-07-30T00:00:22.000Z'),
    limit: 1
  })).effects.length, 0);
  const reclaimed = await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker-2',
    repair_owner_epoch: '5',
    claim_token_prefix: 'claim-5',
    claimed_at: now,
    lease_until: new Date('2026-07-30T00:00:22.000Z'),
    limit: 1
  });
  const live = reclaimed.effects[0]!;
  assert.notEqual(live.repair_claim_token, claimed.repair_claim_token);
  now = new Date('2026-07-30T00:00:13.000Z');
  const reconciled = await oracle.reconcile(effectIdentity, {
    repair_owner_id: live.repair_owner_id!,
    repair_owner_epoch: live.repair_owner_epoch!,
    repair_claim_token: live.repair_claim_token!,
    repair_claim_revision: live.repair_claim_revision!
  }, {
    receipt_id: 'receipt-reconciled',
    outcome: 'protocol_observed'
  });
  assert.equal(reconciled.state, 'protocol_observed');
});

test('unknown effects never expose wire bytes through the normal retransmit path', async () => {
  const store = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const effectIdentity = identity();
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(effectIdentity, 'receipt-durable');
  await oracle.recordSendAttempted(effectIdentity, 'receipt-send');
  assert.deepEqual(
    await oracle.wireBytesForRetransmission(effectIdentity),
    ORIGINAL_WIRE_BYTES
  );
  await oracle.recordUnknown(effectIdentity, 'receipt-unknown', {
    repair_after_ms: 0
  });

  await assert.rejects(
    oracle.wireBytesForRetransmission(effectIdentity),
    isFenceLost
  );
  const [claimed] = (await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker',
    repair_owner_epoch: '1',
    claim_token_prefix: 'claim',
    claimed_at: new Date('2026-07-30T00:00:00.000Z'),
    lease_until: new Date('2026-07-30T00:00:10.000Z'),
    limit: 1
  })).effects;
  assert.ok(claimed);
  await assert.rejects(
    oracle.wireBytesForRetransmission(effectIdentity),
    isFenceLost
  );
});

test('repair exhaustion is finite, operator-visible, auditable and compactable', async () => {
  const store = new MemoryEffectStore();
  let now = new Date('2026-07-30T00:00:00.000Z');
  const oracle = testSipEffectOracle({ store, now: () => new Date(now) });
  const effectIdentity = identity();
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(effectIdentity, 'receipt-durable');
  await oracle.recordSendAttempted(effectIdentity, 'receipt-send');
  await oracle.recordUnknown(effectIdentity, 'receipt-unknown');

  for (let epoch = 1; epoch <= 8; epoch += 1) {
    now = new Date(`2026-07-30T00:00:${String(epoch).padStart(2, '0')}.000Z`);
    const batch = await oracle.claimRepairBatch({
      tenant_id: 'tenant-a',
      repair_owner_id: 'repair-worker',
      repair_owner_epoch: String(epoch),
      claim_token_prefix: `claim-${epoch}`,
      claimed_at: now,
      lease_until: new Date(now.getTime() + 5_000),
      limit: 1
    });
    assert.equal(batch.effects.length, 1);
    const claimed = batch.effects[0]!;
    await oracle.releaseRepairClaim({
      identity: effectIdentity,
      fence: fenceFrom(claimed),
      next_repair_at: now
    });
  }
  now = new Date('2026-07-30T00:00:20.000Z');
  const exhausted = await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker',
    repair_owner_epoch: '9',
    claim_token_prefix: 'claim-9',
    claimed_at: now,
    lease_until: new Date(now.getTime() + 5_000),
    limit: 1
  });
  assert.deepEqual(exhausted, { effects: [], exhausted_count: 1 });
  const record = (await oracle.query(effectIdentity))!;
  assert.equal(record.operator_attention_required, true);
  assert.match(record.repair_exhaustion_receipt_hash!, /^[a-f0-9]{64}$/);
  assert.ok(record.repair_exhausted_at);
  assert.deepEqual(await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker',
    repair_owner_epoch: '10',
    claim_token_prefix: 'claim-10',
    claimed_at: now,
    lease_until: new Date(now.getTime() + 5_000),
    limit: 1
  }), { effects: [], exhausted_count: 0 });
  assert.equal(await oracle.compactExhaustedRepairs({
    tenant_id: 'tenant-a',
    cutoff: now,
    limit: 1
  }), 1);
  assert.ok((await oracle.query(effectIdentity))!.repair_compacted_at);
});

test('bounded queue and metrics keep O(1), low-cardinality repair units', async () => {
  const queue = new BoundedEffectQueue<number>(2);
  queue.enqueue(1);
  queue.enqueue(2);
  assert.throws(
    () => queue.enqueue(3),
    (error: unknown) =>
      error instanceof SipEffectError && error.code === 'sip_effect_queue_full'
  );
  assert.equal(queue.dequeue(), 1);
  queue.enqueue(3);
  assert.deepEqual([queue.dequeue(), queue.dequeue(), queue.dequeue()], [2, 3, undefined]);

  const metrics = new SipEffectMetricBook();
  const oracle = testSipEffectOracle({
    store: new MemoryEffectStore(),
    metrics,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(identity(), 'receipt-durable');
  await oracle.recordSendAttempted(identity(), 'receipt-send');
  await oracle.recordUnknown(identity(), 'receipt-unknown');
  await oracle.claimRepairBatch({
    tenant_id: 'tenant-a',
    repair_owner_id: 'worker',
    repair_owner_epoch: '1',
    claim_token_prefix: 'claim',
    claimed_at: new Date('2026-07-30T00:00:01.000Z'),
    lease_until: new Date('2026-07-30T00:00:11.000Z'),
    limit: 1
  });
  const snapshot = metrics.snapshot();
  assert.ok(snapshot.repairs.some((entry) =>
    entry.result === 'claimed' && entry.unit === 'batches' && entry.count === 1
  ));
  assert.ok(snapshot.repairs.some((entry) =>
    entry.result === 'claimed' && entry.unit === 'effects' && entry.count === 1
  ));
  assert.equal(JSON.stringify(snapshot).includes('tenant-a'), false);
  assert.equal(JSON.stringify(snapshot).includes('effect-1'), false);
});

test('store failures map to a deterministic closed SIP 503 Retry-After contract', () => {
  const maximum = {
    failure_code: 'store_timeout' as const,
    pool_wait_ms: 250,
    queue_depth: 1024,
    retry_attempt: 3
  };
  assert.deepEqual(createStoreFailureSip503(maximum), {
    failure_code: 'store_timeout',
    sip_status: 503,
    retry_after_seconds: 9
  });
  for (const invalid of [
    { ...maximum, failure_code: 'provider_timeout' },
    { ...maximum, pool_wait_ms: 251 },
    { ...maximum, queue_depth: 1025 },
    { ...maximum, retry_attempt: 4 },
    { ...maximum, retry_attempt: 1.5 },
    { ...maximum, queue_depth: '1' }
  ]) {
    assert.throws(
      () => createStoreFailureSip503(invalid as never),
      (error: unknown) =>
        error instanceof SipEffectError &&
        error.code === 'sip_effect_retry_after_input_invalid' &&
        !('retry_after_seconds' in error.details)
    );
  }
});

test('Postgres atomic boundary fails closed before any untyped domain writer can run', async () => {
  const metadata = boundaryMetadata('call_admission');
  const pool = new UnexpectedConnectPool();
  const store = new PostgresEffectStore(pool as PgQueryable);

  await assert.rejects(
    store.runAtomicBoundary(metadata),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_schema_incompatible' &&
      error.details.reason === 'atomic_domain_writes_not_wired_not_production'
  );
  assert.equal(pool.connected, false);
});

test('Postgres atomic boundary stays unavailable for caller-owned clients', async () => {
  const client = new CallerOwnedTransactionClient();
  const store = new PostgresEffectStore(client);

  await assert.rejects(
    store.runAtomicBoundary(boundaryMetadata('call_admission')),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_schema_incompatible' &&
      error.details.reason === 'atomic_domain_writes_not_wired_not_production'
  );

  assert.equal(client.domainWriteSurvived, false);
});

test('Postgres effect transitions reject caller-owned clients before receipt writes', async () => {
  const memory = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store: memory,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(identity(), 'receipt-durable');
  const current = await oracle.recordSendAttempted(identity(), 'receipt-send');
  const client = new CallerOwnedEffectClient(effectRow(current));
  const store = new PostgresEffectStore(client);
  const receiptId = 'receipt-observed';
  const transition: EffectTransition = {
    identity: identity(),
    receipt_id: receiptId,
    receipt_hash: canonicalSipEffectHash({
      identity: identity(),
      receipt_id: receiptId,
      level: 'protocol_observed',
      failure_code: '',
      repair_delay_ms: null
    }),
    level: 'protocol_observed',
    allowed_from: ['send_attempted', 'transport_accepted'],
    observed_at: '2026-07-30T00:00:01.000Z',
    failure_code: '',
    repair_delay_ms: null,
    terminal: true,
    repair_fence: null
  };

  await assert.rejects(
    store.transition(transition),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_schema_incompatible'
  );
  assert.equal(client.orphanReceiptCommitted, false);
});

test('atomic metadata, typed receipts and canonical boundary hashes are closed and deterministic', () => {
  const left = callAdmissionResult();
  const right = callAdmissionResult();
  left.writes[0]!.payload = { z: 2, nested: { b: true, a: 'x' } };
  right.writes[0]!.payload = { nested: { a: 'x', b: true }, z: 2 };
  const first = createAtomicBoundaryCommit(
    boundaryMetadata('call_admission'),
    left
  );
  const second = createAtomicBoundaryCommit(
    boundaryMetadata('call_admission'),
    right
  );
  assert.equal(first.facts_hash, second.facts_hash);
  assert.equal(first.boundary_hash, second.boundary_hash);
  assert.match(
    JSON.stringify(first.facts[0]!.payload),
    /"receipt_id":"receipt-call_session"/
  );

  assert.throws(
    () => createAtomicBoundaryCommit({
      ...boundaryMetadata('call_admission'),
      surprise: true
    } as never, callAdmissionResult()),
    isValidationError
  );
  assert.throws(
    () => createAtomicBoundaryCommit(
      boundaryMetadata('call_admission'),
      {
        ...callAdmissionResult(),
        writes: [
          {
            ...callAdmissionResult().writes[0]!,
            surprise: true
          } as never,
          ...callAdmissionResult().writes.slice(1)
        ]
      }
    ),
    isValidationError
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => createAtomicBoundaryCommit(
      boundaryMetadata('call_admission'),
      {
        ...callAdmissionResult(),
        writes: [
          {
            ...callAdmissionResult().writes[0]!,
            payload: circular as never
          },
          ...callAdmissionResult().writes.slice(1)
        ]
      }
    ),
    isValidationError
  );
  for (const invalidPayload of [null, true, 1, 'text', []]) {
    assert.throws(
      () => createAtomicBoundaryCommit(
        boundaryMetadata('call_admission'),
        {
          ...callAdmissionResult(),
          writes: [
            {
              ...callAdmissionResult().writes[0]!,
              payload: invalidPayload
            } as never,
            ...callAdmissionResult().writes.slice(1)
          ]
        }
      ),
      (error: unknown) =>
        error instanceof SipEffectError &&
        error.code === 'sip_effect_boundary_facts_invalid'
    );
  }
});

test('bridge-head boundary facts require an explicit successful revision/epoch/state CAS', () => {
  assert.throws(
    () => createAtomicBoundaryCommit(boundaryMetadata('bridge_head'), {
      boundary_kind: 'bridge_head',
      writes: [
        writeReceipt('bridge_command'),
        writeReceipt('bridge_decision'),
        writeReceipt('bridge_receipt'),
        {
          ...writeReceipt('head_compare_and_swap'),
          expected_revision: '9',
          committed_revision: '11',
          expected_owner_epoch: '3',
          committed_owner_epoch: '3',
          expected_state: 'prepared',
          committed_state: 'committed',
          cas_applied: true
        }
      ]
    }),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'sip_effect_boundary_facts_invalid'
  );
});

test('Postgres admission is bounded and every transaction installs timeout and schema gates', async () => {
  const pg = new BlockingPg();
  const metrics = new SipEffectMetricBook();
  const store = new PostgresEffectStore(pg, {
    max_in_flight: 1,
    max_queue_depth: 1,
    pool_wait_timeout_ms: 250,
    metrics
  });
  const first = store.query(identity());
  await pg.waitUntilBlocked(1);
  const second = store.query(identity());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    store.query(identity()),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_pool_exhausted' &&
      error.retryable &&
      error.details.queue_depth === 1
  );
  pg.releaseOne();
  await first;
  await pg.waitUntilBlocked(2);
  pg.releaseOne();
  await second;
  assert.ok(pg.queries.some((query) =>
    /SET LOCAL statement_timeout = '250ms'/.test(query.text)
  ));
  assert.ok(pg.queries.some((query) =>
    /SET LOCAL lock_timeout = '250ms'/.test(query.text)
  ));
  assert.ok(pg.queries.some((query) =>
    /ivekit_assert_sip_effect_writer/.test(query.text) &&
    query.params.includes(SIP_EFFECT_SCHEMA_ID) &&
    query.params.includes(SIP_EFFECT_SCHEMA_VERSION) &&
    query.params.includes(SIP_EFFECT_SCHEMA_HASH)
  ));
  assert.ok(pg.queries.some((query) =>
    /set_config\(\s*'app\.sip_effect_writer_identity'/.test(query.text)
  ));
  const tenant = pg.queries.findIndex((query) =>
    /set_config\('app\.current_tenant'/.test(query.text)
  );
  const statementTimeout = pg.queries.findIndex((query) =>
    /SET LOCAL statement_timeout/.test(query.text)
  );
  const lockTimeout = pg.queries.findIndex((query) =>
    /SET LOCAL lock_timeout/.test(query.text)
  );
  const searchPath = pg.queries.findIndex((query) =>
    /SET LOCAL search_path = pg_catalog, public, pg_temp/.test(query.text)
  );
  const role = pg.queries.findIndex((query) =>
    /SET LOCAL ROLE opc_sip_effect_executor/.test(query.text)
  );
  const writerIdentity = pg.queries.findIndex((query) =>
    /set_config\(\s*'app\.sip_effect_writer_identity'/.test(query.text)
  );
  const election = pg.queries.findIndex((query) =>
    /ivekit_assert_sip_effect_writer/.test(query.text)
  );
  assert.ok(
    tenant >= 0 &&
    tenant < statementTimeout &&
    statementTimeout < lockTimeout &&
    lockTimeout < searchPath &&
    searchPath < role &&
    role < writerIdentity &&
    writerIdentity < election
  );
  assert.equal(metrics.snapshot().queue_depth.current, 0);
  assert.equal(metrics.snapshot().queue_depth.high_watermark, 1);
});

test('Postgres pool acquisition has a hard 250ms deadline when connect never settles', async () => {
  const pool = stalledConnectPool();
  const store = new PostgresEffectStore(pool);

  const error = await expectSipEffectRejection(
    store.query(identity()),
    'store_pool_exhausted',
    500
  );
  assert.equal(error.retryable, true);
  assert.equal(error.status, 503);
  assert.equal(pool.connectCount, 1);
});

test('Postgres pool acquisition releases a client that arrives after its deadline', async () => {
  const deferred = new DeferredConnections();
  const pool = new TestConnectPool(() => deferred.connect());
  const store = singlePermitStore(pool);
  const operation = store.query(identity());

  await expectSipEffectRejection(operation, 'store_pool_exhausted');

  const lateClient = new TestPoolClient();
  deferred.resolveNext(lateClient);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateClient.releaseCount, 1);
  assert.equal(lateClient.queries.length, 0);
});

test('Postgres retains admission when a late client has no data release method', async () => {
  const deferred = new DeferredConnections();
  const pool = new TestConnectPool(() => deferred.connect());
  const store = singlePermitStore(pool);

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  deferred.resolveNext({
    query: async () => emptyQueryResult()
  });
  await new Promise((resolve) => setImmediate(resolve));

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  assert.equal(pool.connectCount, 1);
});

test('Postgres retains admission when a late client release throws', async () => {
  const deferred = new DeferredConnections();
  const pool = new TestConnectPool(() => deferred.connect());
  const store = singlePermitStore(pool);

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  const lateClient = new TestPoolClient(new Error('physical release failed'));
  deferred.resolveNext(lateClient);
  await new Promise((resolve) => setImmediate(resolve));

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  assert.equal(lateClient.releaseCount, 1);
  assert.equal(pool.connectCount, 1);
});

test('Postgres assimilates a hostile multi-callback connect thenable exactly once', async () => {
  const client = new TestPoolClient();
  const pool = new TestConnectPool(() => ({
    then(
      resolve: (value: TestPoolClient) => void,
      reject: (error: unknown) => void
    ): void {
      resolve(client);
      resolve(client);
      reject(new Error('hostile extra rejection'));
    }
  }));
  const store = singlePermitStore(pool, 20);

  assert.equal(await store.query(identity()), null);
  assert.equal(pool.connectCount, 1);
  assert.equal(client.releaseCount, 1);
});

test('Postgres rejects an early client without query before BEGIN and releases it', async () => {
  let releaseCount = 0;
  const client = {
    release(): void {
      releaseCount += 1;
    }
  };
  const pool = new TestConnectPool(() => Promise.resolve(client));
  const store = singlePermitStore(pool, 20);

  await expectSipEffectRejection(
    store.query(identity()),
    'store_schema_incompatible'
  );
  assert.equal(releaseCount, 1);
});

test('Postgres rejects an early client without release before BEGIN and retains admission', async () => {
  const client = new MissingReleaseClient();
  const pool = new TestConnectPool(() => Promise.resolve(client));
  const store = singlePermitStore(pool);

  await expectSipEffectRejection(
    store.query(identity()),
    'store_schema_incompatible'
  );
  assert.equal(client.queryCount, 0);

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  assert.equal(pool.connectCount, 1);
});

test('Postgres release failure cannot override COMMIT and retains admission', async () => {
  const client = new TestPoolClient(new Error('physical release failed'));
  const pool = new TestConnectPool(() => Promise.resolve(client));
  const store = singlePermitStore(pool);

  assert.equal(await store.query(identity()), null);
  assert.equal(client.releaseCount, 1);
  assert.ok(client.queries.includes('COMMIT'));

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  assert.equal(pool.connectCount, 1);
  assert.equal(client.releaseCount, 1);
});

test('Postgres admission queue and connect share one monotonic pool wait deadline', async () => {
  const pool = new QueueThenStallPool();
  const store = new PostgresEffectStore(pool, {
    max_in_flight: 1,
    max_queue_depth: 1,
    pool_wait_timeout_ms: 200
  });
  const first = store.query(identity());
  await pool.waitUntilFirstQueryBlocks();
  const second = store.query(identity());

  await new Promise((resolve) => setTimeout(resolve, 80));
  pool.releaseFirstQuery();
  await first;
  const error = await expectSipEffectRejection(
    second,
    'store_pool_exhausted',
    160
  );
  assert.equal(error.details.pool_wait_ms, 200);
  assert.ok(error.details.pool_wait_ms >= 0);
  assert.ok(error.details.pool_wait_ms <= 250);
  assert.equal(pool.connectCount, 2);
});

test('Postgres late connect rejection restores exactly one admission permit', async () => {
  const deferred = new DeferredConnections();
  const pool = new TestConnectPool(() => deferred.connect());
  const store = singlePermitStore(pool, 200);

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted', 300);
  const second = store.query(identity());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.connectCount, 1);

  deferred.rejectNext(new Error('late connection rejected'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.connectCount, 2);
  deferred.rejectNext(new Error('next connection rejected'));
  await assert.rejects(second);
  assert.equal(pool.connectCount, 2);
});

test('Postgres default concurrency cannot bypass the pool acquisition deadline', async () => {
  const pool = stalledConnectPool();
  const store = new PostgresEffectStore(pool);
  const operations = Array.from(
    { length: 24 },
    () => store.query(identity())
  );

  const outcome = await settleWithin(Promise.allSettled(operations), 500);

  assert.equal(outcome.status, 'resolved');
  assert.equal(pool.connectCount, 24);
  if (outcome.status !== 'resolved') return;
  assert.equal(outcome.value.length, 24);
  for (const result of outcome.value) {
    assert.equal(result.status, 'rejected');
    assert.ok(
      result.status === 'rejected' &&
      result.reason instanceof SipEffectError &&
      result.reason.code === 'store_pool_exhausted'
    );
  }
});

test('Postgres timed-out connects retain admission capacity until the pool settles', async () => {
  const pool = stalledConnectPool();
  const store = singlePermitStore(pool);

  await expectSipEffectRejection(store.query(identity()), 'store_pool_exhausted');
  const queued = settleWithin(store.query(identity()), 100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.connectCount, 1);
  assert.equal((await queued).status, 'rejected');
  assert.equal(pool.connectCount, 1);
});

test('Postgres pool deadline exposes bounded low-cardinality Retry-After facts', async () => {
  const pool = stalledConnectPool();
  const store = new PostgresEffectStore(pool, {
    pool_wait_timeout_ms: 7
  });

  const outcome = await settleWithin(store.query(identity()), 100);

  assert.equal(outcome.status, 'rejected');
  if (outcome.status !== 'rejected') return;
  assert.ok(outcome.error instanceof SipEffectError);
  if (!(outcome.error instanceof SipEffectError)) return;
  assert.equal(outcome.error.code, 'store_pool_exhausted');
  assert.deepEqual(outcome.error.details, {
    pool_wait_ms: 7,
    queue_depth: 0,
    retry_attempt: 0
  });
  assert.equal(Object.isFrozen(outcome.error.details), true);
  assert.deepEqual(createStoreFailureSip503({
    failure_code: outcome.error.code,
    pool_wait_ms: outcome.error.details.pool_wait_ms,
    queue_depth: outcome.error.details.queue_depth,
    retry_attempt: outcome.error.details.retry_attempt
  }), {
    failure_code: 'store_pool_exhausted',
    sip_status: 503,
    retry_after_seconds: 2
  });
});

test('Postgres repair SQL is tenant-scoped, bounded, token/revision fenced and never regresses epoch', async () => {
  const pg = new RecordingPg();
  const store = new PostgresEffectStore(pg);
  await assert.rejects(
    Promise.resolve().then(() => store.claimUnknownForRepair({
      tenant_id: 'tenant-a',
      repair_owner_id: 'repair-worker-1',
      repair_owner_epoch: '1',
      claim_token_prefix: 'claim-too-long',
      claimed_at: new Date('2026-07-30T00:00:00.000Z'),
      lease_until: new Date('2026-07-30T00:00:30.001Z'),
      limit: 1
    })),
    isValidationError
  );
  assert.deepEqual(await store.claimUnknownForRepair({
    tenant_id: 'tenant-a',
    repair_owner_id: 'repair-worker-1',
    repair_owner_epoch: MAX_U64,
    claim_token_prefix: 'claim-max',
    claimed_at: new Date('2026-07-30T00:00:00.000Z'),
    lease_until: new Date('2026-07-30T00:00:10.000Z'),
    limit: 100
  }), { effects: [], exhausted_count: 0 });
  const sql = pg.queries.find((query) => query.text.includes('claim-repair'))!;
  assert.match(sql.text, /tenant_id\s*=\s*\$1/);
  assert.match(sql.text, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql.text, /LIMIT \$\d+/);
  assert.match(sql.text, /repair_epoch_high_watermark\s*<\s*\$\d+/);
  assert.match(sql.text, /repair_claim_token/);
  assert.match(sql.text, /repair_claim_revision/);
  assert.match(sql.text, /repair_attempts < 8/);
  assert.match(sql.text, /repair_due_at\s*<=\s*statement_timestamp\(\)/);
  assert.match(
    sql.text,
    /repair_lease_until\s*<=\s*statement_timestamp\(\)/
  );
  assert.doesNotMatch(sql.text, /clock_timestamp\(\)/);
  assert.match(sql.text, /owner_epoch::text AS owner_epoch/);
  assert.match(sql.text, /revision::text AS revision/);
  assert.equal(sql.params.includes(MAX_U64), true);
  assert.equal(
    sql.params.includes('2026-07-30T00:00:00.000Z'),
    false
  );

  await assert.rejects(
    store.releaseRepairClaim({
      identity: identity(),
      fence: {
        repair_owner_id: 'worker',
        repair_owner_epoch: '8',
        repair_claim_token: 'token',
        repair_claim_revision: '9'
      },
      released_at: new Date('2026-07-30T00:00:01.000Z'),
      next_repair_at: new Date('2026-07-30T00:00:02.000Z')
    }),
    isFenceLost
  );
  const release = pg.queries.find((query) => query.text.includes('release-repair'))!;
  assert.match(release.text, /repair_owner_id = \$\d+/);
  assert.match(release.text, /repair_owner_epoch = \$\d+/);
  assert.match(release.text, /repair_claim_token = \$\d+/);
  assert.match(release.text, /repair_claim_revision = \$\d+/);
  assert.match(release.text, /effect_identity_hash = \$\d+/);
  assert.equal(
    release.params.includes(protocolEffectIdentityHash(identity())),
    true
  );
  assert.match(release.text, /repair_lease_until > statement_timestamp\(\)/);
  assert.match(release.text, /repair_due_at = statement_timestamp\(\)/);
  assert.match(release.text, /updated_at = statement_timestamp\(\)/);
  assert.doesNotMatch(release.text, /clock_timestamp\(\)/);
});

test('Postgres repair exhaustion hash binds the committed high-watermark epoch', async () => {
  const memory = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store: memory,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(identity(), 'receipt-durable');
  await oracle.recordSendAttempted(identity(), 'receipt-send');
  await oracle.recordUnknown(identity(), 'receipt-unknown');
  const exhausted = cloneEffect((await oracle.query(identity()))!);
  exhausted.repair_attempts = 8;
  exhausted.repair_epoch_high_watermark = '8';

  const pg = new ExhaustedRepairPg(effectRow(exhausted));
  const store = new PostgresEffectStore(pg);
  assert.deepEqual(await store.claimUnknownForRepair({
    tenant_id: exhausted.tenant_id,
    repair_owner_id: 'repair-worker-9',
    repair_owner_epoch: '9',
    claim_token_prefix: 'claim-9',
    claimed_at: new Date('2026-07-30T00:00:09.000Z'),
    lease_until: new Date('2026-07-30T00:00:19.000Z'),
    limit: 1
  }), { effects: [], exhausted_count: 1 });

  const update = pg.queries.find((query) =>
    query.text.includes('exhaust-repair-update')
  )!;
  assert.equal(
    update.params.includes(canonicalSipEffectHash({
      tenant_id: exhausted.tenant_id,
      protocol_effect_id: exhausted.protocol_effect_id,
      repair_attempts: 8,
      repair_epoch_high_watermark: '9'
    })),
    true
  );
});

test('Postgres transitions bind repair delay and use database clock authority', async () => {
  const memory = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store: memory,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  await oracle.prepare(preparedInput());
  await oracle.recordDurableDecision(identity(), 'receipt-durable');
  const current = await oracle.recordSendAttempted(
    identity(),
    'receipt-send'
  );
  const pg = new TransitionCapturePg(effectRow(current));
  const store = new PostgresEffectStore(pg);
  const receiptId = 'receipt-unknown-db-clock';
  const repairDelayMs = 1_234;

  await assert.rejects(
    store.transition({
      identity: identity(),
      receipt_id: receiptId,
      receipt_hash: canonicalSipEffectHash({
        identity: identity(),
        receipt_id: receiptId,
        level: 'unknown',
        failure_code: '',
        repair_delay_ms: repairDelayMs
      }),
      level: 'unknown',
      allowed_from: ['send_attempted', 'transport_accepted'],
      observed_at: '2000-01-01T00:00:00.000Z',
      failure_code: '',
      repair_delay_ms: repairDelayMs,
      terminal: false,
      repair_fence: null
    }),
    isFenceLost
  );

  const receipt = pg.queries.find((query) =>
    query.text.includes('receipt-insert')
  )!;
  assert.match(receipt.text, /repair_delay_ms,\s*observed_at/);
  assert.match(receipt.text, /statement_timestamp\(\)/);
  assert.equal(receipt.params.includes(repairDelayMs), true);
  assert.equal(
    receipt.params.includes('2000-01-01T00:00:00.000Z'),
    false
  );
  const update = pg.queries.find((query) =>
    query.text.includes('transition-update')
  )!;
  assert.match(update.text, /last_receipt_repair_delay_ms = \$14/);
  assert.match(
    update.text,
    /repair_due_at = CASE[\s\S]*statement_timestamp\(\)/
  );
  assert.match(
    update.text,
    /terminal_at = CASE[\s\S]*statement_timestamp\(\)/
  );
  assert.match(update.text, /updated_at = statement_timestamp\(\)/);
  assert.doesNotMatch(update.text, /clock_timestamp\(\)/);
});

test('Postgres NUMERIC uint64 values decode only from canonical decimal strings', async () => {
  const memory = new MemoryEffectStore();
  const oracle = testSipEffectOracle({
    store: memory,
    now: () => new Date('2026-07-30T00:00:00.000Z')
  });
  const input = preparedInput({
    owner_epoch: MAX_U64,
    command_sequence: MAX_U64
  });
  const fresh = (await oracle.prepare(input)).effect;
  const replay = await new PostgresEffectStore(
    new PreparedReplayPg(effectRow(fresh))
  ).prepare(fresh);
  assert.equal(replay.effect.owner_epoch, MAX_U64);
  assert.equal(replay.effect.command_sequence, MAX_U64);
  assert.equal(replay.effect.revision, '1');

  const numericRow = effectRow(fresh);
  numericRow.owner_epoch = Number.MAX_SAFE_INTEGER;
  await assert.rejects(
    new PostgresEffectStore(new PreparedReplayPg(numericRow)).prepare(fresh),
    (error: unknown) =>
      error instanceof SipEffectError &&
      error.code === 'store_schema_incompatible'
  );
});

test('migration 107 remains immutable while v2 and stale recovery expand additively', async () => {
  const migrationUrl = new URL(
    '../src/migrations/107_ivekit_sip_effect_oracle.sql',
    import.meta.url
  );
  const migration = await readFile(migrationUrl, 'utf8');
  const transportCompletedMigration = await readFile(
    new URL(
      '../src/migrations/113_converact_sip_effect_transport_completed.sql',
      import.meta.url
    ),
    'utf8'
  );
  const transportCompletedValidation = await readFile(
    new URL(
      '../src/migrations/114_converact_sip_effect_transport_completed_validate.sql',
      import.meta.url
    ),
    'utf8'
  );
  const staleNonterminalRecovery = await readFile(
    new URL(
      '../src/migrations/115_converact_sip_effect_stale_nonterminal_recovery.sql',
      import.meta.url
    ),
    'utf8'
  );
  const projection = await readFile(
    new URL(
      '../src/agent-runtime/converact/voice/sip-foundation/migrations/001_effect_oracle.sql',
      import.meta.url
    ),
    'utf8'
  );
  const sqliteProjection = await readFile(
    new URL('../src/schema.sql', import.meta.url),
    'utf8'
  );
  for (const table of [
    'ivekit_sip_protocol_effects',
    'ivekit_sip_effect_receipts',
    'ivekit_sip_durable_boundaries',
    'ivekit_sip_durable_boundary_facts'
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sqliteProjection, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.doesNotMatch(projection, /\bCREATE TABLE\b/i);
  assert.match(projection, /107_ivekit_sip_effect_oracle\.sql/);
  assert.match(migration, /owner_epoch NUMERIC\(20,\s*0\)/);
  assert.match(migration, /command_sequence NUMERIC\(20,\s*0\)/);
  assert.match(migration, /repair_epoch_high_watermark NUMERIC\(20,\s*0\)/);
  assert.match(migration, /repair_claim_token/);
  assert.match(migration, /repair_claim_revision NUMERIC\(20,\s*0\)/);
  assert.match(migration, /last_receipt_repair_delay_ms INTEGER/);
  assert.match(migration, /repair_delay_ms INTEGER/);
  assert.match(migration, /uq_ivekit_sip_effect_active_repair_token/);
  assert.match(migration, /ivekit_assert_sip_effect_writer/);
  assert.match(migration, /activation_receipt_id TEXT/);
  assert.match(
    migration,
    /enabled BOOLEAN NOT NULL DEFAULT FALSE/
  );
  const sqliteSchemaRegistry = sqliteProjection.slice(
    sqliteProjection.indexOf(
      'CREATE TABLE IF NOT EXISTS ivekit_sip_effect_schema_registry'
    ),
    sqliteProjection.indexOf(
      'CREATE TABLE IF NOT EXISTS ivekit_sip_effect_writer_registry'
    )
  );
  assert.match(
    sqliteSchemaRegistry,
    /CHECK \(\s*enabled = 0 OR\s*\(activation_receipt_id IS NOT NULL AND activated_at IS NOT NULL\)\s*\)/
  );
  assert.match(
    migration,
    /CREATE TRIGGER ivekit_sip_effect_writer_guard[\s\S]*ivekit_sip_protocol_effects/
  );
  assert.match(
    migration,
    /CREATE TRIGGER ivekit_sip_receipt_writer_guard[\s\S]*ivekit_sip_effect_receipts/
  );
  assert.match(
    migration,
    /CREATE TRIGGER ivekit_sip_effect_identity_immutable/
  );
  assert.match(migration, /illegal SIP effect state transition/);
  assert.match(migration, /SIP effect receipt was not applied atomically/);
  assert.match(
    migration,
    /octet_length\(fact_payload::text\) <= 65536/
  );
  assert.match(
    migration,
    /jsonb_typeof\(fact_payload\) = 'object'/
  );
  assert.match(migration, /schema_version IN \(1,\s*2\)/);
  assert.match(migration, new RegExp(SIP_EFFECT_SCHEMA_V1_HASH));
  assert.doesNotMatch(migration, /transport_completed/);
  assert.match(transportCompletedMigration, new RegExp(SIP_EFFECT_SCHEMA_HASH));
  assert.match(transportCompletedMigration, /transport_completed/);
  assert.match(transportCompletedMigration, /compatibility_slot[^;]*'N\+1'/s);
  assert.match(transportCompletedMigration, /enabled\)\s*VALUES[\s\S]*FALSE/);
  assert.doesNotMatch(
    transportCompletedMigration,
    /UPDATE\s+ivekit_sip_protocol_effects\s+SET/i
  );
  assert.doesNotMatch(transportCompletedMigration, /VALIDATE CONSTRAINT/);
  for (const constraint of [
    'ivekit_sip_protocol_effects_state_v2_check',
    'ivekit_sip_protocol_effects_terminal_v2_check',
    'ivekit_sip_effect_receipts_level_v2_check',
    'ivekit_sip_effect_receipts_transition_v2_check'
  ]) {
    assert.match(
      transportCompletedValidation,
      new RegExp(`VALIDATE CONSTRAINT ${constraint}`)
    );
  }
  assert.doesNotMatch(transportCompletedValidation, /DROP CONSTRAINT|UPDATE\s/i);
  assert.match(staleNonterminalRecovery, /idx_ivekit_sip_effect_stale_nonterminal/);
  assert.match(staleNonterminalRecovery, /protocol_session_id/);
  assert.match(staleNonterminalRecovery, /protocol_session_generation/);
  assert.match(staleNonterminalRecovery, /updated_at/);
  assert.match(
    staleNonterminalRecovery,
    /WHERE state IN \('send_attempted', 'transport_accepted'\)/
  );
  assert.doesNotMatch(staleNonterminalRecovery, /UPDATE\s+ivekit_sip_protocol_effects/i);
  assert.match(
    migration,
    /GRANT USAGE ON SCHEMA public TO opc_sip_effect_executor/
  );
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON[\s\S]*ivekit_sip_protocol_effects[\s\S]*FROM PUBLIC, opc_sip_effect_executor/
  );
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON[\s\S]*ivekit_sip_protocol_effects[\s\S]*FROM opc_runtime/
  );
  assert.match(
    migration,
    /GRANT UPDATE \([\s\S]*state,[\s\S]*updated_at[\s\S]*\) ON ivekit_sip_protocol_effects TO opc_sip_effect_executor/
  );
  assert.match(
    migration,
    /GRANT INSERT ON\s+ivekit_sip_protocol_effects,\s+ivekit_sip_effect_receipts\s+TO opc_sip_effect_executor/
  );
  assert.doesNotMatch(
    migration,
    /GRANT INSERT ON[\s\S]{0,240}ivekit_sip_durable_boundar(?:ies|y_facts)[\s\S]{0,120}TO opc_sip_effect_executor/
  );
  assert.doesNotMatch(
    migration,
    /GRANT (?:DELETE|TRUNCATE|REFERENCES|TRIGGER) ON[\s\S]*TO opc_sip_effect_executor/
  );
  assert.match(
    migration,
    /current_user <> 'opc_sip_effect_executor'[\s\S]*session_user <> 'opc_runtime'/
  );
  for (const column of [
    'protocol_session_id',
    'protocol_session_generation',
    'adapter_identity_hash',
    'wire_attempt_facts_hash',
    'wire_freeze_sha256',
    'effect_identity_hash'
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
    assert.match(sqliteProjection, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /WHERE state = 'unknown' AND operator_attention_required = FALSE/);
  assert.match(migration, /WHERE operator_attention_required = TRUE/);
  assert.match(migration, /WHERE terminal_at IS NOT NULL AND payload_retained = TRUE/);

  const plan = readPostgresMigrationPlan(new URL('../src/migrations', import.meta.url).pathname);
  const sipEffectMigration = plan.find((entry) => entry.file === '107_ivekit_sip_effect_oracle.sql');
  const transportCompletedEntry = plan.find((entry) =>
    entry.file === '113_converact_sip_effect_transport_completed.sql'
  );
  const transportCompletedValidationEntry = plan.find((entry) =>
    entry.file === '114_converact_sip_effect_transport_completed_validate.sql'
  );
  const staleNonterminalRecoveryEntry = plan.find((entry) =>
    entry.file === '115_converact_sip_effect_stale_nonterminal_recovery.sql'
  );
  assert.ok(sipEffectMigration);
  assert.ok(transportCompletedEntry);
  assert.ok(transportCompletedValidationEntry);
  assert.ok(staleNonterminalRecoveryEntry);
  const runner = new MigrationRecorder();
  await runPostgresMigrationsOnClient(
    runner,
    [
      sipEffectMigration,
      transportCompletedEntry,
      transportCompletedValidationEntry,
      staleNonterminalRecoveryEntry
    ]
  );
  assert.deepEqual(runner.applied, [
    '107_ivekit_sip_effect_oracle',
    '113_converact_sip_effect_transport_completed',
    '114_converact_sip_effect_transport_completed_validate',
    '115_converact_sip_effect_stale_nonterminal_recovery'
  ]);

  assert.equal(SIP_EFFECT_SCHEMA_ID, 'ivekit.sip-effect-oracle');
  assert.equal(SIP_EFFECT_SCHEMA_VERSION, 2);
  assert.match(SIP_EFFECT_SCHEMA_HASH, /^[a-f0-9]{64}$/);
  assert.equal(
    canonicalSipEffectHash(SIP_EFFECT_MACHINE_SCHEMA_DESCRIPTOR),
    SIP_EFFECT_SCHEMA_HASH
  );
  assert.equal(Object.isFrozen(SIP_EFFECT_MACHINE_SCHEMA_DESCRIPTOR), true);
  assert.deepEqual(SIP_EFFECT_ATOMIC_DOMAIN_WRITES_STATUS, {
    status: 'not_wired_not_production',
    production_eligible: false
  });
  assert.equal(SIP_EFFECT_PHYSICAL_POSTGRES_VERIFICATION.production_eligible, false);
  assert.equal(
    Object.values(SIP_EFFECT_PHYSICAL_POSTGRES_VERIFICATION)
      .filter((value) => value !== false)
      .every((value) => value === 'not_run'),
    true
  );
});

class RecordingPg implements PgQueryable {
  readonly queries: Array<{ text: string; params: unknown[] }> = [];

  async connect(): Promise<RecordingPgClient> {
    return new RecordingPgClient(this);
  }

  async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    return emptyQueryResult<R>();
  }
}

class RecordingPgClient implements PgQueryable {
  constructor(private readonly pool: RecordingPg) {}

  query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    return this.pool.query<R>(text, params);
  }

  release(): void {}
}

class PreparedReplayPg extends RecordingPg {
  constructor(private readonly row: Record<string, unknown>) {
    super();
  }

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('prepare-conflict-read')) {
      return {
        rows: [structuredClone(this.row) as R],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: []
      };
    }
    return emptyQueryResult<R>();
  }
}

class DirectPreparedReplayPg extends RecordingPg {
  constructor(private readonly row: Record<string, unknown>) {
    super();
  }

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('prepare-conflict-read')) {
      return queryResult([this.row as R]);
    }
    return emptyQueryResult<R>();
  }
}

class HostileRepairRowsPg extends RecordingPg {
  constructor(private readonly hostileRows: Record<string, unknown>[]) {
    super();
  }

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('claim-repair')) {
      return queryResult(this.hostileRows as R[]);
    }
    return emptyQueryResult<R>();
  }
}

class ExhaustedRepairPg extends RecordingPg {
  constructor(private readonly exhaustedRow: Record<string, unknown>) {
    super();
  }

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('claim-repair')) {
      return queryResult([structuredClone(this.exhaustedRow) as R]);
    }
    if (text.includes('exhaust-repair-update')) {
      return queryResult([{
        protocol_effect_id: this.exhaustedRow.protocol_effect_id
      } as unknown as R]);
    }
    return emptyQueryResult<R>();
  }
}

class ReceiptReplayPg extends RecordingPg {
  constructor(
    private readonly current: Record<string, unknown>,
    private readonly receipt: Record<string, unknown>
  ) {
    super();
  }

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('transition-lock')) {
      return queryResult([structuredClone(this.current) as R]);
    }
    if (text.includes('receipt-replay')) {
      return queryResult([structuredClone(this.receipt) as R]);
    }
    return emptyQueryResult<R>();
  }
}

class TransitionCapturePg extends RecordingPg {
  constructor(private readonly current: Record<string, unknown>) {
    super();
  }

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('transition-lock')) {
      return queryResult([structuredClone(this.current) as R]);
    }
    if (text.includes('receipt-insert')) {
      return queryResult([{
        receipt_id: 'receipt-unknown-db-clock'
      } as unknown as R]);
    }
    return emptyQueryResult<R>();
  }
}

class BlockingPg extends RecordingPg {
  private readonly blockers: Array<() => void> = [];
  private blockedCount = 0;
  private readonly blockedWaiters: Array<{ target: number; resolve: () => void }> = [];

  override async query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, params });
    if (text.includes('converact-sip-effect-oracle:query')) {
      this.blockedCount += 1;
      for (const waiter of [...this.blockedWaiters]) {
        if (this.blockedCount >= waiter.target) waiter.resolve();
      }
      await new Promise<void>((resolve) => this.blockers.push(resolve));
    }
    return emptyQueryResult<R>();
  }

  waitUntilBlocked(target: number): Promise<void> {
    if (this.blockedCount >= target) return Promise.resolve();
    return new Promise((resolve) => this.blockedWaiters.push({ target, resolve }));
  }

  releaseOne(): void {
    this.blockers.shift()?.();
  }
}

function singlePermitStore(
  pg: PgQueryable,
  poolWaitTimeoutMs = 5
): PostgresEffectStore {
  return new PostgresEffectStore(pg, {
    max_in_flight: 1,
    max_queue_depth: 1,
    pool_wait_timeout_ms: poolWaitTimeoutMs
  });
}

async function expectSipEffectRejection<T>(
  promise: Promise<T>,
  code: StoreFailureCode,
  timeoutMs = 100
): Promise<SipEffectError> {
  const outcome = await settleWithin(promise, timeoutMs);
  assert.equal(outcome.status, 'rejected');
  assert.ok(outcome.status === 'rejected');
  assert.ok(outcome.error instanceof SipEffectError);
  assert.equal(outcome.error.code, code);
  return outcome.error;
}

type TimedSettlement<T> =
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'watchdog' };

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<TimedSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): TimedSettlement<T> => ({ status: 'resolved', value }),
        (error: unknown): TimedSettlement<T> => ({
          status: 'rejected',
          error
        })
      ),
      new Promise<TimedSettlement<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'watchdog' }), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class TestConnectPool implements PgQueryable {
  connectCount = 0;

  constructor(private readonly open: () => unknown) {}

  async query<R extends Record<string, unknown>>(): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    throw new Error('pool query must not bypass an owned client');
  }

  connect(): Promise<never> {
    this.connectCount += 1;
    return this.open() as Promise<never>;
  }
}

function stalledConnectPool(): TestConnectPool {
  return new TestConnectPool(() => new Promise<never>(() => {}));
}

class DeferredConnections {
  readonly #pending: Array<{
    resolve: (client: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  connect(): Promise<never> {
    return new Promise<never>((resolve, reject) => {
      this.#pending.push({
        resolve: resolve as (client: unknown) => void,
        reject
      });
    });
  }

  resolveNext(client: unknown): void {
    const pending = this.#pending.shift();
    assert.ok(pending);
    pending.resolve(client);
  }

  rejectNext(error: unknown): void {
    const pending = this.#pending.shift();
    assert.ok(pending);
    pending.reject(error);
  }
}

class TestPoolClient implements PgQueryable {
  readonly queries: string[] = [];
  releaseCount = 0;

  constructor(private readonly releaseError?: Error) {}

  async query<R extends Record<string, unknown>>(
    text: string
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push(text);
    return emptyQueryResult<R>();
  }

  release(): void {
    this.releaseCount += 1;
    if (this.releaseError) throw this.releaseError;
  }
}

class MissingReleaseClient {
  queryCount = 0;

  async query<R extends Record<string, unknown>>(): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queryCount += 1;
    return emptyQueryResult<R>();
  }
}

class QueueThenStallPool extends TestConnectPool {
  readonly #client: FirstQueryBlockingClient;

  constructor() {
    const client = new FirstQueryBlockingClient();
    let calls = 0;
    super(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(client)
        : new Promise<never>(() => {});
    });
    this.#client = client;
  }

  waitUntilFirstQueryBlocks(): Promise<void> {
    return this.#client.waitUntilBlocked();
  }

  releaseFirstQuery(): void {
    this.#client.releaseQuery();
  }
}

class FirstQueryBlockingClient extends TestPoolClient {
  #blocked: Promise<void>;
  #notifyBlocked!: () => void;
  #releaseQuery!: () => void;

  constructor() {
    super();
    this.#blocked = new Promise((resolve) => {
      this.#notifyBlocked = resolve;
    });
  }

  override async query<R extends Record<string, unknown>>(
    text: string
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push(text);
    if (text.includes('converact-sip-effect-oracle:query')) {
      this.#notifyBlocked();
      await new Promise<void>((resolve) => {
        this.#releaseQuery = resolve;
      });
    }
    return emptyQueryResult<R>();
  }

  waitUntilBlocked(): Promise<void> {
    return this.#blocked;
  }

  releaseQuery(): void {
    this.#releaseQuery();
  }
}

class UnexpectedConnectPool {
  connected = false;

  async query(): Promise<never> {
    throw new Error('pool query must not bypass transaction client');
  }

  async connect(): Promise<never> {
    this.connected = true;
    throw new Error('atomic boundary must fail before opening PostgreSQL');
  }
}

class CallerOwnedTransactionClient implements PgQueryable {
  domainWriteSurvived = false;

  async query<R extends Record<string, unknown>>(
    text: string
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    if (text.startsWith('INSERT INTO test_domain_facts')) {
      this.domainWriteSurvived = true;
    }
    return emptyQueryResult<R>();
  }

  release(): void {}
}

class CallerOwnedEffectClient implements PgQueryable {
  orphanReceiptCommitted = false;

  constructor(private readonly current: Record<string, unknown>) {}

  async query<R extends Record<string, unknown>>(
    text: string
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    if (text.includes('transition-lock')) {
      return queryResult([structuredClone(this.current) as R]);
    }
    if (text.includes('receipt-insert')) {
      this.orphanReceiptCommitted = true;
      return queryResult([{ receipt_id: 'receipt-observed' } as unknown as R]);
    }
    if (text.includes('transition-update')) {
      throw Object.assign(new Error('connection lost'), { code: '08006' });
    }
    return emptyQueryResult<R>();
  }

  release(): void {}
}

class MigrationRecorder implements MigrationQueryable {
  readonly applied: string[] = [];

  async query(
    text: string,
    params: unknown[] = []
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (text.startsWith('SELECT version, checksum')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('INSERT INTO schema_migrations')) {
      this.applied.push(String(params[0]));
    }
    return { rows: [], rowCount: 0 };
  }
}

function boundaryMetadata(
  boundary_kind: AtomicBoundaryMetadata['boundary_kind']
): AtomicBoundaryMetadata {
  return {
    tenant_id: 'tenant-a',
    boundary_id: `boundary-${boundary_kind}`,
    boundary_kind,
    decision_id: `decision-${boundary_kind}`,
    idempotency_key: `idempotency-${boundary_kind}`,
    request_hash: sha256(`request-${boundary_kind}`),
    owner_epoch: '3',
    command_sequence: '9',
    committed_at: new Date('2026-07-30T00:00:00.000Z')
  };
}

function writeReceipt(
  fact_type: AtomicBoundaryWriteReceipt['fact_type']
): AtomicBoundaryWriteReceipt {
  return {
    fact_type,
    receipt_id: `receipt-${fact_type}`,
    aggregate_id: `aggregate-${fact_type}`,
    aggregate_revision: '1',
    applied: true,
    payload: { fact_type, durable: true }
  };
}

function callAdmissionResult(): AtomicBoundaryResult {
  return {
    boundary_kind: 'call_admission',
    writes: [
      writeReceipt('call_session'),
      writeReceipt('protocol_effect'),
      writeReceipt('effect_wal'),
      writeReceipt('capacity_reservation_receipt'),
      writeReceipt('idempotency_record')
    ]
  };
}

function fenceFrom(effect: ProtocolEffectRecord): EffectRepairFence {
  return {
    repair_owner_id: effect.repair_owner_id!,
    repair_owner_epoch: effect.repair_owner_epoch!,
    repair_claim_token: effect.repair_claim_token!,
    repair_claim_revision: effect.repair_claim_revision!
  };
}

function effectKey(
  effect: Pick<ProtocolEffectIdentity, 'tenant_id' | 'protocol_effect_id'>
): string {
  return `${effect.tenant_id}:${effect.protocol_effect_id}`;
}

function cloneEffect(effect: ProtocolEffectRecord): ProtocolEffectRecord {
  return {
    ...structuredClone(effect),
    canonical_wire_bytes: Buffer.from(effect.canonical_wire_bytes)
  };
}

function samePreparedEffect(
  left: ProtocolEffectRecord,
  right: ProtocolEffectRecord
): boolean {
  return left.protocol_effect_id === right.protocol_effect_id &&
    left.protocol_session_id === right.protocol_session_id &&
    left.protocol_session_generation === right.protocol_session_generation &&
    left.decision_id === right.decision_id &&
    left.idempotency_key === right.idempotency_key &&
    left.request_hash === right.request_hash &&
    left.command_id === right.command_id &&
    left.adapter_identity_hash === right.adapter_identity_hash &&
    left.wire_bytes_hash === right.wire_bytes_hash &&
    left.wire_length_bytes === right.wire_length_bytes &&
    left.route_binding_hash === right.route_binding_hash &&
    left.wire_attempt_facts_hash === right.wire_attempt_facts_hash &&
    left.wire_freeze_sha256 === right.wire_freeze_sha256 &&
    left.owner_epoch === right.owner_epoch &&
    left.command_sequence === right.command_sequence &&
    Buffer.from(left.canonical_wire_bytes).equals(Buffer.from(right.canonical_wire_bytes));
}

function assertIdentity(
  effect: ProtocolEffectRecord,
  effectIdentity: ProtocolEffectIdentity
): void {
  for (const field of [
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
  ] as const) {
    if (effect[field] !== effectIdentity[field]) {
      throw new SipEffectError({
        code: 'sip_effect_identity_conflict',
        status: 409
      });
    }
  }
}

function assertRepairFence(
  effect: ProtocolEffectRecord,
  fence: EffectRepairFence | null,
  observedAt: string
): void {
  if (!fence ||
      effect.repair_owner_id !== fence.repair_owner_id ||
      effect.repair_owner_epoch !== fence.repair_owner_epoch ||
      effect.repair_claim_token !== fence.repair_claim_token ||
      effect.repair_claim_revision !== fence.repair_claim_revision ||
      effect.revision !== fence.repair_claim_revision ||
      !effect.repair_lease_until ||
      Date.parse(effect.repair_lease_until) <= Date.parse(observedAt)) {
    throw new SipEffectError({ code: 'sip_effect_fence_lost', status: 409 });
  }
}

function addU64(value: string, increment: number): string {
  return (BigInt(value) + BigInt(increment)).toString();
}

function effectRow(effect: ProtocolEffectRecord): Record<string, unknown> {
  const row = structuredClone(effect) as unknown as Record<string, unknown>;
  delete row.terminal_tombstone;
  return {
    ...row,
    writer_identity: 'unified-rustpbx.sip-foundation',
    effect_identity_hash: protocolEffectIdentityHash(effect),
    canonical_wire_bytes: Buffer.from(effect.canonical_wire_bytes),
    terminal_tombstone_id: effect.terminal_tombstone?.receipt_id ?? null,
    terminal_tombstone_hash: effect.terminal_tombstone?.receipt_hash ?? null,
    terminal_at: effect.terminal_tombstone?.terminal_at ?? null
  };
}

function emptyQueryResult<R extends Record<string, unknown>>(): {
  rows: R[];
  rowCount: number;
  command: string;
  oid: number;
  fields: never[];
} {
  return {
    rows: [],
    rowCount: 0,
    command: '',
    oid: 0,
    fields: []
  };
}

function queryResult<R extends Record<string, unknown>>(rows: R[]): {
  rows: R[];
  rowCount: number;
  command: string;
  oid: number;
  fields: never[];
} {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: []
  };
}

function idempotencyConflict(): never {
  throw new SipEffectError({
    code: 'sip_effect_idempotency_conflict',
    status: 409
  });
}

function notFound(): never {
  throw new SipEffectError({ code: 'sip_effect_not_found', status: 404 });
}

function isValidationError(error: unknown): boolean {
  return error instanceof SipEffectError &&
    (error.code === 'sip_effect_validation_failed' ||
     error.code === 'sip_effect_prepared_authority_rejected');
}

function isStoreSchemaError(error: unknown): boolean {
  return error instanceof SipEffectError &&
    error.code === 'store_schema_incompatible';
}

function isFenceLost(error: unknown): boolean {
  return error instanceof SipEffectError &&
    error.code === 'sip_effect_fence_lost';
}
