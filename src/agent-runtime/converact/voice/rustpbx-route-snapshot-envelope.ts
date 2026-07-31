import { createHmac, timingSafeEqual } from 'node:crypto';

export const RUSTPBX_ROUTE_SNAPSHOT_MAX_ROUTES = 100_000;
export const RUSTPBX_ROUTE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const RUSTPBX_ROUTE_SNAPSHOT_WIRE_PREFIX = 'ivekit-route-snapshot-v1.';

export interface RustPbxRouteSnapshotEnvelopeBody<Route = unknown> {
  schema_version: '1.0.0';
  sequence: number;
  tenant_id: string;
  profile_id: string;
  source_revision: number;
  generated_at: string;
  expires_at: string;
  routes: Record<string, Route>;
}

export function verifyRustPbxRouteSnapshotEnvelope<Route = unknown>(
  raw: string,
  input: {
    signing_key: string;
    tenant_id: string;
    profile_id: string;
    now?: Date;
  }
): RustPbxRouteSnapshotEnvelopeBody<Route> {
  const now = input.now ?? new Date();
  validDate(now);
  const body = decodeRustPbxRouteSnapshotEnvelope<Route>(
    raw,
    decodeRustPbxRouteSnapshotKey(input.signing_key),
    validIdentifier(input.tenant_id, 'tenant_id'),
    validIdentifier(input.profile_id, 'profile_id')
  );
  if (Date.parse(body.expires_at) <= now.getTime()) {
    throw new Error('RustPBX route snapshot is expired');
  }
  return body;
}

export function decodeRustPbxRouteSnapshotEnvelope<Route = unknown>(
  raw: string,
  signingKey: Buffer,
  tenantId: string,
  profileId: string
): RustPbxRouteSnapshotEnvelopeBody<Route> {
  if (!raw || Buffer.byteLength(raw) > RUSTPBX_ROUTE_SNAPSHOT_MAX_BYTES) {
    throw new Error('RustPBX route snapshot envelope is invalid');
  }
  const newline = raw.indexOf('\n');
  const header = newline < 0 ? '' : raw.slice(0, newline);
  const encodedBody = newline < 0 ? '' : raw.slice(newline + 1);
  const escapedPrefix = RUSTPBX_ROUTE_SNAPSHOT_WIRE_PREFIX.replaceAll('.', '\\.');
  if (!new RegExp(`^${escapedPrefix}[A-Za-z0-9_-]{43}$`).test(header) || !encodedBody) {
    throw new Error('RustPBX route snapshot envelope is invalid');
  }
  const signature = header.slice(RUSTPBX_ROUTE_SNAPSHOT_WIRE_PREFIX.length);
  const expected = createHmac('sha256', signingKey).update(encodedBody).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('RustPBX route snapshot signature mismatch');
  }
  const body = plainRecord(
    JSON.parse(encodedBody)
  ) as unknown as RustPbxRouteSnapshotEnvelopeBody<Route>;
  if (canonicalRustPbxRouteSnapshotJson(body) !== encodedBody
    || body.schema_version !== '1.0.0'
    || !Number.isSafeInteger(body.sequence) || body.sequence < 1
    || !Number.isSafeInteger(body.source_revision) || body.source_revision < 1
    || body.tenant_id !== tenantId || body.profile_id !== profileId) {
    throw new Error('RustPBX route snapshot identity or schema is invalid');
  }
  const generatedAt = Date.parse(body.generated_at);
  const expiresAt = Date.parse(body.expires_at);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= generatedAt || expiresAt - generatedAt > 300_000
    || !isPlainRecord(body.routes)
    || Object.keys(body.routes).length > RUSTPBX_ROUTE_SNAPSHOT_MAX_ROUTES) {
    throw new Error('RustPBX route snapshot body is invalid');
  }
  for (const key of Object.keys(body.routes)) validAddressHmac(key);
  return body;
}

export function decodeRustPbxRouteSnapshotKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(value || ''))) {
    throw new Error('RustPBX route snapshot signing key must be canonical base64');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('RustPBX route snapshot signing key must decode to 32 bytes');
  }
  return key;
}

export function canonicalRustPbxRouteSnapshotJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function validAddressHmac(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) {
    throw new Error('RustPBX route snapshot address HMAC is invalid');
  }
  return value;
}

function validIdentifier(value: string, field: string): string {
  const result = String(value || '').trim();
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`RustPBX route snapshot ${field} is invalid`);
  }
  return result;
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('RustPBX route snapshot clock is invalid');
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error('RustPBX route snapshot JSON object is invalid');
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON rejects non-finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('canonical JSON rejects circular objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    if (!isPlainRecord(value)) {
      throw new TypeError('canonical JSON rejects non-plain objects');
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key], ancestors)
    ]));
  } finally {
    ancestors.delete(value);
  }
}
