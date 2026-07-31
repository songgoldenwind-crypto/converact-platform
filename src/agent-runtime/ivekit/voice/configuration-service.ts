import { randomUUID } from 'node:crypto';

import { canonicalVoicePayloadHash } from './canonical.js';
import {
  assertVoiceConfigContainsNoSecrets,
  validateVoiceDeploymentProfile
} from './deployment-profile-service.js';
import { VoiceError } from './errors.js';
import type {
  VoiceAddressProtector,
  VoiceConfigurationUnitOfWork,
  VoiceConfigurationUnitOfWorkContext,
  VoiceEventPort
} from './ports.js';
import type {
  VoiceAdapter,
  VoiceConfigurationCommand,
  VoiceConfigurationOperation,
  VoiceConfigurationResourceType,
  VoiceConsent,
  VoiceDeploymentProfile,
  VoiceDid,
  VoiceExtension,
  VoiceListInput,
  VoicePage,
  VoicePolicy,
  VoiceRoute,
  VoiceRouteDirection,
  VoiceRouteVersion,
  VoiceSipTrunk
} from './types.js';

export interface VoiceConfigurationServiceOptions {
  unit_of_work: VoiceConfigurationUnitOfWork;
  address_protector: VoiceAddressProtector;
  event_port: VoiceEventPort;
  id?: (kind: string) => string;
  now?: () => Date;
}

interface AdminInput {
  tenant_id: string;
  actor: string;
}

export interface CreateVoiceProfileInput extends AdminInput {
  name: string;
  adapter: VoiceAdapter;
  base_url: string;
  desired_version: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  status?: VoiceDeploymentProfile['status'];
}

export interface UpdateVoiceProfileInput extends AdminInput {
  profile_id: string;
  expected_revision: number;
  patch: Partial<Pick<VoiceDeploymentProfile,
    'name' | 'adapter' | 'status' | 'base_url' | 'desired_version' | 'config' | 'secret_refs'>>;
}

export interface CreateVoiceTrunkInput extends AdminInput {
  profile_id: string;
  name: string;
  direction: VoiceRouteDirection;
  transport: VoiceSipTrunk['transport'];
  codecs: string[];
  max_channels: number;
  credential_secret_ref: string;
  desired_state: Record<string, unknown>;
}

export interface UpdateVoiceTrunkInput extends AdminInput {
  trunk_id: string;
  expected_revision: number;
  patch: Partial<Pick<VoiceSipTrunk,
    'name' | 'direction' | 'transport' | 'codecs' | 'max_channels' | 'credential_secret_ref' | 'desired_state' | 'status'>>;
}

export interface CreateVoiceDidInput extends AdminInput {
  trunk_id: string;
  route_id: string | null;
  e164: string;
  metadata: Record<string, unknown>;
  status?: VoiceDid['status'];
}

export interface UpdateVoiceDidInput extends AdminInput {
  did_id: string;
  expected_revision: number;
  patch: Partial<Pick<VoiceDid, 'trunk_id' | 'route_id' | 'provider_ref' | 'status' | 'metadata'>>;
}

export interface CreateVoiceExtensionInput extends AdminInput {
  profile_id: string;
  identity: string;
  extension: string;
  display_name: string;
  credential_secret_ref: string;
  permissions: Record<string, unknown>;
  webrtc_enabled: boolean;
  status?: VoiceExtension['status'];
}

export interface UpdateVoiceExtensionInput extends AdminInput {
  extension_id: string;
  expected_revision: number;
  patch: Partial<Pick<VoiceExtension,
    'identity' | 'extension' | 'display_name' | 'credential_secret_ref' | 'permissions' | 'webrtc_enabled' | 'status'>>;
}

export interface CreateVoiceRouteInput extends AdminInput {
  profile_id: string;
  name: string;
  direction: VoiceRouteDirection;
  draft_rules: Record<string, unknown>;
}

export interface UpdateVoiceRouteInput extends AdminInput {
  route_id: string;
  expected_revision: number;
  patch: Partial<Pick<VoiceRoute, 'name' | 'direction' | 'status' | 'draft_rules'>>;
}

