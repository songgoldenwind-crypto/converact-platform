import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  createLiveKitEdgeConfigRenderInputFromEnv,
  renderLiveKitEdgeConfigs
} from '../scripts/render-media-configs.js';

function edgeEnv(outputDir: string): NodeJS.ProcessEnv {
  return {
    OPC_LIVEKIT_EDGE_CONFIG_DIR: outputDir,
    LIVEKIT_SIGNAL_DOMAIN: 'livekit.example.com',
    LIVEKIT_TURN_DOMAIN: 'turn.example.com',
    IVEKIT_API_DOMAIN: 'opc.example.com',
    TINODE_PUBLIC_DOMAIN: 'tinode.example.com',
    IVEKIT_API_HTTP_PORT: '8300',
    TINODE_HTTP_PORT: '6060',
    LIVEKIT_ACME_EMAIL: 'ops@example.com',
    LIVEKIT_API_KEY: 'edge-livekit-key',
    LIVEKIT_API_SECRET: 'edge-livekit-secret',
    OPC_MEDIA_CONFIG_WEBHOOK_URL: 'https://opc.example.com/api/media/webhooks/livekit',
    OPC_MEDIA_CONFIG_REDIS_ADDRESS: '127.0.0.1:6379',
    OPC_MEDIA_CONFIG_LIVEKIT_URL: 'ws://127.0.0.1:7880',
    MINIO_ENDPOINT: 'http://127.0.0.1:9000',
    MINIO_BUCKET: 'recordings',
    MINIO_ACCESS_KEY: 'edge-minio-key',
    MINIO_SECRET_KEY: 'edge-minio-secret',
    OPC_MEDIA_CONFIG_RTC_TCP_PORT: '7881',
    OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_START: '50000',
    OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_END: '60000',
    OPC_LIVEKIT_EDGE_TURN_TLS_PORT: '5349',
    OPC_LIVEKIT_EDGE_TURN_UDP_PORT: '3478',
    OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT: '8091',
    OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_LOW_MS: '100',
    OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_MID_MS: '100',
    OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_HIGH_MS: '100',
    LIVEKIT_SERVER_IMAGE_TAG: 'v1.13.4-ivekit.1',
    LIVEKIT_EGRESS_IMAGE_TAG: 'v1.13.0',
    LIVEKIT_CADDYL4_IMAGE_TAG: 'v2.11.3',
    LIVEKIT_REDIS_IMAGE_TAG: '7.4.9'
  };
}

