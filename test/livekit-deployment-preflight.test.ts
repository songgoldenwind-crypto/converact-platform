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
    LIVEKIT_URL: 'wss://livekit.example.com',
    LIVEKIT_API_KEY: 'livekit-key',
    LIVEKIT_API_SECRET: 'livekit-secret',
    OPC_BASE_URL: 'https://opc.example.com',
    OPC_MEDIA_API_TOKEN: 'media-secret',
    OPC_MEDIA_INVITE_SECRET: 'invite-secret',
    OPC_MEDIA_SMOKE_TENANT_ID: 'tenant_livekit',
    OPC_MEDIA_RECORDING_RETENTION_DAYS: '90',
    OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT: '1',
    OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS: '60000',
    OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS: '2000',
    MINIO_ACCESS_KEY: 'minio-access-secret',
    MINIO_SECRET_KEY: 'minio-secret-secret',
    OPC_VIDEO_READINESS_TARGETS: 'media,sip-volte',
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
  assert.equal(report.summary.livekitUrl, '');
  assert.equal(report.summary.mediaTokenConfigured, false);
  assert.equal(report.summary.inviteSecretConfigured, false);
  assert.equal(report.summary.egressConfigured, false);
  assert.deepEqual(
    report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    [
      'livekit_url',
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
      'sip_bridge_target',
      'rustpbx_livekit_trunk',
      'rustpbx_rwi_url',
      'rustpbx_rwi_token'
    ]
  );
});

test('LiveKit deployment preflight passes a configured media and SIP deployment', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv());

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary.targets, ['media', 'sip-volte']);
  assert.equal(report.summary.livekitUrl, 'wss://livekit.example.com');
  assert.equal(report.summary.opcBaseUrl, 'https://opc.example.com');
  assert.equal(report.summary.mediaTokenConfigured, true);
  assert.equal(report.summary.inviteSecretConfigured, true);
  assert.equal(report.summary.tenantConfigured, true);
  assert.equal(report.summary.egressConfigured, true);
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
    'rwi-secret-token'
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('LiveKit deployment env checklist groups required variables and masks secrets', () => {
  const checklist = renderLiveKitDeploymentEnvChecklist(configuredEnv({
    OPC_FRONTEND_URL: 'https://frontend.example.com',
    OPC_BROWSER_SMOKE_AGENT_A_TOKEN: 'agent-a-secret'
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
  assert.match(checklist, /\| OPC_MEDIA_API_TOKEN \| required \| `configured` \|/);
  assert.match(checklist, /\| MINIO_SECRET_KEY \| required \| `configured` \|/);
  assert.match(checklist, /\| MINIO_BUCKET \| optional \| `recordings` \|/);
  assert.match(checklist, /\| OPC_MEDIA_RECORDING_RETENTION_DAYS \| optional \| `90` \|/);
  assert.match(checklist, /\| OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT \| optional \| `1` \|/);
  assert.equal(checklist.includes('agent-a-secret'), false);
});

test('LiveKit deployment preflight rejects invalid recording retention and object polling values', () => {
  const report = createLiveKitDeploymentPreflightReport(configuredEnv({
    OPC_MEDIA_RECORDING_RETENTION_DAYS: '0',
    OPC_RECORDING_HTTP_TIMEOUT_MS: '0',
    OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS: 'not-a-number'
  }));

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'media_recording_retention_days')?.status, 'fail');
  assert.equal(report.checks.find((check) => check.id === 'media_recording_http_timeout')?.status, 'fail');
  assert.equal(report.checks.find((check) => check.id === 'media_recording_object_timeout')?.status, 'fail');
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
          OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE: checklistPath,
          OPC_LIVEKIT_PREFLIGHT_REPORT_FILE: reportPath
        })
      },
      encoding: 'utf8'
    }
  );

  assert.equal(JSON.parse(stdout).ok, true);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).ok, true);
  assert.match(readFileSync(checklistPath, 'utf8'), /OPC_VIDEO_READINESS_TARGETS/);
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
    'OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE=',
    'OPC_LIVEKIT_PREFLIGHT_REPORT_FILE='
  ]) {
    assert.match(rootEnvExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});
