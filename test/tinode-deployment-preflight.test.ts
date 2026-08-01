import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createTinodeDeploymentPreflightReport,
  renderTinodeDeploymentEnvChecklist,
  writeTinodeDeploymentEnvChecklist,
  writeTinodeDeploymentPreflightReport
} from '../scripts/tinode-deployment-preflight.js';

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TINODE_BASE_URL: 'https://tinode.example.com',
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    TINODE_PUBLIC_BASE_URL: 'https://chat.example.com',
    TINODE_PUBLIC_WS_URL: 'wss://chat.example.com/v0/channels',
    TINODE_API_KEY: 'tinode-api-key',
    TINODE_ROOT_API_KEY: 'tinode-root-api-key',
    TINODE_AUTH_TOKEN: 'tinode-root-token',
    TINODE_USER_PASSWORD_SECRET: 'tinode-user-secret',
    TINODE_REQUEST_TIMEOUT_MS: '5000',
    CONVERACT_TINODE_DELIVERY_WORKER_ENABLED: '1',
    CONVERACT_TINODE_DELIVERY_INTERVAL_MS: '5000',
    CONVERACT_TINODE_DELIVERY_BATCH_SIZE: '50',
    CONVERACT_TINODE_DELIVERY_MAX_ATTEMPTS: '3',
    CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS: '30000',
    CONVERACT_TINODE_DELIVERY_RETRY_DELAYS_MS: '2000,10000',
    TINODE_CHAT_SMOKE_TENANT_ID: 'tenant_tinode',
    TINODE_CHAT_SMOKE_PARTICIPANT_IDENTITY: 'customer_tinode',
    ...overrides
  };
}

function configuredSelfHostedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return configuredEnv({
    NODE_ENV: 'production',
    TINODE_DEPLOYMENT_MODE: 'self_hosted',
    TINODE_POSTGRES_DSN: 'postgresql://opc:private-db-password@postgres:5432/tinode?sslmode=disable',
    TINODE_AUTH_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'),
    TINODE_UID_ENCRYPTION_KEY: Buffer.alloc(16, 2).toString('base64'),
    ...overrides
  });
}

test('Tinode deployment preflight reports missing required deployment env', () => {
  const report = createTinodeDeploymentPreflightReport({});

  assert.equal(report.ok, false);
  assert.equal(report.summary.providerConfigured, false);
  assert.equal(report.summary.rootApiKeyConfigured, false);
  assert.equal(report.summary.rootAuthConfigured, false);
  assert.equal(report.summary.userProvisioningConfigured, false);
  assert.deepEqual(
    report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    [
      'tinode_base_url',
      'tinode_api_key',
      'tinode_root_api_key',
      'tinode_root_auth',
      'tinode_user_password_secret',
      'tinode_smoke_tenant'
    ]
  );
});

