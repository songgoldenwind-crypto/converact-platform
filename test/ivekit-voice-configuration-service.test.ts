import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VoiceConfigurationService,
  VoiceError,
  type VoiceAddressProtector,
  type VoiceConfigurationRepository,
  type VoiceConfigurationUnitOfWork,
  type VoiceConfigurationUnitOfWorkContext,
  type VoiceEventPort,
  type VoiceCommandRepository,
  type VoiceConfigurationCommand,
  type VoiceDeploymentProfile,
  type VoiceDid,
  type VoiceExtension,
  type VoicePolicy,
  type VoiceRoute,
  type VoiceRouteVersion,
  type VoiceSipTrunk,
  type VoiceConsent
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Voice configuration service creates validated desired state and immutable admin events', async () => {
  const fixture = configurationFixture();
  const service = fixture.service;
  const profile = await service.createProfile({
    tenant_id: 'tenant-a', name: 'Primary PBX', adapter: 'rustpbx',
    base_url: 'https://pbx.internal', desired_version: '1.0.0',
    config: { paths: { health: '/health' } },
    secret_refs: { rwi: 'env://RUSTPBX_RWI_TOKEN' }, actor: 'admin-a'
  });
  const trunk = await service.createTrunk({
    tenant_id: 'tenant-a', profile_id: profile.id, name: 'Carrier A',
    direction: 'both', transport: 'tls', codecs: ['PCMU', 'opus'], max_channels: 30,
    credential_secret_ref: 'env://RUSTPBX_TRUNK_CREDENTIAL',
    desired_state: { registrar: 'sip.carrier.test' }, actor: 'admin-a'
  });
  const did = await service.createDid({
    tenant_id: 'tenant-a', trunk_id: trunk.id, route_id: null,
    e164: '+86 138-0013-8000', metadata: { region: 'cn' }, actor: 'admin-a'
  });
  const extension = await service.createExtension({
    tenant_id: 'tenant-a', profile_id: profile.id, identity: 'agent-1001',
    extension: '1001', display_name: 'Agent 1001',
    credential_secret_ref: 'env://RUSTPBX_EXTENSION_1001',
    permissions: { outbound: true }, webrtc_enabled: true, actor: 'admin-a'
  });
  const route = await service.createRoute({
    tenant_id: 'tenant-a', profile_id: profile.id, name: 'Inbound support',
    direction: 'inbound', draft_rules: { action: 'forward_sip', target: 'sip:1001@pbx.internal' },
    actor: 'admin-a'
  });
  const policy = await service.upsertPolicy({
    tenant_id: 'tenant-a', require_outbound_consent: true,
    recording_mode: 'consent_required', recording_retention_days: 30,
    require_ai_disclosure: true, allowed_calling_windows: [], masking_policy: {},
    status: 'active', expected_revision: null, actor: 'admin-a'
  });
  const consent = await service.createConsent({
    tenant_id: 'tenant-a', subject_ref_type: 'customer', subject_ref_id: 'customer-a',
    business_ref_type: 'order', business_ref_id: 'order-a', consent_type: 'outbound_call',
    status: 'granted', evidence_ref: 'evidence://consent-a', granted_by: 'customer-a',
    expires_at: null, actor: 'admin-a'
  });

  assert.deepEqual(did.e164, { kind: 'e164', redacted: '+86*******8000' });
  assert.equal(fixture.protectedValues[0]?.value, '+8613800138000');
  assert.equal(extension.revision, 1);
  assert.equal(route.draft_revision, 1);
  assert.equal(policy.revision, 1);
  assert.equal(consent.status, 'granted');
  assert.equal(fixture.events.length, 7);
  assert.equal(fixture.events.every((event) => event.type.startsWith('voice.configuration.')), true);
  assert.equal(fixture.providerCalls, 0);

  assert.deepEqual(await service.listProfiles({ tenant_id: 'tenant-a', limit: 20 }), {
    items: [profile], next_cursor: null
  });
  assert.equal((await service.getRoute('tenant-a', route.id)).id, route.id);
});

