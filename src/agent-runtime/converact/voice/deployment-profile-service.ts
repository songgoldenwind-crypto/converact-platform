import { randomUUID } from 'node:crypto';

import {
  normalizeVoiceActionCapabilities,
  VOICE_CAPABILITIES,
  VOICE_CAPABILITY_SCHEMA_VERSION
} from './capabilities.js';
import { canonicalVoicePayloadHash } from './canonical.js';
import { VoiceError } from './errors.js';
import { observeVoicePreflight } from './metrics.js';
import type { VoiceConfigurationRepository } from './ports.js';
import { VoiceProviderRegistry } from './provider-registry.js';
import type {
  VoiceCapability,
  VoiceCapabilitySnapshot,
  VoiceDeploymentProfile
} from './types.js';

export { VOICE_CAPABILITIES } from './capabilities.js';

export interface VoiceDeploymentProfileServiceOptions {
  repository: VoiceConfigurationRepository;
  registry: VoiceProviderRegistry;
  id?: () => string;
  now?: () => Date;
}

export class VoiceDeploymentProfileService {
  readonly #repository: VoiceConfigurationRepository;
  readonly #registry: VoiceProviderRegistry;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: VoiceDeploymentProfileServiceOptions) {
    this.#repository = options.repository;
    this.#registry = options.registry;
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async create(profile: VoiceDeploymentProfile): Promise<VoiceDeploymentProfile> {
    validateVoiceDeploymentProfile(profile);
    return this.#repository.insertProfile(profile);
  }

  async update(profile: VoiceDeploymentProfile, expectedRevision: number): Promise<VoiceDeploymentProfile> {
    validateVoiceDeploymentProfile(profile);
    return this.#repository.updateProfile(profile, expectedRevision);
  }

  async preflight(tenantId: string, profileId: string): Promise<VoiceCapabilitySnapshot> {
    const profile = await this.#repository.getProfile(tenantId, profileId);
    if (!profile) throw new VoiceError({ code: 'not_found', status: 404 });
    validateVoiceDeploymentProfile(profile);
    const checkedAt = this.#now().toISOString();
    const configHash = voiceProfileConfigHash(profile);
    let adapter: Awaited<ReturnType<VoiceProviderRegistry['create']>> | null = null;
    let provider: string = profile.adapter;
    let providerVersion = profile.desired_version;
    let capabilities = emptyCapabilities();
    let actionCapabilities = normalizeVoiceActionCapabilities();
    let status: VoiceCapabilitySnapshot['status'] = 'failed';
    let errorCode = '';

    try {
      adapter = await this.#registry.create(profile, { purpose: 'preflight' });
      const result = await adapter.preflight();
      provider = result.provider || profile.adapter;
      providerVersion = result.provider_version || profile.desired_version;
      capabilities = normalizeCapabilities(result.capabilities);
      actionCapabilities = normalizeVoiceActionCapabilities(result.action_capabilities);
      status = 'ready';
    } catch (error) {
      errorCode = classifyPreflightError(error);
      status = errorCode === 'capability_unavailable' ? 'not_available' : 'failed';
    } finally {
      await adapter?.close().catch(() => undefined);
    }

    observeVoicePreflight({ adapter: profile.adapter, result: status });

    return this.#repository.insertCapabilitySnapshot({
      id: this.#id(),
      tenant_id: tenantId,
      profile_id: profileId,
      provider,
      provider_version: providerVersion,
      status,
      capabilities,
      capability_schema_version: VOICE_CAPABILITY_SCHEMA_VERSION,
      action_capabilities: actionCapabilities,
      config_hash: configHash,
      error_code: errorCode,
      error_message: errorCode,
      checked_at: checkedAt,
      created_at: checkedAt
    });
  }

  async getCapabilities(tenantId: string, profileId: string): Promise<VoiceCapabilitySnapshot | null> {
    const profile = await this.#repository.getProfile(tenantId, profileId);
    if (!profile) throw new VoiceError({ code: 'not_found', status: 404 });
    const snapshot = await this.#repository.getLatestCapabilitySnapshot(tenantId, profileId);
    if (!snapshot || snapshot.config_hash !== voiceProfileConfigHash(profile)) return null;
    return snapshot;
  }
}

export function voiceProfileConfigHash(profile: VoiceDeploymentProfile): string {
  return canonicalVoicePayloadHash({
    adapter: profile.adapter,
    base_url: profile.base_url,
    desired_version: profile.desired_version,
    config: profile.config,
    secret_refs: Object.fromEntries(Object.entries(profile.secret_refs).sort(([left], [right]) => left.localeCompare(right)))
  });
}

export function validateVoiceDeploymentProfile(profile: VoiceDeploymentProfile): void {
  if (!profile.id || !profile.tenant_id || !profile.name) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  for (const ref of Object.values(profile.secret_refs)) {
    if (!/^env:\/\/[A-Z][A-Z0-9_]*$/.test(ref)) {
      throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    }
  }
  if (profile.base_url) {
    let url: URL;
    try {
      url = new URL(profile.base_url);
    } catch {
      throw new VoiceError({ code: 'validation_failed', status: 422 });
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new VoiceError({ code: 'validation_failed', status: 422 });
    }
    if (url.username || url.password) {
      throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    }
    if (url.search || url.hash) {
      throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    }
  }
  assertVoiceConfigContainsNoSecrets(profile.config);
}

export function assertVoiceConfigContainsNoSecrets(value: unknown): void {
  assertNoSecretConfig(value, new Set());
}

function assertNoSecretConfig(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertNoSecretConfig(item, ancestors);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (/password|secret|token|authorization|credential|apikey/.test(normalized)) {
        throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
      }
      assertNoSecretConfig(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function normalizeCapabilities(input: Readonly<Record<VoiceCapability, boolean>>): Readonly<Record<VoiceCapability, boolean>> {
  return Object.fromEntries(VOICE_CAPABILITIES.map((capability) => [capability, input[capability] === true])) as Record<VoiceCapability, boolean>;
}

function emptyCapabilities(): Readonly<Record<VoiceCapability, boolean>> {
  return Object.fromEntries(VOICE_CAPABILITIES.map((capability) => [capability, false])) as Record<VoiceCapability, boolean>;
}

function classifyPreflightError(error: unknown): string {
  if (error instanceof VoiceError && [
    'provider_auth_failed',
    'provider_unavailable',
    'protocol_mismatch',
    'capability_unavailable'
  ].includes(error.code)) return error.code;
  return 'provider_unavailable';
}
