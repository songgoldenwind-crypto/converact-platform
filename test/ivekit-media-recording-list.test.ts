import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { routeIveKitMediaApi } from '../src/agent-runtime/converact/media-http.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { createDatabase, run } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';

test('recording list preserves arrays and adds tenant-scoped filtered cursor pages', async () => {
  const previousKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'recording-list-key';
  const db = createDatabase(':memory:');
  try {
    const tenant = createTenant(db, { name: 'Recording list tenant' });
    const otherTenant = createTenant(db, { name: 'Other recording tenant' });
    const media = createLiveKitMediaModule({ db });
    await media.rooms.createRoom({ tenant_id: tenant.id, room_name: 'room-a', purpose: 'video_service' });
    await media.rooms.createRoom({ tenant_id: tenant.id, room_name: 'room-b', purpose: 'conference' });
    await media.rooms.createRoom({ tenant_id: otherTenant.id, room_name: 'room-other', purpose: 'video_service' });
    const first = await media.recordings.startRecording(tenant.id, null, 'room-a', {
      mediaCallId: 'call-a',
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-a' }
    });
    const second = await media.recordings.startRecording(tenant.id, null, 'room-b', {
      mediaCallId: 'call-b',
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-b' }
    });
    await media.recordings.startRecording(otherTenant.id, null, 'room-other', {
      mediaCallId: 'call-a',
      businessRef: { tenant_id: otherTenant.id, type: 'order', id: 'order-a' }
    });
    run(db, "UPDATE call_recordings SET status = 'completed' WHERE id = ?", [first.id]);

    assert.equal(media.recordings.listRecordings(tenant.id).length, 2);
    assert.deepEqual(media.recordings.listRecordings(tenant.id, { mediaCallId: 'call-a' }).map((item) => item.id), [first.id]);
    assert.deepEqual(media.recordings.listRecordings(tenant.id, { roomName: 'room-b' }).map((item) => item.id), [second.id]);
    assert.deepEqual(media.recordings.listRecordings(tenant.id, { businessRefType: 'order', businessRefId: 'order-a', status: 'completed' }).map((item) => item.id), [first.id]);
    assert.equal(first.media_call_id, 'call-a');
    assert.equal(first.room_name, 'room-a');

    const pageOne = media.recordings.listRecordingsPage(tenant.id, { limit: 1 });
    assert.equal(pageOne.items.length, 1);
    assert.equal(pageOne.has_more, true);
    assert.ok(pageOne.next_cursor);
    const pageTwo = media.recordings.listRecordingsPage(tenant.id, { limit: 1, cursor: pageOne.next_cursor! });
    assert.equal(pageTwo.items.length, 1);
    assert.notEqual(pageTwo.items[0].id, pageOne.items[0].id);
    assert.equal(pageTwo.has_more, false);

    const path = '/api/ivekit/media/recordings?page=1&call_id=call-a&room_name=room-a&limit=1';
    const response = await routeIveKitMediaApi(
      db,
      'GET',
      '/api/ivekit/media/recordings',
      new URL(`http://localhost${path}`),
      null,
      '',
      { 'X-API-Key': 'recording-list-key', 'X-Tenant-Id': tenant.id, 'X-User-Id': 'host-1' }
    ) as { data: { items: Array<{ id: string }>; has_more: boolean } };
    assert.deepEqual(response.data.items.map((item) => item.id), [first.id]);
    assert.equal(response.data.has_more, false);
  } finally {
    db.close();
    if (previousKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousKey;
  }
});

test('JWT recording access is call-member scoped and writes are host-only', async () => {
  const previousSecret = process.env.OPC_JWT_SECRET;
  process.env.OPC_JWT_SECRET = 'recording-list-jwt-secret-32-bytes';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  try {
    const tenant = createTenant(db, { name: 'Recording JWT tenant' });
    const media = createLiveKitMediaModule({ db });
    await media.rooms.createRoom({ tenant_id: tenant.id, room_name: 'jwt-room', purpose: 'video_service' });
    const host = jwt(tenant.id, 'host-1');
    const participant = jwt(tenant.id, 'participant-1');
    const outsider = jwt(tenant.id, 'outsider-1');
    const created = await routed('POST', '/api/ivekit/media/calls', {
      media: 'video', participant_identities: ['participant-1'], business_ref: { type: 'order', id: 'order-jwt' }
    }, host) as { data: { call: { id: string; room_name: string } } };
    const callId = created.data.call.id;
    const callRoom = created.data.call.room_name;
    await routed('POST', `/api/ivekit/media/calls/${callId}/actions`, { action: 'ring' }, {
      ...host, 'Idempotency-Key': 'recording-call-ring'
    });
    await routed('POST', `/api/ivekit/media/calls/${callId}/actions`, { action: 'accept' }, {
      ...participant, 'Idempotency-Key': 'recording-call-accept'
    });
    await assert.rejects(
      () => routed('POST', '/api/ivekit/media/rooms/jwt-room/recordings/start', {
        media_call_id: callId, business_ref: { type: 'order', id: 'order-jwt' }
      }, host),
      status(404)
    );
    await assert.rejects(
      () => routed('POST', `/api/ivekit/media/rooms/${callRoom}/recordings/start`, { media_call_id: callId }, participant),
      status(403)
    );
    const started = await routed('POST', `/api/ivekit/media/rooms/${callRoom}/recordings/start`, {
      media_call_id: callId, business_ref: { type: 'order', id: 'order-jwt' }
    }, host) as { data: { id: string; egress_id: string; evidence_record_id?: string; storage_url?: string } };
    assert.equal(started.data.evidence_record_id, 'evidence-recording-test');
    assert.equal('storage_url' in started.data, false);
    await assert.rejects(
      () => routed('POST', `/api/ivekit/media/rooms/${callRoom}/recordings/start`, {
        media_call_id: callId, business_ref: { type: 'order', id: 'order-jwt' }
      }, host),
      status(409)
    );
    const listed = await routed('GET', `/api/ivekit/media/recordings?page=1&call_id=${callId}`, null, participant) as {
      data: { items: Array<{ id: string; evidence_record_id?: string; storage_url?: string }> }
    };
    assert.deepEqual(listed.data.items.map((item) => item.id), [started.data.id]);
    assert.equal(listed.data.items[0].evidence_record_id, 'evidence-recording-test');
    assert.equal('storage_url' in listed.data.items[0], false);
    await assert.rejects(
      () => routed('GET', `/api/ivekit/media/recordings?page=1&call_id=${callId}`, null, outsider),
      status(404)
    );
    await assert.rejects(
      () => routed('POST', `/api/ivekit/media/recordings/${started.data.egress_id}/stop`, {}, participant),
      status(403)
    );
    const stopped = await routed('POST', `/api/ivekit/media/recordings/${started.data.id}/stop`, {}, host) as {
      data: { id: string; status: string };
    };
    assert.equal(stopped.data.id, started.data.id);
    assert.equal(stopped.data.status, 'stopped');
    const replayedStop = await routed(
      'POST',
      `/api/ivekit/media/recordings/${started.data.egress_id}/stop`,
      {},
      host
    ) as { data: { id: string; status: string } };
    assert.equal(replayedStop.data.id, started.data.id);
    assert.equal(replayedStop.data.status, 'stopped');
    await routed('POST', `/api/ivekit/media/calls/${callId}/actions`, { action: 'end' }, {
      ...host, 'Idempotency-Key': 'recording-call-end'
    });
    await assert.rejects(
      () => routed('POST', `/api/ivekit/media/rooms/${callRoom}/recordings/start`, {
        media_call_id: callId, business_ref: { type: 'order', id: 'order-jwt' }
      }, host),
      status(409)
    );

    function routed(method: string, path: string, body: unknown, headers: Record<string, string>) {
      const pathname = new URL(`http://localhost${path}`).pathname;
      return routeIveKitMediaApi(db, method, pathname, new URL(`http://localhost${path}`), body, '', headers, {
        pg,
        onRecordingStarted: async () => ({ id: 'evidence-recording-test' })
      });
    }
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.OPC_JWT_SECRET;
    else process.env.OPC_JWT_SECRET = previousSecret;
  }
});

test('recording SDK keeps legacy arrays and exposes encoded page filters', async () => {
  const urls: string[] = [];
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.test',
    tenantId: 'tenant-1',
    accessToken: 'token',
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json(urls.length === 1 ? [] : { items: [], next_cursor: null, has_more: false });
    }
  });
  await sdk.media.listRecordings({ call_id: 'call/a', room_name: 'room a', limit: 20 });
  await sdk.media.listRecordingsPage({
    call_id: 'call/a', room_name: 'room a', business_ref_type: 'order', business_ref_id: 'SO/1',
    status: 'completed', cursor: 'cursor+value', limit: 10
  });
  const legacy = new URL(urls[0]);
  assert.equal(legacy.searchParams.get('page'), null);
  assert.equal(legacy.searchParams.get('call_id'), 'call/a');
  const page = new URL(urls[1]);
  assert.equal(page.searchParams.get('page'), '1');
  assert.equal(page.searchParams.get('cursor'), 'cursor+value');
  assert.equal(page.searchParams.get('business_ref_id'), 'SO/1');
  assert.equal(page.searchParams.get('status'), 'completed');
});

