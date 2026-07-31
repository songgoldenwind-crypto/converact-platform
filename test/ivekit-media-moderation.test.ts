import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import { routeIveKitMediaApi } from '../src/agent-runtime/converact/media-http.js';
import { LiveKitModerationService } from '../src/agent-runtime/livekit/livekit-moderation-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

const JWT_SECRET = 'ivekit-media-moderation-secret-32-bytes';

test('iveKit media enforces host moderation and revokes provider before terminal state', async () => {
  const previous = {
    jwtSecret: process.env.CONVERACT_JWT_SECRET,
    apiKey: process.env.CONVERACT_API_KEY,
    nodeEnv: process.env.NODE_ENV
  };
  process.env.CONVERACT_JWT_SECRET = JWT_SECRET;
  process.env.CONVERACT_API_KEY = 'ivekit-media-moderation-system-key';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const store = new MediaCallStore(pg);
  const tenantId = 'tenant_media_moderation';
  const host = jwtHeaders(tenantId, 'host-engineer');
  const customer = jwtHeaders(tenantId, 'customer-led');
  const provider = new FakeModerationProvider();
  const route = (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>
  ) => routeIveKitMediaApi(
    db,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers,
    { pg, moderationProvider: provider }
  );
  try {
    const active = await createActiveCall(route, tenantId, 'MOD-1', host, customer);
    const roomName = active.call.room_name;
    const mutePath = `/api/ivekit/media/rooms/${roomName}/participants/customer-led/mute`;
    const removePath = `/api/ivekit/media/rooms/${roomName}/participants/customer-led/remove`;

    await assert.rejects(
      () => route('POST', mutePath, {
        track_sid: 'TR_MIC_1', source: 'microphone', muted: true
      }, host),
      hasStatus(400)
    );
    await assert.rejects(
      () => route('POST', mutePath, {
        track_sid: 'TR_MIC_1', source: 'microphone', muted: true
      }, withIdempotency(customer, 'participant-mute')),
      hasStatus(403)
    );
    await assert.rejects(
      () => route('POST', mutePath, {
        track_sid: 'TR_MIC_1', source: 'microphone', muted: false
      }, withIdempotency(host, 'remote-unmute')),
      hasStatus(400)
    );

    const muted = await route('POST', mutePath, {
      track_sid: 'TR_MIC_1', source: 'microphone', muted: true
    }, withIdempotency(host, 'mute-customer-1')) as {
      status: number;
      data: { action: string; actor_identity: string };
      afterCommit?: () => Promise<void>;
    };
    assert.equal(muted.status, 201);
    assert.equal(muted.data.action, 'mute');
    assert.equal(muted.data.actor_identity, 'host-engineer');
    assert.deepEqual(provider.operations.at(-1), 'mute:customer-led:TR_MIC_1:true');
    await muted.afterCommit?.();
    assert.equal(
      (await store.getModerationCommandByIdempotencyKey(tenantId, 'mute-customer-1'))?.status,
      'completed'
    );
    const replayedMute = await route('POST', mutePath, {
      track_sid: 'TR_MIC_1', source: 'microphone', muted: true
    }, withIdempotency(host, 'mute-customer-1')) as { data: { status: string } };
    assert.equal(replayedMute.data.status, 'applied');
    assert.equal(
      provider.operations.filter((operation) => operation === 'mute:customer-led:TR_MIC_1:true').length,
      1
    );
    await assert.rejects(
      () => route('POST', mutePath, {
        track_sid: 'TR_MIC_DIFFERENT', source: 'microphone', muted: true
      }, withIdempotency(host, 'mute-customer-1')),
      hasStatus(409)
    );

    provider.failRemove = true;
    await assert.rejects(
      () => route('POST', removePath, { reason: 'host_removed' }, withIdempotency(host, 'remove-fail')),
      hasStatus(502)
    );
    assert.equal(
      (await store.snapshot(tenantId, active.call.id))?.participants
        .find((participant) => participant.identity === 'customer-led')?.status,
      'joined'
    );
    provider.failRemove = false;
    const removeCountBefore = provider.operations.filter((operation) => operation === 'remove:customer-led').length;
    const concurrentRemoves = await Promise.all([
      route('POST', removePath, { reason: 'host_removed' }, withIdempotency(host, 'remove-customer-1')),
      route('POST', removePath, { reason: 'host_removed' }, withIdempotency(host, 'remove-customer-1'))
    ]) as Array<{ status: number; data: { status: string } }>;
    assert.deepEqual(
      concurrentRemoves.map((result) => result.data.status).sort(),
      ['applied', 'applied']
    );
    assert.equal(concurrentRemoves.every((result) => result.status === 201), true);
    assert.equal(
      (await store.snapshot(tenantId, active.call.id))?.participants
        .find((participant) => participant.identity === 'customer-led')?.status,
      'removed'
    );
    const removeCount = provider.operations.filter((operation) => operation === 'remove:customer-led').length;
    assert.equal(removeCount, removeCountBefore + 1);
    const repeatedRemove = await route(
      'POST',
      removePath,
      { reason: 'host_removed' },
      withIdempotency(host, 'remove-customer-already')
    ) as {
      data: { status: string };
    };
    assert.equal(repeatedRemove.data.status, 'already_applied');
    assert.equal(
      provider.operations.filter((operation) => operation === 'remove:customer-led').length,
      removeCount
    );

    const audit = await store.listModerationActions(tenantId, active.call.id);
    assert.deepEqual(audit.map((item) => [item.action, item.actor_identity]), [
      ['mute', 'host-engineer'],
      ['remove', 'host-engineer']
    ]);

    await store.insertParticipant({
      tenant_id: tenantId,
      call_id: active.call.id,
      identity: 'observer-qm',
      role: 'observer',
      status: 'joined'
    });
    const observerJoin = await route(
      'POST',
      `/api/ivekit/media/calls/${active.call.id}/join`,
      { identity: 'observer-qm' },
      jwtHeaders(tenantId, 'observer-qm')
    ) as { status: number; data: { role: string; token: { token: string } } };
    assert.equal(observerJoin.status, 201);
    assert.equal(observerJoin.data.role, 'observer');
    assert.match(observerJoin.data.token.token, /supervisor_listen$/);

    await assert.rejects(
      () => route('POST', mutePath, {
        track_sid: 'TR_MIC_1', source: 'microphone', muted: true
      }, withIdempotency(jwtHeaders('tenant_media_moderation_foreign', 'foreign-host'), 'foreign-mute')),
      hasStatus(404)
    );

    const terminal = await createActiveCall(route, tenantId, 'MOD-TERMINAL', host, customer);
    await assert.rejects(
      () => route(
        'POST',
        `/api/ivekit/media/rooms/${terminal.call.room_name}/participants/customer-led/mute`,
        { track_sid: 'TR_MIC_SYSTEM', source: 'microphone', muted: true },
        {
          'X-API-Key': 'ivekit-media-moderation-system-key',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': 'system-missing-actor'
        }
      ),
      hasStatus(400)
    );
    await assert.rejects(
      () => route(
        'POST',
        `/api/ivekit/media/rooms/${terminal.call.room_name}/participants/host-engineer/remove`,
        { reason: 'self_remove' },
        withIdempotency(host, 'host-self-remove')
      ),
      hasStatus(403)
    );
    const systemMuted = await route(
      'POST',
      `/api/ivekit/media/rooms/${terminal.call.room_name}/participants/customer-led/mute`,
      { track_sid: 'TR_MIC_SYSTEM', source: 'microphone', muted: true },
      {
        'X-API-Key': 'ivekit-media-moderation-system-key',
        'X-Tenant-Id': tenantId,
        'X-User-Id': 'system-moderator',
        'Idempotency-Key': 'system-mute'
      }
    ) as { data: { actor_identity: string } };
    assert.equal(systemMuted.data.actor_identity, 'system-moderator');
    assert.deepEqual(
      (await store.listModerationActions(tenantId, terminal.call.id)).map((item) => [
        item.action,
        item.actor_identity
      ]),
      [['mute', 'system-moderator']]
    );
    await store.insertParticipant({
      tenant_id: tenantId,
      call_id: terminal.call.id,
      identity: 'former-observer',
      role: 'observer',
      status: 'left'
    });
    provider.inspectStatus = async () => {
      assert.equal((await store.snapshot(tenantId, terminal.call.id))?.call.status, 'active');
    };
    provider.failClose = true;
    await assert.rejects(
      () => action(route, terminal.call.id, 'end', 'terminal-end-fail', host),
      hasStatus(502)
    );
    assert.equal((await store.snapshot(tenantId, terminal.call.id))?.call.status, 'active');

    provider.failClose = false;
    const ended = await action(route, terminal.call.id, 'end', 'terminal-end-ok', host) as {
      data: { call: { status: string } };
    };
    assert.equal(ended.data.call.status, 'ended');
    assert.equal(provider.operations.includes('remove:host-engineer'), true);
    assert.equal(provider.operations.includes('remove:customer-led'), true);
    assert.equal(provider.operations.includes('remove:former-observer'), true);
    assert.equal(provider.operations.includes(`close:${terminal.call.room_name}`), true);
    assert.equal(provider.revocationTimestamps.length > 0, true);
    assert.equal(provider.revocationTimestamps.every((timestamp) => timestamp > 0n), true);
    provider.inspectStatus = undefined;

    const revivalCloseCount = provider.operations.filter(
      (operation) => operation === `close:${terminal.call.room_name}`
    ).length;
    const revival = await route(
      'POST',
      '/api/ivekit/media/webhooks/livekit',
      {
        event: 'participant_joined',
        room: { name: terminal.call.room_name },
        participant: {
          identity: 'former-observer',
          metadata: JSON.stringify({ tenant_id: tenantId, role: 'supervisor' })
        }
      },
      {}
    ) as { event: string; room_name: string };
    assert.equal(revival.event, 'participant_joined');
    assert.equal(revival.room_name, terminal.call.room_name);
    assert.equal(
      provider.operations.filter((operation) => operation === `close:${terminal.call.room_name}`).length,
      revivalCloseCount + 1
    );

    await assert.rejects(
      () => route('POST', '/api/ivekit/media/moderation/recover', { limit: 20 }, host),
      hasStatus(403)
    );
    const recoveredCommands = await route(
      'POST',
      '/api/ivekit/media/moderation/recover',
      { limit: 20 },
      {
        'X-API-Key': 'ivekit-media-moderation-system-key',
        'X-Tenant-Id': tenantId,
        'X-User-Id': 'recovery-worker'
      }
    ) as {
      data: { examined: number; finalized: number; recovered: number };
    };
    assert.equal(recoveredCommands.data.examined >= 2, true);
    assert.equal(recoveredCommands.data.finalized >= 2, true);

    const noProvider = await createActiveCall(route, tenantId, 'MOD-NO-PROVIDER', host, customer);
    process.env.NODE_ENV = 'production';
    const noProviderSnapshot = (await store.snapshot(tenantId, noProvider.call.id))!;
    await assert.rejects(
      () => new LiveKitModerationService(store, null).revokeForTerminal(noProviderSnapshot),
      hasStatus(503)
    );
    assert.equal((await store.snapshot(tenantId, noProvider.call.id))?.call.status, 'active');
  } finally {
    db.close();
    restoreEnv('CONVERACT_JWT_SECRET', previous.jwtSecret);
    restoreEnv('CONVERACT_API_KEY', previous.apiKey);
    restoreEnv('NODE_ENV', previous.nodeEnv);
  }
});

