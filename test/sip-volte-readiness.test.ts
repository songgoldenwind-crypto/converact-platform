import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSipVolteReadinessConfigFromEnv,
  SipVolteReadinessError,
  runSipVolteReadiness
} from '../scripts/sip-volte-readiness.js';

test('sip volte readiness config requires LiveKit SIP and RustPBX bridge settings', () => {
  assert.throws(
    () => createSipVolteReadinessConfigFromEnv({}),
    /LIVEKIT_URL is required/
  );
  assert.throws(
    () =>
      createSipVolteReadinessConfigFromEnv({
        LIVEKIT_URL: 'ws://livekit:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret',
        LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061'
      }),
    /RUSTPBX_LIVEKIT_TRUNK is required/
  );
});

test('sip volte readiness fails when active gateway is required but still planned', async () => {
  const config = createSipVolteReadinessConfigFromEnv({
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
    RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
    RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: 'rwi-token',
    OPC_SIP_VOLTE_REQUIRE_ACTIVE: '1'
  });

  await assert.rejects(
    async () => runSipVolteReadiness(config),
    (error: unknown) => {
      assert.ok(error instanceof SipVolteReadinessError);
      assert.equal(error.result.gatewayStatus, 'planned');
      assert.equal(error.result.activationRequired, true);
      assert.match(error.message, /sip_volte gateway is still planned/);
      return true;
    }
  );
});

test('sip volte readiness reports planned gateway status and a stable dial plan', async () => {
  const config = createSipVolteReadinessConfigFromEnv({
    LIVEKIT_URL: 'ws://livekit:7880/',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
    RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
    RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: 'rwi-token',
    OPC_SIP_VOLTE_SMOKE_ROOM_NAME: 'tenant-1-volte-room',
    OPC_SIP_VOLTE_SMOKE_CUSTOMER_PHONE: '+819012345678'
  });

  const result = await runSipVolteReadiness(config);

  assert.equal(result.gatewayStatus, 'planned');
  assert.equal(result.activationRequired, true);
  assert.equal(result.dialPlan.mode, 'sip_bridge');
  assert.equal(result.dialPlan.trunk, 'livekit-bridge');
  assert.equal(result.dialPlan.video, true);
  assert.match(result.dialPlan.sipDialTarget, /^sip:livekit-bridge@livekit-sip:5061;room=tenant-1-volte-room$/);
  assert.deepEqual(result.checks.map((check) => check.name), [
    'livekit_server_config',
    'livekit_sip_bridge_target',
    'rustpbx_livekit_trunk',
    'rustpbx_rwi_config',
    'sip_volte_gateway_status',
    'sip_bridge_dial_plan'
  ]);
});

test('sip volte readiness can promote gateway status from a live runtime probe', async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const config = createSipVolteReadinessConfigFromEnv({
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
    RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
    RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: 'rwi-token',
    OPC_SIP_VOLTE_GATEWAY_STATUS_URL: 'http://bridge.local/status',
    OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN: 'status-token',
    OPC_SIP_VOLTE_REQUIRE_ACTIVE: '1'
  });

  const result = await runSipVolteReadiness(config, async (input, init = {}) => {
    calls.push({
      url: String(input),
      authorization: (init.headers as Record<string, string> | undefined)?.authorization
    });
    return new Response(
      JSON.stringify({
        status: 'active',
        sip_bridge_target: 'sip:livekit-bridge@livekit-sip:5061',
        rustpbx_livekit_trunk: 'livekit-bridge',
        video: true
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  assert.equal(result.gatewayStatus, 'active');
  assert.equal(result.activationRequired, false);
  assert.equal(result.checks.find((check) => check.name === 'sip_volte_runtime_status')?.ok, true);
  assert.deepEqual(calls, [{ url: 'http://bridge.local/status', authorization: 'Bearer status-token' }]);
});

test('sip volte readiness does not promote an incomplete runtime probe', async () => {
  const config = createSipVolteReadinessConfigFromEnv({
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
    RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
    RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: 'rwi-token',
    OPC_SIP_VOLTE_GATEWAY_STATUS_URL: 'http://bridge.local/status'
  });

  const result = await runSipVolteReadiness(config, async () =>
    new Response(JSON.stringify({ status: 'active' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  );

  assert.equal(result.gatewayStatus, 'planned');
  assert.equal(result.activationRequired, true);
  assert.equal(result.checks.find((check) => check.name === 'sip_volte_runtime_status')?.ok, false);
});
