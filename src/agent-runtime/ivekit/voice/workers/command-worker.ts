import { randomUUID } from 'node:crypto';

import { safeVoiceProviderPayload } from '../canonical.js';
import { voiceProfileConfigHash } from '../deployment-profile-service.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceAddressProtector,
  VoiceCommandRepository,
  VoiceConfigurationRepository,
  VoiceManagementApplyResult,
  VoiceProviderAdapter
} from '../ports.js';
import { VoiceProviderRegistry } from '../provider-registry.js';
import type {
  VoiceCallCommand,
  VoiceCapability,
  VoiceConfigurationCommand,
  VoiceDid,
  VoiceExtension,
  VoiceRoute,
  VoiceRouteVersion,
  VoiceSipTrunk
} from '../types.js';

export interface VoiceCallCommandExecutorResult {
  provider_command_id: string;
  result: Record<string, unknown>;
}

export interface VoiceCommandWorkerOptions {
  commands: VoiceCommandRepository;
  configuration: VoiceConfigurationRepository;
  provider_registry: VoiceProviderRegistry;
  address_protector?: VoiceAddressProtector;
  call_executor?: (command: VoiceCallCommand) => Promise<VoiceCallCommandExecutorResult>;
  worker_id: string;
  batch_size?: number;
  lease_ms?: number;
  retry_base_ms?: number;
  retry_max_ms?: number;
  retry_delays_ms?: readonly number[];
  max_attempts?: number;
  retry_jitter_ratio?: number;
  now?: () => Date;
  random?: () => number;
  id?: () => string;
}

export interface VoiceCommandWorkerRunResult {
  claimed: number;
  succeeded: number;
  failed: number;
  retry_wait: number;
  uncertain: number;
  stale: number;
}

interface MutableResult extends VoiceCommandWorkerRunResult {}

type QueueKind = 'call' | 'configuration';
type AnyCommand = VoiceCallCommand | VoiceConfigurationCommand;

export class VoiceCommandWorker {
  readonly #commands: VoiceCommandRepository;
  readonly #configuration: VoiceConfigurationRepository;
  readonly #registry: VoiceProviderRegistry;
  readonly #addressProtector?: VoiceAddressProtector;
  readonly #callExecutor?: (command: VoiceCallCommand) => Promise<VoiceCallCommandExecutorResult>;
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #retryDelays: readonly number[] | null;
  readonly #maxAttempts: number;
  readonly #retryJitterRatio: number;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #id: () => string;
  #active: Promise<VoiceCommandWorkerRunResult> | null = null;
  #shutdown = false;

  constructor(options: VoiceCommandWorkerOptions) {
    this.#commands = options.commands;
    this.#configuration = options.configuration;
    this.#registry = options.provider_registry;
    this.#addressProtector = options.address_protector;
    this.#callExecutor = options.call_executor;
    this.#workerId = boundedIdentifier(options.worker_id);
    this.#batchSize = boundedInteger(options.batch_size, 25, 1, 200);
    this.#leaseMs = boundedInteger(options.lease_ms, 30_000, 1_000, 15 * 60_000);
    this.#retryBaseMs = boundedInteger(options.retry_base_ms, 1_000, 100, 60_000);
    this.#retryMaxMs = boundedInteger(options.retry_max_ms, 60_000, this.#retryBaseMs, 24 * 60 * 60_000);
    this.#retryDelays = options.retry_delays_ms === undefined
      ? null
      : boundedRetryDelays(options.retry_delays_ms);
    this.#maxAttempts = boundedInteger(options.max_attempts, 100, 1, 100);
    this.#retryJitterRatio = boundedNumber(options.retry_jitter_ratio, 0.2, 0, 1);
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#id = options.id ?? randomUUID;
  }

