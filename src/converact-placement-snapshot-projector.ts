import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PlacementSnapshotSigner
} from './agent-runtime/converact/placement/snapshot.js';
import type {
  InteractionKind,
  PlacementSnapshotBody,
  PlacementState,
  SignedPlacementSnapshot
} from './agent-runtime/converact/placement/types.js';

interface PlacementTopologyCell {
  cell_id: string;
  routing_weight: number;
  supported_interaction_kinds: InteractionKind[];
  supported_profile_ids: string[];
  admission_endpoint: string;
}

interface PlacementTopology {
  regions: Array<{
    region_id: string;
    zones: Array<{
      zone_id: string;
      state: PlacementState;
      cells: PlacementTopologyCell[];
    }>;
  }>;
}

interface CellState {
  state: PlacementState;
  cell_lease_epoch: number;
  capacity_sequence: number;
  capacity_expires_at: string;
  dimensions: Record<string, {
    unit: string;
    safe_capacity: number;
    used: number;
    reserved: number;
  }>;
}

export interface PlacementSnapshotProjectorConfig {
  output_file: string;
  profile_id: string;
  signing_key_id: string;
  signing_keys: Record<string, Buffer | string>;
  service_token: string;
  interval_ms: number;
  snapshot_ttl_ms: number;
  request_timeout_ms: number;
  response_max_bytes: number;
  topology: PlacementTopology;
}

export interface PlacementSnapshotProjector {
  runOnce(): Promise<SignedPlacementSnapshot>;
}

export function createPlacementSnapshotProjector(
  input: Omit<PlacementSnapshotProjectorConfig, 'interval_ms' | 'response_max_bytes'> & {
    interval_ms?: number;
    response_max_bytes?: number;
    fetch?: typeof fetch;
    now?: () => Date;
  }
): PlacementSnapshotProjector {
  const outputFile = absolutePath(input.output_file);
  const profileId = profile(input.profile_id);
  const keyId = identifier(input.signing_key_id, 'placement snapshot key ID');
  const signer = new PlacementSnapshotSigner(input.signing_keys);
  const serviceToken = serviceTokenValue(input.service_token);
  const topology = checkedTopology(input.topology, profileId);
  const ttlMs = boundedInteger(
    input.snapshot_ttl_ms,
    1_000,
    300_000,
    'placement snapshot TTL'
  );
  const timeoutMs = boundedInteger(
    input.request_timeout_ms,
    100,
    30_000,
    'placement snapshot request timeout'
  );
  const responseMaxBytes = boundedInteger(
    input.response_max_bytes ?? 1_048_576,
    1_024,
    8 * 1024 * 1024,
    'placement snapshot response maximum bytes'
  );
  const fetchImpl = input.fetch || globalThis.fetch;
  const now = input.now || (() => new Date());
  return {
    async runOnce() {
      const generatedAt = validDate(now());
      const previousVersion = await readPreviousVersion(
        outputFile,
        signer,
        generatedAt
      );
      const snapshotVersion = Math.max(
        generatedAt.getTime(),
        previousVersion + 1
      );
      const regions = await Promise.all(topology.regions.map(async (region) => ({
        region_id: region.region_id,
        zones: await Promise.all(region.zones.map(async (zone) => ({
          zone_id: zone.zone_id,
          state: zone.state,
          cells: await Promise.all(zone.cells.map(async (cell) => {
            const state = await readCellState({
              endpoint: cell.admission_endpoint,
              serviceToken,
              timeoutMs,
              responseMaxBytes,
              fetch: fetchImpl,
              now: generatedAt
            });
            return {
              cell_id: cell.cell_id,
              state: state.state,
              routing_weight: cell.routing_weight,
              supported_interaction_kinds: [...cell.supported_interaction_kinds],
              supported_profile_ids: [...cell.supported_profile_ids],
              capacity_vector_sequence: state.capacity_sequence,
              capacity_expires_at: state.capacity_expires_at,
              dominant_utilization_ratio: dominantUtilization(state.dimensions),
              capacity_dimensions: state.dimensions,
              cell_lease_epoch: state.cell_lease_epoch,
              admission_endpoint: cell.admission_endpoint
            };
          }))
        })))
      })));
      const body: PlacementSnapshotBody = {
        schema_version: '1.0.0',
        snapshot_version: snapshotVersion,
        generated_at: generatedAt.toISOString(),
        expires_at: new Date(generatedAt.getTime() + ttlMs).toISOString(),
        profile_id: profileId,
        regions
      };
      const signed = signer.sign(body, keyId);
      await atomicWriteJson(outputFile, signed);
      return signed;
    }
  };
}

