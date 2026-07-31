import { createHash } from 'node:crypto';

import {
  assertBackendCapabilities,
  backendRuntimeIdentityFromCapabilitySet,
  validateBackendRuntimeIdentity,
  createBackendCapabilitySet,
  sameRuntimeIdentity
} from './capabilities.js';
import {
  SipFoundationError,
  type BackendCapabilitySet,
  type BackendRuntimeIdentity,
  type BoundSipProtocolSessionBinding,
  type BoundSipWireAttemptFacts,
  type OpenProtocolSessionInput,
  type PreparedProtocolEffect,
  type PrepareProtocolEffectInput,
  type SipFoundationAdapter,
  type SipFoundationBackendSession,
  type SipFoundationCapabilityId,
  type SipProtocolSessionLease,
  type SipProtocolSession,
  type SipProtocolSessionBinding,
  type SipRouteBinding
} from './types.js';
import {
  snapshotClosedBytes,
  snapshotClosedRecord
} from './closed-schema.js';
import {
  assertSipRouteMatchesSession,
  bindSipProtocolSession,
  bindSipRoute,
  bindSipWireAttemptFacts,
  SIP_WIRE_BRANCH_PLACEHOLDER,
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256,
  validateBoundSipWireAttemptFacts
} from './route-binding.js';
import {
  assertSipFoundationSessionLease,
  verifyPreparedProtocolEffect
} from './session-registry.js';