  runOnce(tenantIdInput: string): Promise<VoiceCommandWorkerRunResult> {
    if (this.#shutdown) return Promise.reject(new VoiceError({ code: 'provider_unavailable', status: 503 }));
    if (this.#active) return this.#active;
    const tenantId = boundedIdentifier(tenantIdInput);
    this.#active = this.#runBatch(tenantId).finally(() => { this.#active = null; });
    return this.#active;
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.#active;
  }

  async #runBatch(tenantId: string): Promise<VoiceCommandWorkerRunResult> {
    const result: MutableResult = { claimed: 0, succeeded: 0, failed: 0, retry_wait: 0, uncertain: 0, stale: 0 };
    const now = this.#now();
    const claim = { tenant_id: tenantId, worker_id: this.#workerId, now, lease_ms: this.#leaseMs, limit: this.#batchSize };
    let callError: unknown;
    let configurationError: unknown;
    const callCommands = await this.#commands.claimCallDue(claim).catch((error) => {
      callError = error;
      return [];
    });
    const remaining = this.#batchSize - callCommands.length;
    const configurationCommands = remaining > 0
      ? await this.#commands.claimConfigurationDue({ ...claim, limit: remaining }).catch((error) => {
        configurationError = error;
        return [];
      })
      : [];
    if (callError && configurationError) throw callError;
    result.claimed = callCommands.length + configurationCommands.length;
    for (const command of callCommands) await this.#processCall(command, result);
    for (const command of configurationCommands) await this.#processConfiguration(command, result);
    return result;
  }

  async #processCall(command: VoiceCallCommand, result: MutableResult): Promise<void> {
    let executed: VoiceCallCommandExecutorResult;
    try {
      if (!this.#callExecutor) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
      executed = await this.#callExecutor(command);
    } catch (error) {
      await this.#settleFailure('call', command, error, true, result);
      return;
    }
    try {
      await this.#complete('call', command, executed.provider_command_id, executed.result, result);
    } catch {
      await this.#settleFailure('call', command, completionUnknown(executed.provider_command_id), true, result);
    }
  }

  async #processConfiguration(command: VoiceConfigurationCommand, result: MutableResult): Promise<void> {
    let executed: VoiceCallCommandExecutorResult;
    try {
      executed = await this.#executeConfiguration(command);
    } catch (error) {
      const ambiguous = command.operation === 'apply';
      await this.#settleFailure('configuration', command, error, ambiguous, result);
      return;
    }
    try {
      await this.#complete('configuration', command, executed.provider_command_id, executed.result, result);
    } catch {
      await this.#settleFailure(
        'configuration', command, completionUnknown(executed.provider_command_id), true, result
      );
    }
  }

  async #executeConfiguration(command: VoiceConfigurationCommand): Promise<VoiceCallCommandExecutorResult> {
    const profile = await this.#configuration.getProfile(command.tenant_id, command.profile_id);
    if (!profile) throw new VoiceError({ code: 'not_found', status: 404 });
    if (command.operation !== 'preflight') await this.#requireCapability(command, profile, 'management_http');
    let adapter: VoiceProviderAdapter | null = null;
    try {
      adapter = await this.#registry.create(profile, {
        purpose: command.operation === 'preflight' ? 'preflight' : 'execute'
      });
      if (command.operation === 'preflight') {
        const capabilities = await adapter.preflight();
        await this.#configuration.insertCapabilitySnapshot({
          id: boundedIdentifier(this.#id()), tenant_id: command.tenant_id, profile_id: profile.id,
          provider: capabilities.provider, provider_version: capabilities.provider_version,
          status: 'ready', capabilities: capabilities.capabilities,
          config_hash: capabilities.config_hash, error_code: '', error_message: '',
          checked_at: capabilities.checked_at, created_at: this.#now().toISOString()
        });
        return { provider_command_id: '', result: safeVoiceProviderPayload(capabilities) };
      }
      if (command.operation === 'test' && command.resource_type === 'sip_trunk') {
        const trunk = await this.#trunk(command);
        const tested = await adapter.management.testTrunk({
          resource_id: trunk.id,
          provider_ref: trunk.provider_ref,
          desired_state: trunkDesiredState(trunk)
        });
        if (!tested.ready) throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
        return { provider_command_id: '', result: safeVoiceProviderPayload(tested) };
      }
      if (command.operation !== 'apply') throw new VoiceError({ code: 'capability_unavailable', status: 501 });
      if (command.resource_type === 'sip_trunk') {
        const trunk = await this.#trunk(command);
        const superseded = supersededResult(command, trunk.revision);
        if (superseded) return superseded;
        const applied = await adapter.management.applyTrunk({
          resource_id: trunk.id,
          provider_ref: trunk.provider_ref,
          desired_state: trunkDesiredState(trunk)
        });
        return managementResult(applied, await this.#convergeTrunk(trunk, applied));
      }
      if (command.resource_type === 'did') {
        const did = await this.#did(command);
        const superseded = supersededResult(command, did.did.revision);
        if (superseded) return superseded;
        if (!this.#addressProtector) {
          throw new VoiceError({ code: 'capability_unavailable', status: 501 });
        }
        const address = await this.#configuration.getDidProtectedAddress(command.tenant_id, did.did.id);
        if (!address) throw new VoiceError({ code: 'not_found', status: 404 });
        let clearAddress = await this.#addressProtector.reveal(
          command.tenant_id, address.ciphertext, 'e164'
        );
        let applied: VoiceManagementApplyResult;
        try {
          applied = await adapter.management.applyDid({
            resource_id: did.did.id,
            provider_ref: did.did.provider_ref,
            desired_state: {
              e164: clearAddress,
              trunk_id: did.trunk.id,
              trunk_provider_ref: did.trunk.provider_ref,
              route_id: did.did.route_id,
              status: did.did.status,
              metadata: did.did.metadata
            }
          });
        } finally {
          clearAddress = '';
        }
        return managementResult(applied, await this.#convergeDid(did.did, applied));
      }
      if (command.resource_type === 'extension') {
        const extension = await this.#extension(command);
        const superseded = supersededResult(command, extension.revision);
        if (superseded) return superseded;
        const applied = await adapter.management.applyExtension({
          resource_id: extension.id,
          desired_state: extensionDesiredState(extension)
        });
        return managementResult(applied, await this.#convergeExtension(extension));
      }
      if (command.resource_type === 'route') {
        const { route, version } = await this.#route(command);
        if (version && route.current_published_version !== version.version) {
          return {
            provider_command_id: '',
            result: {
              resource_update: 'superseded',
              route_version: version.version,
              current_published_version: route.current_published_version
            }
          };
        }
        const applied = await adapter.management.applyRoute({
          resource_id: route.id,
          desired_state: {
            name: route.name,
            direction: route.direction,
            status: route.status,
            version: version?.version ?? route.current_published_version,
            rules: version?.rules ?? route.draft_rules
          }
        });
        const resourceUpdate = version
          ? await this.#convergeRouteVersion(version, applied)
          : 'not_tracked';
        return managementResult(applied, resourceUpdate);
      }
      throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    } finally {
      await adapter?.close().catch(() => undefined);
    }
  }

  async #requireCapability(
    command: VoiceConfigurationCommand,
    profile: { id: string } & Parameters<typeof voiceProfileConfigHash>[0],
    capability: VoiceCapability
  ): Promise<void> {
    const snapshot = await this.#configuration.getLatestCapabilitySnapshot(command.tenant_id, command.profile_id);
    if (!snapshot || snapshot.status !== 'ready' || snapshot.config_hash !== voiceProfileConfigHash(profile)
      || snapshot.capabilities[capability] !== true) {
      throw new VoiceError({ code: 'capability_unavailable', status: 501, details: { capability } });
    }
  }

  async #trunk(command: VoiceConfigurationCommand): Promise<VoiceSipTrunk> {
    const trunk = await this.#configuration.getTrunk(command.tenant_id, command.resource_id);
    if (!trunk) throw new VoiceError({ code: 'not_found', status: 404 });
    assertResourceProfile(trunk.profile_id, command.profile_id);
    return trunk;
  }

  async #extension(command: VoiceConfigurationCommand): Promise<VoiceExtension> {
    const extension = await this.#configuration.getExtension(command.tenant_id, command.resource_id);
    if (!extension) throw new VoiceError({ code: 'not_found', status: 404 });
    assertResourceProfile(extension.profile_id, command.profile_id);
    return extension;
  }

  async #did(command: VoiceConfigurationCommand): Promise<{ did: VoiceDid; trunk: VoiceSipTrunk }> {
    const did = await this.#configuration.getDid(command.tenant_id, command.resource_id);
    if (!did) throw new VoiceError({ code: 'not_found', status: 404 });
    const trunk = await this.#configuration.getTrunk(command.tenant_id, did.trunk_id);
    if (!trunk) throw new VoiceError({ code: 'not_found', status: 404 });
    assertResourceProfile(trunk.profile_id, command.profile_id);
    return { did, trunk };
  }

  async #route(command: VoiceConfigurationCommand): Promise<{ route: VoiceRoute; version: VoiceRouteVersion | null }> {
    const route = await this.#configuration.getRoute(command.tenant_id, command.resource_id);
    if (!route) throw new VoiceError({ code: 'not_found', status: 404 });
    assertResourceProfile(route.profile_id, command.profile_id);
    const versionId = typeof command.payload.route_version_id === 'string' ? command.payload.route_version_id : '';
    const versions = versionId ? await this.#configuration.listRouteVersions(command.tenant_id, route.id) : [];
    const version = versionId ? versions.find((candidate) => candidate.id === versionId) ?? null : null;
    if (versionId && !version) throw new VoiceError({ code: 'not_found', status: 404 });
    return { route, version };
  }

  async #convergeTrunk(
    trunk: VoiceSipTrunk,
    applied: VoiceManagementApplyResult
  ): Promise<'applied' | 'superseded'> {
    try {
      await this.#configuration.updateTrunk({
        ...trunk,
        provider_ref: applied.provider_ref,
        status: ['draft', 'applying', 'degraded'].includes(trunk.status) ? 'active' : trunk.status,
        revision: trunk.revision + 1,
        updated_by: this.#workerId,
        updated_at: this.#now().toISOString()
      }, trunk.revision);
      return 'applied';
    } catch (error) {
      if (isRevisionConflict(error)) return 'superseded';
      throw error;
    }
  }

  async #convergeDid(
    did: VoiceDid,
    applied: VoiceManagementApplyResult
  ): Promise<'applied' | 'superseded'> {
    try {
      await this.#configuration.updateDid({
        ...did,
        provider_ref: applied.provider_ref,
        revision: did.revision + 1,
        updated_at: this.#now().toISOString()
      }, did.revision);
      return 'applied';
    } catch (error) {
      if (isRevisionConflict(error)) return 'superseded';
      throw error;
    }
  }

  async #convergeExtension(
    extension: VoiceExtension
  ): Promise<'applied' | 'superseded'> {
    try {
      await this.#configuration.updateExtension({
        ...extension,
        revision: extension.revision + 1,
        updated_at: this.#now().toISOString()
      }, extension.revision);
      return 'applied';
    } catch (error) {
      if (isRevisionConflict(error)) return 'superseded';
      throw error;
    }
  }

  async #convergeRouteVersion(
    version: VoiceRouteVersion,
    applied: VoiceManagementApplyResult
  ): Promise<'applied'> {
    await this.#configuration.updateRouteVersionDeployment({
      ...version,
      deployment_state: 'applied',
      provider_revision: applied.provider_revision
    });
    return 'applied';
  }

  async #complete(
    queue: QueueKind,
    command: AnyCommand,
    providerCommandId: string,
    payload: Record<string, unknown>,
    result: MutableResult
  ): Promise<void> {
    try {
      const input = {
        tenant_id: command.tenant_id, command_id: command.id, worker_id: this.#workerId,
        state: 'succeeded' as const, provider_command_id: providerCommandId,
        result: safeVoiceProviderPayload(payload)
      };
      if (queue === 'call') await this.#commands.completeCall(input);
      else await this.#commands.completeConfiguration(input);
      result.succeeded += 1;
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'lease_lost') {
        result.stale += 1;
        return;
      }
      throw error;
    }
  }

  async #settleFailure(
    queue: QueueKind,
    command: AnyCommand,
    error: unknown,
    ambiguous: boolean,
    result: MutableResult
  ): Promise<void> {
    if (error instanceof VoiceError && error.code === 'lease_lost') {
      result.stale += 1;
      return;
    }
    const classified = classifyWorkerError(error);
    let state: 'retry_wait' | 'uncertain' | 'failed' = 'failed';
    let nextAttemptAt: Date | null = null;
    if (classified.code === 'provider_timeout' && ambiguous) {
      state = 'uncertain';
    } else if (classified.retryable
      && command.attempt_count < Math.min(command.max_attempts, this.#maxAttempts)) {
      state = 'retry_wait';
      nextAttemptAt = new Date(this.#now().getTime() + this.#retryDelay(command.attempt_count));
    }
    try {
      const input = {
        tenant_id: command.tenant_id, command_id: command.id, worker_id: this.#workerId,
        state, next_attempt_at: nextAttemptAt, error_code: classified.code,
        provider_command_id: providerCommandIdFromError(error) || command.provider_command_id
      };
      if (queue === 'call') await this.#commands.releaseCall(input);
      else await this.#commands.releaseConfiguration(input);
      result[state] += 1;
    } catch (releaseError) {
      if (releaseError instanceof VoiceError && releaseError.code === 'lease_lost') {
        result.stale += 1;
        return;
      }
      throw releaseError;
    }
  }

  #retryDelay(attemptCount: number): number {
    if (this.#retryDelays) {
      return this.#retryDelays[Math.min(
        Math.max(0, attemptCount - 1),
        this.#retryDelays.length - 1
      )];
    }
    const exponential = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** Math.max(0, attemptCount)));
    const jitter = exponential * this.#retryJitterRatio * ((this.#random() * 2) - 1);
    return Math.max(this.#retryBaseMs, Math.min(this.#retryMaxMs, Math.round(exponential + jitter)));
  }
}