test('iveKit media moderation audit migration is tenant scoped', () => {
  const path = 'src/migrations/035_ivekit_media_moderation.sql';
  assert.equal(existsSync(path), true);
  const sql = readFileSync(path, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_media_moderation_actions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_media_moderation_commands/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, call_id\)/);
  assert.match(sql, /ivekit_media_moderation_payload_valid/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.equal((sql.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 2);
  assert.equal((sql.match(/CREATE POLICY tenant_isolation/g) || []).length, 2);
});

test('iveKit media moderation recovers provider success after a failed audit write', async () => {
  const pg = new FailOnceModerationAuditMemoryPg();
  const store = new MediaCallStore(pg);
  const tenantId = 'tenant_media_moderation_recovery';
  const created = await store.insertCall({
    tenant_id: tenantId,
    media: 'video',
    initiated_by: 'host-recovery',
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'MOD-RECOVERY' },
    title: '',
    metadata: {},
    ring_timeout_seconds: 30
  });
  const now = new Date().toISOString();
  await store.updateCall({
    ...created,
    status: 'active',
    accepted_at: now,
    started_at: now
  });
  await store.insertParticipant({
    tenant_id: tenantId,
    call_id: created.id,
    identity: 'host-recovery',
    role: 'host',
    status: 'joined'
  });
  await store.insertParticipant({
    tenant_id: tenantId,
    call_id: created.id,
    identity: 'customer-recovery',
    role: 'participant',
    status: 'joined'
  });
  await assert.rejects(
    () => new LiveKitModerationService(store, null).mute({
      tenant_id: tenantId,
      room_name: created.room_name,
      participant_identity: 'customer-recovery',
      actor_identity: 'host-recovery',
      idempotency_key: 'mute-unconfigured',
      track_sid: 'TR_UNCONFIGURED',
      source: 'microphone',
      muted: true
    }),
    hasStatus(503)
  );
  assert.equal(
    await store.getModerationCommandByIdempotencyKey(tenantId, 'mute-unconfigured'),
    null
  );
  const provider = new FakeModerationProvider();
  const service = new LiveKitModerationService(store, provider);
  const input = {
    tenant_id: tenantId,
    room_name: created.room_name,
    participant_identity: 'customer-recovery',
    actor_identity: 'host-recovery',
    idempotency_key: 'mute-recovery-1',
    track_sid: 'TR_RECOVERY',
    source: 'microphone' as const,
    muted: true as const
  };

  await assert.rejects(() => service.mute(input), /injected moderation audit failure/);
  assert.equal(provider.operations.filter((item) => item.startsWith('mute:')).length, 1);
  assert.equal((await store.listModerationActions(tenantId, created.id)).length, 0);
  assert.equal(
    (await store.getModerationCommandByIdempotencyKey(tenantId, input.idempotency_key))?.status,
    'pending'
  );

  const recovery = await service.recoverPending(tenantId);
  assert.equal(recovery.recovered, 1);
  assert.equal(provider.operations.filter((item) => item.startsWith('mute:')).length, 2);
  assert.equal((await store.listModerationActions(tenantId, created.id)).length, 1);
  assert.equal(
    (await store.getModerationCommandByIdempotencyKey(tenantId, input.idempotency_key))?.status,
    'completed'
  );

  await service.mute(input);
  assert.equal(provider.operations.filter((item) => item.startsWith('mute:')).length, 2);
  assert.equal((await store.listModerationActions(tenantId, created.id)).length, 1);
});

