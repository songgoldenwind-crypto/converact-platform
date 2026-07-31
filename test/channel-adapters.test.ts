import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createTenant } from '../src/services.js';

test('channel adapter registry normalizes inbound messages to the standard contract', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Channel Adapter 测试公司' });
  const harness = createHarness(db);

  const inbound = await harness.channelAdapterRegistry.normalizeInbound('telegram', {
    tenant_id: tenant.id,
    external_user_id: 'tg_user_1',
    thread_id: 'thread_1',
    object_type: 'lead',
    object_id: 'lead_123',
    message: '请帮我跟进这个 lead',
    signature_verified: true
  });

  assert.equal(inbound.tenantId, tenant.id);
  assert.equal(inbound.workspaceId, 'default');
  assert.equal(inbound.channel, 'telegram');
  assert.equal(inbound.businessObjectType, 'lead');
  assert.equal(inbound.businessObjectId, 'lead_123');
  assert.equal(inbound.signatureVerified, true);
});

test('channel adapter registry queues outbound delivery through planned adapters', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Outbound Adapter 测试公司' });
  const harness = createHarness(db);

  const delivery = await harness.channelAdapterRegistry.deliverOutbound('voice_rustpbx', {
    tenantId: tenant.id,
    threadId: 'lead_123',
    text: 'Queue call for approval'
  });

  assert.equal(delivery.status, 'queued_for_adapter');
  assert.equal(delivery.channel, 'voice_rustpbx');
  assert.match(delivery.delivery_id, /^voice_rustpbx:/);
});

test('channel adapter registry keeps heavy voice adapters out of the channel default path', () => {
  const db = createDatabase(':memory:');
  const harness = createHarness(db);

  const channels = harness.channelAdapterRegistry.list().map((adapter) => adapter.channel);
  assert.ok(channels.includes('voice_rustpbx'));
  assert.equal(channels.includes('asterisk'), false);
  assert.equal(channels.includes('freeswitch'), false);
});
