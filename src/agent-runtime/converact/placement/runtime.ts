import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { HttpCellAdmissionClient } from './admission-http.js';
import { PlacementService } from './placement-service.js';
import { PlacementSnapshotSigner, PlacementTokenSigner } from './snapshot.js';
import {
  PlacementError,
  type CellAdmissionPort,
  type PlacementDecision,
  type PlacementRequest,
  type SignedPlacementSnapshot
} from './types.js';

export type PlacementRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      snapshot_file: string;
      snapshot_hmac_keys: Record<string, string>;
      token_hmac_keys: Record<string, string>;
      token_key_id: string;
      admission_service_token: string;
      home_region_id: string;
      failover_region_ids: string[];
      snapshot_refresh_ms: number;
      stale_grace_ms: number;
      admission_timeout_ms: number;
      snapshot_max_bytes: number;
    };

interface FileSnapshot {
  snapshot: SignedPlacementSnapshot;
  fingerprint: string;
}

export interface PlacementSnapshotProbeResult {
  snapshot_version: number;
  generated_at: string;
  expires_at: string;
}

export interface PlacementOwnerInspectionInput {
  profile_id: string;
  interaction_kind: import('./types.js').InteractionKind;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  cell_lease_epoch: number;
  reservation_id: string;
  admission_endpoint: string;
}

export type PlacementOwnerInspection =
  | { status: 'eligible'; reason: string }
  | { status: 'recoverable'; reason: string }
  | { status: 'unknown'; reason: string };

export class FilePlacementRuntime {
  readonly #source: AtomicFilePlacementSnapshotSource;
  readonly #snapshotSigner: PlacementSnapshotSigner;
  readonly #tokenSigner: PlacementTokenSigner;
  readonly #tokenKeyId: string;
  readonly #admissionToken: string;
  readonly #admissionTimeoutMs: number;
  readonly #homeRegionId: string;
  readonly #failoverRegionIds: string[];
  readonly #staleGraceMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #lastAcceptedSnapshotVersion = 0;
  #acceptedFingerprint = '';
  #serviceFingerprint = '';
  #service: PlacementService | null = null;

