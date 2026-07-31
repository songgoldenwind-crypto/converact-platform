import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

import {
  buildKamailioComposeRuntime
} from '../src/converact-kamailio-compose-config.js';
import { renderKamailioConfig } from '../src/agent-runtime/converact/voice/kamailio-config.js';

const composePath = 'services/converact-service/docker-compose.voice.yml';

test('Compose builds a Cell-local Kamailio edge in front of two independently owned RustPBX nodes', () => {
  const compose = parse(readFileSync(composePath, 'utf8')) as any;
  const services = compose.services;

  for (const name of [
    'kamailio-compose-config-render',
    'kamailio-config-render',
    'kamailio-state-init',
    'kamailio',
    'kamailio-route-agent',
    'rustpbx',
    'rustpbx-b',
    'rustpbx-component-node',
    'rustpbx-b-component-node'
  ]) assert.ok(services[name], name);

  assert.match(services.kamailio.image, /IVEKIT_KAMAILIO_IMAGE.*immutable digest reference is required/);
  assert.deepEqual(services['kamailio-route-agent'].network_mode, 'service:kamailio');
  assert.equal(
    services['kamailio-route-agent'].environment.CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED,
    '${CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED:-false}'
  );
  assert.equal(
    services['kamailio-route-agent'].environment.CONVERACT_FABRIC_KAMAILIO_HOMER_METRICS_ENDPOINT,
    '${CONVERACT_FABRIC_KAMAILIO_HOMER_METRICS_ENDPOINT:-http://127.0.0.1:9090/metrics}'
  );
  assert.deepEqual(services['rustpbx-component-node'].network_mode, 'service:rustpbx');
  assert.deepEqual(services['rustpbx-b-component-node'].network_mode, 'service:rustpbx-b');
  assert.deepEqual(services['rustpbx-b'].profiles, ['voice-capacity', 'voice-t1']);
  assert.deepEqual(
    services['rustpbx-b-component-node'].profiles,
    ['voice-capacity', 'voice-t1']
  );
  assert.equal(services['kamailio-compose-config-render'].user, '0:0');
  assert.match(services['kamailio-compose-config-render'].command.join(' '), /chown 1000:1000/);
  assert.equal(services['kamailio-config-render'].user, '0:0');
  assert.match(services['kamailio-config-render'].command.join(' '), /chown 10001:10001/);
  assert.equal(services['kamailio-state-init'].user, '0:0');
  assert.match(services['kamailio-state-init'].command.join(' '), /chown -R 1000:10001/);
  assert.equal(services['kamailio-route-agent'].user, '1000:10001');
  assert.deepEqual(services.kamailio.command, [
    '-DD',
    '-E',
    '-x',
    '${KAMAILIO_SHM_ALLOCATOR:-fm}',
    '-m',
    '${KAMAILIO_SHM_MEMORY_MB:-512}',
    '-M',
    '${KAMAILIO_PKG_MEMORY_MB:-32}',
    '-f',
    '/etc/kamailio/kamailio.cfg'
  ]);

  const kamailioPorts = services.kamailio.ports.map(String).join('\n');
  assert.match(kamailioPorts, /SIP_PORT:-5060}.*SIP_PORT:-5060}\/udp/);
  assert.match(kamailioPorts, /SIP_PORT:-5060}.*SIP_PORT:-5060}\/tcp/);
  assert.match(kamailioPorts, /TLS_PORT:-5061}.*TLS_PORT:-5061}/);
  assert.match(kamailioPorts, /WSS_PORT:-7443}.*WSS_PORT:-7443}/);
  assert.match(kamailioPorts, /127\.0\.0\.1.*METRICS_PORT:-3220}:3220/);

  for (const name of ['rustpbx', 'rustpbx-b']) {
    const ports = (services[name].ports || []).map(String).join('\n');
    assert.doesNotMatch(ports, /:5060(?:\/|$)/, `${name} must not publish SIP`);
    assert.doesNotMatch(ports, /\/tcp/, `${name} must publish only its RTP UDP range`);
  }
  assert.match(
    services.rustpbx.ports.map(String).join('\n'),
    /RUSTPBX_RTP_START_PORT:-20000}-\$\{RUSTPBX_RTP_END_PORT:-20099}:\$\{RUSTPBX_RTP_START_PORT:-20000}-\$\{RUSTPBX_RTP_END_PORT:-20099}\/udp/,
    'RustPBX A must expose the same configurable RTP range that it listens on'
  );
  assert.notDeepEqual(services.rustpbx.ports, services['rustpbx-b'].ports);
  assert.notEqual(
    services.rustpbx.environment.IVEKIT_RUSTPBX_OWNER_NODE_ID,
    services['rustpbx-b'].environment.IVEKIT_RUSTPBX_OWNER_NODE_ID
  );

  for (const secret of [
    'kamailio-topoh-key',
    'kamailio-jsonrpc-token',
    'kamailio-route-key-current',
    'kamailio-webphone-jwt-secret',
    'kamailio-tls-key',
    'kamailio-tls-cert',
    'kamailio-tls-ca',
    'component-node-token'
  ]) assert.ok(compose.secrets[secret], secret);
});