test('Tinode deployment preflight passes configured websocket and user provisioning env without leaking secrets', () => {
  const report = createTinodeDeploymentPreflightReport(configuredEnv());

  assert.equal(report.ok, true);
  assert.equal(report.summary.providerConfigured, true);
  assert.equal(report.summary.rootApiKeyConfigured, true);
  assert.equal(report.summary.rootAuthConfigured, true);
  assert.equal(report.summary.userProvisioningConfigured, true);
  assert.equal(report.summary.clientWsUrl, 'wss://chat.example.com/v0/channels');
  assert.equal(report.summary.deliveryWorkerEnabled, true);
  assert.equal(report.summary.deliveryClaimLeaseMs, 30_000);
  assert.equal(report.checks.every((check) => check.status !== 'fail'), true);

  const serialized = JSON.stringify(report);
  for (const secret of ['tinode-root-token', 'tinode-user-secret', 'tinode-api-key', 'tinode-root-api-key']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Tinode deployment preflight rejects a provider configured without a server root API key', () => {
  const report = createTinodeDeploymentPreflightReport(configuredEnv({
    TINODE_ROOT_API_KEY: ''
  }));

  assert.equal(report.ok, false);
  assert.equal(report.summary.providerConfigured, false);
  assert.equal(report.summary.rootApiKeyConfigured, false);
  assert.equal(
    report.checks.some((check) => check.id === 'tinode_root_api_key' && check.status === 'fail'),
    true
  );
});

test('Tinode deployment preflight rejects identical browser and root API keys', () => {
  const report = createTinodeDeploymentPreflightReport(configuredEnv({
    TINODE_ROOT_API_KEY: ' tinode-api-key '
  }));

  assert.equal(report.ok, false);
  assert.equal(report.summary.providerConfigured, false);
  assert.equal(report.summary.apiKeysDistinct, false);
  assert.equal(
    report.checks.some((check) =>
      check.id === 'tinode_api_key_separation' && check.status === 'fail'
    ),
    true
  );
});

test('Tinode self-hosted preflight requires PostgreSQL and correctly sized runtime keys', () => {
  const report = createTinodeDeploymentPreflightReport(configuredSelfHostedEnv({
    TINODE_POSTGRES_DSN: '',
    TINODE_AUTH_TOKEN_KEY: Buffer.alloc(31, 1).toString('base64'),
    TINODE_UID_ENCRYPTION_KEY: ''
  }));

  assert.equal(report.ok, false);
  assert.equal(report.summary.deploymentMode, 'self_hosted');
  assert.equal(report.summary.serverRuntimeConfigured, false);
  assert.deepEqual(
    report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    ['tinode_postgres_dsn', 'tinode_auth_token_key', 'tinode_uid_encryption_key']
  );
});

test('Tinode self-hosted preflight passes without exposing database or runtime secrets', () => {
  const env = configuredSelfHostedEnv();
  const report = createTinodeDeploymentPreflightReport(env);
  const checklist = renderTinodeDeploymentEnvChecklist(env);

  assert.equal(report.ok, true);
  assert.equal(report.summary.serverRuntimeConfigured, true);
  for (const secret of [
    'private-db-password',
    String(env.TINODE_AUTH_TOKEN_KEY),
    String(env.TINODE_UID_ENCRYPTION_KEY)
  ]) {
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(checklist.includes(secret), false);
  }
  assert.match(checklist, /## Tinode Runtime/);
  assert.match(checklist, /\| TINODE_POSTGRES_DSN \| required \| `configured` \|/);
});

test('Tinode production self-hosted preflight requires a public secure browser websocket URL', () => {
  const report = createTinodeDeploymentPreflightReport(configuredSelfHostedEnv({
    TINODE_PUBLIC_BASE_URL: '',
    TINODE_PUBLIC_WS_URL: ''
  }));

  assert.equal(report.ok, false);
  assert.equal(report.summary.browserClientConfigured, false);
  assert.equal(
    report.checks.some((check) => check.id === 'tinode_public_ws_url' && check.status === 'fail'),
    true
  );
});

test('Tinode production external preflight also requires a public secure browser websocket URL', () => {
  const report = createTinodeDeploymentPreflightReport(configuredEnv({
    NODE_ENV: 'production',
    TINODE_DEPLOYMENT_MODE: 'external',
    TINODE_PUBLIC_BASE_URL: '',
    TINODE_PUBLIC_WS_URL: ''
  }));

  assert.equal(report.ok, false);
  assert.equal(report.summary.browserClientConfigured, false);
  assert.equal(
    report.checks.some((check) => check.id === 'tinode_public_ws_url' && check.status === 'fail'),
    true
  );
});

test('Tinode deployment preflight reports invalid modes without external fallback state', () => {
  const report = createTinodeDeploymentPreflightReport(configuredEnv({
    TINODE_DEPLOYMENT_MODE: 'invalid-mode'
  }));

  assert.equal(report.ok, false);
  assert.equal(report.summary.deploymentMode, 'invalid');
  assert.equal(report.summary.serverRuntimeConfigured, false);
});

test('Tinode deployment preflight removes credentials and query secrets from reported URLs', () => {
  const env = configuredEnv({
    TINODE_BASE_URL: '',
    TINODE_WS_URL: 'wss://root:url-pass-123@tinode.example.com/v0/channels?apikey=query-secret-456',
    TINODE_PUBLIC_BASE_URL: '',
    TINODE_PUBLIC_WS_URL: ''
  });
  const report = createTinodeDeploymentPreflightReport(env);
  const checklist = renderTinodeDeploymentEnvChecklist(env);

  assert.equal(report.summary.wsUrl, 'wss://tinode.example.com/v0/channels');
  assert.equal(report.summary.clientWsUrl, 'wss://tinode.example.com/v0/channels');
  for (const secret of ['url-pass-123', 'query-secret-456']) {
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(checklist.includes(secret), false);
  }
});

test('Tinode deployment preflight rejects a delivery lease shorter than the provider timeout budget', () => {
  const report = createTinodeDeploymentPreflightReport(configuredEnv({
    TINODE_REQUEST_TIMEOUT_MS: '5000',
    CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS: '20000'
  }));

  assert.equal(report.ok, false);
  assert.equal(
    report.checks.some((check) =>
      check.id === 'tinode_delivery_worker' &&
      check.status === 'fail' &&
      check.message.includes('26000')
    ),
    true
  );
  assert.equal(JSON.stringify(report).includes('tinode-root-token'), false);
});

test('Tinode deployment preflight accepts an internal websocket URL without a base URL', () => {
  const env = configuredEnv({
    TINODE_BASE_URL: '',
    TINODE_WS_URL: 'wss://tinode-internal.example.com/v0/channels'
  });
  const report = createTinodeDeploymentPreflightReport(env);
  const checklist = renderTinodeDeploymentEnvChecklist(env);

  assert.equal(report.ok, true);
  assert.equal(report.summary.providerConfigured, true);
  assert.equal(report.summary.wsUrl, 'wss://tinode-internal.example.com/v0/channels');
  assert.match(checklist, /\| TINODE_BASE_URL \| optional \| `missing` \|/);
  assert.match(checklist, /\| TINODE_WS_URL \| required \| `wss:\/\/tinode-internal\.example\.com\/v0\/channels` \|/);
});

test('Tinode deployment preflight accepts complete basic root credentials without an auth token', () => {
  const env = configuredEnv({
    TINODE_AUTH_TOKEN: '',
    TINODE_BASIC_USER: 'root-user',
    TINODE_BASIC_PASSWORD: 'root-password'
  });
  const report = createTinodeDeploymentPreflightReport(env);
  const checklist = renderTinodeDeploymentEnvChecklist(env);

  assert.equal(report.ok, true);
  assert.equal(report.summary.rootAuthConfigured, true);
  assert.match(checklist, /\| TINODE_AUTH_TOKEN \| optional \| `missing` \|/);
  assert.match(checklist, /\| TINODE_BASIC_USER \| required \| `root-user` \|/);
  assert.match(checklist, /\| TINODE_BASIC_PASSWORD \| required \| `configured` \|/);
  assert.equal(JSON.stringify(report).includes('root-password'), false);
  assert.equal(checklist.includes('root-password'), false);
});

test('Tinode deployment env checklist masks secrets and groups variables', () => {
  const checklist = renderTinodeDeploymentEnvChecklist(configuredEnv());

  for (const heading of [
    '## Tinode Server',
    '## Tinode Runtime',
    '## Tinode Auth',
    '## Client Plan',
    '## Delivery Worker',
    '## Smoke',
    '## Preflight Artifacts'
  ]) {
    assert.match(checklist, new RegExp(heading));
  }
  assert.match(checklist, /\| TINODE_API_KEY \| required \| `configured` \|/);
  assert.match(checklist, /\| TINODE_ROOT_API_KEY \| required \| `configured` \|/);
  assert.match(checklist, /\| TINODE_AUTH_TOKEN \| required \| `configured` \|/);
  assert.match(checklist, /\| TINODE_USER_PASSWORD_SECRET \| required \| `configured` \|/);
  assert.match(checklist, /\| CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS \| required \| `30000` \|/);
  assert.equal(checklist.includes('tinode-root-token'), false);
  assert.equal(checklist.includes('tinode-root-api-key'), false);
  assert.equal(checklist.includes('tinode-user-secret'), false);
});

test('Tinode deployment preflight writes checklist and report artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-tinode-preflight-'));
  const checklistPath = join(dir, 'tinode-env-checklist.md');
  const reportPath = join(dir, 'tinode-preflight.json');
  const env = configuredEnv();

  const checklistWrite = writeTinodeDeploymentEnvChecklist(checklistPath, env);
  const report = createTinodeDeploymentPreflightReport(env);
  const reportWrite = writeTinodeDeploymentPreflightReport(reportPath, env, report);

  assert.equal(checklistWrite.outputFile, checklistPath);
  assert.equal(checklistWrite.missing.length, 0);
  assert.equal(reportWrite.outputFile, reportPath);
  assert.equal(reportWrite.ok, true);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).ok, true);
  assert.match(readFileSync(checklistPath, 'utf8'), /# Tinode Deployment Env Checklist/);
});