test('recording call/room migration is indexed and preserves forced tenant RLS', () => {
  const migration = readFileSync('src/migrations/036_media_recording_call_room.sql', 'utf8');
  const lifecycle = readFileSync('src/migrations/026_media_recording_lifecycle.sql', 'utf8');
  const evidence = readFileSync('src/migrations/038_media_recording_evidence.sql', 'utf8');
  const fullSchema = readFileSync('src/migrations/005_full_schema.sql', 'utf8');
  const callRecordings = tableDefinition(fullSchema, 'call_recordings');
  const voiceWebrtcSessions = tableDefinition(fullSchema, 'voice_webrtc_sessions');
  assert.match(migration, /media_call_id/i);
  assert.match(migration, /room_name/i);
  assert.match(migration, /idx_call_recordings_media_call/i);
  assert.match(migration, /uq_call_recordings_active_room/i);
  assert.match(lifecycle, /ALTER TABLE call_recordings FORCE ROW LEVEL SECURITY/i);
  assert.match(callRecordings, /media_call_id TEXT NULL/i);
  assert.match(callRecordings, /room_name TEXT NOT NULL DEFAULT ''/i);
  assert.match(fullSchema, /uq_call_recordings_active_room/i);
  assert.match(evidence, /evidence_record_id/i);
  assert.match(callRecordings, /evidence_record_id TEXT NOT NULL DEFAULT ''/i);
  assert.doesNotMatch(voiceWebrtcSessions, /media_call_id|room_name/i);
});

function tableDefinition(schema: string, table: string): string {
  const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `missing ${table} table definition`);
  return match[1];
}

function jwt(tenantId: string, identity: string): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken({ sub: identity, tid: tenantId, role: 'operator' })}` };
}

function status(expected: number) {
  return (cause: unknown) => {
    assert.equal((cause as { status?: number }).status, expected);
    return true;
  };
}