test('Compose Kamailio runtime compiler emits aligned strict config and two-node topology', () => {
  const result = buildKamailioComposeRuntime({
    CONVERACT_FABRIC_KAMAILIO_REGION_ID: 'region-a',
    CONVERACT_FABRIC_KAMAILIO_ZONE_ID: 'zone-a',
    CONVERACT_FABRIC_KAMAILIO_CELL_ID: 'cell-a',
    CONVERACT_FABRIC_KAMAILIO_CELL_LEASE_EPOCH: '7',
    CONVERACT_FABRIC_KAMAILIO_PROFILE_ID: 'cell-10k-v1',
    CONVERACT_FABRIC_KAMAILIO_ADVERTISE_SIP_HOST: 'sip.example.test',
    CONVERACT_FABRIC_KAMAILIO_ADVERTISE_WSS_HOST: 'voice.example.test',
    CONVERACT_FABRIC_KAMAILIO_TRUSTED_SOURCE_CIDRS: '127.0.0.0/8,172.16.0.0/12',
    CONVERACT_FABRIC_KAMAILIO_RUSTPBX_SOURCE_CIDRS: '172.16.0.0/12',
    CONVERACT_FABRIC_KAMAILIO_DMQ_SOURCE_CIDRS: '172.16.0.0/12',
    CONVERACT_FABRIC_KAMAILIO_SIP_TRACE_ENABLED: 'true',
    CONVERACT_FABRIC_KAMAILIO_HEP_COLLECTOR_HOST: 'homer-capture',
    CONVERACT_FABRIC_KAMAILIO_HEP_CAPTURE_ID: '101',
    CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED: 'true',
    CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ALLOWED_ORIGINS: 'https://agent.example.test',
    CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER: 'ivekit',
    CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE: 'rustpbx-webphone',
    RUSTPBX_OWNER_NODE_ID: 'rustpbx-a',
    RUSTPBX_OWNER_NODE_ID_B: 'rustpbx-b'
  });

  assert.equal(result.config.cell_lease_epoch, 7);
  assert.equal(result.config.udp_listener.advertise?.host, 'sip.example.test');
  assert.equal(result.config.wss_listener.advertise?.host, 'voice.example.test');
  assert.equal(result.config.rpc_listener.host, '127.0.0.1');
  assert.deepEqual(result.config.rustpbx_source_cidrs, ['172.16.0.0/12']);
  assert.deepEqual(result.config.dmq_source_cidrs, ['172.16.0.0/12']);
  assert.deepEqual(result.config.webphone_auth.allowed_origins, ['https://agent.example.test']);
  assert.equal(
    result.config.webphone_auth.jwt_secret_file,
    '/run/secrets/kamailio-webphone-jwt-secret'
  );
  assert.equal(result.config.dmq.enabled, false);
  assert.deepEqual(result.config.sip_trace, {
    enabled: true,
    collector_host: 'homer-capture',
    collector_port: 9060,
    capture_id: 101,
    include_options: false,
    initial_mode: 'off'
  });
  assert.deepEqual(result.topology.pools[0]?.nodes.map((node) => ({
    id: node.node_id,
    component: node.component_endpoint,
    sip: node.sip_uri,
    pin: node.pin_set_id
  })), [
    {
      id: 'rustpbx-a',
      component: 'http://rustpbx:3210',
      sip: 'sip:rustpbx:5060;transport=udp',
      pin: 10_000
    },
    {
      id: 'rustpbx-b',
      component: 'http://rustpbx-b:3210',
      sip: 'sip:rustpbx-b:5060;transport=udp',
      pin: 10_001
    }
  ]);
  assert.doesNotThrow(() => renderKamailioConfig(result.config, {
    topoh_mask_key: 'topoh-mask-key-that-is-distinct-123456',
    rpc_bearer_token: 'rpc-bearer-token-that-is-distinct-123456',
    webphone_jwt_secret: 'webphone-jwt-secret-that-is-distinct-123456'
  }));
});

