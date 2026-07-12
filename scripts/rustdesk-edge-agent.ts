import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RustDeskEdgeCommandProcessor,
  rustDeskMinimumCommandLeaseMs,
  type RustDeskEdgeCommandPollResult
} from './rustdesk-edge-command.js';

export interface RustDeskEdgeAgentConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  businessRef: {
    type: string;
    id: string;
  };
  rustdeskId: string;
  displayName: string;
  actorIdentity: string;
  runtimeStatus: 'online' | 'offline';
  heartbeatIntervalMs: number;
  offlineOnExit?: boolean;
  metadata: Record<string, unknown>;
  seenAt?: string;
  edgeInstanceId?: string;
  commandToken?: string;
  commandPollIntervalMs?: number;
  commandLeaseMs?: number;
  commandTimeoutMs?: number;
  disconnectAdapter?: RustDeskEdgeAdapter | null;
  restartAdapter?: RustDeskEdgeAdapter | null;
  disconnectCommandCapable?: boolean;
  spoolDir?: string;
  spoolMaxBytes?: number;
  spoolMaxAgeMs?: number;
  spoolMaxQuarantineRecords?: number;
}

export interface RustDeskEdgeAdapter {
  executable: string;
  args: string[];
}

export interface RustDeskEdgeAgentResult {
  deviceId: string;
  rustdeskId: string;
  registered: boolean;
  runtimeStatus: string;
  lastSeenAt: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RustDeskDevicePayload {
  id: string;
  status?: string;
  rustdesk_id: string;
  display_name?: string;
  runtime_status?: string;
  last_seen_at?: string | null;
}

export function createRustDeskEdgeAgentConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskEdgeAgentConfig {
  const rawBaseUrl = env.OPC_RUSTDESK_EDGE_BASE_URL || env.OPC_BASE_URL || env.OPC_COLLABORATION_BASE_URL || '';
  const baseUrlEnvName = env.OPC_RUSTDESK_EDGE_BASE_URL
    ? 'OPC_RUSTDESK_EDGE_BASE_URL'
    : env.OPC_BASE_URL
      ? 'OPC_BASE_URL'
      : 'OPC_COLLABORATION_BASE_URL';
  const apiKey = String(
    env.OPC_RUSTDESK_EDGE_API_KEY ||
    env.OPC_COLLABORATION_API_KEY ||
    env.OPC_API_KEY ||
    ''
  ).trim();
  const tenantId = String(env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_REMOTE_GATEWAY_TENANT_ID || '').trim();
  const businessRefType = String(env.OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE || '').trim();
  const businessRefId = String(env.OPC_RUSTDESK_EDGE_BUSINESS_REF_ID || '').trim();
  const rustdeskId = resolveRustDeskId(env);
  const metadata = parseMetadataJson(env.OPC_RUSTDESK_EDGE_METADATA_JSON);
  const clientVersion = edgeVersion(
    env.OPC_RUSTDESK_EDGE_CLIENT_VERSION || metadata.client_version
  );
  const edgeOs = edgeOperatingSystem(env.OPC_RUSTDESK_EDGE_OS || metadata.os);

  if (!stripTrailingSlash(rawBaseUrl)) throw new Error('OPC_RUSTDESK_EDGE_BASE_URL or OPC_BASE_URL is required');
  const baseUrl = normalizeHttpBaseUrl(rawBaseUrl, baseUrlEnvName);
  if (!apiKey) throw new Error('OPC_RUSTDESK_EDGE_API_KEY or OPC_COLLABORATION_API_KEY or OPC_API_KEY is required');
  if (!tenantId) throw new Error('OPC_RUSTDESK_EDGE_TENANT_ID is required');
  if (!businessRefType) throw new Error('OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE is required');
  if (!businessRefId) throw new Error('OPC_RUSTDESK_EDGE_BUSINESS_REF_ID is required');
  if (!rustdeskId) throw new Error('OPC_RUSTDESK_EDGE_RUSTDESK_ID or RUSTDESK_ID is required');

  const heartbeatIntervalMs = parseHeartbeatIntervalMs(env.OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS);
  const commandPollIntervalMs = parseBoundedInteger(
    env.OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS,
    'OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS',
    2_000,
    250,
    300_000
  );
  const commandLeaseMs = parseBoundedInteger(
    env.OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS,
    'OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS',
    40_000,
    1_000,
    300_000
  );
  const commandTimeoutMs = parseBoundedInteger(
    env.OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS,
    'OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS',
    15_000,
    100,
    299_999
  );
  if (commandLeaseMs < rustDeskMinimumCommandLeaseMs(commandTimeoutMs)) {
    throw new Error(
      'OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS must cover primary and fallback timeouts plus reporting margin'
    );
  }
  const disconnectAdapter = parseEdgeAdapter(
    env.OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE,
    env.OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON,
    'OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE',
    'OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON'
  );
  const restartAdapter = parseEdgeAdapter(
    env.OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE,
    env.OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON,
    'OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE',
    'OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON'
  );
  const commandToken = resolveCommandToken(env);
  if ((disconnectAdapter || restartAdapter) && !commandToken) {
    throw new Error('OPC_RUSTDESK_EDGE_COMMAND_TOKEN is required when a command adapter is configured');
  }
  const spoolDir = String(env.OPC_RUSTDESK_EDGE_SPOOL_DIR || '').trim();
  if ((disconnectAdapter || restartAdapter) && !spoolDir) {
    throw new Error('OPC_RUSTDESK_EDGE_SPOOL_DIR is required when a command adapter is configured');
  }
  if (spoolDir && !isAbsolute(spoolDir)) {
    throw new Error('OPC_RUSTDESK_EDGE_SPOOL_DIR must be an absolute path');
  }
  return {
    baseUrl,
    apiKey,
    tenantId,
    businessRef: {
      type: businessRefType,
      id: businessRefId
    },
    rustdeskId,
    displayName: String(env.OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME || env.HOSTNAME || rustdeskId).trim(),
    actorIdentity: String(env.OPC_RUSTDESK_EDGE_ACTOR_IDENTITY || 'rustdesk-edge-agent').trim(),
    runtimeStatus: parseRuntimeStatus(env.OPC_RUSTDESK_EDGE_RUNTIME_STATUS),
    heartbeatIntervalMs,
    edgeInstanceId: String(
      env.OPC_RUSTDESK_EDGE_INSTANCE_ID ||
      metadata.agent_instance ||
      env.HOSTNAME ||
      `rustdesk-edge-${rustdeskId}`
    ).trim(),
    commandToken,
    commandPollIntervalMs,
    commandLeaseMs,
    commandTimeoutMs,
    disconnectAdapter,
    restartAdapter,
    disconnectCommandCapable: Boolean(disconnectAdapter || restartAdapter),
    ...(spoolDir
      ? {
        spoolDir,
        spoolMaxBytes: parseBoundedInteger(
          env.OPC_RUSTDESK_EDGE_SPOOL_MAX_BYTES,
          'OPC_RUSTDESK_EDGE_SPOOL_MAX_BYTES',
          64 * 1_024,
          1_024,
          1_048_576
        ),
        spoolMaxAgeMs: parseBoundedInteger(
          env.OPC_RUSTDESK_EDGE_SPOOL_MAX_AGE_MS,
          'OPC_RUSTDESK_EDGE_SPOOL_MAX_AGE_MS',
          7 * 24 * 60 * 60 * 1_000,
          1_000,
          365 * 24 * 60 * 60 * 1_000
        ),
        spoolMaxQuarantineRecords: parseBoundedInteger(
          env.OPC_RUSTDESK_EDGE_SPOOL_MAX_QUARANTINE_RECORDS,
          'OPC_RUSTDESK_EDGE_SPOOL_MAX_QUARANTINE_RECORDS',
          100,
          1,
          10_000
        )
      }
      : {}),
    offlineOnExit: envFlag(env.OPC_RUSTDESK_EDGE_OFFLINE_ON_EXIT),
    metadata: {
      ...metadata,
      ...(clientVersion ? { client_version: clientVersion } : {}),
      ...(edgeOs ? { os: edgeOs } : {})
    }
  };
}

function parseHeartbeatIntervalMs(rawIntervalMs: string | undefined): number {
  if (rawIntervalMs === undefined || rawIntervalMs.trim() === '') return 60_000;
  const intervalMs = Number(rawIntervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
    throw new Error('OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS must be a number >= 10000');
  }
  return intervalMs;
}

function parseBoundedInteger(
  rawValue: string | undefined,
  envName: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const upperBound = maximum < 300_000 ? ` and <= ${maximum}` : '';
    throw new Error(`${envName} must be a number >= ${minimum}${upperBound}`);
  }
  return value;
}