test('iveKit media moderation recovery requires a root PostgreSQL pool even with no pending work', async () => {
  const scopedClient = {
    query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
    release: () => undefined
  } as unknown as PgQueryable;
  const service = new LiveKitModerationService(
    new MediaCallStore(scopedClient),
    new FakeModerationProvider(),
    { commandPg: scopedClient }
  );
  await assert.rejects(() => service.recoverPending('tenant_scoped_client'), hasStatus(503));
});

async function createActiveCall(
  route: Route,
  tenantId: string,
  businessRefId: string,
  host: Record<string, string>,
  customer: Record<string, string>
) {
  const created = await route('POST', '/api/ivekit/media/calls', {
    media: 'video',
    participant_identities: ['customer-led'],
    business_ref: { type: 'service_order', id: businessRefId }
  }, host) as { data: { call: { id: string; room_name: string } } };
  await action(route, created.data.call.id, 'ring', `${businessRefId}-ring`, host);
  await action(route, created.data.call.id, 'accept', `${businessRefId}-accept`, customer);
  const active = await action(route, created.data.call.id, 'activate', `${businessRefId}-activate`, host) as {
    data: { call: { id: string; room_name: string; status: string } };
  };
  return active.data;
}

function action(
  route: Route,
  callId: string,
  actionName: string,
  idempotencyKey: string,
  headers: Record<string, string>
) {
  return route(
    'POST',
    `/api/ivekit/media/calls/${callId}/actions`,
    { action: actionName },
    { ...headers, 'Idempotency-Key': idempotencyKey }
  );
}