export interface PublishVoiceRouteInput extends AdminInput {
  route_id: string;
  expected_revision: number;
  idempotency_key: string;
}

export interface UpsertVoicePolicyInput extends AdminInput {
  require_outbound_consent: boolean;
  recording_mode: VoicePolicy['recording_mode'];
  recording_retention_days: number;
  require_ai_disclosure: boolean;
  allowed_calling_windows: unknown[];
  masking_policy: Record<string, unknown>;
  status: VoicePolicy['status'];
  expected_revision: number | null;
}

export interface CreateVoiceConsentInput extends AdminInput {
  subject_ref_type: string;
  subject_ref_id: string;
  business_ref_type: string;
  business_ref_id: string;
  consent_type: VoiceConsent['consent_type'];
  status: VoiceConsent['status'];
  evidence_ref: string;
  granted_by: string;
  expires_at: string | null;
}

export interface EnqueueVoiceConfigurationOperationInput extends AdminInput {
  profile_id: string;
  resource_type: VoiceConfigurationResourceType;
  resource_id: string;
  operation: VoiceConfigurationOperation;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

export class VoiceConfigurationService {
  readonly #unitOfWork: VoiceConfigurationUnitOfWork;
  readonly #addressProtector: VoiceAddressProtector;
  readonly #eventPort: VoiceEventPort;
  readonly #id: (kind: string) => string;
  readonly #now: () => Date;

  constructor(options: VoiceConfigurationServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#addressProtector = options.address_protector;
    this.#eventPort = options.event_port;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async createProfile(input: CreateVoiceProfileInput): Promise<VoiceDeploymentProfile> {
    const now = this.#timestamp();
    const profile: VoiceDeploymentProfile = {
      id: this.#newId('profile'),
      tenant_id: boundedIdentifier(input.tenant_id),
      name: boundedName(input.name),
      adapter: voiceAdapter(input.adapter),
      status: profileStatus(input.status ?? 'disabled'),
      base_url: String(input.base_url ?? ''),
      desired_version: boundedText(input.desired_version, 128, true),
      config: jsonRecord(input.config),
      secret_refs: secretRefs(input.secret_refs),
      revision: 1,
      created_by: boundedIdentifier(input.actor),
      updated_by: boundedIdentifier(input.actor),
      created_at: now,
      updated_at: now
    };
    validateVoiceDeploymentProfile(profile);
    const created = await this.#unitOfWork.run(profile.tenant_id, ({ configuration }) => configuration.insertProfile(profile));
    await this.#event(profile.tenant_id, 'profile.created', created, input.actor);
    return created;
  }

