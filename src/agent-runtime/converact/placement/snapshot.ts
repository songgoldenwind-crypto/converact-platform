import {
  createHmac,
  timingSafeEqual
} from 'node:crypto';

import {
  PlacementError,
  type CapacityDimensionState,
  type PlacementSnapshotBody,
  type PlacementTokenClaims,
  type SignedPlacementSnapshot,
  type VerifiedPlacementSnapshot
} from './types.js';

export class PlacementSnapshotSigner {
  readonly #keys: Map<string, Buffer>;

  constructor(keys: Record<string, Buffer | string>) {
    this.#keys = signingKeys(keys);
  }

  sign(body: PlacementSnapshotBody, keyId: string): SignedPlacementSnapshot {
    validateSnapshotBody(body);
    const key = requiredKey(this.#keys, keyId, 'unknown_snapshot_key');
    const cloned = structuredClone(body);
    return deepFreeze({
      key_id: keyId,
      body: cloned,
      signature: hmac(key, canonicalJson(cloned))
    }) as SignedPlacementSnapshot;
  }

  verify(
    snapshot: SignedPlacementSnapshot,
    input: {
      now: Date;
      last_accepted_version: number;
      stale_grace_ms: number;
    }
  ): VerifiedPlacementSnapshot {
    validateSnapshotBody(snapshot.body);
    const key = requiredKey(this.#keys, snapshot.key_id, 'unknown_snapshot_key');
    if (!safeEqual(snapshot.signature, hmac(key, canonicalJson(snapshot.body)))) {
      throw new PlacementError({ code: 'invalid_snapshot_signature', status: 401 });
    }
    if (!Number.isInteger(input.last_accepted_version) || input.last_accepted_version < 0) {
      throw new Error('last accepted snapshot version is invalid');
    }
    if (snapshot.body.snapshot_version < input.last_accepted_version) {
      throw new PlacementError({
        code: 'snapshot_version_regression',
        status: 409,
        details: {
          snapshot_version: snapshot.body.snapshot_version,
          last_accepted_version: input.last_accepted_version
        }
      });
    }
    if (!Number.isInteger(input.stale_grace_ms) || input.stale_grace_ms < 0) {
      throw new Error('snapshot stale grace is invalid');
    }
    const nowMs = validDate(input.now, 'snapshot verification time').getTime();
    const generatedMs = Date.parse(snapshot.body.generated_at);
    if (nowMs < generatedMs) {
      throw new PlacementError({
        code: 'placement_snapshot_not_yet_valid',
        status: 409,
        retryable: true
      });
    }
    const expiresMs = Date.parse(snapshot.body.expires_at);
    if (nowMs > expiresMs + input.stale_grace_ms) {
      throw new PlacementError({
        code: 'placement_snapshot_expired',
        status: 503,
        retryable: true
      });
    }
    return deepFreeze({
      body: structuredClone(snapshot.body),
      freshness: nowMs > expiresMs ? 'grace' : 'fresh'
    }) as VerifiedPlacementSnapshot;
  }
}

export class PlacementTokenSigner {
  readonly #keys: Map<string, Buffer>;

  constructor(keys: Record<string, Buffer | string>) {
    this.#keys = signingKeys(keys);
  }

  issue(claims: PlacementTokenClaims): string {
    validateTokenClaims(claims);
    const key = requiredKey(this.#keys, claims.key_id, 'unknown_placement_token_key');
    const payload = Buffer.from(canonicalJson(claims)).toString('base64url');
    return `${payload}.${hmac(key, payload)}`;
  }

  verify(token: string, now: Date): PlacementTokenClaims {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra) return invalidToken();
    let claims: PlacementTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      validateTokenClaims(claims);
    } catch {
      return invalidToken();
    }
    const key = requiredKey(this.#keys, claims.key_id, 'invalid_placement_token');
    if (!safeEqual(signature, hmac(key, payload))) return invalidToken();
    const nowMs = validDate(now, 'placement token verification time').getTime();
    const issuedMs = Date.parse(claims.issued_at);
    const expiresMs = Date.parse(claims.expires_at);
    if (nowMs < issuedMs) {
      throw new PlacementError({
        code: 'placement_token_not_yet_valid',
        status: 409,
        retryable: true
      });
    }
    if (nowMs >= expiresMs) {
      throw new PlacementError({
        code: 'placement_token_expired',
        status: 409,
        retryable: true
      });
    }
    return deepFreeze(structuredClone(claims)) as PlacementTokenClaims;
  }
}

function validateSnapshotBody(body: PlacementSnapshotBody): void {
  if (!body || body.schema_version !== '1.0.0') throw new Error('invalid placement snapshot schema');
  if (!Number.isSafeInteger(body.snapshot_version) || body.snapshot_version < 1) {
    throw new Error('invalid placement snapshot version');
  }
  const generated = Date.parse(body.generated_at);
  const expires = Date.parse(body.expires_at);
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || expires <= generated) {
    throw new Error('invalid placement snapshot validity window');
  }
  safeProfile(body.profile_id);
  const regionIds = new Set<string>();
  for (const region of body.regions) {
    safeId(region.region_id, 'region');
    if (regionIds.has(region.region_id)) throw new Error('duplicate placement region');
    regionIds.add(region.region_id);
    const zoneIds = new Set<string>();
    for (const zone of region.zones) {
      safeId(zone.zone_id, 'zone');
      if (!['accepting', 'degraded', 'draining', 'offline'].includes(zone.state)) {
        throw new Error(`invalid placement zone ${zone.zone_id}`);
      }
      if (zoneIds.has(zone.zone_id)) throw new Error('duplicate placement zone');
      zoneIds.add(zone.zone_id);
      const cellIds = new Set<string>();
      for (const cell of zone.cells) {
        safeId(cell.cell_id, 'cell');
        if (cellIds.has(cell.cell_id)) throw new Error('duplicate placement cell');
        cellIds.add(cell.cell_id);
        if (!['accepting', 'degraded', 'draining', 'offline'].includes(cell.state) ||
            !Number.isFinite(cell.routing_weight) || cell.routing_weight <= 0 ||
            !Number.isSafeInteger(cell.capacity_vector_sequence) || cell.capacity_vector_sequence < 0 ||
            !Number.isFinite(Date.parse(cell.capacity_expires_at)) ||
            !Number.isFinite(cell.dominant_utilization_ratio) ||
            cell.dominant_utilization_ratio < 0 ||
            !Number.isInteger(cell.cell_lease_epoch) || cell.cell_lease_epoch < 1 ||
            cell.cell_lease_epoch > 0xffff_ffff) {
          throw new Error(`invalid placement cell ${cell.cell_id}`);
        }
        checkedEndpoint(cell.admission_endpoint);
        if (new Set(cell.supported_interaction_kinds).size !==
            cell.supported_interaction_kinds.length ||
            new Set(cell.supported_profile_ids).size !== cell.supported_profile_ids.length ||
            cell.supported_interaction_kinds.length === 0 ||
            cell.supported_profile_ids.length === 0 ||
            cell.supported_interaction_kinds.some((kind) =>
              !['tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote']
                .includes(kind))) {
          throw new Error(`invalid placement cell capabilities ${cell.cell_id}`);
        }
        for (const profile of cell.supported_profile_ids) safeProfile(profile);
        const utilization = validateCapacityDimensions(cell.capacity_dimensions);
        if (Math.abs(utilization - cell.dominant_utilization_ratio) > 1e-9) {
          throw new Error(`invalid placement cell utilization ${cell.cell_id}`);
        }
        if (cell.state === 'accepting' && utilization > 1) {
          throw new Error(`accepting placement cell exceeds safe capacity ${cell.cell_id}`);
        }
      }
    }
  }
}

function validateTokenClaims(claims: PlacementTokenClaims): void {
  const expected = [
    'key_id', 'tenant_id', 'interaction_id', 'interaction_kind', 'profile_id',
    'region_id', 'zone_id', 'cell_id', 'owner_node_id', 'owner_epoch',
    'reservation_id', 'issued_at', 'expires_at'
  ].sort();
  if (!claims || typeof claims !== 'object' ||
      JSON.stringify(Object.keys(claims).sort()) !== JSON.stringify(expected)) {
    throw new Error('invalid placement token claims');
  }
  for (const key of [
    'key_id', 'tenant_id', 'interaction_id', 'region_id', 'zone_id',
    'cell_id', 'owner_node_id', 'reservation_id'
  ] as const) safeId(claims[key], key);
  if (!['tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote']
    .includes(claims.interaction_kind)) {
    throw new Error('invalid placement token interaction kind');
  }
  safeProfile(claims.profile_id);
  if (!/^(?:0|[1-9]\d{0,19})$/.test(claims.owner_epoch) ||
      BigInt(claims.owner_epoch) > 0xffff_ffff_ffff_ffffn) {
    throw new Error('invalid placement token owner epoch');
  }
  const issued = Date.parse(claims.issued_at);
  const expires = Date.parse(claims.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    throw new Error('invalid placement token validity window');
  }
}

function signingKeys(keys: Record<string, Buffer | string>): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(keys)) {
    safeId(id, 'key');
    const key = Buffer.isBuffer(value) ? Buffer.from(value) : decodeBase64Key(value);
    if (key.length < 32) throw new Error(`placement signing key ${id} is too short`);
    result.set(id, key);
  }
  if (result.size === 0) throw new Error('at least one placement signing key is required');
  return result;
}

