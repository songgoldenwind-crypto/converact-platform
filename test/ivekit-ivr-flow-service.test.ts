import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrFlowService,
  type IvrFlow,
  type IvrFlowGraph,
  type IvrFlowRepository,
  type IvrFlowUnitOfWork,
  type IvrFlowVersion
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('IVR flow service creates and revision-locks editable drafts', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createFlow({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Main IVR', graph: validGraph('Welcome')
  });
  assert.equal(created.draft_revision, 1);
  assert.equal(created.status, 'draft');

  const updated = await fixture.service.updateDraft({
    tenant_id: 'tenant-a', actor: 'admin-b', flow_id: created.id,
    expected_revision: 1, name: 'Main IVR v2', graph: validGraph('Updated')
  });
  assert.equal(updated.draft_revision, 2);
  assert.equal(updated.name, 'Main IVR v2');
  await assert.rejects(() => fixture.service.updateDraft({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: created.id,
    expected_revision: 1, graph: validGraph('Stale')
  }), hasIvrCode('revision_conflict'));
});

test('IVR flow publication stores an immutable canonical release and safely replays', async () => {
  const fixture = createFixture();
  const flow = await fixture.service.createFlow({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Main', graph: validGraph('Welcome')
  });
  const first = await fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_draft_revision: 1, idempotency_key: 'publish-main-1'
  });
  assert.equal(first.version.version, 1);
  assert.equal(first.version.release_kind, 'publish');
  assert.equal(first.version.source_version, null);
  assert.match(first.version.graph_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.version.dependencies.audio_assets, ['audio-welcome']);
  assert.equal(first.flow.current_published_version, 1);
  assert.equal(first.flow.status, 'published');

  const replay = await fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_draft_revision: 1, idempotency_key: 'publish-main-1'
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.version.id, first.version.id);
  assert.equal(fixture.repository.versions.length, 1);

  await assert.rejects(() => fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_draft_revision: 2, idempotency_key: 'publish-main-1'
  }), hasIvrCode('idempotency_conflict'));
});

test('IVR rollback creates a new immutable version even when the graph hash repeats', async () => {
  const fixture = createFixture();
  const flow = await fixture.service.createFlow({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Main', graph: validGraph('V1')
  });
  const v1 = await fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_draft_revision: 1, idempotency_key: 'publish-v1'
  });
  await fixture.service.updateDraft({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_revision: 1, graph: validGraph('V2')
  });
  const v2 = await fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_draft_revision: 2, idempotency_key: 'publish-v2'
  });
  const rollback = await fixture.service.rollback({
    tenant_id: 'tenant-a', actor: 'admin-b', flow_id: flow.id,
    source_version: 1, expected_draft_revision: 2, idempotency_key: 'rollback-v1'
  });

  assert.equal(rollback.version.version, 3);
  assert.equal(rollback.version.release_kind, 'rollback');
  assert.equal(rollback.version.source_version, 1);
  assert.equal(rollback.version.graph_hash, v1.version.graph_hash);
  assert.notEqual(rollback.version.graph_hash, v2.version.graph_hash);
  assert.equal(rollback.flow.current_published_version, 3);
  assert.equal(fixture.repository.versions.length, 3);
});

test('IVR publication blocks compiler and dependency resolution errors', async () => {
  const fixture = createFixture({
    dependencyErrors: [{ code: 'dependency_unavailable', message: 'audio dependency is unavailable', node_id: 'play' }]
  });
  const flow = await fixture.service.createFlow({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Main', graph: validGraph('Welcome')
  });
  await assert.rejects(() => fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: flow.id,
    expected_draft_revision: 1, idempotency_key: 'publish-main'
  }), (error: unknown) => error instanceof IvrError
    && error.code === 'publish_validation_failed'
    && JSON.stringify(error.details).includes('dependency_unavailable'));

  const invalid = await fixture.service.createFlow({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Invalid',
    graph: { ...validGraph('Invalid'), edges: [] }
  });
  await assert.rejects(() => fixture.service.publish({
    tenant_id: 'tenant-a', actor: 'admin-a', flow_id: invalid.id,
    expected_draft_revision: 1, idempotency_key: 'publish-invalid'
  }), hasIvrCode('publish_validation_failed'));
});

