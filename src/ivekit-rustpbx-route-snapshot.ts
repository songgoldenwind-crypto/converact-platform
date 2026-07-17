import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import type { PgQueryable } from './db-pg.js';
import { withPgTenant } from './db-pg-tenant.js';
import { RustPbxRouterAdapter, type RustPbxRouterResponse } from './agent-runtime/ivekit/voice/adapters/rustpbx-routing.js';
import { VOICE_CAPABILITIES } from './agent-runtime/ivekit/voice/capabilities.js';
import {
  compileRustPbxRouteRules,
  type VoiceRouteDependency
} from './agent-runtime/ivekit/voice/route-compiler.js';
import type { VoiceCapability } from './agent-runtime/ivekit/voice/types.js';

const MAX_ROUTES = 100_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const WIRE_PREFIX = 'ivekit-route-snapshot-v1.';

export interface RustPbxRouteProjectionProfile {
  tenant_id: string;
  profile_id: string;
  adapter: 'rustpbx';
  status: 'enabled' | 'degraded';
  source_revision: number;
}

export interface RustPbxRouteProjectionRow {
  address_hmac: string;
  rules: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

export interface RustPbxRouteSnapshotRepository {
  loadProfileRevision(
    tenantId: string,
    profileId: string
  ): Promise<RustPbxRouteProjectionProfile | null>;
  listRoutes(tenantId: string, profileId: string): Promise<RustPbxRouteProjectionRow[]>;
}

export interface RustPbxRouteSnapshotBody {
  schema_version: '1.0.0';
  sequence: number;
  tenant_id: string;
  profile_id: string;
  source_revision: number;
  generated_at: string;
  expires_at: string;
  routes: Record<string, RustPbxRouterResponse>;
}

export interface RustPbxRouteSnapshotProjector {
  runOnce(now?: Date): Promise<{
    path: string;
    route_count: number;
    body: RustPbxRouteSnapshotBody;
    published: boolean;
  }>;
}

export class PostgresRustPbxRouteSnapshotRepository implements RustPbxRouteSnapshotRepository {
  constructor(private readonly pg: PgQueryable) {}

  loadProfileRevision(
    tenantId: string,
    profileId: string
  ): Promise<RustPbxRouteProjectionProfile | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<{
        tenant_id: string;
        profile_id: string;
        adapter: string;
        status: string;
        source_revision: string | number;
      }>(
        `SELECT profile.tenant_id, profile.id AS profile_id, profile.adapter, profile.status,
                revision.revision AS source_revision
         FROM ivekit_voice_deployment_profiles profile
         INNER JOIN ivekit_voice_route_snapshot_revisions revision
           ON revision.tenant_id = profile.tenant_id AND revision.profile_id = profile.id
         WHERE profile.tenant_id = $1 AND profile.id = $2
           AND profile.adapter = 'rustpbx'
           AND profile.status IN ('enabled', 'degraded')
         LIMIT 1`,
        [tenantId, profileId]
      );
      const row = result.rows[0];
      return row ? {
        tenant_id: String(row.tenant_id),
        profile_id: String(row.profile_id),
        adapter: 'rustpbx',
        status: row.status === 'degraded' ? 'degraded' : 'enabled',
        source_revision: positiveSafeInteger(row.source_revision, 'source_revision')
      } : null;
    });
  }

  listRoutes(tenantId: string, profileId: string): Promise<RustPbxRouteProjectionRow[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<{
        address_hmac: string;
        rules: unknown;
        capabilities: unknown;
      }>(
        `WITH latest_capability AS (
           SELECT snapshot.capabilities
           FROM ivekit_voice_capability_snapshots snapshot
           WHERE snapshot.tenant_id = $1 AND snapshot.profile_id = $2
           ORDER BY snapshot.checked_at DESC, snapshot.created_at DESC, snapshot.id DESC
           LIMIT 1
         )
         SELECT did.e164_hmac AS address_hmac,
                version.rules,
                COALESCE((SELECT capabilities FROM latest_capability), '{}'::jsonb) AS capabilities
         FROM ivekit_voice_dids did
         INNER JOIN ivekit_voice_sip_trunks trunk
           ON trunk.tenant_id = did.tenant_id AND trunk.id = did.trunk_id
         INNER JOIN ivekit_voice_routes route
           ON route.tenant_id = did.tenant_id AND route.id = did.route_id
         INNER JOIN ivekit_voice_route_versions version
           ON version.tenant_id = route.tenant_id
          AND version.route_id = route.id
          AND version.version = route.current_published_version
         WHERE did.tenant_id = $1
           AND trunk.profile_id = $2
           AND did.status = 'active'
           AND trunk.status = 'active'
           AND route.profile_id = $2
           AND route.status = 'active'
           AND route.direction IN ('inbound', 'both')
           AND version.deployment_state = 'applied'
         ORDER BY did.e164_hmac
         LIMIT 100001`,
        [tenantId, profileId]
      );
      return result.rows.map((row) => ({
        address_hmac: String(row.address_hmac),
        rules: plainRecord(row.rules),
        capabilities: plainRecord(row.capabilities)
      }));
    });
  }
}

