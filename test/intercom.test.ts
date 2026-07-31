import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import {
  startIntercomCommand,
  acceptIntercomCommand,
  declineIntercomCommand
} from '../src/agent-runtime/call-center/application.js';

before(() => {
  useMemoryRedisForTests();
});

function setup() {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Intercom Co' });
  const seats = new AgentSeatStore(db);
  const seatA = seats.upsertSeat({ tenant_id: tenant.id, user_id: 'user-a', display_name: 'Alice' });
  const seatB = seats.upsertSeat({ tenant_id: tenant.id, user_id: 'user-b', display_name: 'Bob' });
  return { db, tenantId: tenant.id, seatA, seatB };
}

test('startIntercom creates a room and returns the caller token', async () => {
  const { db, tenantId, seatA, seatB } = setup();
  const result = await startIntercomCommand(db, tenantId, 'user-a', {
    from_seat_id: seatA.id,
    target_seat_id: seatB.id,
    media: 'video'
  });
  const data = (result as { data: Record<string, unknown> }).data;
  assert.ok(data.room_name);
  assert.equal(data.media, 'video');
  assert.equal(data.target_seat_id, seatB.id);
  assert.equal(data.target_user_id, 'user-b');
  assert.ok((data.caller_token as { token: string }).token);
});

test('startIntercom defaults media to voice', async () => {
  const { db, tenantId, seatA, seatB } = setup();
  const result = await startIntercomCommand(db, tenantId, 'user-a', {
    from_seat_id: seatA.id,
    target_seat_id: seatB.id
  });
  assert.equal((result as { data: { media: string } }).data.media, 'voice');
});

test('startIntercom rejects calling yourself', async () => {
  const { db, tenantId, seatA } = setup();
  await assert.rejects(
    () => startIntercomCommand(db, tenantId, 'user-a', { from_seat_id: seatA.id, target_seat_id: seatA.id }),
    /cannot intercom yourself/
  );
});

test('startIntercom rejects caller seat not owned by user', async () => {
  const { db, tenantId, seatA, seatB } = setup();
  await assert.rejects(
    () => startIntercomCommand(db, tenantId, 'wrong-user', { from_seat_id: seatA.id, target_seat_id: seatB.id }),
    /does not belong to current user/
  );
});

test('startIntercom rejects unknown target seat', async () => {
  const { db, tenantId, seatA } = setup();
  await assert.rejects(
    () => startIntercomCommand(db, tenantId, 'user-a', { from_seat_id: seatA.id, target_seat_id: 'nonexistent' }),
    /target seat not found/
  );
});

test('acceptIntercom issues a token for the existing room', async () => {
  const { db, tenantId, seatA, seatB } = setup();
  const started = await startIntercomCommand(db, tenantId, 'user-a', {
    from_seat_id: seatA.id,
    target_seat_id: seatB.id,
    media: 'video'
  });
  const roomName = (started as { data: { room_name: string } }).data.room_name;

  const accepted = await acceptIntercomCommand(db, tenantId, 'user-b', {
    room_name: roomName,
    seat_id: seatB.id
  });
  const data = (accepted as { data: Record<string, unknown> }).data;
  assert.equal(data.room_name, roomName);
  assert.equal(data.seat_id, seatB.id);
  assert.ok((data.livekit as { token: string }).token);
});

test('acceptIntercom rejects unknown room', async () => {
  const { db, tenantId, seatB } = setup();
  await assert.rejects(
    () => acceptIntercomCommand(db, tenantId, 'user-b', { room_name: 'no-such-room', seat_id: seatB.id }),
    /intercom room not found/
  );
});

test('acceptIntercom rejects closed room', async () => {
  const { db, tenantId, seatA, seatB } = setup();
  const started = await startIntercomCommand(db, tenantId, 'user-a', {
    from_seat_id: seatA.id,
    target_seat_id: seatB.id,
    media: 'video'
  });
  const roomName = (started as { data: { room_name: string } }).data.room_name;
  new LiveKitRoomStore(db).closeRoom(roomName);

  await assert.rejects(
    () => acceptIntercomCommand(db, tenantId, 'user-b', { room_name: roomName, seat_id: seatB.id }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );
});

test('acceptIntercom rejects seat not owned by user', async () => {
  const { db, tenantId, seatA, seatB } = setup();
  const started = await startIntercomCommand(db, tenantId, 'user-a', {
    from_seat_id: seatA.id,
    target_seat_id: seatB.id
  });
  const roomName = (started as { data: { room_name: string } }).data.room_name;
  await assert.rejects(
    () => acceptIntercomCommand(db, tenantId, 'wrong-user', { room_name: roomName, seat_id: seatB.id }),
    /does not belong to current user/
  );
});

test('declineIntercom returns ok and normalizes reason', () => {
  const { db, tenantId } = setup();
  const result = declineIntercomCommand(db, tenantId, 'user-b', {
    room_name: 'room-1',
    reason: 'cancelled'
  });
  assert.equal((result as { data: { ok: boolean } }).data.ok, true);
  assert.equal((result as { data: { room_name: string } }).data.room_name, 'room-1');
});
