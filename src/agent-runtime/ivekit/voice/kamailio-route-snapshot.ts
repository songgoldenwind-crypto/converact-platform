import { createHmac, timingSafeEqual } from 'node:crypto';

const WIRE_PREFIX = 'ivekit-kamailio-route-v1.';
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 1_024;
const MAX_POOLS = 256;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 300_000;

const BODY_KEYS = [
  'cell_id',
  'cell_lease_epoch',
  'edge_replica_count',
  'expires_at',
  'generated_at',
  'pools',
  'region_id',
  'schema_version',
  'sequence',
  'zone_id'
].sort();
const POOL_KEYS = ['nodes', 'pool_id', 'profile_id'].sort();
const NODE_KEYS = [
  'node_id',
  'pin_set_id',
  'priority',
  'reserved',
  'routing_weight',
  'safe_capacity',
  'sip_uri',
  'state',
  'used'
].sort();

export type KamailioRouteNodeState = 'accepting' | 'degraded' | 'draining' | 'offline';

export interface KamailioRouteSnapshotNode {
  node_id: string;
  sip_uri: string;
  pin_set_id: number;
  state: KamailioRouteNodeState;
  safe_capacity: number;
  used: number;
  reserved: number;
  routing_weight: number;
  priority: number;
}

export interface KamailioRouteSnapshotPool {
  pool_id: number;
  profile_id: string;
  nodes: KamailioRouteSnapshotNode[];
}

export interface KamailioRouteSnapshotBody {
  schema_version: '1.0.0';
  sequence: number;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  generated_at: string;
  expires_at: string;
  edge_replica_count: number;
  pools: KamailioRouteSnapshotPool[];
}

export interface KamailioRouteSnapshotKey {
  key_id: string;
  key: Buffer | string;
}

export interface KamailioRouteSnapshotVerificationInput {
  now: Date;
  expected_region_id: string;
  expected_zone_id: string;
  expected_cell_id: string;
  expected_cell_lease_epoch: number;
  last_accepted_sequence: number;
}

export interface VerifiedKamailioRouteSnapshot {
  key_id: string;
  body: Readonly<KamailioRouteSnapshotBody>;
}

export type KamailioRouteSnapshotErrorCode =
  | 'invalid_route_snapshot'
  | 'invalid_route_snapshot_signature'
  | 'unknown_route_snapshot_key'
  | 'route_snapshot_too_large'
  | 'route_snapshot_identity_mismatch'
  | 'route_snapshot_epoch_mismatch'
  | 'route_snapshot_sequence_regression'
  | 'route_snapshot_not_yet_valid'
  | 'route_snapshot_expired';

export class KamailioRouteSnapshotError extends Error {
  constructor(readonly code: KamailioRouteSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'KamailioRouteSnapshotError';
  }
}

export class KamailioRouteSnapshotCodec {
  readonly #currentKeyId: string;
  readonly #keys: Map<string, Buffer>;

  constructor(input: {
    current: KamailioRouteSnapshotKey;
    previous?: KamailioRouteSnapshotKey;
  }) {
    const current = checkedKey(input.current);
    const previous = input.previous ? checkedKey(input.previous) : null;
    if (previous?.key_id === current.key_id) {
      throw new Error('Kamailio route snapshot rotation requires different key ids');
    }
    this.#currentKeyId = current.key_id;
    this.#keys = new Map([[current.key_id, current.key]]);
    if (previous) this.#keys.set(previous.key_id, previous.key);
  }

