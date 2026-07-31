import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { decodeRustDeskEdgeObservation } from './rustdesk-edge-observation-contract.js';
import {
  RustDeskObservationSpool,
  type RustDeskObservationSpoolOptions,
  type RustDeskObservationSpoolRecord
} from './rustdesk-observation-spool.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RustDeskObservationBridgeConfig {
  baseUrl: string;
  deviceTokenFile: string;
  inputDirectory: string;
  spoolDirectory: string;
  batchSize: number;
  retryDelayMs: number;
  maxAttempts: number;
  maxInputBytes: number;
  maxQuarantineRecords: number;
  placementEnabled: boolean;
  now?: () => Date;
}

export interface RustDeskObservationBridgePollResult {
  ingested: number;
  forwarded: number;
  deadLettered: number;
}

export function createRustDeskObservationBridgeConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskObservationBridgeConfig {
  const baseUrl = normalizeBaseUrl(env.OPC_RUSTDESK_EDGE_BASE_URL || '');
  const deviceTokenFile = absolutePath(
    env.OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE,
    'OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE'
  );
  const inputDirectory = absolutePath(
    env.OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR,
    'OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR'
  );
  const spoolDirectory = absolutePath(
    env.OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR,
    'OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR'
  );
  return {
    baseUrl,
    deviceTokenFile,
    inputDirectory,
    spoolDirectory,
    batchSize: boundedEnv(env.OPC_RUSTDESK_EDGE_OBSERVATION_BATCH_SIZE, 20, 1, 100, 'OPC_RUSTDESK_EDGE_OBSERVATION_BATCH_SIZE'),
    retryDelayMs: boundedEnv(env.OPC_RUSTDESK_EDGE_OBSERVATION_RETRY_DELAY_MS, 5_000, 0, 3_600_000, 'OPC_RUSTDESK_EDGE_OBSERVATION_RETRY_DELAY_MS'),
    maxAttempts: boundedEnv(env.OPC_RUSTDESK_EDGE_OBSERVATION_MAX_ATTEMPTS, 10, 1, 100, 'OPC_RUSTDESK_EDGE_OBSERVATION_MAX_ATTEMPTS'),
    maxInputBytes: boundedEnv(env.OPC_RUSTDESK_EDGE_OBSERVATION_MAX_INPUT_BYTES, 64 * 1_024, 1_024, 1_048_576, 'OPC_RUSTDESK_EDGE_OBSERVATION_MAX_INPUT_BYTES'),
    maxQuarantineRecords: boundedEnv(env.OPC_RUSTDESK_EDGE_OBSERVATION_MAX_QUARANTINE_RECORDS, 100, 1, 10_000, 'OPC_RUSTDESK_EDGE_OBSERVATION_MAX_QUARANTINE_RECORDS'),
    placementEnabled: flag(env.OPC_IVEKIT_PLACEMENT_ENABLED)
  };
}

export class RustDeskObservationBridge {
  private constructor(
    private readonly config: RustDeskObservationBridgeConfig,
    private readonly deviceToken: string,
    private readonly spool: RustDeskObservationSpool,
    private readonly fetchImpl: FetchLike
  ) {}

  static async open(
    config: RustDeskObservationBridgeConfig,
    fetchImpl: FetchLike = fetch
  ): Promise<RustDeskObservationBridge> {
    await ensurePrivateDirectory(config.inputDirectory, 'RustDesk observation input directory');
    await ensurePrivateDirectory(join(config.inputDirectory, 'quarantine'), 'RustDesk observation quarantine directory');
    const deviceToken = await readDeviceToken(config.deviceTokenFile);
    const spoolOptions: RustDeskObservationSpoolOptions = {
      directory: config.spoolDirectory,
      retry_delay_ms: config.retryDelayMs,
      max_attempts: config.maxAttempts,
      ...(config.now ? { now: config.now } : {})
    };
    const spool = await RustDeskObservationSpool.open(spoolOptions);
    return new RustDeskObservationBridge(config, deviceToken, spool, fetchImpl);
  }