function parseEdgeAdapter(
  executableValue: string | undefined,
  argsValue: string | undefined,
  executableEnvName: string,
  argsEnvName: string
): RustDeskEdgeAdapter | null {
  const executable = String(executableValue || '').trim();
  const args = validateAdapterArgs(parseStringArray(argsValue, argsEnvName), argsEnvName);
  if (!executable) {
    if (args.length) throw new Error(`${executableEnvName} is required when ${argsEnvName} is configured`);
    return null;
  }
  if (!isAbsoluteExecutable(executable)) {
    throw new Error(`${executableEnvName} must be an absolute path`);
  }
  return { executable, args };
}

function validateAdapterArgs(args: string[], envName: string): string[] {
  const supported = new Set([
    '{command_id}',
    '{external_id}',
    '{target_id}',
    '{rustdesk_id}',
    '{requested_reason}'
  ]);
  for (const arg of args) {
    const placeholders = arg.match(/\{[a-z_]+\}/g) || [];
    for (const placeholder of placeholders) {
      if (arg !== placeholder || !supported.has(placeholder)) {
        throw new Error(`${envName} contains unsupported RustDesk adapter placeholder: ${placeholder}`);
      }
    }
  }
  return args;
}

function isAbsoluteExecutable(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function parseStringArray(value: string | undefined, envName: string): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error(`${envName} must be a JSON string array`);
  }
}

