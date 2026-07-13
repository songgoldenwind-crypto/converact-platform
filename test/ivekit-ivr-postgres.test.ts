import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

import { withPgTenant } from '../src/db-pg-tenant.js';
import {
  IvrFlowService,
  IvrResourceService,
  IvrSessionService,
  RustPbxStepIvrService,
  PostgresIvrFlowStore,
  PostgresIvrFlowUnitOfWork,
  PostgresIvrPendingActionStore,
  PostgresIvrResourceUnitOfWork,
  PostgresRustPbxStepIvrBindingResolver,
  PostgresIvrSessionStepStore,
  PostgresIvrSessionUnitOfWork,
  type IvrFlowGraph
} from '../src/agent-runtime/ivekit/ivr/index.js';

const url = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL;

test('PostgreSQL IVR flow store publishes, replays, rolls back, isolates, and preserves history', {
  skip: url ? false : 'requires OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantA = 'ivekit_ivr_runtime_a';
  const tenantB = 'ivekit_ivr_runtime_b';
  const profileId = 'ivekit_ivr_profile_a';
  const callId = 'ivekit_ivr_call_a';
  try {
    const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL!;
    const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING`,
        [tenantA, 'IVR runtime A', tenantB, 'IVR runtime B']);
      await admin.query(
        `INSERT INTO ivekit_voice_deployment_profiles
          (id, tenant_id, name, adapter, status, created_by, updated_by)
         VALUES ($1, $2, 'IVR controlled', 'controlled', 'enabled', 'test', 'test')`,
        [profileId, tenantA]
      );
      await admin.query(
        `INSERT INTO ivekit_voice_capability_snapshots
          (id, tenant_id, profile_id, provider, provider_version, status,
           capabilities, config_hash, checked_at, created_at)
         VALUES ('ivekit_ivr_capabilities_a', $1, $2, 'controlled', 'test', 'ready',
                 '{"step_ivr":true}'::jsonb, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [tenantA, profileId, 'c'.repeat(64)]
      );
      await admin.query(
        `INSERT INTO ivekit_voice_calls
          (id, tenant_id, business_ref_type, business_ref_id, provider_profile_id,
           direction, from_address_kind, from_address_ciphertext, from_address_hmac,
           from_address_redacted, to_address_kind, to_address_ciphertext, to_address_hmac,
           to_address_redacted, idempotency_key)
         VALUES ($1, $2, 'test', 'ivr', $3, 'inbound', 'extension', 'cipher-a', $4,
                 '***1', 'extension', 'cipher-b', $5, '***2', 'ivr-call-a')`,
        [callId, tenantA, profileId, 'a'.repeat(64), 'b'.repeat(64)]
      );
    } finally {
      await admin.end();
    }

    let id = 0;
    const resourceService = new IvrResourceService({
      unit_of_work: new PostgresIvrResourceUnitOfWork(pool),
      id: (kind) => `${kind}-pg-${++id}`,
      now: () => new Date('2026-07-13T00:00:00.000Z')
    });
    const audio = await resourceService.createAudioAsset({
      tenant_id: tenantA, actor: 'admin-a', name: 'Welcome', source_kind: 'tts',
      tts_text: 'Welcome', tts_profile_id: 'tts-controlled'
    });
    const service = new IvrFlowService({
      unit_of_work: new PostgresIvrFlowUnitOfWork(pool),
      id: (kind) => `${kind}-pg-${++id}`,
      now: () => new Date(`2026-07-13T00:00:0${Math.min(id, 9)}.000Z`)
    });
    const flow = await service.createFlow({
      tenant_id: tenantA, actor: 'admin-a', name: 'Main', graph: graph('V1', audio.id)
    });
    const first = await service.publish({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_draft_revision: 1, idempotency_key: 'postgres-publish-v1' });
    const replay = await service.publish({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_draft_revision: 1, idempotency_key: 'postgres-publish-v1' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.version.id, first.version.id);
    await assert.rejects(() => resourceService.updateAudioAsset({
      tenant_id: tenantA, actor: 'admin-a', id: audio.id, expected_revision: 1,
      tts_text: 'must not mutate while published'
    }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'resource_in_use');
    const renamedAudio = await resourceService.updateAudioAsset({
      tenant_id: tenantA, actor: 'admin-a', id: audio.id, expected_revision: 1,
      name: 'Welcome display name'
    });
    assert.equal(renamedAudio.revision, 2);

    await service.updateDraft({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_revision: 1, graph: graph('V2', audio.id) });
    await service.publish({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_draft_revision: 2, idempotency_key: 'postgres-publish-v2' });
    const rolledBack = await service.rollback({ tenant_id: tenantA, actor: 'admin-b', flow_id: flow.id,
      expected_draft_revision: 2, source_version: 1, idempotency_key: 'postgres-rollback-v1' });
    assert.equal(rolledBack.version.version, 3);
    assert.equal(rolledBack.version.graph_hash, first.version.graph_hash);

    const store = new PostgresIvrFlowStore(pool);
    assert.equal((await store.listVersions(tenantA, flow.id)).length, 3);
    assert.equal(await store.getFlow(tenantB, flow.id), null);

    await withPgTenant(pool, tenantA, (client) => client.query(
      `UPDATE ivekit_voice_calls
       SET provider_call_id = $3,
           metadata = jsonb_build_object('_ivekit_ivr', jsonb_build_object(
             'flow_id', $4::text, 'flow_version', 3, 'variables', jsonb_build_object('locale', 'zh-CN')
           ))
       WHERE tenant_id = $1 AND id = $2`,
      [tenantA, callId, 'rustpbx-session-a', flow.id]
    ));
    const binding = await new PostgresRustPbxStepIvrBindingResolver(pool).resolve({
      tenant_id: tenantA, profile_id: profileId, provider_session_id: 'rustpbx-session-a',
      safe_metadata: {}
    });
    assert.deepEqual(binding, {
      call_id: callId, flow_id: flow.id, flow_version: 3,
      variables: { locale: 'zh-CN' }, trace_id: undefined
    });

    const sessionService = new IvrSessionService({
      unit_of_work: new PostgresIvrSessionUnitOfWork(pool),
      id: (kind) => `${kind}-pg-${++id}`,
      now: () => new Date('2026-07-13T00:01:00.000Z')
    });
    const stepService = new RustPbxStepIvrService({
      sessions: sessionService,
      bindings: new PostgresRustPbxStepIvrBindingResolver(pool)
    });
    const stepRequest = (sequence: number, type: string) => ({
      profile_id: profileId, provider_session_id: 'rustpbx-session-a',
      event_sequence: sequence, action_revision: sequence, event: { type }
    });
    const started = await stepService.handle({
      tenant_id: tenantA, profile_id: profileId, request: stepRequest(1, 'session_start')
    });
    assert.equal(started.action_node.type, 'prompt');
    const stepReplay = await stepService.handle({
      tenant_id: tenantA, profile_id: profileId, request: stepRequest(1, 'session_start')
    });
    assert.equal(stepReplay.replayed, true);
    assert.deepEqual(stepReplay.action_node, started.action_node);
    const hangup = await stepService.handle({
      tenant_id: tenantA, profile_id: profileId, request: stepRequest(2, 'audio_complete')
    });
    assert.equal(hangup.action_node.type, 'hangup');
    const completed = await stepService.handle({
      tenant_id: tenantA, profile_id: profileId, request: stepRequest(3, 'hangup')
    });
    assert.equal(completed.session_state, 'completed');
    const sessionId = started.session_id;
    assert.deepEqual(
      (await new PostgresIvrSessionStepStore(pool).list(tenantA, sessionId)).map((step) => step.node_id),
      ['start', 'play', 'end']
    );
    const actionCounts = await withPgTenant(pool, tenantA, (client) => client.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count FROM ivekit_ivr_pending_actions
       WHERE tenant_id = $1 AND session_id = $2 GROUP BY state`,
      [tenantA, sessionId]
    ));
    assert.deepEqual(actionCounts.rows, [{ state: 'succeeded', count: '2' }]);

    const actionStore = new PostgresIvrPendingActionStore(pool);
    await actionStore.insert({
      id: 'ivr-worker-action-a', tenant_id: tenantA, session_id: sessionId,
      step_index: 99, node_id: 'worker-webhook', action_kind: 'webhook', state: 'pending',
      dispatch_mode: 'worker', idempotency_key: 'ivr-worker-action-a', payload_hash: 'c'.repeat(64),
      payload: { webhook_ref: 'controlled' }, result: {}, attempt_count: 0, max_attempts: 3,
      next_attempt_at: null, lease_until: null, worker_id: '', provider_profile_id: '',
      provider_action_id: '', error_code: '', error_message: '', trace_id: 'trace-worker-a',
      reconciliation_count: 0, created_at: '2026-07-13T00:02:00.000Z',
      updated_at: '2026-07-13T00:02:00.000Z', completed_at: null
    });
    const claimedA = await actionStore.claimDue({ tenant_id: tenantA, worker_id: 'worker-a',
      now: '2026-07-13T00:03:00.000Z', limit: 10, lease_ms: 30_000 });
    assert.deepEqual(claimedA.map((action) => action.id), ['ivr-worker-action-a']);
    assert.deepEqual(await actionStore.claimDue({ tenant_id: tenantA, worker_id: 'worker-b',
      now: '2026-07-13T00:03:01.000Z', limit: 10, lease_ms: 30_000 }), []);
    await actionStore.release({ tenant_id: tenantA, action_id: 'ivr-worker-action-a', worker_id: 'worker-a',
      state: 'retry_wait', next_attempt_at: '2026-07-13T00:04:00.000Z', error_code: 'provider_unavailable',
      error_message: 'provider_unavailable', now: '2026-07-13T00:03:02.000Z' });
    assert.deepEqual(await actionStore.claimDue({ tenant_id: tenantA, worker_id: 'worker-b',
      now: '2026-07-13T00:03:59.000Z', limit: 10, lease_ms: 30_000 }), []);
    const claimedB = await actionStore.claimDue({ tenant_id: tenantA, worker_id: 'worker-b',
      now: '2026-07-13T00:04:00.000Z', limit: 10, lease_ms: 30_000 });
    assert.equal(claimedB[0]?.attempt_count, 2);
    await assert.rejects(() => actionStore.settle({ tenant_id: tenantA, action_id: 'ivr-worker-action-a',
      worker_id: 'worker-a', state: 'succeeded', result: {}, error_code: '',
      completed_at: '2026-07-13T00:04:01.000Z' }));
    await actionStore.settle({ tenant_id: tenantA, action_id: 'ivr-worker-action-a',
      worker_id: 'worker-b', state: 'succeeded', result: { ok: true }, error_code: '',
      completed_at: '2026-07-13T00:04:01.000Z' });

    await actionStore.insert({
      id: 'ivr-uncertain-action-a', tenant_id: tenantA, session_id: sessionId,
      step_index: 100, node_id: 'worker-transfer', action_kind: 'transfer', state: 'uncertain',
      dispatch_mode: 'worker', idempotency_key: 'ivr-uncertain-action-a', payload_hash: 'd'.repeat(64),
      payload: { target_ref: 'agent-a' }, result: {}, attempt_count: 1, max_attempts: 3,
      next_attempt_at: '2026-07-13T00:05:00.000Z', lease_until: null, worker_id: '',
      provider_profile_id: profileId, provider_action_id: '', error_code: 'provider_timeout',
      error_message: '', trace_id: 'trace-uncertain-a', reconciliation_count: 0,
      created_at: '2026-07-13T00:04:00.000Z', updated_at: '2026-07-13T00:04:00.000Z', completed_at: null
    });
    assert.deepEqual(await actionStore.claimDue({ tenant_id: tenantA, worker_id: 'executor-must-not-replay',
      now: '2026-07-13T00:05:00.000Z', limit: 10, lease_ms: 30_000 }), []);
    const reconClaim = await actionStore.claimUncertain({ tenant_id: tenantA, worker_id: 'reconcile-a',
      now: '2026-07-13T00:05:00.000Z', limit: 10, lease_ms: 30_000 });
    assert.equal(reconClaim[0]?.state, 'uncertain');
    assert.equal(reconClaim[0]?.reconciliation_count, 1);
    assert.deepEqual(await actionStore.claimUncertain({ tenant_id: tenantA, worker_id: 'reconcile-b',
      now: '2026-07-13T00:05:01.000Z', limit: 10, lease_ms: 30_000 }), []);
    await actionStore.release({ tenant_id: tenantA, action_id: 'ivr-uncertain-action-a', worker_id: 'reconcile-a',
      state: 'uncertain', next_attempt_at: '2026-07-13T00:06:00.000Z',
      error_code: 'provider_result_unknown', error_message: 'provider_result_unknown',
      now: '2026-07-13T00:05:02.000Z' });
    assert.deepEqual(await actionStore.claimUncertain({ tenant_id: tenantA, worker_id: 'reconcile-b',
      now: '2026-07-13T00:05:59.000Z', limit: 10, lease_ms: 30_000 }), []);
    assert.equal((await actionStore.claimUncertain({ tenant_id: tenantA, worker_id: 'reconcile-b',
      now: '2026-07-13T00:06:00.000Z', limit: 10, lease_ms: 30_000 }))[0]?.reconciliation_count, 2);

    await assert.rejects(
      () => withPgTenant(pool, tenantA, (client) => client.query(
        `UPDATE ivekit_ivr_flow_versions SET graph = '{}'::jsonb WHERE id = $1`,
        [first.version.id]
      )),
      /immutable/i
    );
  } finally {
    await pool.end();
  }
});

function graph(text: string, audioAssetId: string): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'play', type: 'play', name: 'Play', position: { x: 1, y: 0 },
        data: { text, audio_asset_id: audioAssetId } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 2, y: 0 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
      { id: 'e2', source: 'play', target: 'end', sourceHandle: 'out' }
    ]
  };
}