test('Compose Kamailio runtime compiler rejects incomplete HEP protection', () => {
  assert.throws(
    () => buildKamailioComposeRuntime(composeRuntimeEnv({
      CONVERACT_FABRIC_KAMAILIO_SIP_TRACE_ENABLED: 'true',
      CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED: 'false'
    })),
    /SIP trace and HEP high-water protection must be enabled together/i
  );
  assert.throws(
    () => buildKamailioComposeRuntime(composeRuntimeEnv({
      CONVERACT_FABRIC_KAMAILIO_SIP_TRACE_ENABLED: 'false',
      CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED: 'true'
    })),
    /SIP trace and HEP high-water protection must be enabled together/i
  );
});

test('standalone image packages the Compose runtime compiler and file-backed contracts', () => {
  const sourcePolicy = JSON.parse(readFileSync('services/converact-service/source-policy.json', 'utf8')) as {
    entrypoints: string[];
  };
  const servicePackage = JSON.parse(readFileSync('services/converact-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const env = readFileSync('services/converact-service/env.example', 'utf8');

  assert.ok(sourcePolicy.entrypoints.includes('src/converact-kamailio-compose-config.ts'));
  assert.equal(
    servicePackage.scripts['render:kamailio-compose'],
    'node dist/converact-kamailio-compose-config.js'
  );
  assert.match(env, /^IVEKIT_KAMAILIO_IMAGE=.*@sha256:[a-f0-9]{64}$/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_ADVERTISE_SIP_HOST=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_TRUSTED_SOURCE_CIDRS=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_RUSTPBX_SOURCE_CIDRS=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_DMQ_SOURCE_CIDRS=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_SIP_TRACE_ENABLED=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_HEP_COLLECTOR_HOST=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_HEP_METRICS_PORT=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_PROCESSING_GAP_OFF_PER_SECOND=/m);
  assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ALLOWED_ORIGINS=/m);
  assert.match(env, /^KAMAILIO_SHM_ALLOCATOR=fm$/m);
  assert.match(env, /^KAMAILIO_SHM_MEMORY_MB=512$/m);
  assert.match(env, /^KAMAILIO_PKG_MEMORY_MB=32$/m);
  assert.match(env, /^RUSTPBX_OWNER_NODE_ID_B=/m);
  assert.match(env, /^KAMAILIO_ROUTE_KEY_CURRENT_FILE=\.\/secrets\//m);
  assert.match(env, /^KAMAILIO_WEBPHONE_JWT_SECRET_FILE=\.\/secrets\//m);
});

function composeRuntimeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CONVERACT_FABRIC_KAMAILIO_REGION_ID: 'region-a',
    CONVERACT_FABRIC_KAMAILIO_ZONE_ID: 'zone-a',
    CONVERACT_FABRIC_KAMAILIO_CELL_ID: 'cell-a',
    CONVERACT_FABRIC_KAMAILIO_PROFILE_ID: 'cell-10k-v1',
    CONVERACT_FABRIC_KAMAILIO_ADVERTISE_SIP_HOST: 'sip.example.test',
    CONVERACT_FABRIC_KAMAILIO_TRUSTED_SOURCE_CIDRS: '127.0.0.0/8',
    CONVERACT_FABRIC_KAMAILIO_RUSTPBX_SOURCE_CIDRS: '172.16.0.0/12',
    CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ALLOWED_ORIGINS: 'https://agent.example.test',
    CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER: 'ivekit',
    CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE: 'rustpbx-webphone',
    RUSTPBX_OWNER_NODE_ID: 'rustpbx-a',
    RUSTPBX_OWNER_NODE_ID_B: 'rustpbx-b',
    ...overrides
  };
}