function decodeBase64Key(value: string): Buffer {
  const text = String(value || '');
  const key = Buffer.from(text, 'base64');
  if (!text || key.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new Error('placement signing key is not canonical base64');
  }
  return key;
}

function validateCapacityDimensions(dimensions: Record<string, CapacityDimensionState>): number {
  const entries = Object.entries(dimensions || {});
  if (entries.length === 0) throw new Error('placement capacity dimensions are required');
  let dominant = 0;
  for (const [name, dimension] of entries) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
        !dimension.unit || dimension.unit.length > 64 ||
        !Number.isFinite(dimension.safe_capacity) || dimension.safe_capacity <= 0 ||
        !Number.isFinite(dimension.used) || dimension.used < 0 ||
        !Number.isFinite(dimension.reserved) || dimension.reserved < 0) {
      throw new Error(`invalid placement capacity dimension ${name}`);
    }
    dominant = Math.max(
      dominant,
      (dimension.used + dimension.reserved) / dimension.safe_capacity
    );
  }
  return dominant;
}

function checkedEndpoint(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid placement admission endpoint');
  }
}

function requiredKey(keys: Map<string, Buffer>, id: string, code: string): Buffer {
  const key = keys.get(id);
  if (!key) throw new PlacementError({ code, status: 401 });
  return key;
}

function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function invalidToken(): never {
  throw new PlacementError({ code: 'invalid_placement_token', status: 401 });
}

function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite canonical value');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('non-JSON canonical value');
  if (ancestors.has(value)) throw new Error('circular canonical value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('non-plain canonical value');
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key], ancestors)}`
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

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error(`invalid placement ${label}`);
  }
}

function safeProfile(value: string): void {
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(value)) {
    throw new Error('invalid placement profile');
  }
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`);
  return value;
}