  constructor(input: {
    snapshot_file: string;
    snapshot_signer: PlacementSnapshotSigner;
    token_keys: Record<string, Buffer | string>;
    token_key_id: string;
    admission_service_token: string;
    home_region_id: string;
    failover_region_ids: string[];
    snapshot_refresh_ms?: number;
    stale_grace_ms?: number;
    admission_timeout_ms?: number;
    snapshot_max_bytes?: number;
    fetch?: typeof fetch;
    now?: () => Date;
  }) {
    this.#now = input.now || (() => new Date());
    this.#source = new AtomicFilePlacementSnapshotSource({
      path: input.snapshot_file,
      refresh_ms: boundedInteger(
        input.snapshot_refresh_ms ?? 1_000,
        100,
        60_000,
        'placement snapshot refresh'
      ),
      max_bytes: boundedInteger(
        input.snapshot_max_bytes ?? 8 * 1024 * 1024,
        1_024,
        64 * 1024 * 1024,
        'placement snapshot maximum bytes'
      ),
      now: this.#now
    });
    this.#snapshotSigner = input.snapshot_signer;
    this.#tokenSigner = new PlacementTokenSigner(input.token_keys);
    this.#tokenKeyId = checkedIdentifier(input.token_key_id, 'placement token key ID');
    this.#admissionToken = checkedServiceToken(input.admission_service_token);
    this.#admissionTimeoutMs = boundedInteger(
      input.admission_timeout_ms ?? 2_000,
      100,
      30_000,
      'placement admission timeout'
    );
    this.#homeRegionId = checkedIdentifier(input.home_region_id, 'placement home Region');
    this.#failoverRegionIds = checkedUniqueIdentifiers(
      input.failover_region_ids,
      'placement failover Region'
    ).filter((regionId) => regionId !== this.#homeRegionId);
    this.#staleGraceMs = boundedInteger(
      input.stale_grace_ms ?? 30_000,
      0,
      300_000,
      'placement snapshot stale grace'
    );
    this.#fetch = input.fetch || globalThis.fetch;
  }

  get lastAcceptedSnapshotVersion(): number {
    return this.#lastAcceptedSnapshotVersion;
  }

  async probe(): Promise<PlacementSnapshotProbeResult> {
    const loaded = await this.#verifiedSnapshot();
    this.#placementService(loaded);
    return {
      snapshot_version: loaded.snapshot.body.snapshot_version,
      generated_at: loaded.snapshot.body.generated_at,
      expires_at: loaded.snapshot.body.expires_at
    };
  }

  async place(request: PlacementRequest): Promise<PlacementDecision> {
    const loaded = await this.#verifiedSnapshot();
    const service = this.#placementService(loaded);
    return service.place({
      snapshot: loaded.snapshot,
      last_accepted_snapshot_version: this.#lastAcceptedSnapshotVersion,
      request
    });
  }

  async inspectOwner(
    input: PlacementOwnerInspectionInput
  ): Promise<PlacementOwnerInspection> {
    const loaded = await this.#verifiedSnapshot();
    const body = loaded.snapshot.body;
    if (body.profile_id !== input.profile_id) {
      return { status: 'recoverable', reason: 'profile_removed' };
    }
    const cell = body.regions
      .flatMap((region) => region.zones.flatMap((zone) => zone.cells))
      .find((candidate) => candidate.cell_id === input.cell_id);
    if (!cell ||
        !cell.supported_interaction_kinds.includes(input.interaction_kind) ||
        !cell.supported_profile_ids.includes(input.profile_id)) {
      return { status: 'recoverable', reason: 'cell_removed' };
    }
    if (cell.cell_lease_epoch > input.cell_lease_epoch) {
      return { status: 'recoverable', reason: 'cell_lease_advanced' };
    }
    if (cell.cell_lease_epoch < input.cell_lease_epoch) {
      return { status: 'unknown', reason: 'cell_lease_regressed' };
    }
    if (cell.state === 'offline') {
      return { status: 'recoverable', reason: 'cell_offline' };
    }
    try {
      const state = await new HttpCellAdmissionClient({
        endpoint: input.admission_endpoint,
        service_token: this.#admissionToken,
        timeout_ms: this.#admissionTimeoutMs,
        fetch: this.#fetch
      }).state();
      if (state.cell_lease_epoch > input.cell_lease_epoch) {
        return { status: 'recoverable', reason: 'admission_lease_advanced' };
      }
      if (state.cell_lease_epoch < input.cell_lease_epoch) {
        return { status: 'unknown', reason: 'admission_lease_regressed' };
      }
      if (state.state === 'offline') {
        return { status: 'recoverable', reason: 'admission_offline' };
      }
      const reservation = state.reservations.find((candidate) =>
        candidate.reservation_id === input.reservation_id
      );
      if (!reservation ||
          reservation.owner_node_id !== input.owner_node_id ||
          reservation.owner_epoch !== input.owner_epoch ||
          reservation.state === 'closed' ||
          reservation.state === 'expired') {
        return { status: 'recoverable', reason: 'reservation_not_owned' };
      }
      const node = state.nodes.find((candidate) =>
        candidate.node_id === input.owner_node_id
      );
      if (!node) {
        return { status: 'recoverable', reason: 'owner_node_removed' };
      }
      if (node.state !== 'offline') {
        return { status: 'eligible', reason: `owner_node_${node.state}` };
      }
      const recoverySafeAfter = Date.parse(node.recovery_safe_after);
      if (!Number.isFinite(recoverySafeAfter) ||
          validDate(this.#now()).getTime() < recoverySafeAfter) {
        return { status: 'unknown', reason: 'owner_fence_pending' };
      }
      return { status: 'recoverable', reason: 'owner_node_fenced' };
    } catch (error) {
      if (!(error instanceof PlacementError)) throw error;
      return { status: 'unknown', reason: error.code };
    }
  }

  async #verifiedSnapshot(): Promise<FileSnapshot> {
    const now = validDate(this.#now());
    const loaded = await this.#source.current();
    const verified = this.#snapshotSigner.verify(loaded.snapshot, {
      now,
      last_accepted_version: this.#lastAcceptedSnapshotVersion,
      stale_grace_ms: this.#staleGraceMs
    });
    if (verified.body.snapshot_version === this.#lastAcceptedSnapshotVersion &&
        this.#acceptedFingerprint &&
        loaded.fingerprint !== this.#acceptedFingerprint) {
      throw new PlacementError({
        code: 'snapshot_version_reused',
        status: 409
      });
    }
    if (verified.body.snapshot_version > this.#lastAcceptedSnapshotVersion) {
      this.#lastAcceptedSnapshotVersion = verified.body.snapshot_version;
      this.#acceptedFingerprint = loaded.fingerprint;
    }
    return loaded;
  }

  #placementService(loaded: FileSnapshot): PlacementService {
    if (this.#service && this.#serviceFingerprint === loaded.fingerprint) {
      return this.#service;
    }
    const admissions = new Map<string, CellAdmissionPort>();
    for (const region of loaded.snapshot.body.regions) {
      for (const zone of region.zones) {
        for (const cell of zone.cells) {
          if (admissions.has(cell.cell_id)) {
            throw new PlacementError({
              code: 'duplicate_snapshot_cell_id',
              status: 409
            });
          }
          admissions.set(cell.cell_id, new HttpCellAdmissionClient({
            endpoint: cell.admission_endpoint,
            service_token: this.#admissionToken,
            timeout_ms: this.#admissionTimeoutMs,
            fetch: this.#fetch
          }));
        }
      }
    }
    this.#service = new PlacementService({
      snapshot_signer: this.#snapshotSigner,
      token_signer: this.#tokenSigner,
      token_key_id: this.#tokenKeyId,
      admissions,
      tenant_regions: {
        resolve: async () => ({
          home_region_id: this.#homeRegionId,
          failover_region_ids: [...this.#failoverRegionIds]
        })
      },
      now: this.#now,
      stale_grace_ms: this.#staleGraceMs
    });
    this.#serviceFingerprint = loaded.fingerprint;
    return this.#service;
  }
}