test('standalone LiveKit renderer writes signal, embedded TURN, Egress, and firewall configs', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-livekit-edge-'));
  try {
    const result = renderLiveKitEdgeConfigs(
      createLiveKitEdgeConfigRenderInputFromEnv(edgeEnv(outputDir))
    );
    const livekit = readFileSync(result.livekitConfigPath, 'utf8');
    const egress = readFileSync(result.egressConfigPath, 'utf8');
    const caddy = readFileSync(result.caddyConfigPath, 'utf8');
    const firewall = readFileSync(result.firewallChecklistPath, 'utf8');
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8')) as Record<string, unknown>;

    assert.match(livekit, /port_range_start: 50000/);
    assert.match(livekit, /port_range_end: 60000/);
    assert.match(livekit, /tcp_port: 7881/);
    assert.match(livekit, /turn:\n  enabled: true/);
    assert.match(livekit, /domain: "turn\.example\.com"/);
    assert.match(livekit, /external_tls: true/);
    assert.match(livekit, /tls_port: 5349/);
    assert.match(livekit, /udp_port: 3478/);
    assert.match(
      livekit,
      /pli_throttle:\n    low_quality: 100ms\n    mid_quality: 100ms\n    high_quality: 100ms/
    );
    assert.match(livekit, /https:\/\/opc\.example\.com\/api\/media\/webhooks\/livekit/);

    assert.match(egress, /ws_url: "ws:\/\/127\.0\.0\.1:7880"/);
    assert.match(egress, /redis:\n  address: "127\.0\.0\.1:6379"/);
    assert.match(egress, /health_port: 8091/);
    assert.match(egress, /storage:\n  s3:/);

    assert.match(caddy, /listen: \[":443"\]/);
    assert.match(caddy, /"turn\.example\.com"/);
    assert.match(caddy, /dial: \["localhost:5349"\]/);
    assert.match(caddy, /"livekit\.example\.com"/);
    assert.match(caddy, /dial: \["localhost:7880"\]/);
    assert.match(caddy, /"opc\.example\.com"/);
    assert.match(caddy, /dial: \["localhost:8300"\]/);
    assert.match(caddy, /"tinode\.example\.com"/);
    assert.match(caddy, /dial: \["localhost:6060"\]/);
    assert.match(caddy, /email: "ops@example\.com"/);

    for (const expected of ['80/tcp', '443/tcp', '7881/tcp', '3478/udp', '50000-60000/udp']) {
      assert.match(firewall, new RegExp(expected.replace('/', '\\/')));
    }
    for (const internalPort of ['5349/tcp', '7880/tcp', '8091/tcp']) {
      assert.match(firewall, new RegExp(`private.*${internalPort.replace('/', '\\/')}`, 'i'));
    }
    assert.equal(summary.signal_url, 'wss://livekit.example.com');
    assert.equal(summary.turn_domain, 'turn.example.com');
    assert.equal(summary.api_key_configured, true);
    assert.equal(summary.api_secret_configured, true);
    assert.deepEqual(summary.pli_throttle_ms, {
      low_quality: 100,
      mid_quality: 100,
      high_quality: 100
    });
    assert.equal(JSON.stringify(summary).includes('edge-livekit-secret'), false);

    assert.equal(statSync(result.livekitConfigPath).mode & 0o777, 0o600);
    assert.equal(statSync(result.egressConfigPath).mode & 0o777, 0o640);
    assert.equal(caddy.includes('edge-livekit-secret'), false);
    assert.equal(firewall.includes('edge-livekit-secret'), false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('standalone LiveKit renderer rejects invalid edge topology', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-livekit-edge-invalid-'));
  try {
    assert.throws(
      () => createLiveKitEdgeConfigRenderInputFromEnv({
        ...edgeEnv(outputDir),
        LIVEKIT_TURN_DOMAIN: 'livekit.example.com'
      }),
      /LIVEKIT_TURN_DOMAIN must differ from LIVEKIT_SIGNAL_DOMAIN/
    );
    assert.throws(
      () => createLiveKitEdgeConfigRenderInputFromEnv({
        ...edgeEnv(outputDir),
        OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_START: '60000',
        OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_END: '50000'
      }),
      /RTC port range end must be greater than or equal to start/
    );
    assert.throws(
      () => createLiveKitEdgeConfigRenderInputFromEnv({
        ...edgeEnv(outputDir),
        LIVEKIT_API_SECRET: 'replace_with_livekit_api_secret'
      }),
      /LIVEKIT_API_SECRET must replace the example placeholder/
    );
    assert.throws(
      () => createLiveKitEdgeConfigRenderInputFromEnv({
        ...edgeEnv(outputDir),
        LIVEKIT_API_KEY: 'devkey'
      }),
      /LIVEKIT_API_KEY must replace the example placeholder/
    );
    assert.throws(
      () => createLiveKitEdgeConfigRenderInputFromEnv({
        ...edgeEnv(outputDir),
        LIVEKIT_REDIS_IMAGE_TAG: 'latest'
      }),
      /LIVEKIT_REDIS_IMAGE_TAG must be an exact semantic version tag/
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('standalone LiveKit renderer resolves the Compose-relative runtime directory inside the repo', () => {
  const input = createLiveKitEdgeConfigRenderInputFromEnv({
    ...edgeEnv('../../.runtime/livekit-edge'),
    OPC_LIVEKIT_EDGE_CONFIG_DIR: '../../.runtime/livekit-edge'
  });

  assert.equal(input.outputDir, resolve('infra/livekit', '../../.runtime/livekit-edge'));
});

test('standalone LiveKit Compose is Linux host-networked and reproducibly pinned', () => {
  const compose = readFileSync(new URL('../infra/livekit/docker-compose.yml', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../infra/livekit/env.example', import.meta.url), 'utf8');
  const redis = readFileSync(new URL('../infra/livekit/config/redis.conf', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };

  for (const service of ['caddy', 'livekit', 'redis', 'egress']) {
    const block = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|\\Z)`, 'm'))?.[0] || '';
    assert.match(block, /network_mode: "host"/, `${service} must use host networking`);
  }
  assert.match(compose, /image: \$\{LIVEKIT_CADDYL4_IMAGE:\?LIVEKIT_CADDYL4_IMAGE immutable digest reference is required\}/);
  assert.match(compose, /image: \$\{LIVEKIT_SERVER_IMAGE:\?LIVEKIT_SERVER_IMAGE immutable digest reference is required\}/);
  assert.match(compose, /image: \$\{LIVEKIT_REDIS_IMAGE:\?LIVEKIT_REDIS_IMAGE immutable digest reference is required\}/);
  assert.match(compose, /image: \$\{LIVEKIT_EGRESS_IMAGE:\?LIVEKIT_EGRESS_IMAGE immutable digest reference is required\}/);
  assert.doesNotMatch(compose, /:latest/);
  assert.match(compose, /SYS_ADMIN/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:8091/);
  assert.match(redis, /^bind 127\.0\.0\.1 ::1$/m);
  assert.match(redis, /^protected-mode yes$/m);
  assert.match(envExample, /^LIVEKIT_SERVER_IMAGE_TAG=v1\.13\.4-ivekit\.1$/m);
  assert.match(envExample, /^LIVEKIT_EGRESS_IMAGE_TAG=v1\.13\.0$/m);
  assert.match(envExample, /^LIVEKIT_CADDYL4_IMAGE_TAG=v2\.11\.3$/m);
  assert.match(envExample, /^LIVEKIT_SERVER_IMAGE=ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-livekit-server@sha256:[a-f0-9]{64}$/m);
  assert.match(envExample, /^LIVEKIT_EGRESS_IMAGE=livekit\/egress:v1\.13\.0@sha256:[a-f0-9]{64}$/m);
  assert.match(envExample, /^LIVEKIT_CADDYL4_IMAGE=livekit\/caddyl4:v2\.11\.3@sha256:[a-f0-9]{64}$/m);
  assert.match(envExample, /^LIVEKIT_REDIS_IMAGE=redis:7\.4\.9@sha256:[a-f0-9]{64}$/m);
  assert.match(envExample, /^OPC_LIVEKIT_DEPLOYMENT_MODE=standalone-vm$/m);
  assert.match(envExample, /^OPC_MEDIA_CONFIG_REDIS_TOPOLOGY=direct$/m);
  assert.match(envExample, /^OPC_MEDIA_CONFIG_REDIS_SENTINEL_MASTER_NAME=$/m);
  assert.match(envExample, /^OPC_MEDIA_CONFIG_REDIS_SENTINEL_ADDRESSES=$/m);
  assert.match(envExample, /^OPC_MEDIA_CONFIG_REDIS_TLS_MODE=disabled$/m);
  assert.match(compose, /redis-tls:\/etc\/livekit-redis-tls:ro/);
  assert.match(envExample, /^LIVEKIT_URL=ws:\/\/127\.0\.0\.1:7880$/m);
  assert.match(envExample, /^LIVEKIT_PUBLIC_URL=wss:\/\/livekit\.example\.com$/m);
  assert.doesNotMatch(envExample, /=latest$/m);
  assert.equal(
    packageJson.scripts['render:livekit-edge'],
    'node --import tsx scripts/render-media-configs.ts --edge'
  );
  assert.equal(
    packageJson.scripts['livekit:edge:config'],
    'docker compose --env-file infra/livekit/env.example -f infra/livekit/docker-compose.yml config'
  );
});

test('LiveKit media plane never depends on Egress or object storage availability', () => {
  const compose = readFileSync(new URL('../infra/livekit/docker-compose.yml', import.meta.url), 'utf8');
  const storage = readFileSync(new URL('../infra/livekit/docker-compose.storage.yml', import.meta.url), 'utf8');
  const livekit = compose.match(/^  livekit:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:|\Z)/m)?.[0] || '';
  const egress = compose.match(/^  egress:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:|\Z)/m)?.[0] || '';

  assert.doesNotMatch(livekit, /egress|minio|object.?stor|s3/i);
  assert.match(livekit, /depends_on:\s*\n\s+redis:/);
  assert.match(egress, /depends_on:[\s\S]*livekit:/);
  assert.match(storage, /^  egress:\n\s+depends_on:\n\s+minio-init:/m);
  assert.doesNotMatch(storage, /^  livekit:/m);
});

test('standalone iveKit application stack runs the iveKit-only process', () => {
  const compose = readFileSync(new URL('../infra/ivekit/docker-compose.yml', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../infra/ivekit/README.md', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../infra/ivekit/env.example', import.meta.url), 'utf8');
  const opcService = compose.match(/^  opc:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|(?![\s\S]))/m)?.[0] || '';

  assert.match(opcService, /command:\s*\["npm",\s*"run",\s*"start:ivekit"\]/);
  assert.match(opcService, /aliases:\s*\n\s*- ivekit-api/);
  assert.doesNotMatch(opcService, /OPC_DISABLE_DIALER/);
  assert.match(opcService, /OPC_IVEKIT_ALLOWED_ORIGINS: \$\{OPC_IVEKIT_ALLOWED_ORIGINS:\?[^}]+\}/);
  assert.match(opcService, /OPC_IVEKIT_HTTP_BODY_MAX_BYTES: \$\{OPC_IVEKIT_HTTP_BODY_MAX_BYTES:-1048576\}/);
  assert.match(opcService, /OPC_SIP_VOLTE_ENABLED: \$\{OPC_SIP_VOLTE_ENABLED:-0\}/);
  assert.match(opcService, /LIVEKIT_SIP_BRIDGE_TARGET: \$\{LIVEKIT_SIP_BRIDGE_TARGET:-\}/);
  assert.match(opcService, /RUSTPBX_LIVEKIT_TRUNK: \$\{RUSTPBX_LIVEKIT_TRUNK:-\}/);
  assert.match(opcService, /RUSTPBX_RWI_URL: \$\{RUSTPBX_RWI_URL:-\}/);
  assert.match(compose, /^  opc:$/m, 'legacy service key must remain stable');
  assert.match(envExample, /standalone iveKit application image/i);
  assert.match(envExample, /^OPC_IVEKIT_ALLOWED_ORIGINS=https:\/\/led\.example\.com$/m);
  assert.match(envExample, /^OPC_SIP_VOLTE_ENABLED=0$/m);
  assert.match(envExample, /^LIVEKIT_SIP_BRIDGE_TARGET=$/m);
  assert.match(envExample, /^RUSTPBX_LIVEKIT_TRUNK=$/m);
  assert.match(envExample, /^RUSTPBX_RWI_URL=$/m);
  assert.match(readme, /@opc\/ivekit-sdk/);
  assert.match(readme, /public base URL/i);
  assert.match(readme, /No PostgreSQL downgrade or data copy is required/i);
  assert.match(readme, /command.*\["npm", "start"\]/is);
});

test('standalone MinIO bootstrap rejects reused root and service credentials', () => {
  const bootstrap = readFileSync(new URL('../infra/scripts/bootstrap-minio-bucket.sh', import.meta.url), 'utf8');

  assert.match(bootstrap, /root and service access keys must differ/);
  assert.match(bootstrap, /root and service secret keys must differ/);
});