function managementResult(value: {
  provider_ref: string;
  provider_revision: string;
  safe_diagnostics: Record<string, unknown>;
}, resourceUpdate: string = 'not_tracked'): VoiceCallCommandExecutorResult {
  return {
    provider_command_id: [value.provider_ref, value.provider_revision].filter(Boolean).join(':'),
    result: {
      provider_ref: value.provider_ref,
      provider_revision: value.provider_revision,
      resource_update: resourceUpdate,
      safe_diagnostics: value.safe_diagnostics
    }
  };
}

function supersededResult(
  command: VoiceConfigurationCommand,
  currentRevision: number
): VoiceCallCommandExecutorResult | null {
  const value = command.payload.source_revision;
  if (value === undefined) return null;
  if (!Number.isInteger(value) || Number(value) < 1) throw validationError();
  if (Number(value) === currentRevision) return null;
  return {
    provider_command_id: '',
    result: {
      resource_update: 'superseded',
      source_revision: Number(value),
      current_revision: currentRevision
    }
  };
}

function extensionDesiredState(extension: VoiceExtension): Record<string, unknown> {
  return {
    identity: extension.identity,
    extension: extension.extension,
    display_name: extension.display_name,
    credential_secret_ref: extension.credential_secret_ref,
    permissions: extension.permissions,
    webrtc_enabled: extension.webrtc_enabled,
    status: extension.status
  };
}