export class AtomicFilePlacementSnapshotSource {
  readonly #path: string;
  readonly #refreshMs: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #nextRefreshAt = 0;
  #fileFingerprint = '';
  #cached: FileSnapshot | null = null;
  #loading: Promise<FileSnapshot> | null = null;

  constructor(input: {
    path: string;
    refresh_ms: number;
    max_bytes: number;
    now?: () => Date;
  }) {
    this.#path = checkedAbsolutePath(input.path);
    this.#refreshMs = boundedInteger(
      input.refresh_ms,
      100,
      60_000,
      'placement snapshot refresh'
    );
    this.#maxBytes = boundedInteger(
      input.max_bytes,
      1_024,
      64 * 1024 * 1024,
      'placement snapshot maximum bytes'
    );
    this.#now = input.now || (() => new Date());
  }

  current(): Promise<FileSnapshot> {
    const now = validDate(this.#now()).getTime();
    if (this.#cached && now < this.#nextRefreshAt) {
      return Promise.resolve(this.#cached);
    }
    if (this.#loading) return this.#loading;
    const loading = this.#load(now).finally(() => {
      if (this.#loading === loading) this.#loading = null;
    });
    this.#loading = loading;
    return loading;
  }

  async #load(now: number): Promise<FileSnapshot> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        this.#path,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
      );
    } catch (error) {
      throw new PlacementError({
        code: (error as NodeJS.ErrnoException)?.code === 'ELOOP'
          ? 'placement_snapshot_symlink_rejected'
          : 'placement_snapshot_unavailable',
        status: 503,
        retryable: true
      });
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size < 2n || stat.size > BigInt(this.#maxBytes)) {
        throw new PlacementError({
          code: 'placement_snapshot_file_invalid',
          status: 503
        });
      }
      const fileFingerprint = [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs
      ].join(':');
      this.#nextRefreshAt = now + this.#refreshMs;
      if (this.#cached && fileFingerprint === this.#fileFingerprint) {
        return this.#cached;
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new PlacementError({
          code: 'placement_snapshot_json_invalid',
          status: 503
        });
      }
      const snapshot = checkedSignedSnapshot(parsed);
      const loaded = {
        snapshot,
        fingerprint: `${snapshot.key_id}:${snapshot.body.snapshot_version}:${snapshot.signature}`
      };
      this.#fileFingerprint = fileFingerprint;
      this.#cached = loaded;
      return loaded;
    } finally {
      await handle.close();
    }
  }
}