export const RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES = Object.freeze([
  'protocol_session',
  'route_binding',
  'prepare_effect',
  'exact_wire_replay'
] as const satisfies readonly SipFoundationCapabilityId[]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_WIRE_BYTES = 65_535;
const MAX_SIP_HEADER_BYTES = 32_768;
const MAX_SIP_BODY_BYTES = 32_768;
const MAX_SIP_HEADERS = 128;
const MAX_SIP_HEADER_LINE_BYTES = 8_192;
const MAX_WIRE_BASE64_CHARACTERS = Math.ceil(MAX_WIRE_BYTES / 3) * 4;
const MAX_ATTEMPTS_PER_SESSION = 256;
const OPEN_SESSION_KEYS = ['protocol_session_id', 'session_binding'] as const;
const PREPARE_EFFECT_KEYS = [
  'effect_id',
  'command_id',
  'owner_epoch',
  'command_sequence',
  'route_binding',
  'wire_attempt_facts',
  'canonical_wire_template'
] as const;
const PREPARED_EFFECT_KEYS = [
  'adapter_identity',
  'wire_identity',
  'route_binding',
  'wire_attempt_facts',
  'wire_bytes_base64'
] as const;
const WIRE_IDENTITY_KEYS = [
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
const RSIPSTACK_SESSION_LEASES = new WeakMap<
  SipProtocolSession,
  SipProtocolSessionLease
>();
interface AttemptAuthorityRecord {
  readonly wire_freeze_sha256: string;
  readonly route_binding_sha256: string;
  readonly wire_attempt_facts_sha256: string;
  readonly wire_sha256: string;
  readonly wire_length_bytes: number;
  readonly command_id: string;
  readonly owner_epoch: string;
  readonly command_sequence: string;
  readonly via_branch: string;
  readonly transaction_lineage_id: string;
  readonly semantic_intent_sha256: string;
}
interface AttemptAuthority {
  readonly by_id: Map<string, AttemptAuthorityRecord>;
  readonly by_branch: Map<string, string>;
}
const RSIPSTACK_SESSION_ATTEMPTS = new WeakMap<
  SipProtocolSession,
  AttemptAuthority
>();

export class RsipstackFoundationAdapter implements SipFoundationAdapter {
  readonly backend_id = 'rsipstack' as const;
  readonly capability_set: BackendCapabilitySet;
  readonly runtime_identity: BackendRuntimeIdentity;

  constructor(capabilitySet: BackendCapabilitySet) {
    this.capability_set = createBackendCapabilitySet(capabilitySet);
    if (this.capability_set.backend_id !== this.backend_id) {
      throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
    }
    this.runtime_identity = backendRuntimeIdentityFromCapabilitySet(
      this.capability_set
    );
    Object.freeze(this);
  }

  createProtocolSession(
    input: OpenProtocolSessionInput,
    lease: SipProtocolSessionLease
  ): SipFoundationBackendSession {
    assertSipFoundationSessionLease(lease);
    assertBackendCapabilities(this.capability_set, {
      backend_id: this.backend_id,
      source_digest: this.capability_set.source_digest,
      binary_digest: this.capability_set.binary_digest,
      config_digest: this.capability_set.config_digest,
      capability_set_digest: this.capability_set.capability_set_digest,
      require_production_eligible: false,
      required_capabilities: RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES
    });
    const checkedInput = exactInputRecord(input, OPEN_SESSION_KEYS);
    return new RsipstackProtocolSession(
      identifier(
        checkedInput.protocol_session_id,
        'sip_foundation_input_invalid'
      ),
      bindSipProtocolSession(
        checkedInput.session_binding as SipProtocolSessionBinding
      ),
      this.runtime_identity,
      lease
    );
  }
}

class RsipstackProtocolSession implements SipFoundationBackendSession {
  readonly backend_id = 'rsipstack' as const;
  readonly adapter_identity: BackendRuntimeIdentity;
  readonly protocol_session_id: string;
  readonly protocol_session_generation: string;
  readonly session_binding: BoundSipProtocolSessionBinding;
  readonly #lease: SipProtocolSessionLease;
  readonly #attempts: AttemptAuthority;

  constructor(
    protocolSessionId: string,
    sessionBinding: BoundSipProtocolSessionBinding,
    adapterIdentity: BackendRuntimeIdentity,
    lease: SipProtocolSessionLease
  ) {
    this.protocol_session_id = protocolSessionId;
    this.protocol_session_generation = lease.generation;
    this.session_binding = sessionBinding;
    this.adapter_identity = validateBackendRuntimeIdentity(adapterIdentity);
    this.#lease = lease;
    this.#attempts = {
      by_id: new Map(),
      by_branch: new Map()
    };
    RSIPSTACK_SESSION_LEASES.set(this, lease);
    RSIPSTACK_SESSION_ATTEMPTS.set(this, this.#attempts);
    Object.freeze(this);
  }

  prepareEffect(input: PrepareProtocolEffectInput): PreparedProtocolEffect {
    this.#lease.assertActive();
    const value = exactInputRecord(input, PREPARE_EFFECT_KEYS);
    const effectId = identifier(value.effect_id, 'sip_foundation_input_invalid');
    const commandId = identifier(value.command_id, 'sip_foundation_input_invalid');
    const ownerEpoch = u64(value.owner_epoch);
    const commandSequence = u64(value.command_sequence);
    const routeBinding = bindSipRoute(
      value.route_binding as SipRouteBinding
    );
    assertSipRouteMatchesSession(routeBinding, this.session_binding);
    const wireAttemptFacts = bindSipWireAttemptFacts(
      value.wire_attempt_facts as PrepareProtocolEffectInput['wire_attempt_facts'],
      effectId,
      generatedViaBranch(this.protocol_session_generation, effectId)
    );
    const parentAttemptId = wireAttemptFacts.parent_attempt_id;
    if (parentAttemptId !== null) {
      const parent = this.#attempts.by_id.get(parentAttemptId);
      if (!parent ||
          parent.transaction_lineage_id !==
            wireAttemptFacts.transaction_lineage_id ||
          parent.semantic_intent_sha256 !==
            wireAttemptFacts.semantic_intent_sha256) {
        throw new SipFoundationError('sip_foundation_wire_attempt_invalid');
      }
    }
    const wireTemplate = snapshotClosedBytes(
      value.canonical_wire_template,
      1,
      MAX_WIRE_BYTES,
      () => new SipFoundationError('sip_foundation_wire_invalid')
    );
    const wireBytes = materializeBoundWire(
      wireTemplate,
      routeBinding,
      wireAttemptFacts
    );
    const wireSha256 = createHash('sha256').update(wireBytes).digest('hex');
    const routeBindingSha256 = sipRouteBindingSha256(routeBinding);
    const attemptFactsSha256 = sipWireAttemptFactsSha256(wireAttemptFacts);
    const wireIdentity = Object.freeze({
      protocol_session_id: this.protocol_session_id,
      protocol_session_generation: this.protocol_session_generation,
      effect_id: effectId,
      command_id: commandId,
      owner_epoch: ownerEpoch,
      command_sequence: commandSequence,
      wire_sha256: wireSha256,
      route_binding_sha256: routeBindingSha256,
      wire_attempt_facts_sha256: attemptFactsSha256,
      wire_freeze_sha256: sipWireFreezeSha256({
        route_binding_sha256: routeBindingSha256,
        wire_attempt_facts_sha256: attemptFactsSha256,
        wire_sha256: wireSha256,
        wire_length_bytes: wireBytes.byteLength
      }),
      wire_length_bytes: wireBytes.byteLength
    });
    const prepared: PreparedProtocolEffect = Object.freeze({
      adapter_identity: this.adapter_identity,
      wire_identity: wireIdentity,
      route_binding: routeBinding,
      wire_attempt_facts: wireAttemptFacts,
      wire_bytes_base64: wireBytes.toString('base64')
    });
    const existing = this.#attempts.by_id.get(effectId);
    if (existing) {
      if (!sameAttemptAuthority(existing, prepared)) {
        throw new SipFoundationError('sip_foundation_wire_attempt_invalid');
      }
      return prepared;
    }
    const existingBranchAttempt = this.#attempts.by_branch.get(
      wireAttemptFacts.via_branch
    );
    if (existingBranchAttempt !== undefined) {
      throw new SipFoundationError('sip_foundation_wire_attempt_invalid');
    }
    if (this.#attempts.by_id.size >= MAX_ATTEMPTS_PER_SESSION) {
      throw new SipFoundationError(
        'sip_foundation_session_capacity_exhausted'
      );
    }
    this.#lease.reserveAttempt();
    this.#attempts.by_id.set(
      effectId,
      attemptAuthorityRecord(prepared)
    );
    this.#attempts.by_branch.set(
      wireAttemptFacts.via_branch,
      effectId
    );
    return prepared;
  }

  verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array {
    return decodeRsipstackPreparedWireBytes(prepared, this);
  }
}