test('Tinode deployment preflight CLI writes requested artifacts without leaking secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-tinode-preflight-cli-'));
  const checklistPath = join(dir, 'tinode-env-checklist.md');
  const reportPath = join(dir, 'tinode-preflight.json');
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/tinode-deployment-preflight.ts'],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        ...configuredEnv({
          CONVERACT_TINODE_PREFLIGHT_ENV_CHECKLIST_FILE: checklistPath,
          CONVERACT_TINODE_PREFLIGHT_REPORT_FILE: reportPath
        })
      },
      encoding: 'utf8'
    }
  );

  assert.equal(JSON.parse(stdout).ok, true);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).ok, true);
  assert.match(readFileSync(checklistPath, 'utf8'), /TINODE_PUBLIC_WS_URL/);
  for (const value of ['tinode-root-token', 'tinode-user-secret', 'tinode-api-key', 'tinode-root-api-key']) {
    assert.equal(stdout.includes(value), false);
    assert.equal(readFileSync(checklistPath, 'utf8').includes(value), false);
  }
});

test('Tinode deployment preflight is exposed through scripts and env examples', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['tinode:deployment-preflight'], 'tsx scripts/tinode-deployment-preflight.ts');

  const rootEnvExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'NODE_ENV=',
    'TINODE_DEPLOYMENT_MODE=',
    'TINODE_POSTGRES_DSN=',
    'TINODE_AUTH_TOKEN_KEY=',
    'TINODE_UID_ENCRYPTION_KEY=',
    'CONVERACT_TINODE_PREFLIGHT_ENV_CHECKLIST_FILE=',
    'CONVERACT_TINODE_PREFLIGHT_REPORT_FILE='
  ]) {
    assert.match(rootEnvExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});