function createFixture(options: { dependencyErrors?: Array<{ code: string; message: string; node_id?: string }> } = {}) {
  const repository = new MemoryFlowRepository();
  let id = 0;
  const service = new IvrFlowService({
    unit_of_work: { run: async (_tenantId, operation) => operation({ flows: repository }) },
    dependency_resolver: {
      async validate() { return options.dependencyErrors ?? []; }
    },
    id: (kind) => `${kind}-${++id}`,
    now: () => new Date('2026-07-13T00:00:00.000Z')
  });
  return { repository, service };
}

class MemoryFlowRepository implements IvrFlowRepository {
  readonly flows: IvrFlow[] = [];
  readonly versions: IvrFlowVersion[] = [];

  async getFlow(tenantId: string, flowId: string): Promise<IvrFlow | null> {
    return clone(this.flows.find((flow) => flow.tenant_id === tenantId && flow.id === flowId) ?? null);
  }

  async listFlows(tenantId: string): Promise<IvrFlow[]> {
    return clone(this.flows.filter((flow) => flow.tenant_id === tenantId));
  }

  async insertFlow(flow: IvrFlow): Promise<IvrFlow> {
    this.flows.push(clone(flow));
    return clone(flow);
  }

  async updateDraft(flow: IvrFlow, expectedRevision: number): Promise<IvrFlow> {
    const index = this.flows.findIndex((item) => item.tenant_id === flow.tenant_id && item.id === flow.id
      && item.draft_revision === expectedRevision);
    if (index < 0) throw new IvrError({ code: 'revision_conflict', status: 409 });
    this.flows[index] = clone(flow);
    return clone(flow);
  }

  async updatePublication(flow: IvrFlow, expectedRevision: number): Promise<IvrFlow> {
    const index = this.flows.findIndex((item) => item.tenant_id === flow.tenant_id && item.id === flow.id
      && item.draft_revision === expectedRevision);
    if (index < 0) throw new IvrError({ code: 'revision_conflict', status: 409 });
    this.flows[index] = clone(flow);
    return clone(flow);
  }

  async listVersions(tenantId: string, flowId: string): Promise<IvrFlowVersion[]> {
    return clone(this.versions.filter((version) => version.tenant_id === tenantId && version.flow_id === flowId));
  }

  async getVersion(tenantId: string, flowId: string, version: number): Promise<IvrFlowVersion | null> {
    return clone(this.versions.find((item) => item.tenant_id === tenantId
      && item.flow_id === flowId && item.version === version) ?? null);
  }

  async getPublished(tenantId: string, flowId: string, version?: number): Promise<IvrFlowVersion | null> {
    if (version !== undefined) return this.getVersion(tenantId, flowId, version);
    const flow = await this.getFlow(tenantId, flowId);
    return flow?.current_published_version
      ? this.getVersion(tenantId, flowId, flow.current_published_version)
      : null;
  }

  async findVersionByPublicationKey(tenantId: string, key: string): Promise<IvrFlowVersion | null> {
    return clone(this.versions.find((item) => item.tenant_id === tenantId && item.publication_key === key) ?? null);
  }

  async insertVersion(version: IvrFlowVersion): Promise<IvrFlowVersion> {
    this.versions.push(clone(version));
    return clone(version);
  }
}

function validGraph(prompt: string): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'play', type: 'play', name: 'Play', position: { x: 1, y: 0 },
        data: { audio_asset_id: 'audio-welcome', text: prompt } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 2, y: 0 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
      { id: 'e2', source: 'play', target: 'end', sourceHandle: 'out' }
    ],
    variables: []
  };
}

function hasIvrCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof IvrError && error.code === code;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