export function createRustPbxRouteSnapshotProjector(input: {
  repository: RustPbxRouteSnapshotRepository;
  tenant_id: string;
  profile_id: string;
  output_path: string;
  signing_key: string;
  ttl_ms: number;
  available_dependencies?: readonly VoiceRouteDependency[];
}): RustPbxRouteSnapshotProjector {
  const tenantId = validIdentifier(input.tenant_id, 'tenant_id');
  const profileId = validIdentifier(input.profile_id, 'profile_id');
  const outputPath = resolve(requiredText(input.output_path, 'output_path'));
  const signingKey = decodeKey(input.signing_key);
  const ttlMs = boundedInteger(input.ttl_ms, 1_000, 300_000, 'ttl_ms');
  const availableDependencies = new Set(input.available_dependencies ?? []);
  const routerAdapter = new RustPbxRouterAdapter();
  const renewalWindowMs = Math.max(1_000, Math.floor(ttlMs / 2));
  let cachedBody: RustPbxRouteSnapshotBody | null = null;
  let cachedRoutesJson: string | null = null;
  let cachedRouteCount = 0;

  return {
    async runOnce(now = new Date()) {
      validDate(now);
      const profile = await input.repository.loadProfileRevision(tenantId, profileId);
      if (!profile || profile.tenant_id !== tenantId || profile.profile_id !== profileId
        || profile.adapter !== 'rustpbx'
        || (profile.status !== 'enabled' && profile.status !== 'degraded')
        || !Number.isSafeInteger(profile.source_revision) || profile.source_revision < 1) {
        throw new Error('RustPBX route snapshot profile is unavailable');
      }
      if (!cachedBody) {
        cachedBody = await readExistingBody(outputPath, signingKey, tenantId, profileId);
        if (cachedBody) {
          cachedRoutesJson = canonicalJson(cachedBody.routes);
          cachedRouteCount = Object.keys(cachedBody.routes).length;
        }
      }
      let routes = cachedBody?.routes ?? null;
      const sourceChanged = !cachedBody || cachedBody.source_revision !== profile.source_revision;
      if (sourceChanged) {
        const rows = await input.repository.listRoutes(tenantId, profileId);
        if (rows.length > MAX_ROUTES) {
          throw new Error(`RustPBX route snapshot exceeds ${MAX_ROUTES} routes`);
        }
        routes = compileRoutes(rows, routerAdapter, availableDependencies);
        cachedRoutesJson = canonicalJson(routes);
        cachedRouteCount = rows.length;
      }
      if (!routes || !cachedRoutesJson) {
        throw new Error('RustPBX route snapshot routes are unavailable');
      }
      const expiresAt = cachedBody ? Date.parse(cachedBody.expires_at) : 0;
      if (!sourceChanged && expiresAt - now.getTime() > renewalWindowMs) {
        return {
          path: outputPath,
          route_count: cachedRouteCount,
          body: cachedBody!,
          published: false
        };
      }
      const sequence = Math.max(1, now.getTime(), (cachedBody?.sequence ?? 0) + 1);
      if (!Number.isSafeInteger(sequence)) {
        throw new Error('RustPBX route snapshot sequence exceeds JavaScript safe integer range');
      }
      const body: RustPbxRouteSnapshotBody = {
        schema_version: '1.0.0',
        sequence,
        tenant_id: tenantId,
        profile_id: profileId,
        source_revision: profile.source_revision,
        generated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        routes
      };
      const encodedBody = encodeSnapshotBody(body, cachedRoutesJson);
      const signature = createHmac('sha256', signingKey)
        .update(encodedBody)
        .digest('base64url');
      const wire = `${WIRE_PREFIX}${signature}\n${encodedBody}`;
      if (Buffer.byteLength(wire) > MAX_SNAPSHOT_BYTES) {
        throw new Error('RustPBX route snapshot exceeds 64 MiB');
      }
      await writeAtomicSnapshot(outputPath, wire);
      cachedBody = body;
      return {
        path: outputPath,
        route_count: cachedRouteCount,
        body,
        published: true
      };
    }
  };
}

