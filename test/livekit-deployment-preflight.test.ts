import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createLiveKitDeploymentPreflightReport,
  renderLiveKitDeploymentEnvChecklist,
  writeLiveKitDeploymentEnvChecklist,
  writeLiveKitDeploymentPreflightReport
} from '../scripts/livekit-deployment-preflight.js';

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    LIVEKIT_URL: 'wss://livekit.example.com',
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
    LIVEKIT_API_KEY: 'livekit-key',
    LIVEKIT_API_SECRET: 'livekit-secret',
    CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'external',
    LIVEKIT_SERVER_IMAGE_TAG: 'v1.13.4-ivekit.1',
    LIVEKIT_EGRESS_IMAGE_TAG: 'v1.12.0',
    LIVEKIT_SIP_IMAGE_TAG: 'v1.1.0',
    LIVEKIT_SERVER_IMAGE: `ghcr.io/songgoldenwind-crypto/opc-ivekit-livekit-server@sha256:${'1'.repeat(64)}`,
    LIVEKIT_EGRESS_IMAGE: `livekit/egress:v1.12.0@sha256:${'2'.repeat(64)}`,
    LIVEKIT_SIP_IMAGE: `ghcr.io/songgoldenwind-crypto/opc-livekit-sip@sha256:${'5'.repeat(64)}`,
    LIVEKIT_CADDYL4_IMAGE: `livekit/caddyl4:v2.11.3@sha256:${'3'.repeat(64)}`,
    LIVEKIT_REDIS_IMAGE: `redis:7.4.9@sha256:${'4'.repeat(64)}`,
    CONVERACT_MEDIA_CONFIG_REDIS_ADDRESS: 'redis://livekit-redis.internal:6379',
    CONVERACT_LIVEKIT_EDGE_TURN_TLS_PORT: '5349',
    CONVERACT_LIVEKIT_EDGE_TURN_UDP_PORT: '3478',
    CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_START: '50000',
    CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_END: '60000',
    CONVERACT_MEDIA_EGRESS_ENABLED: '1',
    CONVERACT_MEDIA_CONFIG_WEBHOOK_URL: 'https://opc.example.com/api/media/webhooks/livekit',
    CONVERACT_LIVEKIT_TIME_SYNC_STATUS: 'synchronized',
    CONVERACT_LIVEKIT_TIME_SYNC_OFFSET_MS: '12',
    CONVERACT_LIVEKIT_TIME_SYNC_MAX_SKEW_MS: '5000',
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_MEDIA_API_TOKEN: 'media-secret',
    CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
    CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant_livekit',
    CONVERACT_MEDIA_RECORDING_RETENTION_DAYS: '90',
    CONVERACT_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT: '1',
    CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS: '60000',
    CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS: '2000',
    MINIO_ACCESS_KEY: 'minio-access-secret',
    MINIO_SECRET_KEY: 'minio-secret-secret',
    MINIO_ENDPOINT: 'https://storage.example.com',
    MINIO_BUCKET: 'recordings',
    CONVERACT_VIDEO_READINESS_TARGETS: 'media,sip-volte',
    CONVERACT_SIP_VOLTE_ENABLED: '1',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
    RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
    RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: 'rwi-secret-token',
    ...overrides
  };
}

test('LiveKit deployment preflight reports missing required media deployment env', () => {
  const report = createLiveKitDeploymentPreflightReport({});

  assert.equal(report.ok, false);
  assert.equal(report.summary.livekitInternalUrlConfigured, false);
  assert.equal(report.summary.livekitPublicUrlConfigured, false);
  assert.equal(report.summary.mediaTokenConfigured, false);
  assert.equal(report.summary.inviteSecretConfigured, false);
  assert.equal(report.summary.egressConfigured, false);
  assert.deepEqual(
    report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    [
      'livekit_internal_url',
      'livekit_public_url',
      'livekit_api_key',
      'livekit_api_secret',
      'opc_base_url',
      'media_api_token',
      'media_invite_secret',
      'media_smoke_tenant',
      'minio_access_key',
      'minio_secret_key',
      'agent_browser_frontend_url',
      'agent_browser_agent_a_token',
      'agent_browser_agent_a_user_id',
      'agent_browser_agent_a_seat_id',
      'agent_browser_agent_b_token',
      'agent_browser_agent_b_user_id',
      'agent_browser_agent_b_seat_id',
      'customer_browser_frontend_url',
      'customer_browser_url_or_room',
      'customer_browser_tenant',
      'sip_volte_gateway_enabled',
      'sip_bridge_target',
      'rustpbx_livekit_trunk',
      'rustpbx_rwi_url',
      'rustpbx_rwi_token'
    ]
  );
});

