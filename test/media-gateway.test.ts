import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MediaGatewayRegistry,
  createDefaultMediaGatewayRegistry
} from '../src/agent-runtime/media-gateway/index.js';
import type { MediaGatewayAdapter } from '../src/agent-runtime/media-gateway/media-gateway-registry.js';

test('default registry has webrtc active and keeps sip_volte fail-closed', () => {
  const registry = createDefaultMediaGatewayRegistry({});
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

test('webrtc gateway forwards the durable Cell owner into the LiveKit token', async () => {
  const registry = createDefaultMediaGatewayRegistry();
  const placement = {
    interaction_id: 'mcall-cell-a',
    reservation_id: 'reservation-cell-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    profile_id: 'cell-10k-v1',
    snapshot_version: 7,
    livekit_url: 'wss://livekit-cell-a.example.com'
  };
  const plan = await registry.prepareJoin('webrtc', {
    tenantId: 'tenant-x',
    roomName: 'room-cell-a',
    identity: 'agent-cell-a',
    role: 'agent',
    media: 'video',
    placement
  });
  assert.equal(plan.mode, 'webrtc');
  if (plan.mode === 'webrtc') {
    assert.equal(plan.token.livekit_url, placement.livekit_url);
    assert.deepEqual(plan.token.placement, placement);
  }
});

test('sip_volte gateway is planned when it is not explicitly enabled', async () => {
  const registry = createDefaultMediaGatewayRegistry(completeSipVolteEnv({
    CONVERACT_SIP_VOLTE_ENABLED: '0'
  }));
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

test('sip_volte activates only with explicit complete production configuration', async () => {
  const registry = createDefaultMediaGatewayRegistry(completeSipVolteEnv());
  assert.equal(registry.get('sip_volte').definition.status, 'active');

  const plan = await registry.prepareJoin('sip_volte', {
    tenantId: 't1',
    roomName: 'room-volte',
    identity: 'customer-1',
    role: 'customer',
    media: 'video'
  });

  assert.equal(plan.mode, 'sip_bridge');
  if (plan.mode === 'sip_bridge') {
    assert.equal(
      plan.sipDialTarget,
      'sip:livekit-bridge@livekit-sip:5061;room=room-volte'
    );
    assert.equal(plan.video, true);
    assert.equal(plan.trunk, 'livekit-bridge');
    assert.doesNotMatch(plan.note, /stub|planned/i);
  }
});

test('sip_volte remains planned when one execution dependency is missing', async () => {
  const env = completeSipVolteEnv();
  delete env.RUSTPBX_RWI_TOKEN;
  const registry = createDefaultMediaGatewayRegistry(env);

  assert.equal(registry.get('sip_volte').definition.status, 'planned');
  await assert.rejects(
    () => registry.prepareJoin('sip_volte', {
      tenantId: 't1', roomName: 'room-volte', identity: 'customer-1', role: 'customer', media: 'video'
    }),
    (error: Error & { status?: number }) => error.status === 501
  );
});

test('sip_volte treats whitespace-only credentials as missing', () => {
  const registry = createDefaultMediaGatewayRegistry(completeSipVolteEnv({
    RUSTPBX_RWI_TOKEN: '   '
  }));
  assert.equal(registry.get('sip_volte').definition.status, 'planned');
});

test('sip_volte rejects an unsafe bridge target instead of activating', () => {
  const registry = createDefaultMediaGatewayRegistry(completeSipVolteEnv({
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:bridge@livekit-sip:5061\r\nX-Injected: yes'
  }));
  assert.equal(registry.get('sip_volte').definition.status, 'planned');
});

test('sip_volte rejects control URLs with embedded credentials or query data', () => {
  for (const rwiUrl of [
    'ws://operator:secret@rustpbx:8080/rwi/v1',
    'ws://rustpbx:8080/rwi/v1?token=secret'
  ]) {
    const registry = createDefaultMediaGatewayRegistry(completeSipVolteEnv({
      RUSTPBX_RWI_URL: rwiUrl
    }));
    assert.equal(registry.get('sip_volte').definition.status, 'planned');
  }
});

function completeSipVolteEnv(
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    CONVERACT_SIP_VOLTE_ENABLED: '1',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
    RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
    RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: 'rwi-token',
    ...overrides
  };
}
