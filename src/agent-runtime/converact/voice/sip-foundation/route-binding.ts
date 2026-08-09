import { isIP } from 'node:net';

import { canonicalVoicePayloadHash } from '../canonical.js';
import {
  snapshotClosedArray,
  snapshotClosedRecord,
  snapshotDataRecord
} from './closed-schema.js';
import {
  SipFoundationError,
  type BoundSipProtocolSessionBinding,
  type BoundSipRouteBinding,
  type BoundSipWireAttemptFacts,
  type BoundSipWireAttemptFactsV1,
  type BoundSipWireAttemptFactsV2,
  type SipEndpoint,
  type SipProtocolSessionBinding,
  type SipResolvedEndpoint,
  type SipRouteBinding,
  type SipTransportProtocol,
  type SipWireAttemptCanonicalDestination,
  type SipWireAttemptCompletionScope,
  type SipWireAttemptFacts
} from './types.js';

const ROUTE_BINDING_KEYS = [
  'schema_id',
  'schema_version',
  'route',
  'rfc3263_candidate',
  'route_set',
  'transport',
  'local_endpoint',
  'advertised_via_sent_by',
  'tls_sni',
  'authorization_identity',
  'authorization_headers_sha256'
] as const;
const ROUTE_KEYS = ['id', 'revision'] as const;
const SESSION_BINDING_KEYS = [
  'schema_id',
  'schema_version',
  'route',
  'authorization_identity'
] as const;
const TRANSPORT_KEYS = ['id', 'protocol', 'next_hop'] as const;
const ENDPOINT_KEYS = ['host', 'port'] as const;
const LOCAL_ENDPOINT_KEYS = ['address', 'port'] as const;
const WIRE_ATTEMPT_INPUT_KEYS = [
  'schema_id',
  'schema_version',
  'attempt_id',
  'transaction_lineage_id',
  'semantic_intent_sha256',
  'parent_attempt_id',
  'lineage_reason'
] as const;
const BOUND_WIRE_ATTEMPT_KEYS = [
  ...WIRE_ATTEMPT_INPUT_KEYS,
  'via_branch'
] as const;
const BOUND_WIRE_ATTEMPT_V2_KEYS = [
  'schema_id',
  'schema_version',
  'lineage',
  'via_branch',
  'canonical_destination',
  'transaction_binding_sha256',
  'completion_scope'
] as const;
const CANONICAL_DESTINATION_KEYS = [
  'transport_id',
  'protocol',
  'address',
  'port',
  'selection_kind',
  'flow_id',
  'flow_generation'
] as const;
const WIRE_ATTEMPT_FINALIZATION_KEYS = [
  'canonical_destination',
  'transaction_binding_sha256',
  'completion_scope'
] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const VIA_BRANCH_PATTERN = /^z9hG4bK[A-Za-z0-9.!%*_+`'~-]{1,248}$/;
const TRANSPORTS = new Set<SipTransportProtocol>([
  'udp',
  'tcp',
  'tls',
  'ws',
  'wss'
]);
const MAX_ROUTE_SET = 32;
const MAX_AUTHORIZATION_HEADERS = 16;
export const SIP_WIRE_BRANCH_PLACEHOLDER =
  `z9hG4bK-opc-${'0'.repeat(40)}` as const;

export function bindSipRoute(
  input: SipRouteBinding
): BoundSipRouteBinding {
  const value = routeRecord(input, ROUTE_BINDING_KEYS);
  if (value.schema_id !== 'sip-foundation-route-binding-v1' ||
      value.schema_version !== '1.0.0') {
    routeInvalid();
  }
  const route = routeRecord(value.route, ROUTE_KEYS);
  const transport = routeRecord(value.transport, TRANSPORT_KEYS);
  const nextHop = resolvedEndpoint(transport.next_hop);
  const local = localEndpoint(value.local_endpoint);
  const advertisedVia = endpoint(value.advertised_via_sent_by);
  const protocol = transport.protocol;
  if (typeof protocol !== 'string' ||
      !TRANSPORTS.has(protocol as SipTransportProtocol)) {
    routeInvalid();
  }
  const tlsSni = nullableHostname(value.tls_sni);
  if ((protocol === 'tls' || protocol === 'wss') !== (tlsSni !== null)) {
    routeInvalid();
  }
  const routeSet = snapshotClosedArray(
    value.route_set,
    MAX_ROUTE_SET,
    routeError
  );
  const boundRouteSet = Object.freeze(routeSet.map((entry) =>
    boundedWireText(entry, 4_096)
  ));

  return Object.freeze({
    schema_id: 'sip-foundation-route-binding-v1',
    schema_version: '1.0.0',
    route: Object.freeze({
      id: identifier(route.id),
      revision: integer(route.revision, 1, Number.MAX_SAFE_INTEGER)
    }),
    rfc3263_candidate: boundedWireText(
      value.rfc3263_candidate,
      1_024
    ),
    route_set: boundRouteSet,
    transport: Object.freeze({
      id: identifier(transport.id),
      protocol: protocol as SipTransportProtocol,
      next_hop: nextHop
    }),
    local_endpoint: local,
    advertised_via_sent_by: advertisedVia,
    tls_sni: tlsSni,
    authorization_identity: nullableIdentifier(
      value.authorization_identity
    ),
    authorization_headers_sha256: routeSha256List(
      value.authorization_headers_sha256
    )
  });
}

export function bindSipProtocolSession(
  input: SipProtocolSessionBinding
): BoundSipProtocolSessionBinding {
  const value = routeRecord(input, SESSION_BINDING_KEYS);
  if (value.schema_id !== 'sip-foundation-session-binding-v1' ||
      value.schema_version !== '1.0.0') {
    routeInvalid();
  }
  const route = routeRecord(value.route, ROUTE_KEYS);
  return Object.freeze({
    schema_id: 'sip-foundation-session-binding-v1',
    schema_version: '1.0.0',
    route: Object.freeze({
      id: identifier(route.id),
      revision: integer(route.revision, 1, Number.MAX_SAFE_INTEGER)
    }),
    authorization_identity: nullableIdentifier(
      value.authorization_identity
    )
  });
}

export function assertSipRouteMatchesSession(
  routeBinding: BoundSipRouteBinding,
  sessionBinding: BoundSipProtocolSessionBinding
): void {
  if (routeBinding.route.id !== sessionBinding.route.id ||
      routeBinding.route.revision !== sessionBinding.route.revision ||
      routeBinding.authorization_identity !==
        sessionBinding.authorization_identity) {
    routeInvalid();
  }
}

export function bindSipWireAttemptFacts(
  input: SipWireAttemptFacts,
  expectedAttemptId: string,
  generatedViaBranch: string
): BoundSipWireAttemptFactsV1 {
  const value = attemptRecord(input, WIRE_ATTEMPT_INPUT_KEYS);
  return boundSipWireAttemptFactsV1(
    value,
    expectedAttemptId,
    generatedViaBranch
  );
}

/** Adapter-only finalization; PrepareProtocolEffectInput remains exact v1. */
export function finalizeSipWireAttemptFacts(
  v1: BoundSipWireAttemptFactsV1,
  finalization: {
    canonical_destination: SipWireAttemptCanonicalDestination;
    transaction_binding_sha256: string;
    completion_scope: SipWireAttemptCompletionScope;
  }
): BoundSipWireAttemptFactsV2 {
  const value = attemptRecord(v1, BOUND_WIRE_ATTEMPT_KEYS);
  const checked = boundSipWireAttemptFactsV1(
    value,
    attemptIdentifier(value.attempt_id),
    value.via_branch
  );
  const finalized = attemptRecord(
    finalization,
    WIRE_ATTEMPT_FINALIZATION_KEYS
  );
  return Object.freeze({
    schema_id: 'sip-foundation-effect-wire-attempt-v2',
    schema_version: '2.0.0',
    lineage: lineageFromBoundV1(checked),
    via_branch: checked.via_branch,
    canonical_destination: canonicalDestination(
      finalized.canonical_destination
    ),
    transaction_binding_sha256: sha256(
      finalized.transaction_binding_sha256
    ),
    completion_scope: completionScope(finalized.completion_scope)
  });
}

export function validateBoundSipWireAttemptFacts(
  input: BoundSipWireAttemptFacts,
  expectedAttemptId: string
): BoundSipWireAttemptFacts {
  const candidate = snapshotDataRecord(
    input,
    BOUND_WIRE_ATTEMPT_KEYS.length,
    attemptError
  );
  if (candidate.schema_id === 'sip-foundation-wire-attempt-v1') {
    const value = attemptRecord(candidate, BOUND_WIRE_ATTEMPT_KEYS);
    return boundSipWireAttemptFactsV1(
      value,
      expectedAttemptId,
      value.via_branch
    );
  }
  if (candidate.schema_id === 'sip-foundation-effect-wire-attempt-v2') {
    const value = attemptRecord(candidate, BOUND_WIRE_ATTEMPT_V2_KEYS);
    if (value.schema_id !== 'sip-foundation-effect-wire-attempt-v2' ||
        value.schema_version !== '2.0.0') {
      attemptInvalid();
    }
    return Object.freeze({
      schema_id: 'sip-foundation-effect-wire-attempt-v2',
      schema_version: '2.0.0',
      lineage: wireAttemptLineage(value.lineage, expectedAttemptId),
      via_branch: viaBranch(value.via_branch),
      canonical_destination: canonicalDestination(
        value.canonical_destination
      ),
      transaction_binding_sha256: sha256(
        value.transaction_binding_sha256
      ),
      completion_scope: completionScope(value.completion_scope)
    });
  }
  return attemptInvalid();
}

function boundSipWireAttemptFactsV1(
  value: Readonly<Record<string, unknown>>,
  expectedAttemptId: string,
  generatedViaBranch: unknown
): BoundSipWireAttemptFactsV1 {
  return Object.freeze({
    ...validatedWireAttemptLineage(value, expectedAttemptId),
    via_branch: viaBranch(generatedViaBranch)
  });
}

function validatedWireAttemptLineage(
  value: Readonly<Record<string, unknown>>,
  expectedAttemptId: string
): Readonly<SipWireAttemptFacts> {
  if (value.schema_id !== 'sip-foundation-wire-attempt-v1' ||
      value.schema_version !== '1.0.0') {
    attemptInvalid();
  }
  const attemptId = attemptIdentifier(value.attempt_id);
  const transactionLineageId = attemptIdentifier(
    value.transaction_lineage_id
  );
  const semanticIntentSha256 = sha256(value.semantic_intent_sha256);
  const expected = attemptIdentifier(expectedAttemptId);
  if (attemptId !== expected) attemptInvalid();
  const parentAttemptId = value.parent_attempt_id === null
    ? null
    : attemptIdentifier(value.parent_attempt_id);
  if (parentAttemptId === attemptId) attemptInvalid();
  const lineageReason = value.lineage_reason;
  if ((lineageReason !== 'transaction_root' &&
       lineageReason !== 'derived_attempt') ||
      (lineageReason === 'transaction_root' &&
       (parentAttemptId !== null ||
        transactionLineageId !== attemptId)) ||
      (lineageReason === 'derived_attempt' && parentAttemptId === null)) {
    attemptInvalid();
  }
  return Object.freeze({
    schema_id: 'sip-foundation-wire-attempt-v1',
    schema_version: '1.0.0',
    attempt_id: attemptId,
    transaction_lineage_id: transactionLineageId,
    semantic_intent_sha256: semanticIntentSha256,
    parent_attempt_id: parentAttemptId,
    lineage_reason: lineageReason
  });
}

function wireAttemptLineage(
  input: unknown,
  expectedAttemptId: string
): Readonly<SipWireAttemptFacts> {
  const value = attemptRecord(input, WIRE_ATTEMPT_INPUT_KEYS);
  return validatedWireAttemptLineage(value, expectedAttemptId);
}

function lineageFromBoundV1(
  bound: BoundSipWireAttemptFactsV1
): Readonly<SipWireAttemptFacts> {
  return Object.freeze({
    schema_id: bound.schema_id,
    schema_version: bound.schema_version,
    attempt_id: bound.attempt_id,
    transaction_lineage_id: bound.transaction_lineage_id,
    semantic_intent_sha256: bound.semantic_intent_sha256,
    parent_attempt_id: bound.parent_attempt_id,
    lineage_reason: bound.lineage_reason
  });
}

function viaBranch(value: unknown): string {
  if (typeof value !== 'string' || !VIA_BRANCH_PATTERN.test(value)) {
    attemptInvalid();
  }
  return value;
}

function canonicalDestination(
  input: unknown
): Readonly<SipWireAttemptCanonicalDestination> {
  const value = attemptRecord(input, CANONICAL_DESTINATION_KEYS);
  if (typeof value.protocol !== 'string' ||
      !TRANSPORTS.has(value.protocol as SipTransportProtocol) ||
      typeof value.address !== 'string' || !isIP(value.address)) {
    attemptInvalid();
  }
  const selectionKind = value.selection_kind;
  if (selectionKind !== 'route_candidate' &&
      selectionKind !== 'datagram_destination' &&
      selectionKind !== 'connected_flow') {
    attemptInvalid();
  }
  const flowId = value.flow_id === null
    ? null
    : attemptIdentifier(value.flow_id);
  const flowGeneration = value.flow_generation === null
    ? null
    : positiveDecimalString(value.flow_generation);
  if ((selectionKind === 'connected_flow') !==
      (flowId !== null && flowGeneration !== null) ||
      (selectionKind !== 'connected_flow' &&
       (flowId !== null || flowGeneration !== null))) {
    attemptInvalid();
  }
  return Object.freeze({
    transport_id: attemptIdentifier(value.transport_id),
    protocol: value.protocol as SipTransportProtocol,
    address: value.address,
    port: attemptInteger(value.port, 1, 65_535),
    selection_kind: selectionKind,
    flow_id: flowId,
    flow_generation: flowGeneration
  });
}

function completionScope(value: unknown): SipWireAttemptCompletionScope {
  if (value !== 'transaction_peer_observation' &&
      value !== 'transport_accepted_terminal' &&
      value !== 'uas_core_deferred') {
    attemptInvalid();
  }
  return value;
}

export function sipRouteBindingSha256(
  routeBinding: BoundSipRouteBinding
): string {
  return canonicalVoicePayloadHash(routeBinding);
}

export function sipProtocolSessionBindingSha256(
  sessionBinding: BoundSipProtocolSessionBinding
): string {
  return canonicalVoicePayloadHash(sessionBinding);
}

export function sipWireAttemptFactsSha256(
  attemptFacts: BoundSipWireAttemptFacts
): string {
  return canonicalVoicePayloadHash(attemptFacts);
}

export function sipWireAttemptLineage(
  attemptFacts: BoundSipWireAttemptFacts
): Readonly<SipWireAttemptFacts> {
  return attemptFacts.schema_id ===
      'sip-foundation-effect-wire-attempt-v2'
    ? attemptFacts.lineage
    : lineageFromBoundV1(attemptFacts);
}

export function sipWireFreezeSha256(input: {
  route_binding_sha256: string;
  wire_attempt_facts_sha256: string;
  wire_sha256: string;
  wire_length_bytes: number;
}): string {
  return canonicalVoicePayloadHash(input);
}

function endpoint(value: unknown): Readonly<SipEndpoint> {
  const record = routeRecord(value, ENDPOINT_KEYS);
  return Object.freeze({
    host: host(record.host),
    port: integer(record.port, 1, 65_535)
  });
}

function resolvedEndpoint(
  value: unknown
): Readonly<SipResolvedEndpoint> {
  const record = routeRecord(value, LOCAL_ENDPOINT_KEYS);
  if (typeof record.address !== 'string' || !isIP(record.address)) {
    routeInvalid();
  }
  return Object.freeze({
    address: record.address,
    port: integer(record.port, 1, 65_535)
  });
}

function localEndpoint(
  value: unknown
): Readonly<{ address: string; port: number }> {
  const record = routeRecord(value, LOCAL_ENDPOINT_KEYS);
  if (typeof record.address !== 'string' || !isIP(record.address)) {
    routeInvalid();
  }
  return Object.freeze({
    address: record.address,
    port: integer(record.port, 1, 65_535)
  });
}

function host(value: unknown): string {
  if (typeof value !== 'string' ||
      (!isIP(value) && !HOSTNAME_PATTERN.test(value))) {
    routeInvalid();
  }
  return isIP(value) ? value : value.toLowerCase();
}

function nullableHostname(value: unknown): string | null {
  if (value === null) return null;
  return host(value);
}

function nullableIdentifier(value: unknown): string | null {
  if (value === null) return null;
  return identifier(value);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    routeInvalid();
  }
  return value;
}

function attemptIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    attemptInvalid();
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    attemptInvalid();
  }
  return value;
}

function routeSha256List(value: unknown): readonly string[] {
  const entries = snapshotClosedArray(
    value,
    MAX_AUTHORIZATION_HEADERS,
    routeError
  );
  return Object.freeze(entries.map((entry) => {
    if (typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry)) {
      routeInvalid();
    }
    return entry;
  }));
}

function boundedWireText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 ||
      value.length > maximum || /[\u0000\r\n]/.test(value)) {
    routeInvalid();
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) {
    routeInvalid();
  }
  return Number(value);
}

function attemptInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) {
    attemptInvalid();
  }
  return Number(value);
}

function positiveDecimalString(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) {
    attemptInvalid();
  }
  try {
    if (BigInt(value) > 18_446_744_073_709_551_615n) attemptInvalid();
  } catch {
    attemptInvalid();
  }
  return value;
}

function routeRecord(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  return snapshotClosedRecord(value, keys, routeError);
}

function attemptRecord(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  return snapshotClosedRecord(value, keys, attemptError);
}

function routeError(): SipFoundationError {
  return new SipFoundationError('sip_foundation_route_binding_invalid');
}

function attemptError(): SipFoundationError {
  return new SipFoundationError('sip_foundation_wire_attempt_invalid');
}

function routeInvalid(): never {
  throw routeError();
}

function attemptInvalid(): never {
  throw attemptError();
}