test('LiveKit deployment preflight rejects a configured but disabled SIP gateway', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_SIP_VOLTE_ENABLED: '0'
  }));

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'sip_volte_gateway_enabled')?.status, 'fail');
});

test('LiveKit deployment preflight passes a configured media and SIP deployment', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv());

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary.targets, ['media', 'sip-volte']);
  assert.equal(report.summary.livekitInternalUrlConfigured, true);
  assert.equal(report.summary.livekitPublicUrlConfigured, true);
  assert.equal(report.summary.deploymentMode, 'external');
  assert.equal(report.summary.opcBaseUrlConfigured, true);
  assert.equal(report.summary.frontendUrlConfigured, false);
  assert.equal(report.summary.mediaTokenConfigured, true);
  assert.equal(report.summary.inviteSecretConfigured, true);
  assert.equal(report.summary.tenantConfigured, true);
  assert.equal(report.summary.egressConfigured, true);
  assert.equal(report.summary.redisConfigured, true);
  assert.equal(report.summary.turnConfigured, true);
  assert.equal(report.summary.webhookConfigured, true);
  assert.equal(report.summary.timeSynchronized, true);
  assert.equal(report.checks.find((check) => check.id === 'media_recording_retention_days')?.status, 'pass');
  assert.equal(report.checks.find((check) => check.id === 'media_recording_http_timeout')?.status, 'pass');
  assert.equal(report.checks.find((check) => check.id === 'media_recording_object_timeout')?.status, 'pass');
  assert.equal(report.checks.every((check) => check.status !== 'fail'), true);

  const serialized = JSON.stringify(report);
  for (const secret of [
    'livekit-secret',
    'media-secret',
    'invite-secret',
    'minio-access-secret',
    'minio-secret-secret',
    'rwi-secret-token',
    'wss://livekit.example.com',
    'https://opc.example.com',
    'https://storage.example.com',
    'sip:livekit-bridge@livekit-sip:5061',
    'livekit-bridge',
    'ws://rustpbx:8080/rwi/v1'
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('LiveKit deployment preflight reuses runtime SIP configuration validation', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    LIVEKIT_URL: 'wss://operator:password@livekit.example.com?credential=forbidden',
    LIVEKIT_API_KEY: 'livekit-key\ninjected',
    LIVEKIT_API_SECRET: 'livekit-secret\tinjected',
    LIVEKIT_SIP_BRIDGE_TARGET: 'sip:bridge@livekit-sip:5061?credential=forbidden',
    RUSTPBX_LIVEKIT_TRUNK: 'invalid trunk',
    RUSTPBX_RWI_URL: 'ws://operator:password@rustpbx:8080/rwi/v1',
    RUSTPBX_RWI_TOKEN: '  '
  }));

  assert.equal(report.ok, false);
  for (const id of [
    'livekit_internal_url',
    'livekit_api_key',
    'livekit_api_secret',
    'sip_bridge_target',
    'rustpbx_livekit_trunk',
    'rustpbx_rwi_url',
    'rustpbx_rwi_token'
  ]) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, 'fail', id);
  }
});