function encodeSnapshotBody(body: RustPbxRouteSnapshotBody, routesJson: string): string {
  return [
    '{"expires_at":', JSON.stringify(body.expires_at),
    ',"generated_at":', JSON.stringify(body.generated_at),
    ',"profile_id":', JSON.stringify(body.profile_id),
    ',"routes":', routesJson,
    ',"schema_version":', JSON.stringify(body.schema_version),
    ',"sequence":', JSON.stringify(body.sequence),
    ',"source_revision":', JSON.stringify(body.source_revision),
    ',"tenant_id":', JSON.stringify(body.tenant_id),
    '}'
  ].join('');
}

export function verifyRustPbxRouteSnapshotEnvelope(
  raw: string,
  input: {
    signing_key: string;
    tenant_id: string;
    profile_id: string;
    now?: Date;
  }
): RustPbxRouteSnapshotBody {
  const now = input.now ?? new Date();
  validDate(now);
  const body = decodeEnvelope(
    raw,
    decodeKey(input.signing_key),
    validIdentifier(input.tenant_id, 'tenant_id'),
    validIdentifier(input.profile_id, 'profile_id')
  );
  if (Date.parse(body.expires_at) <= now.getTime()) {
    throw new Error('RustPBX route snapshot is expired');
  }
  return body;
}

async function readExistingBody(
  path: string,
  signingKey: Buffer,
  tenantId: string,
  profileId: string
): Promise<RustPbxRouteSnapshotBody | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return decodeEnvelope(raw, signingKey, tenantId, profileId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function decodeEnvelope(
  raw: string,
  signingKey: Buffer,
  tenantId: string,
  profileId: string
): RustPbxRouteSnapshotBody {
  if (!raw || Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) {
    throw new Error('RustPBX route snapshot envelope is invalid');
  }
  const newline = raw.indexOf('\n');
  const header = newline < 0 ? '' : raw.slice(0, newline);
  const encodedBody = newline < 0 ? '' : raw.slice(newline + 1);
  if (!new RegExp(`^${WIRE_PREFIX.replaceAll('.', '\\.')}[A-Za-z0-9_-]{43}$`).test(header)
    || !encodedBody) {
    throw new Error('RustPBX route snapshot envelope is invalid');
  }
  const signature = header.slice(WIRE_PREFIX.length);
  const expected = createHmac('sha256', signingKey).update(encodedBody).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('RustPBX route snapshot signature mismatch');
  }
  const body = plainRecord(JSON.parse(encodedBody)) as unknown as RustPbxRouteSnapshotBody;
  if (canonicalJson(body) !== encodedBody
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
    || !isPlainRecord(body.routes) || Object.keys(body.routes).length > MAX_ROUTES) {
    throw new Error('RustPBX route snapshot body is invalid');
  }
  for (const key of Object.keys(body.routes)) validAddressHmac(key);
  return body;
}

function compileRoutes(
  rows: RustPbxRouteProjectionRow[],
  routerAdapter: RustPbxRouterAdapter,
  availableDependencies: ReadonlySet<VoiceRouteDependency>
): Record<string, RustPbxRouterResponse> {
  const routes: Record<string, RustPbxRouterResponse> = {};
  for (const row of rows) {
    const addressHmac = validAddressHmac(row.address_hmac);
    if (routes[addressHmac]) {
      throw new Error('RustPBX route snapshot contains duplicate address HMAC');
    }
    routes[addressHmac] = compileRustPbxRouteRules({
      rules: plainRecord(row.rules),
      capabilities: normalizeCapabilities(row.capabilities),
      router_adapter: routerAdapter,
      available_dependencies: availableDependencies
    });
  }
  return routes;
}