test('Voice configuration updates require revisions and reject credentials in desired state', async () => {
  const fixture = configurationFixture();
  const profile = await fixture.service.createProfile({
    tenant_id: 'tenant-a', name: 'PBX', adapter: 'rustpbx', base_url: 'https://pbx.internal',
    desired_version: '1', config: {}, secret_refs: {}, actor: 'admin-a'
  });
  const updated = await fixture.service.updateProfile({
    tenant_id: 'tenant-a', profile_id: profile.id, expected_revision: 1,
    patch: { name: 'PBX Updated', status: 'enabled' }, actor: 'admin-b'
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.updated_by, 'admin-b');
  await assert.rejects(() => fixture.service.updateProfile({
    tenant_id: 'tenant-a', profile_id: profile.id, expected_revision: 1,
    patch: { name: 'stale' }, actor: 'admin-b'
  }), hasVoiceCode('revision_conflict'));
  await assert.rejects(() => fixture.service.createTrunk({
    tenant_id: 'tenant-a', profile_id: profile.id, name: 'Unsafe', direction: 'both',
    transport: 'tls', codecs: ['PCMU'], max_channels: 10,
    credential_secret_ref: 'plain-password', desired_state: { password: 'private' }, actor: 'admin-a'
  }), (error: unknown) => error instanceof VoiceError
    && ['secret_ref_invalid', 'validation_failed'].includes(error.code));

  const trunk = await fixture.service.createTrunk({
    tenant_id: 'tenant-a', profile_id: profile.id, name: 'Safe', direction: 'both',
    transport: 'tls', codecs: ['PCMU'], max_channels: 10,
    credential_secret_ref: 'env://RUSTPBX_TRUNK_CREDENTIAL', desired_state: {}, actor: 'admin-a'
  });
  await assert.rejects(() => fixture.service.updateTrunk({
    tenant_id: 'tenant-a', trunk_id: trunk.id, expected_revision: 1,
    patch: { id: 'another-trunk', tenant_id: 'tenant-b', max_channels: 20 } as never,
    actor: 'admin-b'
  }), hasVoiceCode('validation_failed'));
  assert.equal((await fixture.service.getTrunk('tenant-a', trunk.id)).max_channels, 10);
});

test('Voice route publish atomically versions desired state and enqueues an idempotent operation', async () => {
  const fixture = configurationFixture();
  const profile = await fixture.service.createProfile({
    tenant_id: 'tenant-a', name: 'PBX', adapter: 'rustpbx', base_url: 'https://pbx.internal',
    desired_version: '1', config: {}, secret_refs: {}, actor: 'admin-a'
  });
  const route = await fixture.service.createRoute({
    tenant_id: 'tenant-a', profile_id: profile.id, name: 'Route', direction: 'inbound',
    draft_rules: { action: 'forward_sip', target: 'sip:1001@pbx.internal' }, actor: 'admin-a'
  });
  const first = await fixture.service.publishRoute({
    tenant_id: 'tenant-a', route_id: route.id, expected_revision: 1,
    idempotency_key: 'publish-route-a', actor: 'admin-a'
  });
  assert.equal(first.version.version, 1);
  assert.equal(first.command.operation, 'apply');
  assert.equal(first.command.state, 'pending');
  assert.equal(fixture.transactionCommits, 3);
  assert.equal(fixture.providerCalls, 0);

  const replay = await fixture.service.publishRoute({
    tenant_id: 'tenant-a', route_id: route.id, expected_revision: 1,
    idempotency_key: 'publish-route-a', actor: 'admin-a'
  });
  assert.equal(replay.command.id, first.command.id);
  assert.equal(replay.version.id, first.version.id);

  fixture.routes.get(route.id)!.draft_rules = { action: 'reject', code: 486 };
  await assert.rejects(() => fixture.service.publishRoute({
    tenant_id: 'tenant-a', route_id: route.id, expected_revision: 2,
    idempotency_key: 'publish-route-a', actor: 'admin-a'
  }), hasVoiceCode('idempotency_conflict'));
});

function configurationFixture(): ReturnType<typeof buildFixture> {
  return buildFixture();
}

function buildFixture() {
  const profiles = new Map<string, VoiceDeploymentProfile>();
  const trunks = new Map<string, VoiceSipTrunk>();
  const dids = new Map<string, VoiceDid>();
  const extensions = new Map<string, VoiceExtension>();
  const routes = new Map<string, VoiceRoute>();
  const routeVersions: VoiceRouteVersion[] = [];
  const policies = new Map<string, VoicePolicy>();
  const consents: VoiceConsent[] = [];
  const commands = new Map<string, VoiceConfigurationCommand>();
  const events: Array<{ tenant_id: string; type: string; data: unknown }> = [];
  const protectedValues: Array<{ tenant_id: string; value: string; kind: string }> = [];
  let idSequence = 0;
  let transactionCommits = 0;
  const now = () => new Date('2026-07-13T00:00:00.000Z');

  const configuration = {
    getProfile: async (_tenant: string, id: string) => profiles.get(id) ?? null,
    listProfiles: async () => page([...profiles.values()]),
    insertProfile: async (value: VoiceDeploymentProfile) => (profiles.set(value.id, value), value),
    updateProfile: async (value: VoiceDeploymentProfile, expected: number) => updateMap(profiles, value.id, value, expected, 'revision'),
    insertCapabilitySnapshot: async (value) => value,
    getLatestCapabilitySnapshot: async () => null,
    getTrunk: async (_tenant: string, id: string) => trunks.get(id) ?? null,
    listTrunks: async () => page([...trunks.values()]),
    insertTrunk: async (value: VoiceSipTrunk) => (trunks.set(value.id, value), value),
    updateTrunk: async (value: VoiceSipTrunk, expected: number) => updateMap(trunks, value.id, value, expected, 'revision'),
    getDid: async (_tenant: string, id: string) => dids.get(id) ?? null,
    getDidProtectedAddress: async () => null,
    listDids: async () => page([...dids.values()]),
    insertDid: async (value: VoiceDid, address: { hmac: string }) => {
      if ([...dids.values()].some((did) => (did.metadata as { address_hmac?: string }).address_hmac === address.hmac)) {
        throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      }
      value.metadata = { ...value.metadata, address_hmac: address.hmac };
      dids.set(value.id, value);
      return value;
    },
    updateDid: async (value: VoiceDid, expected: number) => updateMap(dids, value.id, value, expected, 'revision'),
    getExtension: async (_tenant: string, id: string) => extensions.get(id) ?? null,
    listExtensions: async () => page([...extensions.values()]),
    insertExtension: async (value: VoiceExtension) => (extensions.set(value.id, value), value),
    updateExtension: async (value: VoiceExtension, expected: number) => updateMap(extensions, value.id, value, expected, 'revision'),
    getRoute: async (_tenant: string, id: string) => routes.get(id) ?? null,
    listRoutes: async () => page([...routes.values()]),
    insertRoute: async (value: VoiceRoute) => (routes.set(value.id, value), value),
    updateRoute: async (value: VoiceRoute, expected: number) => updateMap(routes, value.id, value, expected, 'draft_revision'),
    insertRouteVersion: async (value: VoiceRouteVersion) => {
      const replay = routeVersions.find((item) => item.route_id === value.route_id && item.payload_hash === value.payload_hash);
      if (replay) return replay;
      routeVersions.push(value);
      return value;
    },
    listRouteVersions: async (_tenant: string, routeId: string) => routeVersions.filter((value) => value.route_id === routeId),
    updateRouteVersionDeployment: async (value: VoiceRouteVersion) => {
      const index = routeVersions.findIndex((item) => item.id === value.id);
      if (index >= 0) routeVersions[index] = value;
      return value;
    },
    getPolicy: async (tenantId: string) => policies.get(tenantId) ?? null,
    upsertPolicy: async (value: VoicePolicy, expected: number | null) => {
      const current = policies.get(value.tenant_id);
      if (expected !== null && current?.revision !== expected) throw revisionConflict();
      policies.set(value.tenant_id, value);
      return value;
    },
    insertConsent: async (value: VoiceConsent) => (consents.push(value), value),
    listConsents: async () => page(consents)
  } as VoiceConfigurationRepository;

  const commandRepository = {
    findConfigurationByIdempotencyKey: async (_tenant: string, key: string) => commands.get(key) ?? null,
    insertConfiguration: async (value: VoiceConfigurationCommand) => {
      const replay = commands.get(value.idempotency_key);
      if (replay && replay.payload_hash !== value.payload_hash) throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      if (replay) return replay;
      commands.set(value.idempotency_key, value);
      return value;
    }
  } as VoiceCommandRepository;
  const context: VoiceConfigurationUnitOfWorkContext = { configuration, commands: commandRepository };
  const unitOfWork: VoiceConfigurationUnitOfWork = {
    async run<T>(_tenantId: string, operation: (context: VoiceConfigurationUnitOfWorkContext) => Promise<T>): Promise<T> {
      const result = await operation(context);
      transactionCommits += 1;
      return result;
    }
  };
  const addressProtector: VoiceAddressProtector = {
    async protect(tenantId, value, kind) {
      protectedValues.push({ tenant_id: tenantId, value, kind });
      return { ciphertext: `cipher:${value}`, hmac: `hmac:${tenantId}:${value}`, redacted: '+86*******8000' };
    },
    async reveal() { throw new Error('not used'); }
  };
  const eventPort: VoiceEventPort = {
    publish(tenantId, type, data) { events.push({ tenant_id: tenantId, type, data }); }
  };
  const service = new VoiceConfigurationService({
    unit_of_work: unitOfWork,
    address_protector: addressProtector,
    event_port: eventPort,
    id: (kind) => `${kind}-${++idSequence}`,
    now
  });
  return {
    service, profiles, trunks, dids, extensions, routes, routeVersions, policies, consents,
    commands, events, protectedValues, providerCalls: 0,
    get transactionCommits() { return transactionCommits; }
  };
}

function page<T>(items: T[]): { items: T[]; next_cursor: null } {
  return { items, next_cursor: null };
}

function updateMap<T, K extends keyof T>(
  map: Map<string, T>, id: string, value: T, expected: number, revisionField: K
): T {
  const current = map.get(id);
  if (!current) throw new VoiceError({ code: 'not_found', status: 404 });
  if (current[revisionField] !== expected) throw revisionConflict();
  map.set(id, value);
  return value;
}

function revisionConflict(): VoiceError {
  return new VoiceError({ code: 'revision_conflict', status: 409 });
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