  async pollOnce(deviceIdValue: string): Promise<RustDeskObservationBridgePollResult> {
    const deviceId = required(deviceIdValue, 'RustDesk observation device id is required');
    const ingested = await this.ingestInput();
    const claimed = await this.spool.claimBatch(this.config.batchSize);
    if (!claimed.length) return { ingested, forwarded: 0, deadLettered: 0 };
    const ids = claimed.map((record) => record.id);
    try {
      const observations = this.config.placementEnabled
        ? await this.bindCurrentOwners(deviceId, claimed)
        : claimed.map((record) => record.observation);
      const response = await this.fetchImpl(
        `${this.config.baseUrl}/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/observations`,
        {
          method: 'POST',
          headers: {
            'x-rustdesk-edge-token': this.deviceToken,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ observations })
        }
      );
      if (!response.ok) {
        await this.spool.markFailed(ids, {
          retriable: response.status === 408 || response.status === 429 || response.status >= 500,
          error_code: `upstream_${response.status}`
        });
        return {
          ingested,
          forwarded: 0,
          deadLettered: await this.deadLetterCount(ids)
        };
      }
      const payload = apiResponseData<{ accepted?: unknown }>(await response.json());
      if (response.status !== 201 || Number(payload?.accepted) !== claimed.length) {
        await this.spool.markFailed(ids, { retriable: false, error_code: 'invalid_upstream_response' });
        return { ingested, forwarded: 0, deadLettered: claimed.length };
      }
      await this.spool.markForwarded(ids);
      return { ingested, forwarded: claimed.length, deadLettered: 0 };
    } catch (error) {
      const ownerError = error instanceof RustDeskObservationOwnerError ? error : null;
      await this.spool.markFailed(ids, {
        retriable: ownerError?.retriable ?? true,
        error_code: ownerError?.code || 'network_error'
      });
      return {
        ingested,
        forwarded: 0,
        deadLettered: await this.deadLetterCount(ids)
      };
    }
  }

  private async bindCurrentOwners(
    deviceId: string,
    records: RustDeskObservationSpoolRecord[]
  ): Promise<Array<Record<string, unknown>>> {
    const response = await this.fetchImpl(
      `${this.config.baseUrl}/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/evidence-context`,
      {
        method: 'GET',
        headers: { 'x-rustdesk-edge-token': this.deviceToken }
      }
    );
    if (!response.ok) {
      throw new RustDeskObservationOwnerError(
        `owner_context_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }
    const context = apiResponseData<Record<string, unknown>>(await response.json());
    if (
      context?.schema_version !== 1 ||
      !Array.isArray(context.sessions) ||
      Date.parse(String(context.expires_at || '')) <= Date.now()
    ) {
      throw new RustDeskObservationOwnerError('owner_context_invalid', false);
    }
    const owners = new Map<string, Record<string, string>>();
    for (const raw of context.sessions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new RustDeskObservationOwnerError('owner_context_invalid', false);
      }
      const session = raw as Record<string, unknown>;
      const owner = ownerIdentity(session);
      const externalId = required(session.external_id, 'RustDesk owner context external_id is required');
      if (owners.has(externalId)) {
        throw new RustDeskObservationOwnerError('owner_context_ambiguous', false);
      }
      owners.set(externalId, owner);
    }
    return records.map((record) => {
      const observation = record.observation as unknown as Record<string, unknown>;
      const externalId = required(
        observation.external_id,
        'RustDesk observation external_id is required'
      );
      const owner = owners.get(externalId);
      if (!owner) throw new RustDeskObservationOwnerError('owner_context_unavailable', false);
      const submitted = optionalOwnerIdentity(observation);
      if (submitted && canonicalOwner(submitted) !== canonicalOwner(owner)) {
        throw new RustDeskObservationOwnerError('rustdesk_owner_binding_mismatch', false);
      }
      return { ...observation, ...owner };
    });
  }

  async listRecords(): Promise<RustDeskObservationSpoolRecord[]> {
    return this.spool.list();
  }

  async close(): Promise<void> {
    await this.spool.close();
  }

  private async ingestInput(): Promise<number> {
    const names = (await readdir(this.config.inputDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    let ingested = 0;
    for (const name of names) {
      const path = join(this.config.inputDirectory, name);
      let raw: Buffer;
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > this.config.maxInputBytes) {
          await this.quarantineInput(name, stat.isSymbolicLink() ? Buffer.from('symbolic-link') : Buffer.from('invalid-file'));
          continue;
        }
        raw = await readFile(path);
        if (raw.byteLength > this.config.maxInputBytes) throw new Error('input exceeds size limit');
        const observation = decodeRustDeskEdgeObservation(JSON.parse(raw.toString('utf8')));
        await this.spool.receive(observation);
        await unlink(path);
        ingested += 1;
      } catch (error) {
        if (nodeCode(error) === 'ENOENT') continue;
        raw = await readFile(path).catch(() => Buffer.from('unreadable'));
        await this.quarantineInput(name, raw);
      }
    }
    return ingested;
  }

  private async quarantineInput(name: string, raw: Buffer): Promise<void> {
    const sourcePath = join(this.config.inputDirectory, name);
    const quarantineDirectory = join(this.config.inputDirectory, 'quarantine');
    const now = (this.config.now || (() => new Date()))();
    const payload = {
      schema_version: 1,
      source_filename: safeFilePart(name),
      sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      rejection: 'invalid_schema',
      rejected_at: now.toISOString()
    };
    const path = join(
      quarantineDirectory,
      `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
    );
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    await unlink(sourcePath).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
    await this.trimQuarantine(quarantineDirectory);
  }

  private async trimQuarantine(directory: string): Promise<void> {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    const remove = names.slice(0, Math.max(0, names.length - this.config.maxQuarantineRecords));
    for (const name of remove) await unlink(join(directory, name));
  }

  private async deadLetterCount(ids: string[]): Promise<number> {
    const selected = new Set(ids);
    return (await this.spool.list()).filter((record) => selected.has(record.id) && record.state === 'dead_letter').length;
  }
}

