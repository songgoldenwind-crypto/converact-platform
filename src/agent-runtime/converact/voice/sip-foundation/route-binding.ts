import { isIP } from 'node:net';

import { canonicalVoicePayloadHash } from '../canonical.js';
import { snapshotClosedArray, snapshotClosedRecord } from './closed-schema.js';
import {
  SipFoundationError,
  type BoundSipProtocolSessionBinding,
  type BoundSipRouteBinding,
  type BoundSipWireAttemptFacts,
  type SipEndpoint,
  type SipProtocolSessionBinding,
  type SipResolvedEndpoint,
  type SipRouteBinding,
  type SipTransportProtocol,
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
): BoundSipWireAttemptFacts {
  const value = attemptRecord(input, WIRE_ATTEMPT_INPUT_KEYS);
  return boundSipWireAttemptFacts(
    value,
    expectedAttemptId,
    generatedViaBranch
  );
}

export function validateBoundSipWireAttemptFacts(
  input: BoundSipWireAttemptFacts,
  expectedAttemptId: string
): BoundSipWireAttemptFacts {
  const value = attemptRecord(input, BOUND_WIRE_ATTEMPT_KEYS);
  return boundSipWireAttemptFacts(
    value,
    expectedAttemptId,
    value.via_branch
  );
}

function boundSipWireAttemptFacts(
  value: Readonly<Record<string, unknown>>,
  expectedAttemptId: string,
  generatedViaBranch: unknown
): BoundSipWireAttemptFacts {
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
  if (typeof generatedViaBranch !== 'string' ||
      !VIA_BRANCH_PATTERN.test(generatedViaBranch)) {
    attemptInvalid();
  }
  return Object.freeze({
    schema_id: 'sip-foundation-wire-attempt-v1',
    schema_version: '1.0.0',
    attempt_id: attemptId,
    transaction_lineage_id: transactionLineageId,
    semantic_intent_sha256: semanticIntentSha256,
    parent_attempt_id: parentAttemptId,
    lineage_reason: lineageReason,
    via_branch: generatedViaBranch
  });
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