  async updateProfile(input: UpdateVoiceProfileInput): Promise<VoiceDeploymentProfile> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const updated = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const current = required(await configuration.getProfile(tenantId, boundedIdentifier(input.profile_id), { for_update: true }));
      assertRevision(current.revision, input.expected_revision);
      const profile: VoiceDeploymentProfile = {
        ...current,
        ...definedPatch(input.patch, [
          'name', 'adapter', 'status', 'base_url', 'desired_version', 'config', 'secret_refs'
        ]),
        id: current.id,
        tenant_id: tenantId,
        revision: current.revision + 1,
        updated_by: boundedIdentifier(input.actor),
        updated_at: this.#timestamp()
      };
      profile.name = boundedName(profile.name);
      profile.adapter = voiceAdapter(profile.adapter);
      profile.status = profileStatus(profile.status);
      profile.config = jsonRecord(profile.config);
      profile.secret_refs = secretRefs(profile.secret_refs);
      validateVoiceDeploymentProfile(profile);
      return configuration.updateProfile(profile, input.expected_revision);
    });
    await this.#event(tenantId, 'profile.updated', updated, input.actor);
    return updated;
  }

  async createTrunk(input: CreateVoiceTrunkInput): Promise<VoiceSipTrunk> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const actor = boundedIdentifier(input.actor);
    const now = this.#timestamp();
    const trunk: VoiceSipTrunk = {
      id: this.#newId('trunk'), tenant_id: tenantId, profile_id: boundedIdentifier(input.profile_id),
      name: boundedName(input.name), provider_ref: '', direction: routeDirection(input.direction),
      transport: trunkTransport(input.transport), codecs: normalizedCodecs(input.codecs),
      max_channels: boundedInteger(input.max_channels, 1, 100_000),
      credential_secret_ref: secretRef(input.credential_secret_ref),
      desired_state: safeConfiguration(input.desired_state), status: 'draft', revision: 1,
      created_by: actor, updated_by: actor, created_at: now, updated_at: now
    };
    const created = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      required(await configuration.getProfile(tenantId, trunk.profile_id));
      return configuration.insertTrunk(trunk);
    });
    await this.#event(tenantId, 'trunk.created', created, actor);
    return created;
  }

  async updateTrunk(input: UpdateVoiceTrunkInput): Promise<VoiceSipTrunk> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const updated = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const current = required(await configuration.getTrunk(tenantId, boundedIdentifier(input.trunk_id), { for_update: true }));
      assertRevision(current.revision, input.expected_revision);
      const trunk = { ...current, ...definedPatch(input.patch, [
        'name', 'direction', 'transport', 'codecs', 'max_channels', 'credential_secret_ref',
        'desired_state', 'status'
      ]), revision: current.revision + 1,
        updated_by: boundedIdentifier(input.actor), updated_at: this.#timestamp() };
      trunk.name = boundedName(trunk.name);
      trunk.direction = routeDirection(trunk.direction);
      trunk.transport = trunkTransport(trunk.transport);
      trunk.codecs = normalizedCodecs(trunk.codecs);
      trunk.max_channels = boundedInteger(trunk.max_channels, 1, 100_000);
      trunk.credential_secret_ref = secretRef(trunk.credential_secret_ref);
      trunk.desired_state = safeConfiguration(trunk.desired_state);
      trunk.status = trunkStatus(trunk.status);
      return configuration.updateTrunk(trunk, input.expected_revision);
    });
    await this.#event(tenantId, 'trunk.updated', updated, input.actor);
    return updated;
  }

  async createDid(input: CreateVoiceDidInput): Promise<VoiceDid> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const normalized = normalizedE164(input.e164);
    const protectedAddress = await this.#addressProtector.protect(tenantId, normalized, 'e164');
    const now = this.#timestamp();
    const did: VoiceDid = {
      id: this.#newId('did'), tenant_id: tenantId, trunk_id: boundedIdentifier(input.trunk_id),
      route_id: nullableIdentifier(input.route_id), e164: { kind: 'e164', redacted: protectedAddress.redacted },
      provider_ref: '', status: didStatus(input.status ?? 'active'), metadata: jsonRecord(input.metadata),
      revision: 1, created_at: now, updated_at: now
    };
    const created = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      required(await configuration.getTrunk(tenantId, did.trunk_id));
      if (did.route_id) required(await configuration.getRoute(tenantId, did.route_id));
      return configuration.insertDid(did, { kind: 'e164', ...protectedAddress });
    });
    await this.#event(tenantId, 'did.created', created, input.actor);
    return created;
  }

  async updateDid(input: UpdateVoiceDidInput): Promise<VoiceDid> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const updated = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const current = required(await configuration.getDid(tenantId, boundedIdentifier(input.did_id), { for_update: true }));
      assertRevision(current.revision, input.expected_revision);
      const did = { ...current, ...definedPatch(input.patch, [
        'trunk_id', 'route_id', 'provider_ref', 'status', 'metadata'
      ]), id: current.id, tenant_id: tenantId,
        e164: current.e164, revision: current.revision + 1, updated_at: this.#timestamp() };
      did.trunk_id = boundedIdentifier(did.trunk_id);
      did.route_id = nullableIdentifier(did.route_id);
      did.metadata = jsonRecord(did.metadata);
      did.status = didStatus(did.status);
      return configuration.updateDid(did, input.expected_revision);
    });
    await this.#event(tenantId, 'did.updated', updated, input.actor);
    return updated;
  }

  async createExtension(input: CreateVoiceExtensionInput): Promise<VoiceExtension> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const now = this.#timestamp();
    const extension: VoiceExtension = {
      id: this.#newId('extension'), tenant_id: tenantId, profile_id: boundedIdentifier(input.profile_id),
      identity: genericIdentity(input.identity), extension: extensionNumber(input.extension),
      display_name: boundedName(input.display_name), credential_secret_ref: secretRef(input.credential_secret_ref),
      permissions: safeConfiguration(input.permissions), webrtc_enabled: booleanValue(input.webrtc_enabled),
      status: extensionStatus(input.status ?? 'active'), revision: 1, created_at: now, updated_at: now
    };
    const created = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      required(await configuration.getProfile(tenantId, extension.profile_id));
      return configuration.insertExtension(extension);
    });
    await this.#event(tenantId, 'extension.created', created, input.actor);
    return created;
  }

  async updateExtension(input: UpdateVoiceExtensionInput): Promise<VoiceExtension> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const updated = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const current = required(await configuration.getExtension(tenantId, boundedIdentifier(input.extension_id), { for_update: true }));
      assertRevision(current.revision, input.expected_revision);
      const extension = { ...current, ...definedPatch(input.patch, [
        'identity', 'extension', 'display_name', 'credential_secret_ref', 'permissions',
        'webrtc_enabled', 'status'
      ]), id: current.id, tenant_id: tenantId,
        revision: current.revision + 1, updated_at: this.#timestamp() };
      extension.identity = genericIdentity(extension.identity);
      extension.extension = extensionNumber(extension.extension);
      extension.display_name = boundedName(extension.display_name);
      extension.credential_secret_ref = secretRef(extension.credential_secret_ref);
      extension.permissions = safeConfiguration(extension.permissions);
      extension.webrtc_enabled = booleanValue(extension.webrtc_enabled);
      extension.status = extensionStatus(extension.status);
      return configuration.updateExtension(extension, input.expected_revision);
    });
    await this.#event(tenantId, 'extension.updated', updated, input.actor);
    return updated;
  }

  async createRoute(input: CreateVoiceRouteInput): Promise<VoiceRoute> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const actor = boundedIdentifier(input.actor);
    const now = this.#timestamp();
    const route: VoiceRoute = {
      id: this.#newId('route'), tenant_id: tenantId, profile_id: boundedIdentifier(input.profile_id),
      name: boundedName(input.name), direction: routeDirection(input.direction), status: 'draft',
      draft_revision: 1, draft_rules: routeRules(input.draft_rules), current_published_version: null,
      created_by: actor, updated_by: actor, created_at: now, updated_at: now
    };
    const created = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      required(await configuration.getProfile(tenantId, route.profile_id));
      return configuration.insertRoute(route);
    });
    await this.#event(tenantId, 'route.created', created, actor);
    return created;
  }

  async updateRoute(input: UpdateVoiceRouteInput): Promise<VoiceRoute> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const updated = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const current = required(await configuration.getRoute(tenantId, boundedIdentifier(input.route_id), { for_update: true }));
      assertRevision(current.draft_revision, input.expected_revision);
      const route = { ...current, ...definedPatch(input.patch, [
        'name', 'direction', 'status', 'draft_rules'
      ]), id: current.id, tenant_id: tenantId,
        draft_revision: current.draft_revision + 1, updated_by: boundedIdentifier(input.actor), updated_at: this.#timestamp() };
      route.name = boundedName(route.name);
      route.direction = routeDirection(route.direction);
      route.draft_rules = routeRules(route.draft_rules);
      route.status = routeStatus(route.status);
      return configuration.updateRoute(route, input.expected_revision);
    });
    await this.#event(tenantId, 'route.updated', updated, input.actor);
    return updated;
  }

  async publishRoute(input: PublishVoiceRouteInput): Promise<{
    route: VoiceRoute;
    version: VoiceRouteVersion;
    command: VoiceConfigurationCommand;
  }> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const routeId = boundedIdentifier(input.route_id);
    const key = boundedIdempotencyKey(input.idempotency_key);
    const result = await this.#unitOfWork.run(tenantId, async (context) => {
      const route = required(await context.configuration.getRoute(tenantId, routeId, { for_update: true }));
      const identity = {
        profile_id: route.profile_id,
        resource_type: 'route',
        resource_id: route.id,
        operation: 'apply',
        source_revision: input.expected_revision,
        rules: routeRules(route.draft_rules)
      } as const;
      const operationHash = canonicalVoicePayloadHash(identity);
      const existing = await context.commands.findConfigurationByIdempotencyKey(tenantId, key);
      if (existing) {
        if (existing.payload_hash !== operationHash) throw idempotencyConflict();
        const versionId = String(existing.payload.route_version_id ?? '');
        const versions = await context.configuration.listRouteVersions(tenantId, route.id);
        const version = versions.find((candidate) => candidate.id === versionId);
        if (!version) throw idempotencyConflict();
        return { route, version, command: existing };
      }
      assertRevision(route.draft_revision, input.expected_revision);
      const versions = await context.configuration.listRouteVersions(tenantId, route.id);
      const versionNumber = Math.max(0, ...versions.map((version) => version.version)) + 1;
      const now = this.#timestamp();
      const version: VoiceRouteVersion = {
        id: this.#newId('route-version'), tenant_id: tenantId, route_id: route.id,
        version: versionNumber, rules: routeRules(route.draft_rules),
        payload_hash: canonicalVoicePayloadHash(route.draft_rules), deployment_state: 'pending',
        provider_revision: '', published_by: boundedIdentifier(input.actor), published_at: now
      };
      const insertedVersion = await context.configuration.insertRouteVersion(version);
      const publishedRoute = await context.configuration.updateRoute({
        ...route,
        status: 'active',
        current_published_version: insertedVersion.version,
        draft_revision: route.draft_revision + 1,
        updated_by: boundedIdentifier(input.actor),
        updated_at: now
      }, input.expected_revision);
      const command = await context.commands.insertConfiguration(this.#newCommand({
        tenant_id: tenantId, profile_id: route.profile_id, resource_type: 'route',
        resource_id: route.id, operation: 'apply', idempotency_key: key,
        payload_hash: operationHash,
        payload: { route_version_id: insertedVersion.id, route_version: insertedVersion.version,
          route_payload_hash: insertedVersion.payload_hash, source_revision: input.expected_revision }
      }));
      return { route: publishedRoute, version: insertedVersion, command };
    });
    await this.#event(tenantId, 'route.published', {
      route_id: result.route.id, route_version_id: result.version.id,
      command_id: result.command.id, revision: result.route.draft_revision
    }, input.actor);
    return result;
  }

  async upsertPolicy(input: UpsertVoicePolicyInput): Promise<VoicePolicy> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const policy = await this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const current = await configuration.getPolicy(tenantId);
      if (input.expected_revision === null && current) throw new VoiceError({ code: 'revision_conflict', status: 409 });
      if (input.expected_revision !== null) assertRevision(required(current).revision, input.expected_revision);
      const actor = boundedIdentifier(input.actor);
      const now = this.#timestamp();
      const value: VoicePolicy = {
        id: current?.id ?? this.#newId('policy'), tenant_id: tenantId,
        require_outbound_consent: booleanValue(input.require_outbound_consent),
        recording_mode: recordingMode(input.recording_mode),
        recording_retention_days: boundedInteger(input.recording_retention_days, 0, 3_650),
        require_ai_disclosure: booleanValue(input.require_ai_disclosure),
        allowed_calling_windows: jsonArray(input.allowed_calling_windows),
        masking_policy: safeConfiguration(input.masking_policy), status: policyStatus(input.status),
        revision: (current?.revision ?? 0) + 1, created_by: current?.created_by ?? actor,
        updated_by: actor, created_at: current?.created_at ?? now, updated_at: now
      };
      return configuration.upsertPolicy(value, input.expected_revision);
    });
    await this.#event(tenantId, 'policy.upserted', policy, input.actor);
    return policy;
  }

  async createConsent(input: CreateVoiceConsentInput): Promise<VoiceConsent> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const now = this.#timestamp();
    const consent: VoiceConsent = {
      id: this.#newId('consent'), tenant_id: tenantId,
      subject_ref_type: boundedIdentifier(input.subject_ref_type), subject_ref_id: boundedIdentifier(input.subject_ref_id),
      business_ref_type: boundedIdentifier(input.business_ref_type), business_ref_id: boundedIdentifier(input.business_ref_id),
      consent_type: consentType(input.consent_type), status: consentStatus(input.status),
      evidence_ref: boundedText(input.evidence_ref, 2_048), granted_by: boundedIdentifier(input.granted_by),
      expires_at: nullableTimestamp(input.expires_at), created_at: now, updated_at: now
    };
    const created = await this.#unitOfWork.run(tenantId, ({ configuration }) => configuration.insertConsent(consent));
    await this.#event(tenantId, 'consent.created', created, input.actor);
    return created;
  }

  async enqueueOperation(input: EnqueueVoiceConfigurationOperationInput): Promise<VoiceConfigurationCommand> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const identity = {
      profile_id: boundedIdentifier(input.profile_id),
      resource_type: configurationResourceType(input.resource_type),
      resource_id: boundedIdentifier(input.resource_id),
      operation: configurationOperation(input.operation),
      payload: safeConfiguration(input.payload)
    };
    const hash = canonicalVoicePayloadHash(identity);
    const command = await this.#unitOfWork.run(tenantId, async ({ commands }) => {
      const existing = await commands.findConfigurationByIdempotencyKey(tenantId, boundedIdempotencyKey(input.idempotency_key));
      if (existing) {
        if (existing.payload_hash !== hash) throw idempotencyConflict();
        return existing;
      }
      return commands.insertConfiguration(this.#newCommand({
        tenant_id: tenantId, ...identity, idempotency_key: boundedIdempotencyKey(input.idempotency_key), payload_hash: hash
      }));
    });
    await this.#event(tenantId, 'command.created', { command_id: command.id, resource_type: command.resource_type,
      resource_id: command.resource_id, operation: command.operation }, input.actor);
    return command;
  }

  getProfile(tenantId: string, id: string): Promise<VoiceDeploymentProfile> {
    return this.#read(tenantId, ({ configuration }) => configuration.getProfile(tenantId, id));
  }
  listProfiles(input: VoiceListInput): Promise<VoicePage<VoiceDeploymentProfile>> {
    return this.#unitOfWork.run(boundedIdentifier(input.tenant_id), ({ configuration }) => configuration.listProfiles(input));
  }
  getTrunk(tenantId: string, id: string): Promise<VoiceSipTrunk> {
    return this.#read(tenantId, ({ configuration }) => configuration.getTrunk(tenantId, id));
  }
  listTrunks(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceSipTrunk>> {
    return this.#unitOfWork.run(boundedIdentifier(input.tenant_id), ({ configuration }) => configuration.listTrunks(input));
  }
  getDid(tenantId: string, id: string): Promise<VoiceDid> {
    return this.#read(tenantId, ({ configuration }) => configuration.getDid(tenantId, id));
  }
  listDids(input: VoiceListInput & { trunk_id?: string }): Promise<VoicePage<VoiceDid>> {
    return this.#unitOfWork.run(boundedIdentifier(input.tenant_id), ({ configuration }) => configuration.listDids(input));
  }
  getExtension(tenantId: string, id: string): Promise<VoiceExtension> {
    return this.#read(tenantId, ({ configuration }) => configuration.getExtension(tenantId, id));
  }
  listExtensions(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceExtension>> {
    return this.#unitOfWork.run(boundedIdentifier(input.tenant_id), ({ configuration }) => configuration.listExtensions(input));
  }
  getRoute(tenantId: string, id: string): Promise<VoiceRoute> {
    return this.#read(tenantId, ({ configuration }) => configuration.getRoute(tenantId, id));
  }
  listRoutes(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceRoute>> {
    return this.#unitOfWork.run(boundedIdentifier(input.tenant_id), ({ configuration }) => configuration.listRoutes(input));
  }
  getPolicy(tenantId: string): Promise<VoicePolicy> {
    return this.#read(tenantId, ({ configuration }) => configuration.getPolicy(tenantId));
  }
  listConsents(input: VoiceListInput & { subject_ref_type?: string; subject_ref_id?: string }): Promise<VoicePage<VoiceConsent>> {
    return this.#unitOfWork.run(boundedIdentifier(input.tenant_id), ({ configuration }) => configuration.listConsents(input));
  }

  async #read<T>(tenantIdInput: string, operation: (context: VoiceConfigurationUnitOfWorkContext) => Promise<T | null>): Promise<T> {
    const tenantId = boundedIdentifier(tenantIdInput);
    return required(await this.#unitOfWork.run(tenantId, operation));
  }

  #newCommand(input: Pick<VoiceConfigurationCommand,
    'tenant_id' | 'profile_id' | 'resource_type' | 'resource_id' | 'operation' |
    'idempotency_key' | 'payload_hash' | 'payload'>): VoiceConfigurationCommand {
    const now = this.#timestamp();
    return {
      id: this.#newId('configuration-command'), ...input, state: 'pending', attempt_count: 0,
      max_attempts: 5, next_attempt_at: null, lease_until: null, worker_id: '',
      provider_command_id: '', result: {}, error_code: '', error_message: '',
      created_at: now, updated_at: now, completed_at: null
    };
  }

  async #event(tenantId: string, suffix: string, resource: unknown, actor: string): Promise<void> {
    const record = isRecord(resource) ? resource : {};
    await this.#eventPort.publish(tenantId, `voice.configuration.${suffix}`, {
      resource_id: typeof record.id === 'string' ? record.id : undefined,
      revision: typeof record.revision === 'number' ? record.revision
        : typeof record.draft_revision === 'number' ? record.draft_revision : undefined,
      actor: boundedIdentifier(actor)
    });
  }

  #newId(kind: string): string {
    return boundedIdentifier(this.#id(kind));
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function safeConfiguration(value: unknown): Record<string, unknown> {
  const result = jsonRecord(value);
  assertVoiceConfigContainsNoSecrets(result);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) throw validationError();
  return result;
}