class FakeModerationProvider {
  operations: string[] = [];
  revocationTimestamps: bigint[] = [];
  failClose = false;
  failRemove = false;
  inspectStatus?: () => Promise<void>;

  async mutePublishedTrack(_roomName: string, identity: string, trackSid: string, muted: boolean) {
    this.operations.push(`mute:${identity}:${trackSid}:${muted}`);
  }

  async removeParticipant(
    _roomName: string,
    identity: string,
    options: { revokeTokenTs: bigint }
  ) {
    this.operations.push(`remove:${identity}`);
    this.revocationTimestamps.push(options.revokeTokenTs);
    if (this.failRemove) throw new Error('provider remove failed');
  }

  async closeRoom(roomName: string) {
    await this.inspectStatus?.();
    this.operations.push(`close:${roomName}`);
    if (this.failClose) throw new Error('provider close failed');
  }
}

class FailOnceModerationAuditMemoryPg extends MemoryPg {
  private shouldFail = true;

  override query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    if (this.shouldFail && text.replace(/\s+/g, ' ').trim().startsWith(
      'INSERT INTO ivekit_media_moderation_actions'
    )) {
      this.shouldFail = false;
      return Promise.reject(new Error('injected moderation audit failure'));
    }
    return super.query<R>(text, params);
  }
}

type Route = (
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
) => Promise<unknown | undefined>;

function jwtHeaders(tenantId: string, identity: string): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken({ sub: identity, tid: tenantId, role: 'operator' })}` };
}

function withIdempotency(headers: Record<string, string>, key: string): Record<string, string> {
  return { ...headers, 'Idempotency-Key': key };
}

function hasStatus(expected: number) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, expected);
    return true;
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
