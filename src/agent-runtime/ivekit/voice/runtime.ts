import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import { MediaCallService } from '../../livekit/media-call-service.js';
import { MediaCallStore } from '../../livekit/media-call-store.js';
import { EncryptedVoiceAddressProtector } from './address-protector.js';
import {
  VoiceLiveKitBridgeCommandExecutor,
  VoiceLiveKitBridgeCommandReconciler,
  VoiceLiveKitBridgeService,
  createLiveKitSipBridgeAdapter
} from './adapters/livekit-sip.js';
import { RustPbxVoiceProviderFactory } from './adapters/rustpbx-provider.js';
import { VoiceProviderCallCommandExecutor } from './call-service.js';
import { voiceProfileConfigHash } from './deployment-profile-service.js';
import { VoiceError } from './errors.js';
import type {
  VoiceAddressProtector,
  VoiceMediaBridgePort,
  VoiceSecretResolver
} from './ports.js';
import { PostgresVoiceCallStore } from './postgres/call-store.js';
import { PostgresVoiceCommandStore } from './postgres/command-store.js';
import { PostgresVoiceConfigurationStore } from './postgres/configuration-store.js';
import { PostgresVoiceRecordingStore } from './postgres/recording-store.js';
import {
  PostgresVoiceCallUnitOfWork,
  PostgresVoiceProviderEventUnitOfWork
} from './postgres/unit-of-work.js';
import { VoiceProviderRegistry } from './provider-registry.js';
import { VoiceRecordingService } from './recording-service.js';
import { EnvVoiceSecretResolver } from './secret-resolver.js';
import {
  VoiceCommandWorker,
  type VoiceCallCommandExecutorResult
} from './workers/command-worker.js';
import { VoiceProviderEventWorker } from './workers/provider-event-worker.js';
import { VoiceReconciliationWorker } from './workers/reconciliation-worker.js';
import type { VoiceCallCommand, VoiceDeploymentProfile } from './types.js';

export interface IveKitVoiceWorkerConfig {
  enabled: boolean;
  command_interval_ms: number;
  command_batch_size: number;
  command_lease_ms: number;
  command_max_attempts: number;
  command_retry_delays_ms: number[];
  event_interval_ms: number;
  event_batch_size: number;
  event_lease_ms: number;
  reconciliation_interval_ms: number;
  reconciliation_max_age_ms: number;
  provider_timeout_ms: number;
  tenant_limit: number;
}

export interface IveKitVoiceRuntimeInput {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  provider_registry?: VoiceProviderRegistry;
  address_protector?: VoiceAddressProtector;
}

export interface IveKitVoiceWorkerHandle {
  stop(): Promise<void>;
}

export type VoiceQueue = 'voice_command' | 'voice_configuration' | 'voice_provider_event';