  encode(body: KamailioRouteSnapshotBody): string {
    validateSnapshotBody(body);
    const canonicalBody = canonicalJson(body);
    const signature = hmac(requiredKey(this.#keys, this.#currentKeyId), canonicalBody);
    const wire = `${WIRE_PREFIX}${this.#currentKeyId}.${signature}\n${canonicalBody}`;
    if (Buffer.byteLength(wire) > MAX_SNAPSHOT_BYTES) {
      fail('route_snapshot_too_large', 'Kamailio route snapshot exceeds 4 MiB');
    }
    return wire;
  }

  verify(
    raw: string,
    input: KamailioRouteSnapshotVerificationInput
  ): VerifiedKamailioRouteSnapshot {
    if (typeof raw !== 'string') fail('invalid_route_snapshot', 'Kamailio route snapshot must be text');
    if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) {
      fail('route_snapshot_too_large', 'Kamailio route snapshot exceeds 4 MiB');
    }
    const newline = raw.indexOf('\n');
    if (newline < 1 || raw.indexOf('\n', newline + 1) !== -1) {
      fail('invalid_route_snapshot', 'Kamailio route snapshot envelope is invalid');
    }
    const header = raw.slice(0, newline);
    const canonicalBody = raw.slice(newline + 1);
    const match = header.match(
      /^ivekit-kamailio-route-v1\.([A-Za-z0-9][A-Za-z0-9._:-]{0,254})\.([A-Za-z0-9_-]{43})$/
    );
    if (!match) fail('invalid_route_snapshot', 'Kamailio route snapshot envelope is invalid');
    const keyId = match[1]!;
    const key = this.#keys.get(keyId);
    if (!key) fail('unknown_route_snapshot_key', 'Kamailio route snapshot key is unknown');
    if (!safeEqual(match[2]!, hmac(key, canonicalBody))) {
      fail('invalid_route_snapshot_signature', 'Kamailio route snapshot signature is invalid');
    }

    let body: KamailioRouteSnapshotBody;
    try {
      body = JSON.parse(canonicalBody) as KamailioRouteSnapshotBody;
    } catch {
      fail('invalid_route_snapshot', 'Kamailio route snapshot body is not JSON');
    }
    if (canonicalJson(body) !== canonicalBody) {
      fail('invalid_route_snapshot', 'Kamailio route snapshot body is not canonical JSON');
    }
    validateSnapshotBody(body);
    validateVerificationInput(input);
    if (
      body.region_id !== input.expected_region_id ||
      body.zone_id !== input.expected_zone_id ||
      body.cell_id !== input.expected_cell_id
    ) {
      fail('route_snapshot_identity_mismatch', 'Kamailio route snapshot topology does not match this Edge');
    }
    if (body.cell_lease_epoch !== input.expected_cell_lease_epoch) {
      fail('route_snapshot_epoch_mismatch', 'Kamailio route snapshot Cell lease epoch does not match');
    }
    if (body.sequence <= input.last_accepted_sequence) {
      fail('route_snapshot_sequence_regression', 'Kamailio route snapshot sequence did not advance');
    }
    const nowMs = input.now.getTime();
    const generatedMs = Date.parse(body.generated_at);
    const expiresMs = Date.parse(body.expires_at);
    if (nowMs < generatedMs) {
      fail('route_snapshot_not_yet_valid', 'Kamailio route snapshot is not yet valid');
    }
    if (nowMs >= expiresMs) {
      fail('route_snapshot_expired', 'Kamailio route snapshot expired');
    }
    return deepFreeze({
      key_id: keyId,
      body: structuredClone(body)
    }) as VerifiedKamailioRouteSnapshot;
  }
}

function validateSnapshotBody(body: KamailioRouteSnapshotBody): void {
  try {
    exactKeys(body, BODY_KEYS, 'body');
    if (body.schema_version !== '1.0.0') invalid('schema version');
    boundedInteger(body.sequence, 1, Number.MAX_SAFE_INTEGER, 'sequence');
    safeId(body.region_id, 'region');
    safeId(body.zone_id, 'zone');
    safeId(body.cell_id, 'cell');
    boundedInteger(body.cell_lease_epoch, 1, 0xffff_ffff, 'Cell lease epoch');
    boundedInteger(body.edge_replica_count, 1, 128, 'Edge replica count');
    const generatedMs = exactIsoTime(body.generated_at, 'generated time');
    const expiresMs = exactIsoTime(body.expires_at, 'expiration time');
    const ttlMs = expiresMs - generatedMs;
    if (ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) invalid('TTL');
    if (!Array.isArray(body.pools) || body.pools.length < 1 || body.pools.length > MAX_POOLS) {
      invalid('pool count');
    }

    const poolIds = new Set<number>();
    const profileIds = new Set<string>();
    const nodeIds = new Set<string>();
    const pinSetIds = new Set<number>();
    let nodeCount = 0;
    for (const pool of body.pools) {
      exactKeys(pool, POOL_KEYS, 'pool');
      boundedInteger(pool.pool_id, 1, 0x7fff_ffff, 'pool id');
      if (poolIds.has(pool.pool_id)) invalid('duplicate pool id');
      poolIds.add(pool.pool_id);
      safeProfile(pool.profile_id);
      if (profileIds.has(pool.profile_id)) invalid('duplicate profile id');
      profileIds.add(pool.profile_id);
      if (!Array.isArray(pool.nodes)) invalid('pool nodes');
      for (const node of pool.nodes) {
        nodeCount += 1;
        if (nodeCount > MAX_NODES) invalid('node count');
        exactKeys(node, NODE_KEYS, 'node');
        safeId(node.node_id, 'node');
        if (nodeIds.has(node.node_id)) invalid('duplicate node id');
        nodeIds.add(node.node_id);
        checkedSipUri(node.sip_uri);
        boundedInteger(node.pin_set_id, 1, 0x7fff_ffff, 'pin set id');
        if (pinSetIds.has(node.pin_set_id)) invalid('duplicate pin set id');
        pinSetIds.add(node.pin_set_id);
        if (!['accepting', 'degraded', 'draining', 'offline'].includes(node.state)) {
          invalid('node state');
        }
        boundedNumber(node.safe_capacity, 1, 1_000_000_000, 'safe capacity');
        boundedNumber(node.used, 0, 1_000_000_000, 'used capacity');
        boundedNumber(node.reserved, 0, 1_000_000_000, 'reserved capacity');
        boundedInteger(node.routing_weight, 1, 100, 'routing weight');
        boundedInteger(node.priority, 0, 65_535, 'priority');
        if (
          (node.state === 'accepting' || node.state === 'degraded') &&
          node.used + node.reserved >= node.safe_capacity
        ) {
          invalid('accepting node headroom');
        }
      }
    }
    for (const pinSetId of pinSetIds) {
      if (poolIds.has(pinSetId)) invalid('pool and pin set id collision');
    }
  } catch (error) {
    if (error instanceof KamailioRouteSnapshotError) throw error;
    fail(
      'invalid_route_snapshot',
      `Kamailio route snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function validateVerificationInput(input: KamailioRouteSnapshotVerificationInput): void {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error('Kamailio route snapshot verification time is invalid');
  }
  safeId(input.expected_region_id, 'expected region');
  safeId(input.expected_zone_id, 'expected zone');
  safeId(input.expected_cell_id, 'expected cell');
  boundedInteger(input.expected_cell_lease_epoch, 1, 0xffff_ffff, 'expected Cell lease epoch');
  boundedInteger(input.last_accepted_sequence, 0, Number.MAX_SAFE_INTEGER, 'last accepted sequence');
}

function checkedKey(input: KamailioRouteSnapshotKey): { key_id: string; key: Buffer } {
  safeId(input?.key_id, 'key');
  const key = Buffer.isBuffer(input?.key) ? Buffer.from(input.key) : decodeBase64Key(input?.key);
  if (key.length < 32) throw new Error(`Kamailio route snapshot key ${input.key_id} is too short`);
  return { key_id: input.key_id, key };
}

function decodeBase64Key(value: string | undefined): Buffer {
  const text = String(value || '');
  const key = Buffer.from(text, 'base64');
  if (!text || key.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new Error('Kamailio route snapshot key is not canonical base64');
  }
  return key;
}

function requiredKey(keys: Map<string, Buffer>, keyId: string): Buffer {
  const key = keys.get(keyId);
  if (!key) fail('unknown_route_snapshot_key', 'Kamailio route snapshot key is unknown');
  return key;
}

function exactKeys(value: unknown, expected: string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    invalid(`${label} fields`);
  }
}

function safeId(value: string | undefined, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error(`invalid ${label}`);
  }
}

function safeProfile(value: string): void {
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(String(value || ''))) {
    invalid('profile id');
  }
}

function checkedSipUri(value: string): void {
  const text = String(value || '');
  if (text.length > 512 || /[\s\x00-\x1f\x7f]/.test(text)) invalid('SIP URI');
  const match = text.match(
    /^(sips?):(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,253})(?::([1-9][0-9]{0,4}))?(?:;transport=(udp|tcp|tls))?$/
  );
  if (!match) invalid('SIP URI');
  const host = match[2]!;
  const port = match[3] ? Number(match[3]) : null;
  const transport = match[4] || '';
  if (port !== null && port > 65_535) invalid('SIP URI port');
  if (!host.startsWith('[') && (
    host.startsWith('.') || host.endsWith('.') || host.includes('..') ||
    host.split('.').some((label) => label.startsWith('-') || label.endsWith('-'))
  )) invalid('SIP URI host');
  if (match[1] === 'sips' && transport && transport !== 'tls') invalid('SIPS transport');
}

function exactIsoTime(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid(label);
  return time;
}

function boundedInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${label}`);
}

function boundedNumber(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`invalid ${label}`);
}

function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('non-finite canonical value');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') invalid('non-JSON canonical value');
  if (ancestors.has(value)) invalid('circular canonical value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid('non-plain canonical value');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`
    ).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function invalid(label: string): never {
  throw new Error(`invalid ${label}`);
}

function fail(code: KamailioRouteSnapshotErrorCode, message: string): never {
  throw new KamailioRouteSnapshotError(code, message);
}
