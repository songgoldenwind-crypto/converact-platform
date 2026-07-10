import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MediaGatewayRegistry,
  createDefaultMediaGatewayRegistry
} from '../src/agent-runtime/media-gateway/index.js';
import type { MediaGatewayAdapter } from '../src/agent-runtime/media-gateway/media-gateway-registry.js';

test('default registry has webrtc (active) and sip_volte (planned)', () => {
  const registry = createDefaultMediaGatewayRegistry();
  const channels = registry.list();
  const webrtc = channels.find((c) => c.channel === 'webrtc');
  const sip = channels.find((c) => c.channel === 'sip_volte');
  assert.ok(webrtc);
  assert.equal(webrtc.status, 'active');
  assert.ok(sip);
  assert.equal(sip.status, 'planned');
});

test('webrtc gateway issues a token for an agent (no joinPath)', async () => {
  const registry = createDefaultMediaGatewayRegistry();
  const plan = await registry.prepareJoin('webrtc', {
    tenantId: 't1',
    roomName: 'room-1',
    identity: 'agent-1',
    role: 'agent',
    media: 'video'
  });
  assert.equal(plan.mode, 'webrtc');
  if (plan.mode === 'webrtc') {
    assert.ok(plan.token.token);
    assert.equal(plan.joinPath, undefined); // agents don't get an H5 path
  }
});

test('webrtc gateway gives customers an H5 join path', async () => {
  const registry = createDefaultMediaGatewayRegistry();
  const plan = await registry.prepareJoin('webrtc', {
    tenantId: 'tenant-x',
    roomName: 'room-abc',
    identity: 'customer-1',
    role: 'customer',
    media: 'video'
  });
  assert.equal(plan.mode, 'webrtc');
  if (plan.mode === 'webrtc') {
    assert.ok(plan.joinPath);
    assert.match(plan.joinPath, /^\/video\?room=room-abc&tenant_id=tenant-x$/);
  }
});

test('sip_volte gateway is planned — prepareJoin is refused (501)', async () => {
  const registry = createDefaultMediaGatewayRegistry();
  await assert.rejects(
    () =>
      registry.prepareJoin('sip_volte', {
        tenantId: 't1',
        roomName: 'room-1',
        identity: 'customer-1',
        role: 'customer',
        media: 'video'
      }),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 501);
      assert.match(err.message, /not active/);
      return true;
    }
  );
});

test('unknown channel throws not-registered', () => {
  const registry = createDefaultMediaGatewayRegistry();
  assert.throws(() => registry.get('telepathy'), /not registered/);
});

test('registry rejects duplicate channel registration', () => {
  const registry = new MediaGatewayRegistry();
  const stub: MediaGatewayAdapter = { prepareJoin: () => ({ mode: 'webrtc', channel: 'x', token: {} as never }) };
  registry.register({ channel: 'x', description: '', status: 'active', supports_video: true, roles: ['agent'] }, stub);
  assert.throws(
    () => registry.register({ channel: 'x', description: '', status: 'active', supports_video: true, roles: ['agent'] }, stub),
    /duplicate/
  );
});

test('registry validates role support', async () => {
  const registry = new MediaGatewayRegistry();
  const stub: MediaGatewayAdapter = { prepareJoin: () => ({ mode: 'webrtc', channel: 'agentonly', token: {} as never }) };
  // Only supports agent role
  registry.register(
    { channel: 'agentonly', description: '', status: 'active', supports_video: true, roles: ['agent'] },
    stub
  );
  await assert.rejects(
    () => registry.prepareJoin('agentonly', { tenantId: 't', roomName: 'r', identity: 'c', role: 'customer', media: 'video' }),
    /does not support role/
  );
});

test('registry validates video support', async () => {
  const registry = new MediaGatewayRegistry();
  const stub: MediaGatewayAdapter = { prepareJoin: () => ({ mode: 'webrtc', channel: 'audioonly', token: {} as never }) };
  registry.register(
    { channel: 'audioonly', description: '', status: 'active', supports_video: false, roles: ['agent', 'customer'] },
    stub
  );
  // voice is fine
  await registry.prepareJoin('audioonly', { tenantId: 't', roomName: 'r', identity: 'a', role: 'agent', media: 'voice' });
  // video is rejected
  await assert.rejects(
    () => registry.prepareJoin('audioonly', { tenantId: 't', roomName: 'r', identity: 'a', role: 'agent', media: 'video' }),
    /does not support video/
  );
});

test('sip_volte adapter (when activated) produces a SIP dial plan', () => {
  // Register sip_volte as active to exercise its prepareJoin output shape.
  const registry = new MediaGatewayRegistry();
  // Re-use the real adapter factory but force active status.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return import('../src/agent-runtime/media-gateway/adapters/sip-volte-gateway.js').then(async (mod) => {
    registry.register(
      { ...mod.SIP_VOLTE_GATEWAY_DEFINITION, status: 'active' },
      mod.createSipVolteGateway()
    );
    const plan = await registry.prepareJoin('sip_volte', {
      tenantId: 't1',
      roomName: 'room-volte',
      identity: 'customer-1',
      role: 'customer',
      media: 'video'
    });
    assert.equal(plan.mode, 'sip_bridge');
    if (plan.mode === 'sip_bridge') {
      assert.match(plan.sipDialTarget, /room=room-volte/);
      assert.equal(plan.video, true);
      assert.ok(plan.trunk);
    }
  });
});