Object.freeze(RsipstackProtocolSession.prototype);

function attemptAuthorityRecord(
  prepared: PreparedProtocolEffect
): AttemptAuthorityRecord {
  return Object.freeze({
    wire_freeze_sha256: prepared.wire_identity.wire_freeze_sha256,
    route_binding_sha256: prepared.wire_identity.route_binding_sha256,
    wire_attempt_facts_sha256:
      prepared.wire_identity.wire_attempt_facts_sha256,
    wire_sha256: prepared.wire_identity.wire_sha256,
    wire_length_bytes: prepared.wire_identity.wire_length_bytes,
    command_id: prepared.wire_identity.command_id,
    owner_epoch: prepared.wire_identity.owner_epoch,
    command_sequence: prepared.wire_identity.command_sequence,
    via_branch: prepared.wire_attempt_facts.via_branch,
    transaction_lineage_id:
      prepared.wire_attempt_facts.transaction_lineage_id,
    semantic_intent_sha256:
      prepared.wire_attempt_facts.semantic_intent_sha256
  });
}

function sameAttemptAuthority(
  authoritative: AttemptAuthorityRecord,
  prepared: {
    wire_identity: {
      wire_freeze_sha256: string;
      route_binding_sha256: string;
      wire_attempt_facts_sha256: string;
      wire_sha256: string;
      wire_length_bytes: number;
      command_id: string;
      owner_epoch: string;
      command_sequence: string;
    };
    wire_attempt_facts: {
      via_branch: string;
      transaction_lineage_id: string;
      semantic_intent_sha256: string;
    };
  }
): boolean {
  return authoritative.wire_freeze_sha256 ===
      prepared.wire_identity.wire_freeze_sha256 &&
    authoritative.route_binding_sha256 ===
      prepared.wire_identity.route_binding_sha256 &&
    authoritative.wire_attempt_facts_sha256 ===
      prepared.wire_identity.wire_attempt_facts_sha256 &&
    authoritative.wire_sha256 === prepared.wire_identity.wire_sha256 &&
    authoritative.wire_length_bytes ===
      prepared.wire_identity.wire_length_bytes &&
    authoritative.command_id === prepared.wire_identity.command_id &&
    authoritative.owner_epoch === prepared.wire_identity.owner_epoch &&
    authoritative.command_sequence ===
      prepared.wire_identity.command_sequence &&
    authoritative.via_branch === prepared.wire_attempt_facts.via_branch &&
    authoritative.transaction_lineage_id ===
      prepared.wire_attempt_facts.transaction_lineage_id &&
    authoritative.semantic_intent_sha256 ===
      prepared.wire_attempt_facts.semantic_intent_sha256;
}