test('LiveKit deployment env checklist groups required variables and masks secrets', () => {
  const checklist = renderLiveKitDeploymentEnvChecklist(configuredEnv({
    CONVERACT_FRONTEND_URL: 'https://frontend.example.com',
    CONVERACT_BROWSER_SMOKE_AGENT_A_TOKEN: 'agent-a-secret'
  }));

  for (const heading of [
    '## LiveKit Server',
    '## Media API',
    '## Egress / Storage',
    '## Readiness Suite',
    '## Browser Smoke',
    '## Web Assist',
    '## SIP / VoLTE'
  ]) {
    assert.match(checklist, new RegExp(heading.replace('/', '\\/')));
  }
  assert.match(checklist, /\| LIVEKIT_API_SECRET \| required \| `configured` \|/);
  assert.match(checklist, /\| LIVEKIT_PUBLIC_URL \| optional \| `wss:\/\/livekit\.example\.com` \|/);
  assert.match(checklist, /\| CONVERACT_LIVEKIT_DEPLOYMENT_MODE \| required \| `external` \|/);
  assert.match(checklist, /\| CONVERACT_MEDIA_API_TOKEN \| required \| `configured` \|/);
  assert.match(checklist, /\| MINIO_SECRET_KEY \| required \| `configured` \|/);
  assert.match(checklist, /\| MINIO_BUCKET \| required \| `recordings` \|/);
  assert.match(checklist, /\| CONVERACT_MEDIA_CONFIG_REDIS_ADDRESS \| required \| `configured` \|/);
  assert.match(checklist, /\| CONVERACT_MEDIA_CONFIG_WEBHOOK_URL \| required \| `https:\/\/opc\.example\.com\/api\/media\/webhooks\/livekit` \|/);
  assert.match(checklist, /\| CONVERACT_LIVEKIT_TIME_SYNC_OFFSET_MS \| required \| `12` \|/);
  assert.match(checklist, /\| CONVERACT_MEDIA_RECORDING_RETENTION_DAYS \| optional \| `90` \|/);
  assert.match(checklist, /\| CONVERACT_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT \| optional \| `1` \|/);
  assert.match(checklist, /\| CONVERACT_SIP_VOLTE_ENABLED \| required \| `1` \|/);
  assert.equal(checklist.includes('agent-a-secret'), false);
});

test('LiveKit deployment preflight requires a public WSS URL for browser targets', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    LIVEKIT_PUBLIC_URL: '',
    CONVERACT_VIDEO_READINESS_TARGETS: 'agent-browser',
    CONVERACT_FRONTEND_URL: 'https://frontend.example.com',
    CONVERACT_BROWSER_SMOKE_AGENT_A_TOKEN: 'agent-a-token',
    CONVERACT_BROWSER_SMOKE_AGENT_A_USER_ID: 'agent-a',
    CONVERACT_BROWSER_SMOKE_AGENT_A_SEAT_ID: 'seat-a',
    CONVERACT_BROWSER_SMOKE_AGENT_B_TOKEN: 'agent-b-token',
    CONVERACT_BROWSER_SMOKE_AGENT_B_USER_ID: 'agent-b',
    CONVERACT_BROWSER_SMOKE_AGENT_B_SEAT_ID: 'seat-b'
  }));

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'livekit_public_url')?.status, 'fail');

  const insecure = createLiveKitDeploymentPreflightReport(configuredEnv({
    LIVEKIT_PUBLIC_URL: 'ws://livekit.example.com',
    CONVERACT_VIDEO_READINESS_TARGETS: 'media'
  }));
  assert.equal(insecure.ok, false);
  assert.equal(insecure.checks.find((check) => check.id === 'livekit_public_wss')?.status, 'fail');
});

test('LiveKit deployment preflight keeps public URL optional for server-only targets', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    LIVEKIT_PUBLIC_URL: '',
    CONVERACT_VIDEO_READINESS_TARGETS: 'media'
  }));

  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === 'livekit_public_url')?.status, 'warn');
  assert.equal(report.checks.find((check) => check.id === 'livekit_public_wss')?.status, 'warn');
});