export function iveKitVoiceWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): IveKitVoiceWorkerConfig {
  const enabled = binaryFlag(env.OPC_IVEKIT_VOICE_WORKERS_ENABLED, false, 'OPC_IVEKIT_VOICE_WORKERS_ENABLED');
  if (enabled) {
    canonicalKey(env.OPC_IVEKIT_VOICE_ADDRESS_KEY, 'OPC_IVEKIT_VOICE_ADDRESS_KEY');
    canonicalKey(env.OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY, 'OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY');
  }
  const providerTimeoutMs = boundedInteger(
    env.OPC_IVEKIT_VOICE_PROVIDER_TIMEOUT_MS,
    10_000,
    100,
    120_000,
    'OPC_IVEKIT_VOICE_PROVIDER_TIMEOUT_MS'
  );
  const commandLeaseMs = boundedInteger(
    env.OPC_IVEKIT_VOICE_COMMAND_LEASE_MS,
    30_000,
    1_000,
    900_000,
    'OPC_IVEKIT_VOICE_COMMAND_LEASE_MS'
  );
  const eventLeaseMs = boundedInteger(
    env.OPC_IVEKIT_VOICE_EVENT_LEASE_MS,
    30_000,
    1_000,
    900_000,
    'OPC_IVEKIT_VOICE_EVENT_LEASE_MS'
  );
  const minimumLease = providerTimeoutMs + 5_000;
  if (enabled && commandLeaseMs < minimumLease) {
    throw new Error('OPC_IVEKIT_VOICE_COMMAND_LEASE_MS must exceed the provider timeout safety budget');
  }
  if (enabled && eventLeaseMs < minimumLease) {
    throw new Error('OPC_IVEKIT_VOICE_EVENT_LEASE_MS must exceed the provider timeout safety budget');
  }
  const reconciliationIntervalMs = boundedInteger(
    env.OPC_IVEKIT_VOICE_RECONCILIATION_INTERVAL_MS, 5_000, 100, 3_600_000,
    'OPC_IVEKIT_VOICE_RECONCILIATION_INTERVAL_MS'
  );
  const reconciliationMaxAgeMs = boundedInteger(
    env.OPC_IVEKIT_VOICE_RECONCILIATION_MAX_AGE_MS, 900_000, 5_000, 604_800_000,
    'OPC_IVEKIT_VOICE_RECONCILIATION_MAX_AGE_MS'
  );
  if (reconciliationMaxAgeMs < reconciliationIntervalMs) {
    throw new Error('OPC_IVEKIT_VOICE_RECONCILIATION_MAX_AGE_MS must be at least the reconciliation interval');
  }
  return {
    enabled,
    command_interval_ms: boundedInteger(
      env.OPC_IVEKIT_VOICE_COMMAND_INTERVAL_MS, 1_000, 100, 300_000,
      'OPC_IVEKIT_VOICE_COMMAND_INTERVAL_MS'
    ),
    command_batch_size: boundedInteger(
      env.OPC_IVEKIT_VOICE_COMMAND_BATCH_SIZE, 25, 1, 200,
      'OPC_IVEKIT_VOICE_COMMAND_BATCH_SIZE'
    ),
    command_lease_ms: commandLeaseMs,
    command_max_attempts: boundedInteger(
      env.OPC_IVEKIT_VOICE_COMMAND_MAX_ATTEMPTS, 5, 1, 100,
      'OPC_IVEKIT_VOICE_COMMAND_MAX_ATTEMPTS'
    ),
    command_retry_delays_ms: retryDelays(env.OPC_IVEKIT_VOICE_COMMAND_RETRY_DELAYS_MS),
    event_interval_ms: boundedInteger(
      env.OPC_IVEKIT_VOICE_EVENT_INTERVAL_MS, 1_000, 100, 300_000,
      'OPC_IVEKIT_VOICE_EVENT_INTERVAL_MS'
    ),
    event_batch_size: boundedInteger(
      env.OPC_IVEKIT_VOICE_EVENT_BATCH_SIZE, 25, 1, 200,
      'OPC_IVEKIT_VOICE_EVENT_BATCH_SIZE'
    ),
    event_lease_ms: eventLeaseMs,
    reconciliation_interval_ms: reconciliationIntervalMs,
    reconciliation_max_age_ms: reconciliationMaxAgeMs,
    provider_timeout_ms: providerTimeoutMs,
    tenant_limit: boundedInteger(
      env.OPC_IVEKIT_VOICE_TENANT_LIMIT, 100, 1, 1_000,
      'OPC_IVEKIT_VOICE_TENANT_LIMIT'
    )
  };
}