export function decodePreparedWireBytes(
  prepared: PreparedProtocolEffect,
  expectedSession: SipProtocolSession
): Uint8Array {
  return verifyPreparedProtocolEffect(prepared, expectedSession);
}

function decodeRsipstackPreparedWireBytes(
  prepared: PreparedProtocolEffect,
  expectedSession: RsipstackProtocolSession
): Uint8Array {
  const sessionLease = RSIPSTACK_SESSION_LEASES.get(expectedSession);
  const attemptAuthority = RSIPSTACK_SESSION_ATTEMPTS.get(expectedSession);
  if (!sessionLease ||
      !attemptAuthority ||
      sessionLease.generation !==
        expectedSession.protocol_session_generation) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  sessionLease.assertActive();
  try {
    const value = exactRecord(
      prepared,
      PREPARED_EFFECT_KEYS,
      'sip_foundation_wire_invalid'
    );
    const expectedIdentity = validateBackendRuntimeIdentity(
      expectedSession.adapter_identity
    );
    const preparedIdentity = validateBackendRuntimeIdentity(
      value.adapter_identity
    );
    if (!sameRuntimeIdentity(expectedIdentity, preparedIdentity)) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const expectedProtocolSessionId = identifier(
      expectedSession.protocol_session_id,
      'sip_foundation_input_invalid'
    );
    const identity = exactRecord(
      value.wire_identity,
      WIRE_IDENTITY_KEYS,
      'sip_foundation_wire_invalid'
    );
    if (identifier(identity.protocol_session_id, 'sip_foundation_input_invalid') !==
        expectedProtocolSessionId) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    if (identifier(
      identity.protocol_session_generation,
      'sip_foundation_input_invalid'
    ) !== expectedSession.protocol_session_generation) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    identifier(identity.effect_id, 'sip_foundation_input_invalid');
    identifier(identity.command_id, 'sip_foundation_input_invalid');
    u64(identity.owner_epoch);
    u64(identity.command_sequence);
    const wireSha256 = sha256(identity.wire_sha256);
    const routeBindingSha = sha256(identity.route_binding_sha256);
    const attemptFactsSha = sha256(identity.wire_attempt_facts_sha256);
    const wireFreezeSha = sha256(identity.wire_freeze_sha256);
    const wireLength = boundedInteger(
      identity.wire_length_bytes,
      1,
      MAX_WIRE_BYTES,
      'sip_foundation_wire_invalid'
    );
    const routeBinding = bindSipRoute(
      value.route_binding as SipRouteBinding
    );
    assertSipRouteMatchesSession(
      routeBinding,
      bindSipProtocolSession(expectedSession.session_binding)
    );
    if (sipRouteBindingSha256(routeBinding) !== routeBindingSha ||
        routeBinding.authorization_identity !==
          expectedSession.session_binding.authorization_identity) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const wireAttemptFacts = validateBoundSipWireAttemptFacts(
      value.wire_attempt_facts as BoundSipWireAttemptFacts,
      String(identity.effect_id)
    );
    if (sipWireAttemptFactsSha256(wireAttemptFacts) !== attemptFactsSha) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const encoded = value.wire_bytes_base64;
    if (typeof encoded !== 'string' ||
        encoded.length > MAX_WIRE_BASE64_CHARACTERS ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded
        )) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.byteLength !== wireLength ||
        createHash('sha256').update(bytes).digest('hex') !== wireSha256) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    if (sipWireFreezeSha256({
      route_binding_sha256: routeBindingSha,
      wire_attempt_facts_sha256: attemptFactsSha,
      wire_sha256: wireSha256,
      wire_length_bytes: wireLength
    }) !== wireFreezeSha) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const authoritativeAttempt = attemptAuthority.by_id.get(
      String(identity.effect_id)
    );
    if (!authoritativeAttempt ||
        !sameAttemptAuthority(authoritativeAttempt, {
          wire_identity: {
            command_id: String(identity.command_id),
            owner_epoch: String(identity.owner_epoch),
            command_sequence: String(identity.command_sequence),
            wire_freeze_sha256: wireFreezeSha,
            route_binding_sha256: routeBindingSha,
            wire_attempt_facts_sha256: attemptFactsSha,
            wire_sha256: wireSha256,
            wire_length_bytes: wireLength
          },
          wire_attempt_facts: wireAttemptFacts
        })) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof SipFoundationError &&
        error.code === 'sip_foundation_wire_invalid') {
      throw error;
    }
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
}