class RustDeskObservationOwnerError extends Error {
  constructor(readonly code: string, readonly retriable: boolean) {
    super(code);
  }
}

function apiResponseData<T>(value: unknown): T {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'data')) {
    return (value as { data: T }).data;
  }
  return value as T;
}

async function readDeviceToken(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('RustDesk edge device token file must be a regular file, not a symbolic link');
  }
  if (stat.size < 16 || stat.size > 4_096) throw new Error('RustDesk edge device token file size is invalid');
  const raw = await readFile(path, 'utf8');
  const token = raw.trim();
  if (token.length < 16 || token.length > 4_000 || /\s/.test(token)) {
    throw new Error('RustDesk edge device token file content is invalid');
  }
  return token;
}

async function ensurePrivateDirectory(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${name} must be a real directory, not a symbolic link`);
  }
  await chmod(path, 0o700);
}

function normalizeBaseUrl(value: string): string {
  const result = String(value || '').trim().replace(/\/+$/, '');
  if (!result) throw new Error('OPC_RUSTDESK_EDGE_BASE_URL is required');
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new Error('OPC_RUSTDESK_EDGE_BASE_URL must be an HTTP URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OPC_RUSTDESK_EDGE_BASE_URL must be an HTTP URL without credentials, query, or fragment');
  }
  return result;
}

function absolutePath(value: string | undefined, name: string): string {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${name} is required`);
  if (!isAbsolute(result) && !/^[A-Za-z]:[\\/]/.test(result) && !/^\\\\/.test(result)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return result;
}

function boundedEnv(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'observation.json';
}

function required(value: unknown, message: string): string {
  const result = String(value || '').trim();
  if (!result) throw new Error(message);
  return result;
}

function ownerIdentity(value: Record<string, unknown>): Record<string, string> {
  const ownerEpoch = required(value.owner_epoch, 'RustDesk owner context owner_epoch is required');
  if (!/^[1-9][0-9]{0,19}$/.test(ownerEpoch)) {
    throw new RustDeskObservationOwnerError('owner_context_invalid', false);
  }
  return {
    interaction_id: required(
      value.interaction_id,
      'RustDesk owner context interaction_id is required'
    ),
    reservation_id: required(
      value.reservation_id,
      'RustDesk owner context reservation_id is required'
    ),
    owner_epoch: BigInt(ownerEpoch).toString()
  };
}

function optionalOwnerIdentity(
  value: Record<string, unknown>
): Record<string, string> | null {
  const present = [value.interaction_id, value.reservation_id, value.owner_epoch]
    .filter((item) => item !== undefined && item !== null);
  if (!present.length) return null;
  if (present.length !== 3) {
    throw new RustDeskObservationOwnerError('rustdesk_owner_binding_incomplete', false);
  }
  return ownerIdentity(value);
}

function canonicalOwner(value: Record<string, string>): string {
  return `${value.interaction_id}\u0000${value.reservation_id}\u0000${value.owner_epoch}`;
}

function flag(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error('OPC_IVEKIT_PLACEMENT_ENABLED must be 0 or 1');
}

function nodeCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code || '');
}