export function startIveKitVoiceCommandWorker(
  input: IveKitVoiceRuntimeInput
): IveKitVoiceWorkerHandle {
  const config = iveKitVoiceWorkerConfig(input.env);
  const registry = input.provider_registry ?? createIveKitVoiceProviderRegistry(input.env);
  const protector = requiredProtector(input);
  const workerId = `voice-command:${process.pid}:${randomUUID()}`;
  const listTenants = createVoiceQueueTenantLister(
    input.pg,
    ['voice_command', 'voice_configuration'],
    config.tenant_limit
  );
  return startTenantLoop({
    enabled: config.enabled,
    interval_ms: config.command_interval_ms,
    list_tenants: listTenants,
    // Claims must commit before a non-idempotent provider call can begin.
    run_tenant: (tenantId) => {
      const commands = new PostgresVoiceCommandStore(input.pg);
      const configuration = new PostgresVoiceConfigurationStore(input.pg);
      const calls = new PostgresVoiceCallStore(input.pg);
      const recordings = new PostgresVoiceRecordingStore(input.pg);
      const secretResolver = createIveKitVoiceSecretResolver(input.env);
      const executor = new VoiceProviderCallCommandExecutor({
        calls,
        configuration,
        address_protector: protector,
        provider_registry: registry
      });
      const bridgeExecutor = new VoiceLiveKitBridgeCommandExecutor({
        calls,
        configuration,
        address_protector: protector,
        bridge: async (profile) => new VoiceLiveKitBridgeService({
          media_calls: new MediaCallService(new MediaCallStore(input.pg)),
          bridge: await createIveKitLiveKitBridgePort({
            profile,
            bridges: recordings,
            secret_resolver: secretResolver,
            env: input.env
          })
        })
      });
      return new VoiceCommandWorker({
        commands,
        configuration,
        provider_registry: registry,
        address_protector: protector,
        call_executor: (command) => dispatchIveKitVoiceCallCommand(
          command,
          (providerCommand) => executor.execute(providerCommand),
          (bridgeCommand) => bridgeExecutor.execute(bridgeCommand)
        ),
        worker_id: workerId,
        batch_size: config.command_batch_size,
        lease_ms: config.command_lease_ms,
        retry_base_ms: config.command_retry_delays_ms[0],
        retry_max_ms: config.command_retry_delays_ms.at(-1),
        retry_delays_ms: config.command_retry_delays_ms,
        max_attempts: config.command_max_attempts
      }).runOnce(tenantId);
    },
    label: 'voice-command'
  });
}

export function startIveKitVoiceProviderEventWorker(
  input: IveKitVoiceRuntimeInput
): IveKitVoiceWorkerHandle {
  const config = iveKitVoiceWorkerConfig(input.env);
  const worker = new VoiceProviderEventWorker({
    unit_of_work: new PostgresVoiceProviderEventUnitOfWork(input.pg),
    recording_service: new VoiceRecordingService(),
    worker_id: `voice-event:${process.pid}:${randomUUID()}`,
    batch_size: config.event_batch_size,
    lease_ms: config.event_lease_ms,
    max_attempts: config.command_max_attempts,
    retry_base_ms: config.command_retry_delays_ms[0],
    retry_max_ms: config.command_retry_delays_ms.at(-1)
  });
  return startTenantLoop({
    enabled: config.enabled,
    interval_ms: config.event_interval_ms,
    list_tenants: () => listVoiceWorkerTenants(
      input.pg, 'voice_provider_event', config.tenant_limit
    ),
    run_tenant: (tenantId) => worker.runOnce(tenantId),
    shutdown: () => worker.shutdown(),
    label: 'voice-event'
  });
}

export function startIveKitVoiceReconciliationWorker(
  input: IveKitVoiceRuntimeInput
): IveKitVoiceWorkerHandle {
  const config = iveKitVoiceWorkerConfig(input.env);
  const secretResolver = createIveKitVoiceSecretResolver(input.env);
  const worker = new VoiceReconciliationWorker({
    unit_of_work: new PostgresVoiceCallUnitOfWork(input.pg),
    provider_registry: input.provider_registry ?? createIveKitVoiceProviderRegistry(input.env),
    worker_id: `voice-reconciliation:${process.pid}:${randomUUID()}`,
    batch_size: config.command_batch_size,
    lease_ms: config.command_lease_ms,
    reconcile_delay_ms: config.reconciliation_interval_ms,
    max_reconcile_age_ms: config.reconciliation_max_age_ms,
    command_reconciler: ({ call, command }) => withPgTenant(
      input.pg,
      command.tenant_id,
      async (pg) => {
        const configuration = new PostgresVoiceConfigurationStore(pg);
        const recordings = new PostgresVoiceRecordingStore(pg);
        const reconciler = new VoiceLiveKitBridgeCommandReconciler({
          bridges: recordings,
          bridge: async (profileId) => {
            const profile = await configuration.getProfile(command.tenant_id, profileId);
            if (!profile) throw new VoiceError({ code: 'not_found', status: 404 });
            return createIveKitLiveKitBridgePort({
              profile,
              bridges: recordings,
              secret_resolver: secretResolver,
              env: input.env
            });
          }
        });
        return reconciler.reconcile({ call, command });
      }
    )
  });
  const listTenants = createVoiceQueueTenantLister(
    input.pg,
    ['voice_command', 'voice_configuration'],
    config.tenant_limit
  );
  return startTenantLoop({
    enabled: config.enabled,
    interval_ms: config.reconciliation_interval_ms,
    list_tenants: listTenants,
    run_tenant: (tenantId) => worker.runOnce(tenantId),
    shutdown: () => worker.shutdown(),
    label: 'voice-reconciliation'
  });
}