export async function runRustDeskEdgeAgentOffline(
  config: RustDeskEdgeAgentConfig,
  fetchImpl: FetchLike = fetch
): Promise<RustDeskEdgeAgentResult> {
  return runRustDeskEdgeAgentOnce({
    ...config,
    runtimeStatus: 'offline',
    metadata: {
      ...config.metadata,
      offline_reason: 'agent_exit'
    }
  }, fetchImpl);
}

export async function runRustDeskEdgeAgentOnce(
  config: RustDeskEdgeAgentConfig,
  fetchImpl: FetchLike = fetch
): Promise<RustDeskEdgeAgentResult> {
  const existing = await findRegisteredDevice(config, fetchImpl);
  const device = existing || await registerDevice(config, fetchImpl);
  const heartbeat = await postHeartbeat(config, device.id, fetchImpl);
  return {
    deviceId: heartbeat.id || device.id,
    rustdeskId: heartbeat.rustdesk_id || device.rustdesk_id || config.rustdeskId,
    registered: !existing,
    runtimeStatus: heartbeat.runtime_status || config.runtimeStatus,
    lastSeenAt: String(heartbeat.last_seen_at || config.seenAt || '')
  };
}

async function findRegisteredDevice(
  config: RustDeskEdgeAgentConfig,
  fetchImpl: FetchLike
): Promise<RustDeskDevicePayload | null> {
  const params = new URLSearchParams({
    business_ref_type: config.businessRef.type,
    business_ref_id: config.businessRef.id,
    limit: '50'
  });
  const payload = await requestJson<{ data?: RustDeskDevicePayload[] }>(
    config,
    fetchImpl,
    `/api/collaboration/rustdesk/devices/by-ref?${params.toString()}`,
    { method: 'GET' }
  );
  const devices = Array.isArray(payload.data) ? payload.data : [];
  return devices.find((device) =>
    device.status !== 'inactive' &&
    String(device.rustdesk_id || '').trim() === config.rustdeskId
  ) || null;
}

async function registerDevice(
  config: RustDeskEdgeAgentConfig,
  fetchImpl: FetchLike
): Promise<RustDeskDevicePayload> {
  const payload = await requestJson<{ data?: RustDeskDevicePayload }>(
    config,
    fetchImpl,
    '/api/collaboration/rustdesk/devices',
    {
      method: 'POST',
      body: JSON.stringify({
        business_ref: {
          type: config.businessRef.type,
          id: config.businessRef.id
        },
        rustdesk_id: config.rustdeskId,
        display_name: config.displayName,
        metadata: {
          source: 'rustdesk-edge-agent',
          ...config.metadata
        }
      })
    }
  );
  if (!payload.data?.id) throw new Error('RustDesk device registration did not return a device id');
  return payload.data;
}