function trunkDesiredState(trunk: VoiceSipTrunk): Record<string, unknown> {
  return {
    ...trunk.desired_state,
    provider_name: trunk.id,
    name: trunk.name,
    direction: trunk.direction,
    transport: trunk.transport,
    codecs: trunk.codecs,
    max_channels: trunk.max_channels,
    credential_secret_ref: trunk.credential_secret_ref,
    status: trunk.status
  };
}

function assertResourceProfile(resourceProfileId: string, commandProfileId: string): void {
  if (resourceProfileId !== commandProfileId) throw new VoiceError({ code: 'validation_failed', status: 422 });
}

function classifyWorkerError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof VoiceError) return { code: error.code, retryable: error.retryable };
  return { code: 'provider_unavailable', retryable: true };
}

function completionUnknown(providerCommandId: string): VoiceError {
  return new VoiceError({
    code: 'provider_timeout', retryable: true, status: 504,
    details: providerCommandId ? { provider_command_id: providerCommandId } : {}
  });
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof VoiceError && error.code === 'revision_conflict';
}

function providerCommandIdFromError(error: unknown): string {
  if (!(error instanceof VoiceError)) return '';
  const value = error.details.provider_command_id;
  return typeof value === 'string' && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : '';
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function boundedRetryDelays(value: readonly number[]): readonly number[] {
  if (!Array.isArray(value) || !value.length || value.length > 20
    || value.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 3_600_000)) {
    throw validationError();
  }
  return [...value];
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