export function placementSnapshotProjectorConfig(
  env: NodeJS.ProcessEnv = process.env
): PlacementSnapshotProjectorConfig {
  const profileId = profile(required(env, 'OPC_IVEKIT_PLACEMENT_PROFILE_ID'));
  const signingKeys = signingKeyMap(
    required(env, 'OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON'),
    'OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON'
  );
  const signingKeyId = identifier(
    required(env, 'OPC_IVEKIT_PLACEMENT_SNAPSHOT_KEY_ID'),
    'placement snapshot key ID'
  );
  if (!signingKeys[signingKeyId]) {
    throw new Error('OPC_IVEKIT_PLACEMENT_SNAPSHOT_KEY_ID is not configured');
  }
  return {
    output_file: absolutePath(
      required(env, 'OPC_IVEKIT_PLACEMENT_SNAPSHOT_FILE')
    ),
    profile_id: profileId,
    signing_key_id: signingKeyId,
    signing_keys: signingKeys,
    service_token: serviceTokenValue(
      required(env, 'OPC_IVEKIT_CELL_ADMISSION_TOKEN')
    ),
    interval_ms: envInteger(
      env.OPC_IVEKIT_PLACEMENT_PROJECTOR_INTERVAL_MS,
      2_000,
      250,
      60_000,
      'OPC_IVEKIT_PLACEMENT_PROJECTOR_INTERVAL_MS'
    ),
    snapshot_ttl_ms: envInteger(
      env.OPC_IVEKIT_PLACEMENT_SNAPSHOT_TTL_MS,
      10_000,
      1_000,
      300_000,
      'OPC_IVEKIT_PLACEMENT_SNAPSHOT_TTL_MS'
    ),
    request_timeout_ms: envInteger(
      env.OPC_IVEKIT_PLACEMENT_PROJECTOR_TIMEOUT_MS,
      2_000,
      100,
      30_000,
      'OPC_IVEKIT_PLACEMENT_PROJECTOR_TIMEOUT_MS'
    ),
    response_max_bytes: envInteger(
      env.OPC_IVEKIT_PLACEMENT_PROJECTOR_RESPONSE_MAX_BYTES,
      1_048_576,
      1_024,
      8 * 1024 * 1024,
      'OPC_IVEKIT_PLACEMENT_PROJECTOR_RESPONSE_MAX_BYTES'
    ),
    topology: checkedTopology(
      jsonObject<PlacementTopology>(
        required(env, 'OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON'),
        'OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON'
      ),
      profileId
    )
  };
}

export async function runPlacementSnapshotProjector(
  config: PlacementSnapshotProjectorConfig
): Promise<void> {
  const projector = createPlacementSnapshotProjector(config);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopped) {
    const started = Date.now();
    try {
      await projector.runOnce();
    } catch (error) {
      console.error(
        '[placement-snapshot-projector] refresh failed; retaining previous snapshot:',
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      );
    }
    if (!stopped) {
      await delay(Math.max(0, config.interval_ms - (Date.now() - started)));
    }
  }
}

