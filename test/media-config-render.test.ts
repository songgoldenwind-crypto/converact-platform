import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  createMediaConfigRenderInputFromEnv,
  renderMediaConfigs
} from '../scripts/render-media-configs.js';

test('media config renderer writes LiveKit and Egress configs from production env', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-media-config-'));
  try {
    const input = createMediaConfigRenderInputFromEnv({
      OPC_MEDIA_CONFIG_DIR: outputDir,
      LIVEKIT_API_KEY: 'prod-livekit-key',
      LIVEKIT_API_SECRET: 'prod-livekit-secret',
      MINIO_ACCESS_KEY: 'prod-minio-key',
      MINIO_SECRET_KEY: 'prod-minio-secret',
      MINIO_BUCKET: 'prod-recordings',
      MINIO_ENDPOINT: 'http://minio:9000',
      OPC_MEDIA_CONFIG_RTC_TCP_PORT: '7881',
      OPC_MEDIA_CONFIG_RTC_UDP_PORT: '7882-7892',
      OPC_MEDIA_CONFIG_USE_EXTERNAL_IP: 'true'
    });

    const result = renderMediaConfigs(input);
    const livekit = readFileSync(result.livekitConfigPath, 'utf8');
    const egress = readFileSync(result.egressConfigPath, 'utf8');

    assert.match(livekit, /"prod-livekit-key": "prod-livekit-secret"/);
    assert.match(livekit, /api_key: "prod-livekit-key"/);
    assert.match(livekit, /http:\/\/opc:3000\/api\/media\/webhooks\/livekit/);
    assert.match(livekit, /tcp_port: 7881/);
    assert.match(livekit, /udp_port: 7882-7892/);
    assert.match(livekit, /use_external_ip: true/);
    assert.doesNotMatch(livekit, /port_range_start|port_range_end/);
    assert.doesNotMatch(livekit, /devkey|secret\n/);

    assert.match(egress, /api_key: "prod-livekit-key"/);
    assert.match(egress, /api_secret: "prod-livekit-secret"/);
    assert.match(egress, /redis:\n  address: "redis:6379"/);
    assert.match(egress, /storage:\n  s3:/);
    assert.doesNotMatch(egress, /^s3:/m);
    assert.match(egress, /access_key: "prod-minio-key"/);
    assert.match(egress, /secret: "prod-minio-secret"/);
    assert.match(egress, /bucket: "prod-recordings"/);
    assert.doesNotMatch(egress, /devkey|api_secret: secret|minioadmin/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('media config renderer requires production LiveKit and MinIO credentials', () => {
  assert.throws(
    () => createMediaConfigRenderInputFromEnv({}),
    /LIVEKIT_API_KEY is required/
  );
  assert.throws(
    () =>
      createMediaConfigRenderInputFromEnv({
        LIVEKIT_API_KEY: 'prod-livekit-key',
        LIVEKIT_API_SECRET: 'prod-livekit-secret',
        MINIO_ACCESS_KEY: 'prod-minio-key'
      }),
    /MINIO_SECRET_KEY is required/
  );
  assert.throws(
    () =>
      createMediaConfigRenderInputFromEnv({
        LIVEKIT_API_KEY: 'prod-livekit-key',
        LIVEKIT_API_SECRET: 'prod-livekit-secret',
        MINIO_ACCESS_KEY: 'prod-minio-key',
        MINIO_SECRET_KEY: 'prod-minio-secret',
        OPC_MEDIA_CONFIG_RTC_UDP_PORT: '70000'
      }),
    /OPC_MEDIA_CONFIG_RTC_UDP_PORT must be a port or ascending port range between 1 and 65535/
  );
});

test('media config renderer resolves the production compose default path inside the repo', () => {
  const input = createMediaConfigRenderInputFromEnv({
    OPC_MEDIA_CONFIG_DIR: '../.runtime/media',
    LIVEKIT_API_KEY: 'prod-livekit-key',
    LIVEKIT_API_SECRET: 'prod-livekit-secret',
    MINIO_ACCESS_KEY: 'prod-minio-key',
    MINIO_SECRET_KEY: 'prod-minio-secret'
  });

  assert.equal(input.outputDir, resolve('infra', '../.runtime/media'));
});

test('media config renderer npm script avoids the tsx ipc server', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };

  assert.equal(
    packageJson.scripts['render:media-configs'],
    'node --import tsx scripts/render-media-configs.ts'
  );
});
