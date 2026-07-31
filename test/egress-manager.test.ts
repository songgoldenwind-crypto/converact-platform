import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { EgressManager } from '../src/agent-runtime/call-center/egress-manager.js';

const EGRESS_CONFIG = {
  livekitUrl: 'http://localhost:7880',
  livekitApiKey: 'devkey',
  livekitApiSecret: 'devsecret'
};

function setup() {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Test' });
  const voiceStore = new VoiceStore(db);
  let egressSequence = 0;
  const egressManager = new EgressManager(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      startRoomCompositeEgress: async () => ({
        egressId: `EG_test_${++egressSequence}`
      }),
      stopEgress: async () => undefined
    })
  });

  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300002222'
  });

  return { db, tenant, voiceStore, egressManager, session };
}

test('startRecording creates a record with correct fields', async () => {
  const { tenant, egressManager, session } = setup();

  const record = await egressManager.startRecording(tenant.id, session.id, 'room-rec-1');

  assert.ok(record.id.startsWith('crec_'));
  assert.equal(record.tenant_id, tenant.id);
  assert.equal(record.call_session_id, session.id);
  assert.equal(record.source, 'livekit_egress');
  assert.equal(record.format, 'ogg');
  assert.ok(record.storage_url.includes(tenant.id));
  assert.ok(record.storage_url.includes(session.id));
  assert.ok(record.egress_id);
});

test('getRecordingBySession retrieves the latest recording for a session', async () => {
  const { tenant, egressManager, session } = setup();

  await egressManager.startRecording(tenant.id, session.id, 'room-rec-2');
  const found = egressManager.getRecordingBySession(session.id);

  assert.ok(found);
  assert.equal(found.call_session_id, session.id);
});

test('stopRecording returns record for valid egress_id', async () => {
  const { tenant, egressManager, session } = setup();

  const record = await egressManager.startRecording(tenant.id, session.id, 'room-rec-3');
  const stopped = await egressManager.stopRecording(record.egress_id);

  assert.ok(stopped);
  assert.equal(stopped.id, record.id);
});

test('stopRecording returns null for unknown egress_id', async () => {
  const { egressManager } = setup();

  const result = await egressManager.stopRecording('nonexistent_egress');
  assert.equal(result, null);
});

test('listRecordings returns tenant-scoped records', async () => {
  const { db, tenant, egressManager, session } = setup();

  await egressManager.startRecording(tenant.id, session.id, 'room-list-1');
  await egressManager.startRecording(tenant.id, session.id, 'room-list-2');

  const otherTenant = createTenant(db, { name: 'Other' });
  const otherVoice = new VoiceStore(db);
  const otherSession = otherVoice.createCallSession({
    tenant_id: otherTenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300003333'
  });
  await egressManager.startRecording(otherTenant.id, otherSession.id, 'room-other');

  const records = egressManager.listRecordings(tenant.id);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.tenant_id === tenant.id));

  const otherRecords = egressManager.listRecordings(otherTenant.id);
  assert.equal(otherRecords.length, 1);
});