async function readCellState(input: {
  endpoint: string;
  serviceToken: string;
  timeoutMs: number;
  responseMaxBytes: number;
  fetch: typeof fetch;
  now: Date;
}): Promise<CellState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetch(new URL('/v1/state', input.endpoint), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.serviceToken}`
      }
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > input.responseMaxBytes) {
      throw new Error('Cell admission state response is too large');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Cell admission state response is invalid JSON');
    }
    if (!response.ok) {
      throw new Error(`Cell admission state rejected with HTTP ${response.status}`);
    }
    return checkedCellState(object(payload).data, input.now);
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError') {
      throw new Error('Cell admission state request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function checkedCellState(value: unknown, now: Date): CellState {
  const state = object(value);
  const placementState = placementStateValue(state.state);
  const leaseEpoch = Number(state.cell_lease_epoch);
  const sequence = Number(state.capacity_sequence);
  const capacityExpiresAt = timestamp(state.capacity_expires_at);
  if (!Number.isInteger(leaseEpoch) || leaseEpoch < 1 ||
      leaseEpoch > 0xffff_ffff ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      Date.parse(capacityExpiresAt) <= now.getTime()) {
    throw new Error('Cell admission state is stale or invalid');
  }
  const dimensions: CellState['dimensions'] = {};
  for (const [name, raw] of Object.entries(object(state.dimensions))) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name)) {
      throw new Error('Cell admission capacity dimension is invalid');
    }
    const dimension = object(raw);
    const unit = String(dimension.unit || '');
    const safeCapacity = Number(dimension.safe_capacity);
    const used = Number(dimension.used);
    const reserved = Number(dimension.reserved);
    if (!unit || !Number.isFinite(safeCapacity) || safeCapacity <= 0 ||
        !Number.isFinite(used) || used < 0 ||
        !Number.isFinite(reserved) || reserved < 0 ||
        used + reserved > safeCapacity) {
      throw new Error('Cell admission capacity dimension is invalid');
    }
    dimensions[name] = {
      unit,
      safe_capacity: safeCapacity,
      used,
      reserved
    };
  }
  if (Object.keys(dimensions).length === 0) {
    throw new Error('Cell admission capacity dimensions are empty');
  }
  return {
    state: placementState,
    cell_lease_epoch: leaseEpoch,
    capacity_sequence: sequence,
    capacity_expires_at: capacityExpiresAt,
    dimensions
  };
}

async function readPreviousVersion(
  path: string,
  signer: PlacementSnapshotSigner,
  now: Date
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw error;
  }
  let previous: SignedPlacementSnapshot;
  try {
    previous = JSON.parse(raw) as SignedPlacementSnapshot;
  } catch {
    throw new Error('existing placement snapshot is invalid JSON');
  }
  const generated = Date.parse(previous.body?.generated_at);
  const expires = Date.parse(previous.body?.expires_at);
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || expires <= generated) {
    throw new Error('existing placement snapshot has invalid timestamps');
  }
  const verificationTime = new Date(
    Math.max(generated, Math.min(now.getTime(), expires - 1))
  );
  signer.verify(previous, {
    now: verificationTime,
    last_accepted_version: 0,
    stale_grace_ms: 0
  });
  return previous.body.snapshot_version;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function checkedTopology(
  value: PlacementTopology,
  profileId: string
): PlacementTopology {
  if (!value || !Array.isArray(value.regions) || value.regions.length === 0 ||
      value.regions.length > 32) {
    throw new Error('placement topology regions are invalid');
  }
  const cellIds = new Set<string>();
  const result: PlacementTopology = { regions: [] };
  for (const region of value.regions) {
    const regionId = identifier(region.region_id, 'placement topology Region');
    if (!Array.isArray(region.zones) || region.zones.length === 0 ||
        region.zones.length > 32) {
      throw new Error('placement topology zones are invalid');
    }
    result.regions.push({
      region_id: regionId,
      zones: region.zones.map((zone) => {
        const zoneId = identifier(zone.zone_id, 'placement topology Zone');
        if (!Array.isArray(zone.cells) || zone.cells.length === 0 ||
            zone.cells.length > 256) {
          throw new Error('placement topology cells are invalid');
        }
        return {
          zone_id: zoneId,
          state: placementStateValue(zone.state),
          cells: zone.cells.map((cell) => {
            const cellId = identifier(cell.cell_id, 'placement topology Cell');
            if (cellIds.has(cellId)) {
              throw new Error('placement topology Cell IDs must be globally unique');
            }
            cellIds.add(cellId);
            if (!Number.isFinite(cell.routing_weight) || cell.routing_weight <= 0) {
              throw new Error('placement topology routing weight is invalid');
            }
            const kinds = interactionKinds(cell.supported_interaction_kinds);
            const profiles = uniqueValues(
              cell.supported_profile_ids.map(profile),
              'placement topology profile'
            );
            if (!profiles.includes(profileId)) {
              throw new Error('placement topology Cell does not support projector profile');
            }
            return {
              cell_id: cellId,
              routing_weight: cell.routing_weight,
              supported_interaction_kinds: kinds,
              supported_profile_ids: profiles,
              admission_endpoint: httpEndpoint(cell.admission_endpoint)
            };
          })
        };
      })
    });
  }
  return result;
}

function dominantUtilization(dimensions: CellState['dimensions']): number {
  return Math.max(...Object.values(dimensions).map((dimension) =>
    (dimension.used + dimension.reserved) / dimension.safe_capacity
  ));
}

function interactionKinds(values: InteractionKind[]): InteractionKind[] {
  const allowed = new Set<InteractionKind>([
    'tinode_im',
    'sip_voice',
    'livekit_av',
    'livekit_screen',
    'rustdesk_remote'
  ]);
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((value) => !allowed.has(value))) {
    throw new Error('placement topology interaction kinds are invalid');
  }
  return [...values].sort();
}

function placementStateValue(value: unknown): PlacementState {
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(String(value))) {
    throw new Error('placement topology state is invalid');
  }
  return String(value) as PlacementState;
}

function signingKeyMap(value: string, field: string): Record<string, string> {
  const parsed = jsonObject<Record<string, unknown>>(value, field);
  const result: Record<string, string> = {};
  for (const [keyId, keyValue] of Object.entries(parsed)) {
    identifier(keyId, `${field} key ID`);
    const text = String(keyValue || '');
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length < 32 ||
        decoded.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
      throw new Error(`${field} contains an invalid signing key`);
    }
    result[keyId] = text;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(`${field} requires at least one signing key`);
  }
  return result;
}

function jsonObject<T extends object>(value: string, field: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} is invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return structuredClone(parsed) as T;
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('placement projector response shape is invalid');
  }
  return value as Record<string, any>;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function absolutePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new Error('placement snapshot output path must be absolute');
  }
  return value;
}

function profile(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(String(value || ''))) {
    throw new Error('placement profile is invalid');
  }
  return value;
}

function identifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function uniqueValues(values: string[], field: string): string[] {
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length) {
    throw new Error(`${field} values are invalid`);
  }
  return [...values].sort();
}

function httpEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('placement topology admission endpoint is invalid');
  }
  return url.toString().replace(/\/$/, '');
}

function serviceTokenValue(value: string): string {
  if (value.length < 24 || value.length > 512 ||
      /[\0\r\n]/.test(value) ||
      /change[_-]?me|replace|placeholder|example/i.test(value)) {
    throw new Error('placement projector service token is invalid');
  }
  return value;
}

function timestamp(value: unknown): string {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error('placement timestamp is invalid');
  return new Date(parsed).toISOString();
}

function envInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  return boundedInteger(
    String(value || '').trim() ? Number(value) : fallback,
    min,
    max,
    field
  );
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('placement projector time is invalid');
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPlacementSnapshotProjector(placementSnapshotProjectorConfig()).catch((error) => {
    console.error(
      '[placement-snapshot-projector] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