async function postHeartbeat(
  config: RustDeskEdgeAgentConfig,
  deviceId: string,
  fetchImpl: FetchLike
): Promise<RustDeskDevicePayload> {
  const payload = await requestJson<{ data?: RustDeskDevicePayload }>(
    config,
    fetchImpl,
    `/api/collaboration/rustdesk/devices/${encodeURIComponent(deviceId)}/heartbeat`,
    {
      method: 'POST',
      body: JSON.stringify({
        actor_identity: config.actorIdentity,
        runtime_status: config.runtimeStatus,
        seen_at: config.seenAt || new Date().toISOString(),
        metadata: heartbeatMetadata(config)
      })
    }
  );
  if (!payload.data?.id) throw new Error('RustDesk heartbeat did not return a device id');
  return payload.data;
}

export function createRustDeskEdgeCommandProcessor(
  config: RustDeskEdgeAgentConfig,
  fetchImpl: FetchLike = fetch
): RustDeskEdgeCommandProcessor {
  const edgeInstanceId = edgeInstanceIdForConfig(config);
  return new RustDeskEdgeCommandProcessor(
    {
      baseUrl: config.baseUrl,
      commandToken: requiredCommandToken(config.commandToken),
      edgeInstanceId,
      commandLeaseMs: config.commandLeaseMs || 40_000,
      execution: {
        timeoutMs: config.commandTimeoutMs || 15_000,
        edgeInstanceId,
        edgeAgentVersion: String(config.metadata.client_version || ''),
        os: String(config.metadata.os || process.platform),
        disconnectAdapter: config.disconnectAdapter || null,
        restartAdapter: config.restartAdapter || null
      },
      ...(config.spoolDir
        ? {
          spool: {
            directory: config.spoolDir,
            max_bytes: config.spoolMaxBytes,
            max_age_ms: config.spoolMaxAgeMs,
            max_quarantine_records: config.spoolMaxQuarantineRecords
          }
        }
        : {})
    },
    fetchImpl
  );
}

export async function runRustDeskEdgeAgentCommandOnce(
  config: RustDeskEdgeAgentConfig,
  deviceId: string,
  fetchImpl: FetchLike = fetch
): Promise<RustDeskEdgeCommandPollResult> {
  if (!disconnectCommandCapable(config)) return 'idle';
  const processor = createRustDeskEdgeCommandProcessor(config, fetchImpl);
  try {
    return await processor.pollOnce(deviceId);
  } finally {
    await processor.close();
  }
}

async function requestJson<T>(
  config: RustDeskEdgeAgentConfig,
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'x-api-key': config.apiKey,
      'x-tenant-id': config.tenantId,
      'x-user-id': config.actorIdentity,
      ...(config.commandToken
        ? { 'x-rustdesk-edge-token': config.commandToken }
        : {}),
      'content-type': 'application/json'
    }
  });
  if (!response.ok) {
    const detail = await responseErrorDetail(response);
    throw new Error(
      `RustDesk edge agent request failed: ${init.method || 'GET'} ${path} ${response.status}${detail ? ` ${detail}` : ''}`
    );
  }
  return (await response.json()) as T;
}

async function responseErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const detail = payload.error || payload.message || payload.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch {
    // Fall through to raw text for non-JSON upstream errors.
  }
  return text.slice(0, 500);
}

function resolveRustDeskId(env: NodeJS.ProcessEnv): string {
  const direct = String(env.OPC_RUSTDESK_EDGE_RUSTDESK_ID || env.RUSTDESK_ID || '').trim();
  if (direct) return direct;
  const filePath = String(env.OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE || '').trim();
  if (!filePath) return '';
  let fileValue = '';
  try {
    fileValue = readFileSync(filePath, 'utf8').trim();
  } catch {
    throw new Error(`OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE cannot be read: ${filePath}`);
  }
  if (!fileValue) throw new Error(`OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE is empty: ${filePath}`);
  return fileValue;
}

function resolveCommandToken(env: NodeJS.ProcessEnv): string {
  const direct = String(env.OPC_RUSTDESK_EDGE_COMMAND_TOKEN || '').trim();
  if (direct) return direct;
  const filePath = String(env.OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE || '').trim();
  if (!filePath) return '';
  let fileValue = '';
  try {
    fileValue = readFileSync(filePath, 'utf8').trim();
  } catch {
    throw new Error(`OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE cannot be read: ${filePath}`);
  }
  if (!fileValue) throw new Error(`OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE is empty: ${filePath}`);
  return fileValue;
}