function generatedViaBranch(
  protocolSessionGeneration: string,
  effectId: string
): string {
  const digest = createHash('sha256')
    .update(protocolSessionGeneration)
    .update('\0')
    .update(effectId)
    .digest('hex');
  return `z9hG4bK-opc-${digest.slice(0, 40)}`;
}

function materializeBoundWire(
  template: Uint8Array,
  routeBinding: SipRouteBinding,
  attemptFacts: BoundSipWireAttemptFacts
): Buffer {
  const bytes = Buffer.from(template);
  const branchOffset = assertWireMatchesBinding(
    bytes,
    routeBinding,
    SIP_WIRE_BRANCH_PLACEHOLDER
  );
  if (attemptFacts.via_branch.length !==
      SIP_WIRE_BRANCH_PLACEHOLDER.length) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  bytes.write(attemptFacts.via_branch, branchOffset, 'ascii');
  assertWireMatchesBinding(bytes, routeBinding, attemptFacts.via_branch);
  return bytes;
}

function assertWireMatchesBinding(
  bytes: Uint8Array,
  routeBinding: SipRouteBinding,
  expectedBranch: string
): number {
  const buffer = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0 || headerEnd > MAX_SIP_HEADER_BYTES) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const headerBytes = buffer.subarray(0, headerEnd);
  for (let index = 0; index < headerBytes.length; index += 1) {
    const byte = headerBytes[index]!;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0d &&
         byte !== 0x0a) ||
        byte === 0x7f) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
  }
  const headerText = headerBytes.toString('utf8');
  if (!Buffer.from(headerText, 'utf8').equals(headerBytes) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(
        headerText
      )) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const lines = headerText.split('\r\n');
  if (lines.length < 2 || !lines[0] ||
      Buffer.byteLength(lines[0], 'utf8') > MAX_SIP_HEADER_LINE_BYTES ||
      lines.length - 1 > MAX_SIP_HEADERS ||
      lines.some((line) => line.includes('\n') || line.includes('\r'))) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const vias: string[] = [];
  const routes: string[] = [];
  const contentLengths: string[] = [];
  const authorizations: Array<{
    name: 'authorization' | 'proxy-authorization';
    value: string;
  }> = [];
  let offset = Buffer.byteLength(lines[0]!, 'utf8') + 2;
  let branchOffset = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line ||
        Buffer.byteLength(line, 'utf8') > MAX_SIP_HEADER_LINE_BYTES ||
        line.startsWith(' ') ||
        line.startsWith('\t')) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const name = line.slice(0, separator).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const rawValue = line.slice(separator + 1);
    if (!rawValue.startsWith(' ') || rawValue.startsWith('  ')) {
      throw new SipFoundationError('sip_foundation_wire_invalid');
    }
    const value = rawValue.slice(1);
    if (name === 'via') {
      vias.push(value);
      if (vias.length === 1) {
        const marker = `branch=${expectedBranch}`;
        const markerOffset = line.indexOf(marker);
        if (markerOffset < 0) {
          throw new SipFoundationError('sip_foundation_wire_invalid');
        }
        branchOffset = offset + markerOffset + 'branch='.length;
      }
    } else if (name === 'route') {
      routes.push(value);
    } else if (name === 'authorization' ||
               name === 'proxy-authorization') {
      authorizations.push({
        name,
        value
      });
    } else if (name === 'content-length') {
      contentLengths.push(value);
    }
    offset += Buffer.byteLength(line, 'utf8') + 2;
  }
  if (vias.length < 1 ||
      contentLengths.length !== 1 ||
      !/^(?:0|[1-9][0-9]{0,5})$/.test(contentLengths[0]!)) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const via = /^SIP\/2\.0\/(UDP|TCP|TLS|WS|WSS) ([^; ]+);(.+)$/.exec(
    vias[0]!
  );
  if (!via ||
      via[1]!.toLowerCase() !== routeBinding.transport.protocol ||
      !sameSentBy(via[2]!, routeBinding.advertised_via_sent_by) ||
      !hasOnlyExpectedBranch(via[3]!, expectedBranch)) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const expectedRoutes = routeBinding.route_set.map((route) => `<${route}>`);
  if (routes.length !== expectedRoutes.length ||
      routes.some((route, index) => route !== expectedRoutes[index])) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const authorizationHashes = authorizations.map((authorization) =>
    createHash('sha256')
      .update(authorization.name)
      .update(':')
      .update(authorization.value)
      .digest('hex')
  );
  if (authorizationHashes.length !==
        routeBinding.authorization_headers_sha256.length ||
      authorizationHashes.some((hash, index) =>
        hash !== routeBinding.authorization_headers_sha256[index]) ||
      (authorizationHashes.length > 0 &&
       routeBinding.authorization_identity === null)) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  const bodyLength = buffer.byteLength - headerEnd - 4;
  if (bodyLength > MAX_SIP_BODY_BYTES ||
      Number(contentLengths[0]) !== bodyLength ||
      branchOffset < 0) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  return branchOffset;
}