async function writeAtomicSnapshot(path: string, body: string): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(body, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function normalizeCapabilities(input: Record<string, unknown>): Record<VoiceCapability, boolean> {
  return Object.fromEntries(VOICE_CAPABILITIES.map((capability) => [
    capability,
    input[capability] === true
  ])) as Record<VoiceCapability, boolean>;
}

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(value || ''))) {
    throw new Error('RustPBX route snapshot signing key must be canonical base64');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('RustPBX route snapshot signing key must decode to 32 bytes');
  }
  return key;
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

function requiredText(value: string, field: string): string {
  const result = String(value || '').trim();
  if (!result || result.length > 4_096 || /[\u0000\r\n]/.test(result)) {
    throw new Error(`RustPBX route snapshot ${field} is invalid`);
  }
  return result;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`RustPBX route snapshot ${field} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(String(value || ''));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`RustPBX route snapshot ${field} is invalid`);
  }
  return parsed;
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('RustPBX route snapshot clock is invalid');
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('RustPBX route snapshot JSON object is invalid');
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError(`canonical JSON rejects ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError('canonical JSON rejects circular objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
    if (!isPlainRecord(value)) throw new TypeError('canonical JSON rejects non-plain objects');
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key], ancestors)
    ]));
  } finally {
    ancestors.delete(value);
  }
}

export interface RustPbxRouteSnapshotRuntimeConfig {
  database_url: string;
  tenant_id: string;
  profile_id: string;
  output_path: string;
  signing_key: string;
  interval_ms: number;
  ttl_ms: number;
  available_dependencies: VoiceRouteDependency[];
}

export function rustPbxRouteSnapshotRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RustPbxRouteSnapshotRuntimeConfig {
  return {
    database_url: requiredText(String(env.DATABASE_URL || ''), 'database_url'),
    tenant_id: validIdentifier(String(env.IVEKIT_RUSTPBX_ROUTE_TENANT_ID || ''), 'tenant_id'),
    profile_id: validIdentifier(String(env.IVEKIT_RUSTPBX_ROUTE_PROFILE_ID || ''), 'profile_id'),
    output_path: requiredText(
      String(env.IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_FILE || ''),
      'output_path'
    ),
    signing_key: String(env.IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_HMAC_KEY || ''),
    interval_ms: boundedInteger(
      Number(env.IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_INTERVAL_MS || 1_000),
      100,
      60_000,
      'interval_ms'
    ),
    ttl_ms: boundedInteger(
      Number(env.IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_TTL_MS || 10_000),
      1_000,
      300_000,
      'ttl_ms'
    ),
    available_dependencies: routeDependencies(
      String(env.IVEKIT_RUSTPBX_ROUTE_DEPENDENCIES || '')
    )
  };
}

async function main(): Promise<void> {
  const config = rustPbxRouteSnapshotRuntimeConfig();
  const pool = new Pool({
    connectionString: config.database_url,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'ivekit-rustpbx-route-snapshot'
  });
  const projector = createRustPbxRouteSnapshotProjector({
    repository: new PostgresRustPbxRouteSnapshotRepository(pool),
    tenant_id: config.tenant_id,
    profile_id: config.profile_id,
    output_path: config.output_path,
    signing_key: config.signing_key,
    ttl_ms: config.ttl_ms,
    available_dependencies: config.available_dependencies
  });
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        const result = await projector.runOnce();
        if (result.published) {
          console.log(JSON.stringify({
            event: 'ivekit.rustpbx_route_snapshot.published',
            sequence: result.body.sequence,
            source_revision: result.body.source_revision,
            route_count: result.route_count,
            expires_at: result.body.expires_at
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'ivekit.rustpbx_route_snapshot.failed',
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      const delay = Math.max(0, config.interval_ms - (Date.now() - startedAt));
      if (!stopped && delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  } finally {
    await pool.end();
  }
}

function routeDependencies(value: string): VoiceRouteDependency[] {
  const allowed = new Set<VoiceRouteDependency>([
    'start_ivr', 'enqueue', 'bridge_livekit', 'voicemail'
  ]);
  const output = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (output.some((item) => !allowed.has(item as VoiceRouteDependency))) {
    throw new Error('RustPBX route snapshot dependencies are invalid');
  }
  return output as VoiceRouteDependency[];
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