export async function listVoiceWorkerTenants(
  pg: PgQueryable,
  queue: VoiceQueue,
  limit: number,
  now = new Date()
): Promise<string[]> {
  const result = await pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_worker_tenant_ids($1, $2, $3)',
    [queue, now.toISOString(), limit]
  );
  return result.rows.map((row) => String(row.tenant_id || '')).filter(Boolean);
}

export function createVoiceQueueTenantLister(
  pg: PgQueryable,
  queues: readonly VoiceQueue[],
  limit: number,
  now: () => Date = () => new Date()
): () => Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000 || queues.length === 0) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  let rotation = 0;
  return async () => {
    const timestamp = now();
    const pages = await Promise.all(queues.map((queue) =>
      listVoiceWorkerTenants(pg, queue, limit, timestamp)
    ));
    const rotated = [...pages.slice(rotation), ...pages.slice(0, rotation)];
    rotation = (rotation + 1) % pages.length;
    return roundRobinUnique(rotated, limit);
  };
}

export function createIveKitVoiceProviderRegistry(
  env: NodeJS.ProcessEnv = process.env
): VoiceProviderRegistry {
  const resolver = createIveKitVoiceSecretResolver(env);
  const registry = new VoiceProviderRegistry();
  registry.register('rustpbx', new RustPbxVoiceProviderFactory({
    secret_resolver: resolver,
    production: env.NODE_ENV === 'production'
  }));
  return registry;
}

export function dispatchIveKitVoiceCallCommand(
  command: VoiceCallCommand,
  providerExecutor: (command: VoiceCallCommand) => Promise<VoiceCallCommandExecutorResult>,
  bridgeExecutor: (command: VoiceCallCommand) => Promise<VoiceCallCommandExecutorResult>
): Promise<VoiceCallCommandExecutorResult> {
  return command.kind === 'livekit_bridge_create'
    ? bridgeExecutor(command)
    : providerExecutor(command);
}

function createIveKitVoiceSecretResolver(
  env: NodeJS.ProcessEnv = process.env
): VoiceSecretResolver {
  const configured = envNames(env.OPC_IVEKIT_VOICE_SECRET_ENV_NAMES);
  return new EnvVoiceSecretResolver({
    env,
    allowlist: {
      rustpbx_management: unique([
        'RUSTPBX_MANAGEMENT_TOKEN', 'OPC_IVEKIT_RUSTPBX_MANAGEMENT_TOKEN', ...configured
      ]),
      rustpbx_resource_credential: unique(configured),
      rwi: unique([
        'RUSTPBX_RWI_TOKEN', 'OPC_IVEKIT_RUSTPBX_RWI_TOKEN', ...configured
      ]),
      livekit_sip_api_key: unique([
        'LIVEKIT_API_KEY', 'OPC_IVEKIT_LIVEKIT_API_KEY', ...configured
      ]),
      livekit_sip_api_secret: unique([
        'LIVEKIT_API_SECRET', 'OPC_IVEKIT_LIVEKIT_API_SECRET', ...configured
      ])
    }
  });
}

async function createIveKitLiveKitBridgePort(input: {
  profile: VoiceDeploymentProfile;
  bridges: PostgresVoiceRecordingStore;
  secret_resolver: VoiceSecretResolver;
  env?: NodeJS.ProcessEnv;
}): Promise<VoiceMediaBridgePort> {
  if (input.profile.adapter !== 'livekit_sip') {
    throw new VoiceError({ code: 'capability_unavailable', status: 501 });
  }
  return createLiveKitSipBridgeAdapter({
    profile_id: input.profile.id,
    config_hash: voiceProfileConfigHash(input.profile),
    host: input.profile.base_url,
    api_key_ref: liveKitSecretRef(input.profile, 'api_key'),
    api_secret_ref: liveKitSecretRef(input.profile, 'api_secret'),
    secret_resolver: input.secret_resolver,
    bridges: input.bridges,
    timeout_ms: optionalPositiveInteger(
      input.profile.config.timeout_ms,
      iveKitVoiceWorkerConfig(input.env).provider_timeout_ms
    ),
    production: input.env?.NODE_ENV === 'production',
    internal_service: input.profile.config.internal_service === true
  });
}