function sameSentBy(
  actual: string,
  expected: { host: string; port: number }
): boolean {
  const bracketed = /^\[([^\]]+)\]:([0-9]{1,5})$/.exec(actual);
  const ordinary = /^([^:]+):([0-9]{1,5})$/.exec(actual);
  const match = bracketed ?? ordinary;
  return !!match &&
    match[1]!.toLowerCase() === expected.host.toLowerCase() &&
    Number(match[2]) === expected.port;
}

function hasOnlyExpectedBranch(
  parameters: string,
  expectedBranch: string
): boolean {
  const parts = parameters.split(';');
  let branchCount = 0;
  for (const part of parts) {
    const separator = part.indexOf('=');
    const name = (separator < 0 ? part : part.slice(0, separator))
      .toLowerCase();
    if (name === 'branch') {
      branchCount += 1;
      if (separator < 0 || part.slice(separator + 1) !== expectedBranch) {
        return false;
      }
    }
  }
  return branchCount === 1;
}

function identifier(
  value: unknown,
  code: 'sip_foundation_input_invalid'
): string {
  if (typeof value !== 'string') {
    throw new SipFoundationError(code);
  }
  const normalized = value;
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new SipFoundationError(code);
  }
  return normalized;
}

function u64(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SipFoundationError('sip_foundation_fence_invalid');
  }
  const normalized = value;
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(normalized)) {
    throw new SipFoundationError('sip_foundation_fence_invalid');
  }
  const parsed = BigInt(normalized);
  if (parsed > U64_MAX || parsed === 0n) {
    throw new SipFoundationError('sip_foundation_fence_invalid');
  }
  return normalized;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code:
    | 'sip_foundation_input_invalid'
    | 'sip_foundation_route_binding_invalid'
    | 'sip_foundation_wire_invalid' = 'sip_foundation_route_binding_invalid'
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new SipFoundationError(code);
  }
  return Number(value);
}

function exactInputRecord(
  value: unknown,
  expected: readonly string[]
): Record<string, unknown> {
  return exactRecord(
    value,
    expected,
    'sip_foundation_input_invalid'
  );
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
  code:
    | 'sip_foundation_input_invalid'
    | 'sip_foundation_route_binding_invalid'
    | 'sip_foundation_wire_invalid'
): Record<string, unknown> {
  return snapshotClosedRecord(
    value,
    expected,
    () => new SipFoundationError(code)
  );
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SipFoundationError('sip_foundation_wire_invalid');
  }
  return value;
}