test('LiveKit standalone VM preflight requires edge domains and immutable images', () => {
  const missing = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
    LIVEKIT_SIGNAL_DOMAIN: '',
    LIVEKIT_TURN_DOMAIN: '',
    LIVEKIT_ACME_EMAIL: '',
    LIVEKIT_SERVER_IMAGE_TAG: 'latest',
    LIVEKIT_SERVER_IMAGE: '',
    LIVEKIT_EGRESS_IMAGE: 'livekit/egress:latest',
    LIVEKIT_SIP_IMAGE: 'livekit/sip:v1.7.0',
    LIVEKIT_CADDYL4_IMAGE: `livekit/caddyl4:v2.11.3@sha256:${'3'.repeat(63)}`,
    LIVEKIT_REDIS_IMAGE: 'redis@sha512:forbidden'
  }));

  assert.equal(missing.ok, false);
  for (const id of [
    'livekit_signal_domain',
    'livekit_turn_domain',
    'livekit_acme_email',
    'livekit_server_image_tag',
    'livekit_server_image',
    'livekit_egress_image',
    'livekit_sip_image',
    'livekit_caddyl4_image',
    'livekit_redis_image'
  ]) {
    assert.equal(missing.checks.find((check) => check.id === id)?.status, 'fail');
  }

  const configured = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
    LIVEKIT_SIGNAL_DOMAIN: 'livekit.example.com',
    LIVEKIT_TURN_DOMAIN: 'turn.example.com',
    LIVEKIT_ACME_EMAIL: 'ops@example.com'
  }));
  assert.equal(configured.ok, true);

  const upstreamServer = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
    LIVEKIT_SIGNAL_DOMAIN: 'livekit.example.com',
    LIVEKIT_TURN_DOMAIN: 'turn.example.com',
    LIVEKIT_ACME_EMAIL: 'ops@example.com',
    LIVEKIT_SERVER_IMAGE: `livekit/livekit-server:v1.13.4@sha256:${'1'.repeat(64)}`
  }));
  assert.equal(upstreamServer.ok, false);
  assert.equal(upstreamServer.checks.find((check) => check.id === 'livekit_server_image')?.status, 'fail');
});

test('LiveKit deployment preflight rejects placeholders and invalid standalone identity values', () => {
  const placeholders = createLiveKitDeploymentPreflightReport(configuredEnv({
    LIVEKIT_API_KEY: 'your_key',
    MINIO_SECRET_KEY: 'change_me_in_production',
    CONVERACT_VIDEO_READINESS_TARGETS: 'media'
  }));
  assert.equal(placeholders.ok, false);
  assert.equal(placeholders.checks.find((check) => check.id === 'livekit_api_key')?.status, 'fail');
  assert.equal(placeholders.checks.find((check) => check.id === 'minio_secret_key')?.status, 'fail');

  const invalidEdge = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
    LIVEKIT_SIGNAL_DOMAIN: 'not-a-domain',
    LIVEKIT_TURN_DOMAIN: 'not-a-domain',
    LIVEKIT_ACME_EMAIL: 'not-an-email'
  }));
  assert.equal(invalidEdge.ok, false);
  assert.equal(invalidEdge.checks.find((check) => check.id === 'livekit_signal_domain')?.status, 'fail');
  assert.equal(invalidEdge.checks.find((check) => check.id === 'livekit_turn_domain')?.status, 'fail');
  assert.equal(invalidEdge.checks.find((check) => check.id === 'livekit_acme_email')?.status, 'fail');
});

test('LiveKit deployment preflight rejects invalid recording retention and object polling values', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_MEDIA_RECORDING_RETENTION_DAYS: '0',
    CONVERACT_RECORDING_HTTP_TIMEOUT_MS: '0',
    CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS: 'not-a-number'
  }));

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'media_recording_retention_days')?.status, 'fail');
  assert.equal(report.checks.find((check) => check.id === 'media_recording_http_timeout')?.status, 'fail');
  assert.equal(report.checks.find((check) => check.id === 'media_recording_object_timeout')?.status, 'fail');
});

test('LiveKit production preflight rejects incomplete TURN, Redis, Egress, webhook, and clock evidence', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_MEDIA_CONFIG_REDIS_ADDRESS: 'redis-without-port',
    CONVERACT_LIVEKIT_EDGE_TURN_TLS_PORT: '70000',
    CONVERACT_LIVEKIT_EDGE_TURN_UDP_PORT: '0',
    CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_START: '60000',
    CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_END: '50000',
    CONVERACT_MEDIA_EGRESS_ENABLED: '0',
    MINIO_ENDPOINT: 'file:///recordings',
    MINIO_BUCKET: '../recordings',
    CONVERACT_MEDIA_CONFIG_WEBHOOK_URL: 'http://opc.example.com/api/media/webhooks/livekit',
    CONVERACT_LIVEKIT_TIME_SYNC_STATUS: 'unsynchronized',
    CONVERACT_LIVEKIT_TIME_SYNC_OFFSET_MS: '6000'
  }));

  assert.equal(report.ok, false);
  for (const id of [
    'livekit_redis_address',
    'livekit_turn_tls_port',
    'livekit_turn_udp_port',
    'livekit_rtc_udp_port_range',
    'livekit_egress_enabled',
    'minio_endpoint',
    'minio_bucket',
    'livekit_webhook_url',
    'livekit_time_sync_status',
    'livekit_time_sync_offset'
  ]) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, 'fail', id);
  }
});