function routeRules(value: unknown): Record<string, unknown> {
  const result = safeConfiguration(value);
  if (!Object.keys(result).length) throw validationError();
  canonicalVoicePayloadHash(result);
  return result;
}

function secretRefs(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 50) throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
  return Object.fromEntries(Object.entries(value).map(([key, ref]) => [boundedIdentifier(key), secretRef(ref)]));
}

function secretRef(value: unknown): string {
  const ref = String(value ?? '');
  if (!/^env:\/\/[A-Z][A-Z0-9_]*$/.test(ref)) throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
  return ref;
}

function normalizedCodecs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) throw validationError();
  const codecs = value.map((codec) => boundedText(codec, 32));
  if (codecs.some((codec) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(codec))) throw validationError();
  return [...new Set(codecs)];
}

function normalizedE164(value: unknown): string {
  const normalized = String(value ?? '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  return normalized;
}

function genericIdentity(value: unknown): string {
  const identity = boundedText(value, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(identity)) throw validationError();
  return identity;
}

function extensionNumber(value: unknown): string {
  const extension = boundedText(value, 20);
  if (!/^\d{1,20}$/.test(extension)) throw validationError();
  return extension;
}

function routeDirection(value: unknown): VoiceRouteDirection {
  if (value !== 'inbound' && value !== 'outbound' && value !== 'both') throw validationError();
  return value;
}

function trunkTransport(value: unknown): VoiceSipTrunk['transport'] {
  if (value !== 'udp' && value !== 'tcp' && value !== 'tls') throw validationError();
  return value;
}

function voiceAdapter(value: unknown): VoiceAdapter {
  if (!['rustpbx', 'livekit_sip', 'active_call', 'livekit_agents', 'controlled'].includes(String(value))) {
    throw validationError();
  }
  return value as VoiceAdapter;
}

function profileStatus(value: unknown): VoiceDeploymentProfile['status'] {
  if (value !== 'disabled' && value !== 'enabled' && value !== 'degraded' && value !== 'archived') throw validationError();
  return value;
}

function trunkStatus(value: unknown): VoiceSipTrunk['status'] {
  if (!['draft', 'applying', 'active', 'degraded', 'disabled', 'archived'].includes(String(value))) throw validationError();
  return value as VoiceSipTrunk['status'];
}

function didStatus(value: unknown): VoiceDid['status'] {
  if (value !== 'active' && value !== 'disabled' && value !== 'porting' && value !== 'released') throw validationError();
  return value;
}

function extensionStatus(value: unknown): VoiceExtension['status'] {
  if (value !== 'active' && value !== 'disabled' && value !== 'archived') throw validationError();
  return value;
}

function routeStatus(value: unknown): VoiceRoute['status'] {
  if (value !== 'draft' && value !== 'active' && value !== 'disabled' && value !== 'archived') throw validationError();
  return value;
}

function consentType(value: unknown): VoiceConsent['consent_type'] {
  if (value !== 'outbound_call' && value !== 'recording' && value !== 'ai_disclosure') throw validationError();
  return value;
}

function consentStatus(value: unknown): VoiceConsent['status'] {
  if (value !== 'granted' && value !== 'revoked' && value !== 'expired') throw validationError();
  return value;
}

function configurationResourceType(value: unknown): VoiceConfigurationResourceType {
  if (!['deployment_profile', 'sip_trunk', 'did', 'extension', 'route'].includes(String(value))) throw validationError();
  return value as VoiceConfigurationResourceType;
}

function configurationOperation(value: unknown): VoiceConfigurationOperation {
  if (!['preflight', 'apply', 'test', 'disable', 'delete'].includes(String(value))) throw validationError();
  return value as VoiceConfigurationOperation;
}

function recordingMode(value: unknown): VoicePolicy['recording_mode'] {
  if (value !== 'disabled' && value !== 'consent_required' && value !== 'always') throw validationError();
  return value;
}

function policyStatus(value: unknown): VoicePolicy['status'] {
  if (value !== 'active' && value !== 'disabled' && value !== 'archived') throw validationError();
  return value;
}

function definedPatch<T extends object>(patch: T, allowedFields: readonly string[]): Partial<T> {
  if (!isRecord(patch)) throw validationError();
  const entries = Object.entries(patch);
  const allowed = new Set(allowedFields);
  if (entries.some(([field]) => !allowed.has(field))) throw validationError();
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as Partial<T>;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : boundedIdentifier(value);
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw validationError();
  return date.toISOString();
}

function boundedName(value: unknown): string {
  return boundedText(value, 256);
}

function boundedIdempotencyKey(value: unknown): string {
  return boundedText(value, 256);
}

function boundedIdentifier(value: unknown): string {
  const result = boundedText(value, 256);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function boundedText(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw validationError();
  return Number(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw validationError();
  canonicalVoicePayloadHash(value);
  return { ...value };
}

function jsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw validationError();
  canonicalVoicePayloadHash(value);
  return [...value];
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new VoiceError({ code: 'not_found', status: 404 });
  return value;
}

function assertRevision(current: number, expected: unknown): void {
  if (!Number.isInteger(expected) || Number(expected) < 1 || current !== expected) {
    throw new VoiceError({ code: 'revision_conflict', status: 409 });
  }
}

function idempotencyConflict(): VoiceError {
  return new VoiceError({ code: 'idempotency_conflict', status: 409 });
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
