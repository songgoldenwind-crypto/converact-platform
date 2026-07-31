import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
      OPC_MEDIA_CONFIG_USE_EXTERNAL_IP: 'true',
      OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_LOW_MS: '100',
      OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_MID_MS: '125',
      OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_HIGH_MS: '150'
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
    assert.match(
      livekit,
      /pli_throttle:\n    low_quality: 100ms\n    mid_quality: 125ms\n    high_quality: 150ms/
    );
    assert.doesNotMatch(livekit, /port_range_start|port_range_end/);
    assert.doesNotMatch(livekit, /devkey|secret\n/);

    assert.match(egress, /api_key: "prod-livekit-key"/);
    assert.match(egress, /api_secret: "prod-livekit-secret"/);
    assert.match(egress, /redis:\n  address: "redis:6379"/);
    assert.match(egress, /health_port: 8091/);
    assert.match(egress, /storage:\n  s3:/);
    assert.doesNotMatch(egress, /^s3:/m);
    assert.match(egress, /access_key: "prod-minio-key"/);
    assert.match(egress, /secret: "prod-minio-secret"/);
    assert.match(egress, /bucket: "prod-recordings"/);
    assert.doesNotMatch(egress, /devkey|api_secret: secret|minioadmin/);
    assert.equal(statSync(result.livekitConfigPath).mode & 0o777, 0o600);
    assert.equal(statSync(result.egressConfigPath).mode & 0o777, 0o640);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('media config renderer supports generic S3 addressing and workload identity', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-media-config-s3-'));
  try {
    const staticInput = createMediaConfigRenderInputFromEnv({
      OPC_MEDIA_CONFIG_DIR: outputDir,
      LIVEKIT_API_KEY: 'prod-livekit-key',
      LIVEKIT_API_SECRET: 'prod-livekit-secret',
      S3_ENDPOINT: 'https://s3.example.invalid',
      S3_BUCKET: 'generic-recordings',
      S3_REGION: 'eu-west-1',
      S3_FORCE_PATH_STYLE: 'false',
      S3_ACCESS_KEY_ID: 'generic-access-key',
      S3_SECRET_ACCESS_KEY: 'generic-secret-key'
    });
    const staticResult = renderMediaConfigs(staticInput);
    const staticEgress = readFileSync(staticResult.egressConfigPath, 'utf8');
    assert.match(staticEgress, /access_key: "generic-access-key"/);
    assert.match(staticEgress, /secret: "generic-secret-key"/);
    assert.match(staticEgress, /region: "eu-west-1"/);
    assert.match(staticEgress, /endpoint: "https:\/\/s3\.example\.invalid"/);
    assert.match(staticEgress, /bucket: "generic-recordings"/);
    assert.match(staticEgress, /force_path_style: false/);

    const identityInput = createMediaConfigRenderInputFromEnv({
      OPC_MEDIA_CONFIG_DIR: outputDir,
      LIVEKIT_API_KEY: 'prod-livekit-key',
      LIVEKIT_API_SECRET: 'prod-livekit-secret',
      S3_BUCKET: 'identity-recordings',
      S3_REGION: 'ap-southeast-1',
      S3_FORCE_PATH_STYLE: 'false'
    });
    const identityResult = renderMediaConfigs(identityInput);
    const identityEgress = readFileSync(identityResult.egressConfigPath, 'utf8');
    assert.match(identityEgress, /access_key: ""/);
    assert.match(identityEgress, /secret: ""/);
    assert.match(identityEgress, /region: "ap-southeast-1"/);
    assert.match(identityEgress, /endpoint: ""/);
    assert.match(identityEgress, /force_path_style: false/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('media config renderer validates the Egress health port', () => {
  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      LIVEKIT_API_KEY: 'prod-livekit-key',
      LIVEKIT_API_SECRET: 'prod-livekit-secret',
      MINIO_ACCESS_KEY: 'prod-minio-key',
      MINIO_SECRET_KEY: 'prod-minio-secret',
      OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT: '0'
    }),
    /OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT must be an integer between 1 and 65535/
  );
});

test('media config renderer bounds LiveKit PLI throttle durations', () => {
  const base = {
    LIVEKIT_API_KEY: 'prod-livekit-key',
    LIVEKIT_API_SECRET: 'prod-livekit-secret',
    MINIO_ACCESS_KEY: 'prod-minio-key',
    MINIO_SECRET_KEY: 'prod-minio-secret'
  };

  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      ...base,
      OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_LOW_MS: '49'
    }),
    /OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_LOW_MS must be an integer between 50 and 5000/
  );
  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      ...base,
      OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_HIGH_MS: '5001'
    }),
    /OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_HIGH_MS must be an integer between 50 and 5000/
  );
});