function startTenantLoop(input: {
  enabled: boolean;
  interval_ms: number;
  list_tenants: () => Promise<string[]>;
  run_tenant: (tenantId: string) => Promise<unknown>;
  shutdown?: () => Promise<void>;
  label: string;
}): IveKitVoiceWorkerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let stopped = !input.enabled;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (!active) {
        active = runTenantBatch(input).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${input.label}] worker failed:`, redactError(message));
        }).finally(() => { active = null; });
      }
      void active.finally(() => schedule(input.interval_ms));
    }, delay);
    timer.unref?.();
  };
  if (input.enabled) schedule(0);
  let stopPromise: Promise<void> | null = null;
  return {
    stop() {
      if (!stopPromise) {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        stopPromise = Promise.resolve(active).then(() => input.shutdown?.());
      }
      return stopPromise;
    }
  };
}

async function runTenantBatch(input: {
  list_tenants: () => Promise<string[]>;
  run_tenant: (tenantId: string) => Promise<unknown>;
}): Promise<void> {
  for (const tenantId of unique(await input.list_tenants())) await input.run_tenant(tenantId);
}

function requiredProtector(input: IveKitVoiceRuntimeInput): VoiceAddressProtector {
  if (input.address_protector) return input.address_protector;
  const env = input.env || process.env;
  return new EncryptedVoiceAddressProtector({
    encryption_key: String(env.OPC_IVEKIT_VOICE_ADDRESS_KEY || ''),
    hmac_key: String(env.OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY || '')
  });
}

function retryDelays(value: string | undefined): number[] {
  if (!String(value || '').trim()) return [1_000, 5_000, 30_000];
  const values = String(value).split(',').map((item) => Number(item.trim()));
  if (!values.length || values.length > 20
    || values.some((item) => !Number.isInteger(item) || item < 0 || item > 3_600_000)) {
    throw new Error('OPC_IVEKIT_VOICE_COMMAND_RETRY_DELAYS_MS must be comma-separated integers between 0 and 3600000');
  }
  return values;
}

function binaryFlag(value: string | undefined, fallback: boolean, field: string): boolean {
  if (!String(value || '').trim()) return fallback;
  if (value !== '0' && value !== '1') throw new Error(`${field} must be 0 or 1`);
  return value === '1';
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function canonicalKey(value: string | undefined, field: string): void {
  const input = String(value || '').trim();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(input, 'base64');
  } catch {
    throw new Error(`${field} must be canonical base64 for 32 bytes`);
  }
  if (!input || decoded.length !== 32 || decoded.toString('base64') !== input) {
    throw new Error(`${field} must be canonical base64 for 32 bytes`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function roundRobinUnique(pages: readonly string[][], limit: number): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  const maxLength = Math.max(0, ...pages.map((page) => page.length));
  for (let index = 0; index < maxLength && selected.length < limit; index += 1) {
    for (const page of pages) {
      const tenantId = page[index];
      if (!tenantId || seen.has(tenantId)) continue;
      seen.add(tenantId);
      selected.push(tenantId);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

function envNames(value: string | undefined): string[] {
  return String(value || '').split(',').map((name) => name.trim())
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
}

function liveKitSecretRef(
  profile: VoiceDeploymentProfile,
  kind: 'api_key' | 'api_secret'
): string {
  const aliases = kind === 'api_key'
    ? ['api_key', 'livekit_api_key']
    : ['api_secret', 'livekit_api_secret'];
  const value = aliases.map((key) => profile.secret_refs[key]).find(Boolean);
  if (!value) throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
  return value;
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || Number(value) < 10 || Number(value) > 120_000) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return Number(value);
}

function redactError(value: string): string {
  return value
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