export function placementRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): PlacementRuntimeConfig {
  const enabled = optionalFlag(env.OPC_IVEKIT_PLACEMENT_ENABLED);
  if (!enabled) return { enabled: false };
  const snapshotKeys = signingKeyMap(
    required(env, 'OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON'),
    'OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON'
  );
  const tokenKeys = signingKeyMap(
    required(env, 'OPC_IVEKIT_PLACEMENT_TOKEN_HMAC_KEYS_JSON'),
    'OPC_IVEKIT_PLACEMENT_TOKEN_HMAC_KEYS_JSON'
  );
  const tokenKeyId = checkedIdentifier(
    required(env, 'OPC_IVEKIT_PLACEMENT_TOKEN_KEY_ID'),
    'placement token key ID'
  );
  if (!tokenKeys[tokenKeyId]) {
    throw new Error('OPC_IVEKIT_PLACEMENT_TOKEN_KEY_ID is not configured');
  }
  return {
    enabled: true,
    snapshot_file: checkedAbsolutePath(
      required(env, 'OPC_IVEKIT_PLACEMENT_SNAPSHOT_FILE')
    ),
    snapshot_hmac_keys: snapshotKeys,
    token_hmac_keys: tokenKeys,
    token_key_id: tokenKeyId,
    admission_service_token: checkedServiceToken(
      required(env, 'OPC_IVEKIT_CELL_ADMISSION_TOKEN')
    ),
    home_region_id: checkedIdentifier(
      required(env, 'OPC_IVEKIT_PLACEMENT_HOME_REGION_ID'),
      'placement home Region'
    ),
    failover_region_ids: checkedUniqueIdentifiers(
      csv(env.OPC_IVEKIT_PLACEMENT_FAILOVER_REGION_IDS || ''),
      'placement failover Region'
    ),
    snapshot_refresh_ms: envInteger(
      env.OPC_IVEKIT_PLACEMENT_SNAPSHOT_REFRESH_MS,
      1_000,
      100,
      60_000,
      'OPC_IVEKIT_PLACEMENT_SNAPSHOT_REFRESH_MS'
    ),
    stale_grace_ms: envInteger(
      env.OPC_IVEKIT_PLACEMENT_STALE_GRACE_MS,
      30_000,
      0,
      300_000,
      'OPC_IVEKIT_PLACEMENT_STALE_GRACE_MS'
    ),
    admission_timeout_ms: envInteger(
      env.OPC_IVEKIT_PLACEMENT_ADMISSION_TIMEOUT_MS,
      2_000,
      100,
      30_000,
      'OPC_IVEKIT_PLACEMENT_ADMISSION_TIMEOUT_MS'
    ),
    snapshot_max_bytes: envInteger(
      env.OPC_IVEKIT_PLACEMENT_SNAPSHOT_MAX_BYTES,
      8 * 1024 * 1024,
      1_024,
      64 * 1024 * 1024,
      'OPC_IVEKIT_PLACEMENT_SNAPSHOT_MAX_BYTES'
    )
  };
}

export function createConfiguredFilePlacementRuntime(input: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
} = {}): FilePlacementRuntime | null {
  const config = placementRuntimeConfig(input.env || process.env);
  if (!config.enabled) return null;
  return new FilePlacementRuntime({
    snapshot_file: config.snapshot_file,
    snapshot_signer: new PlacementSnapshotSigner(config.snapshot_hmac_keys),
    token_keys: config.token_hmac_keys,
    token_key_id: config.token_key_id,
    admission_service_token: config.admission_service_token,
    home_region_id: config.home_region_id,
    failover_region_ids: config.failover_region_ids,
    snapshot_refresh_ms: config.snapshot_refresh_ms,
    stale_grace_ms: config.stale_grace_ms,
    admission_timeout_ms: config.admission_timeout_ms,
    snapshot_max_bytes: config.snapshot_max_bytes,
    fetch: input.fetch,
    now: input.now
  });
}

function checkedSignedSnapshot(value: unknown): SignedPlacementSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlacementError({
      code: 'placement_snapshot_shape_invalid',
      status: 503
    });
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.key_id !== 'string' ||
      typeof candidate.signature !== 'string' ||
      !candidate.body || typeof candidate.body !== 'object' ||
      Array.isArray(candidate.body)) {
    throw new PlacementError({
      code: 'placement_snapshot_shape_invalid',
      status: 503
    });
  }
  return structuredClone(value) as SignedPlacementSnapshot;
}

function signingKeyMap(value: string, field: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} is invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  const result: Record<string, string> = {};
  for (const [keyId, keyValue] of Object.entries(parsed)) {
    checkedIdentifier(keyId, `${field} key ID`);
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

function optionalFlag(value: string | undefined): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (normalized !== '0' && normalized !== '1') {
    throw new Error('OPC_IVEKIT_PLACEMENT_ENABLED must be 0 or 1');
  }
  return normalized === '1';
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function checkedAbsolutePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new Error('placement snapshot path must be absolute');
  }
  return value;
}

function checkedServiceToken(value: string): string {
  if (value.length < 24 || value.length > 512 ||
      /[\0\r\n]/.test(value) ||
      /change[_-]?me|replace|placeholder|example/i.test(value)) {
    throw new Error('invalid placement admission service token');
  }
  return value;
}

function checkedIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function checkedUniqueIdentifiers(values: string[], field: string): string[] {
  const result = values.map((value) => checkedIdentifier(value, field));
  if (new Set(result).size !== result.length) {
    throw new Error(`duplicate ${field}`);
  }
  return result;
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function envInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  const parsed = String(value || '').trim() ? Number(value) : fallback;
  return boundedInteger(parsed, min, max, field);
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid placement runtime time');
  }
  return value;
}