test('media config renderer writes one Sentinel and verified TLS contract for LiveKit and Egress', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-media-config-sentinel-'));
  const caFile = join(outputDir, 'source-ca.pem');
  const certFile = join(outputDir, 'source-client.pem');
  const keyFile = join(outputDir, 'source-client-key.pem');
  writeFileSync(caFile, 'test-ca');
  writeFileSync(certFile, 'test-client-cert');
  writeFileSync(keyFile, 'test-client-key');

  try {
    const input = createMediaConfigRenderInputFromEnv({
      OPC_MEDIA_CONFIG_DIR: outputDir,
      LIVEKIT_API_KEY: 'prod-livekit-key',
      LIVEKIT_API_SECRET: 'prod-livekit-secret',
      MINIO_ACCESS_KEY: 'prod-minio-key',
      MINIO_SECRET_KEY: 'prod-minio-secret',
      OPC_MEDIA_CONFIG_REDIS_TOPOLOGY: 'sentinel',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_MASTER_NAME: 'livekit',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_ADDRESSES:
        'sentinel-a.internal:26379,sentinel-b.internal:26379,sentinel-c.internal:26379',
      OPC_MEDIA_CONFIG_REDIS_USERNAME: 'livekit-data',
      OPC_MEDIA_CONFIG_REDIS_PASSWORD: 'data-secret',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_USERNAME: 'livekit-sentinel',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_PASSWORD: 'sentinel-secret',
      OPC_MEDIA_CONFIG_REDIS_TLS_MODE: 'required',
      OPC_MEDIA_CONFIG_REDIS_TLS_SERVER_NAME: 'valkey.internal',
      OPC_MEDIA_CONFIG_REDIS_TLS_CA_FILE: caFile,
      OPC_MEDIA_CONFIG_REDIS_TLS_CERT_FILE: certFile,
      OPC_MEDIA_CONFIG_REDIS_TLS_KEY_FILE: keyFile,
      OPC_MEDIA_CONFIG_REDIS_READ_TIMEOUT_MS: '250',
      OPC_MEDIA_CONFIG_REDIS_WRITE_TIMEOUT_MS: '300',
      OPC_MEDIA_CONFIG_REDIS_POOL_SIZE: '512'
    });

    const result = renderMediaConfigs(input);
    const livekit = readFileSync(result.livekitConfigPath, 'utf8');
    const egress = readFileSync(result.egressConfigPath, 'utf8');
    for (const config of [livekit, egress]) {
      assert.match(config, /sentinel_master_name: "livekit"/);
      assert.match(config, /sentinel_addresses:\n    - "sentinel-a\.internal:26379"/);
      assert.match(config, /sentinel_username: "livekit-sentinel"/);
      assert.match(config, /sentinel_password: "sentinel-secret"/);
      assert.match(config, /username: "livekit-data"/);
      assert.match(config, /password: "data-secret"/);
      assert.match(config, /read_timeout: 250/);
      assert.match(config, /write_timeout: 300/);
      assert.match(config, /pool_size: 512/);
      assert.match(config, /tls:\n    enabled: true\n    insecure: false/);
      assert.match(config, /server_name: "valkey\.internal"/);
      assert.match(config, /ca_cert_file: \/etc\/livekit-redis-tls\/ca\.crt/);
      assert.match(config, /client_cert_file: \/etc\/livekit-redis-tls\/client\.crt/);
      assert.match(config, /client_key_file: \/etc\/livekit-redis-tls\/client\.key/);
      assert.equal(config.includes(caFile), false);
    }
    assert.equal(readFileSync(join(result.redisTlsDir, 'ca.crt'), 'utf8'), 'test-ca');
    assert.equal(readFileSync(join(result.redisTlsDir, 'client.crt'), 'utf8'), 'test-client-cert');
    assert.equal(readFileSync(join(result.redisTlsDir, 'client.key'), 'utf8'), 'test-client-key');
    assert.equal(statSync(join(result.redisTlsDir, 'client.key')).mode & 0o777, 0o600);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('media config renderer rejects mixed Redis topology and incomplete ACL or TLS input', () => {
  const base = {
    LIVEKIT_API_KEY: 'prod-livekit-key',
    LIVEKIT_API_SECRET: 'prod-livekit-secret',
    MINIO_ACCESS_KEY: 'prod-minio-key',
    MINIO_SECRET_KEY: 'prod-minio-secret'
  };

  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      ...base,
      OPC_MEDIA_CONFIG_REDIS_TOPOLOGY: 'sentinel',
      OPC_MEDIA_CONFIG_REDIS_ADDRESS: 'redis.internal:6379',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_MASTER_NAME: 'livekit',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_ADDRESSES: 's1:26379,s2:26379,s3:26379'
    }),
    /OPC_MEDIA_CONFIG_REDIS_ADDRESS must be empty in sentinel topology/
  );
  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      ...base,
      OPC_MEDIA_CONFIG_REDIS_TOPOLOGY: 'sentinel',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_MASTER_NAME: 'livekit',
      OPC_MEDIA_CONFIG_REDIS_SENTINEL_ADDRESSES: 's1:26379,s2:26379'
    }),
    /exactly three unique host:port entries/
  );
  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      ...base,
      OPC_MEDIA_CONFIG_REDIS_USERNAME: 'livekit-data'
    }),
    /REDIS_USERNAME and REDIS_PASSWORD must be configured together/
  );
  assert.throws(
    () => createMediaConfigRenderInputFromEnv({
      ...base,
      OPC_MEDIA_CONFIG_REDIS_TLS_MODE: 'required',
      OPC_MEDIA_CONFIG_REDIS_TLS_CERT_FILE: '/tmp/client.crt'
    }),
    /Redis TLS certificate and key files must be configured together/
  );
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
    /MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be configured together/
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