function parseMetadataJson(value: string | undefined): Record<string, unknown> {
  const raw = String(value || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('OPC_RUSTDESK_EDGE_METADATA_JSON must be a JSON object');
  }
}

function parseRuntimeStatus(value: string | undefined): 'online' | 'offline' {
  const raw = String(value || '').trim();
  if (!raw) return 'online';
  if (raw === 'online' || raw === 'offline') return raw;
  throw new Error('OPC_RUSTDESK_EDGE_RUNTIME_STATUS must be online or offline');
}

function edgeVersion(value: unknown): string {
  const version = String(value || '').trim();
  if (version && !/^[a-zA-Z0-9._+-]{1,64}$/.test(version)) {
    throw new Error('OPC_RUSTDESK_EDGE_CLIENT_VERSION must contain 1 to 64 version characters');
  }
  return version;
}

function edgeOperatingSystem(value: unknown): string {
  const os = String(value || '').trim();
  if (
    os &&
    !['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'windows'].includes(os)
  ) {
    throw new Error('OPC_RUSTDESK_EDGE_OS must be a supported operating system');
  }
  return os;
}

function stripTrailingSlash(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeHttpBaseUrl(value: string, envName: string): string {
  const baseUrl = stripTrailingSlash(value);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${envName} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http(s)`);
  }
  return baseUrl;
}

async function main(): Promise<void> {
  const config = createRustDeskEdgeAgentConfigFromEnv(process.env);
  if (envFlag(process.env.OPC_RUSTDESK_EDGE_ONCE)) {
    const result = await runRustDeskEdgeAgentOnce(config);
    const command = await runRustDeskEdgeAgentCommandOnce(config, result.deviceId);
    console.log(JSON.stringify({ ...result, command }, null, 2));
    return;
  }

  const commandProcessor = createRustDeskEdgeCommandProcessor(config);
  let deviceId = '';
  let heartbeatRunning = false;
  let commandRunning = false;
  const beat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const result = await runRustDeskEdgeAgentOnce(config);
      deviceId = result.deviceId;
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    } finally {
      heartbeatRunning = false;
    }
  };
  const pollCommand = async () => {
    if (!disconnectCommandCapable(config) || !deviceId || commandRunning) return;
    commandRunning = true;
    try {
      const command = await commandProcessor.pollOnce(deviceId);
      if (command !== 'idle') console.log(JSON.stringify({ at: new Date().toISOString(), command }));
    } finally {
      commandRunning = false;
    }
  };
  await beat();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await commandProcessor.close();
    if (config.offlineOnExit) {
      try {
        const result = await runRustDeskEdgeAgentOffline(config);
        console.log(JSON.stringify({ at: new Date().toISOString(), signal, ...result }));
      } catch (error) {
        console.error((error as Error).message);
      }
    }
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  setInterval(() => {
    void beat().catch((error) => {
      console.error((error as Error).message);
    });
  }, config.heartbeatIntervalMs);
  setInterval(() => {
    void pollCommand().catch((error) => {
      console.error((error as Error).message);
    });
  }, config.commandPollIntervalMs || 2_000);
}

function envFlag(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function heartbeatMetadata(config: RustDeskEdgeAgentConfig): Record<string, unknown> {
  return {
    ...config.metadata,
    disconnect_command_capable: disconnectCommandCapable(config),
    edge_instance_id: edgeInstanceIdForConfig(config),
    command_poll_interval_ms: config.commandPollIntervalMs || 2_000
  };
}

function disconnectCommandCapable(config: RustDeskEdgeAgentConfig): boolean {
  const adapterCapable = config.disconnectCommandCapable !== undefined
    ? config.disconnectCommandCapable
    : Boolean(config.disconnectAdapter || config.restartAdapter);
  return adapterCapable && Boolean(String(config.commandToken || '').trim());
}

function requiredCommandToken(value: string | undefined): string {
  const token = String(value || '').trim();
  if (!token) throw new Error('OPC_RUSTDESK_EDGE_COMMAND_TOKEN is required');
  return token;
}

function edgeInstanceIdForConfig(config: RustDeskEdgeAgentConfig): string {
  return String(
    config.edgeInstanceId ||
    config.metadata.agent_instance ||
    config.actorIdentity ||
    `rustdesk-edge-${config.rustdeskId}`
  ).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