test('LiveKit production preflight never serializes Redis credentials', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    CONVERACT_MEDIA_CONFIG_REDIS_ADDRESS: 'redis://livekit:redis-password@redis.internal:6379'
  }));

  assert.equal(report.ok, true);
  assert.equal(JSON.stringify(report).includes('redis-password'), false);
});

test('LiveKit deployment preflight writes checklist and report artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-preflight-'));
  const checklistPath = join(dir, 'livekit-env-checklist.md');
  const reportPath = join(dir, 'livekit-preflight.json');
  const env = configuredEnv();

  const checklistWrite = writeLiveKitDeploymentEnvChecklist(checklistPath, env);
  const report = createLiveKitDeploymentPreflightReport(env);
  const reportWrite = writeLiveKitDeploymentPreflightReport(reportPath, env, report);

  assert.equal(checklistWrite.outputFile, checklistPath);
  assert.equal(checklistWrite.missing.length, 0);
  assert.equal(reportWrite.outputFile, reportPath);
  assert.equal(reportWrite.ok, true);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).ok, true);
  assert.match(readFileSync(checklistPath, 'utf8'), /# LiveKit Deployment Env Checklist/);
});

test('LiveKit deployment preflight CLI writes requested artifacts without leaking secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-preflight-cli-'));
  const checklistPath = join(dir, 'livekit-env-checklist.md');
  const reportPath = join(dir, 'livekit-preflight.json');
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/livekit-deployment-preflight.ts'],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        ...configuredEnv({
          CONVERACT_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE: checklistPath,
          CONVERACT_LIVEKIT_PREFLIGHT_REPORT_FILE: reportPath
        })
      },
      encoding: 'utf8'
    }
  );

  assert.equal(JSON.parse(stdout).ok, true);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).ok, true);
  assert.match(readFileSync(checklistPath, 'utf8'), /CONVERACT_VIDEO_READINESS_TARGETS/);
  for (const value of ['livekit-secret', 'media-secret', 'invite-secret', 'rwi-secret-token']) {
    assert.equal(stdout.includes(value), false);
    assert.equal(readFileSync(checklistPath, 'utf8').includes(value), false);
  }
});

test('LiveKit deployment preflight is exposed through scripts and env examples', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['livekit:deployment-preflight'], 'tsx scripts/livekit-deployment-preflight.ts');

  const rootEnvExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'LIVEKIT_PUBLIC_URL=',
    'CONVERACT_LIVEKIT_DEPLOYMENT_MODE=',
    'LIVEKIT_SERVER_IMAGE_TAG=',
    'LIVEKIT_EGRESS_IMAGE_TAG=',
    'LIVEKIT_SIP_IMAGE_TAG=',
    'LIVEKIT_SIP_IMAGE=',
    'CONVERACT_MEDIA_CONFIG_REDIS_ADDRESS=',
    'CONVERACT_LIVEKIT_EDGE_TURN_TLS_PORT=',
    'CONVERACT_LIVEKIT_EDGE_TURN_UDP_PORT=',
    'CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_START=',
    'CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_END=',
    'CONVERACT_MEDIA_EGRESS_ENABLED=',
    'CONVERACT_MEDIA_CONFIG_WEBHOOK_URL=',
    'CONVERACT_LIVEKIT_TIME_SYNC_STATUS=',
    'CONVERACT_LIVEKIT_TIME_SYNC_OFFSET_MS=',
    'CONVERACT_LIVEKIT_TIME_SYNC_MAX_SKEW_MS=',
    'CONVERACT_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE=',
    'CONVERACT_LIVEKIT_PREFLIGHT_REPORT_FILE='
  ]) {
    assert.match(rootEnvExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});
