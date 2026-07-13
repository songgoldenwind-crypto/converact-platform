import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrResourceService,
  type IvrAudioAsset,
  type IvrResource,
  type IvrResourceKind,
  type IvrResourceRepository,
  type IvrResourceUnitOfWork,
  type IvrSettings
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('IVR resource service creates safe audio assets and revision-locks updates', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Welcome', source_kind: 'audio_file',
    object_ref: 's3://ivr-audio/welcome.wav', content_type: 'audio/wav', checksum: 'a'.repeat(64)
  });
  assert.equal(created.revision, 1);
  assert.equal(created.status, 'active');

  const updated = await fixture.service.updateAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-b', id: created.id, expected_revision: 1,
    name: 'Welcome prompt', metadata: { locale: 'zh-CN' }
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.updated_by, 'admin-b');
  await assert.rejects(() => fixture.service.updateAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-a', id: created.id, expected_revision: 1,
    name: 'stale'
  }), hasCode('revision_conflict'));
});

test('IVR resource service blocks runtime mutations while a published flow references the resource', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Welcome', source_kind: 'tts',
    tts_text: 'Welcome', tts_profile_id: 'tts-main'
  });
  fixture.repository.references.set(`audio_asset:${created.id}`, [{ flow_id: 'flow-main', version: 3 }]);

  await assert.rejects(() => fixture.service.updateAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-a', id: created.id, expected_revision: 1,
    tts_text: 'Changed after publication'
  }), (error: unknown) => error instanceof IvrError
    && error.code === 'resource_in_use'
    && JSON.stringify(error.details).includes('flow-main'));

  const renamed = await fixture.service.updateAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-a', id: created.id, expected_revision: 1,
    name: 'Welcome display name', metadata: { owner: 'voice-team' }
  });
  assert.equal(renamed.revision, 2);
});

test('IVR resource service validates groups, singleton settings, and secret-free values', async () => {
  const fixture = createFixture();
  const group = await fixture.service.createRingGroup({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Support',
    member_identities: ['agent-a', 'agent-b'], strategy: 'sequential', ring_timeout_seconds: 25
  });
  assert.equal(group.max_rounds, 1);

  const defaults = await fixture.service.getSettings('tenant-a');
  assert.equal(defaults.revision, 0);
  assert.equal(defaults.max_steps, 500);
  const settings = await fixture.service.updateSettings({
    tenant_id: 'tenant-a', actor: 'admin-a', expected_revision: 0,
    default_language: 'en-US', allowed_webhook_refs: ['crm-safe']
  });
  assert.equal(settings.revision, 1);
  assert.equal(settings.default_language, 'en-US');

  await assert.rejects(() => fixture.service.createAudioAsset({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Unsafe', source_kind: 'audio_file',
    object_ref: 'https://user:password@example.test/prompt.wav?access_token=secret'
  }), hasCode('validation_failed'));
  await assert.rejects(() => fixture.service.updateSettings({
    tenant_id: 'tenant-a', actor: 'admin-a', expected_revision: 1,
    execution_policy: { authorization: 'Bearer secret' }
  }), hasCode('validation_failed'));
});

function createFixture() {
  const repository = new MemoryResourceRepository();
  const unitOfWork: IvrResourceUnitOfWork = {
    run: async (_tenantId, operation) => operation({ resources: repository })
  };
  let sequence = 0;
  const service = new IvrResourceService({
    unit_of_work: unitOfWork,
    id: (kind) => `${kind}-${++sequence}`,
    now: () => new Date('2026-07-13T00:00:00.000Z')
  });
  return { repository, service };
}

class MemoryResourceRepository implements IvrResourceRepository {
  readonly resources = new Map<string, IvrResource>();
  readonly references = new Map<string, Array<{ flow_id: string; version: number }>>();
  settings: IvrSettings | null = null;

  async list<K extends IvrResourceKind>(tenantId: string, kind: K): Promise<Array<Extract<IvrResource, { kind: K }>>> {
    return clone([...this.resources.values()].filter((item) => item.tenant_id === tenantId && item.kind === kind)) as never;
  }

  async get<K extends IvrResourceKind>(tenantId: string, kind: K, id: string): Promise<Extract<IvrResource, { kind: K }> | null> {
    const item = this.resources.get(`${kind}:${id}`);
    return clone(item?.tenant_id === tenantId ? item : null) as never;
  }

  async insert<K extends IvrResourceKind>(resource: Extract<IvrResource, { kind: K }>): Promise<Extract<IvrResource, { kind: K }>> {
    this.resources.set(`${resource.kind}:${resource.id}`, clone(resource));
    return clone(resource);
  }

  async update<K extends IvrResourceKind>(resource: Extract<IvrResource, { kind: K }>, expectedRevision: number): Promise<Extract<IvrResource, { kind: K }>> {
    const key = `${resource.kind}:${resource.id}`;
    const current = this.resources.get(key);
    if (!current || current.revision !== expectedRevision) throw new IvrError({ code: 'revision_conflict' });
    this.resources.set(key, clone(resource));
    return clone(resource);
  }

  async currentPublishedReferences(tenantId: string, kind: IvrResourceKind, id: string) {
    return clone(this.references.get(`${kind}:${id}`) ?? []).filter(() => Boolean(tenantId));
  }

  async getSettings(tenantId: string): Promise<IvrSettings | null> {
    return clone(this.settings?.tenant_id === tenantId ? this.settings : null);
  }

  async insertSettings(settings: IvrSettings): Promise<IvrSettings> {
    this.settings = clone(settings);
    return clone(settings);
  }

  async updateSettings(settings: IvrSettings, expectedRevision: number): Promise<IvrSettings> {
    if (!this.settings || this.settings.revision !== expectedRevision) throw new IvrError({ code: 'revision_conflict' });
    this.settings = clone(settings);
    return clone(settings);
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof IvrError && error.code === code;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
