import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskDeploymentPreflightReport,
  renderRustDeskDeploymentEnvChecklist,
  writeRustDeskDeploymentEnvChecklist,
  writeRustDeskDeploymentPreflightReport
} from '../scripts/rustdesk-deployment-preflight.js';

test('RustDesk deployment preflight reports missing server readiness inputs without leaking secrets', () => {
  const report = createRustDeskDeploymentPreflightReport({
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_RUSTDESK_LAUNCH_SECRET: 'launch-secret'
  });

  assert.equal(report.ok, false);
  assert.deepEqual(failedCheckIds(report), [
    'control_plane_base_url',
    'public_key',
    'id_server',
    'launch_base_url',
    'target',
    'tenant',
    'collaboration_api_key',
    'port_check_host',
    'protocol_url_template'
  ]);
  assert.equal(JSON.stringify(report).includes('rustdesk-secret-token'), false);
  assert.equal(JSON.stringify(report).includes('launch-secret'), false);
});

test('RustDesk deployment preflight passes a strict configured target deployment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-preflight-'));
  const publicKeyFile = join(dir, 'id_ed25519.pub');
  writeFileSync(publicKeyFile, 'rustdesk-public-key\n');

  const report = createRustDeskDeploymentPreflightReport({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_COLLABORATION_API_KEY: 'collaboration-secret',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk_1',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    CONVERACT_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PUBLIC_KEY_FILE: publicKeyFile,
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}',
    CONVERACT_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE: '1',
    CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS: '1',
    CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL: '1'
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.controlPlaneBaseUrl, 'https://opc.example.com');
  assert.equal(report.summary.publicKeySource, 'file');
  assert.equal(report.summary.targetMode, 'configured');
  assert.equal(report.summary.portCheckHost, 'rustdesk-id.example.com');
  assert.equal(JSON.stringify(report).includes('rustdesk-secret-token'), false);
  assert.equal(JSON.stringify(report).includes('collaboration-secret'), false);
});

test('RustDesk deployment preflight accepts edge-agent derived targets only when edge inputs are ready', () => {
  const report = createRustDeskDeploymentPreflightReport({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    CONVERACT_COLLABORATION_API_KEY: 'collaboration-secret',
    CONVERACT_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1',
    CONVERACT_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    CONVERACT_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
    CONVERACT_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    CONVERACT_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}&id={id_server}&relay={relay_server}&api={api_server}&key={public_key}'
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.targetMode, 'edge-agent');
  assert.equal(report.summary.publicKeySource, 'env');

  const broken = createRustDeskDeploymentPreflightReport({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    CONVERACT_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}'
  });

  assert.equal(broken.ok, false);
  assert.equal(failedCheckIds(broken).includes('edge_agent_inputs'), true);
});

test('RustDesk deployment preflight requires a strong authorization-code secret in strict mode', () => {
  const missingSecret = createRustDeskDeploymentPreflightReport({
    ...validPreflightEnv(),
    CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE: '1'
  });
  assert.equal(missingSecret.ok, false);
  assert.equal(failedCheckIds(missingSecret).includes('authorization_code_secret'), true);
  assert.equal(missingSecret.summary.authorizationCodeRequired, true);
  assert.equal(missingSecret.summary.authorizationCodeSecretConfigured, false);

  const ready = createRustDeskDeploymentPreflightReport({
    ...validPreflightEnv(),
    CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE: '1',
    CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET: 'rustdesk-authorization-preflight-secret-32-bytes'
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.summary.authorizationCodeSecretConfigured, true);
  assert.equal(JSON.stringify(ready).includes('rustdesk-authorization-preflight-secret'), false);
});

test('RustDesk deployment preflight gates strict physical disconnect and sanitizes edge command inputs', () => {
  const integrationDisabled = createRustDeskDeploymentPreflightReport({
    ...validPreflightEnv(),
    CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT: '1',
    CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT: '0'
  });
  assert.equal(integrationDisabled.ok, false);
  assert.equal(failedCheckIds(integrationDisabled).includes('physical_disconnect_readiness'), true);

  const missingAdapter = createRustDeskDeploymentPreflightReport({
    ...physicalDisconnectPreflightEnv(),
    CONVERACT_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: '',
    CONVERACT_RUSTDESK_EDGE_RESTART_EXECUTABLE: ''
  });
  assert.equal(missingAdapter.ok, false);
  assert.equal(failedCheckIds(missingAdapter).includes('physical_disconnect_adapter'), true);

  const missingCredentialsEnv = physicalDisconnectPreflightEnv();
  delete missingCredentialsEnv.CONVERACT_COLLABORATION_API_KEY;
  delete missingCredentialsEnv.CONVERACT_RUSTDESK_EDGE_API_KEY;
  delete missingCredentialsEnv.CONVERACT_REMOTE_GATEWAY_TENANT_ID;
  delete missingCredentialsEnv.CONVERACT_RUSTDESK_EDGE_TENANT_ID;
  const missingCredentials = createRustDeskDeploymentPreflightReport(missingCredentialsEnv);
  assert.equal(missingCredentials.ok, false);
  assert.equal(failedCheckIds(missingCredentials).includes('physical_disconnect_edge_credentials'), true);

  const missingCommandTokenEnv = physicalDisconnectPreflightEnv();
  delete missingCommandTokenEnv.CONVERACT_RUSTDESK_EDGE_COMMAND_TOKEN;
  const missingCommandToken = createRustDeskDeploymentPreflightReport(missingCommandTokenEnv);
  assert.equal(missingCommandToken.ok, false);
  assert.equal(failedCheckIds(missingCommandToken).includes('physical_disconnect_edge_token'), true);

  const shortTokenSecret = createRustDeskDeploymentPreflightReport({
    ...physicalDisconnectPreflightEnv(),
    CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET: 'short'
  });
  assert.equal(shortTokenSecret.ok, false);
  assert.equal(
    failedCheckIds(shortTokenSecret).includes('physical_disconnect_edge_token_secret'),
    true
  );

  const invalidTiming = createRustDeskDeploymentPreflightReport({
    ...physicalDisconnectPreflightEnv(),
    CONVERACT_RUSTDESK_EDGE_COMMAND_LEASE_MS: '30000',
    CONVERACT_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS: '15000'
  });
  assert.equal(invalidTiming.ok, false);
  assert.equal(failedCheckIds(invalidTiming).includes('physical_disconnect_timing'), true);

  const missingSpoolEnv = physicalDisconnectPreflightEnv();
  delete missingSpoolEnv.CONVERACT_RUSTDESK_EDGE_SPOOL_DIR;
  const missingSpool = createRustDeskDeploymentPreflightReport(missingSpoolEnv);
  assert.equal(missingSpool.ok, false);
  assert.equal(failedCheckIds(missingSpool).includes('physical_disconnect_spool'), true);

  const ready = createRustDeskDeploymentPreflightReport(physicalDisconnectPreflightEnv());
  assert.equal(ready.ok, true);
  assert.equal(ready.summary.physicalDisconnectRequired, true);
  assert.equal(ready.summary.physicalDisconnectReadinessCheck, true);
  assert.equal(ready.summary.edgeCommandExecutionEnabled, true);
  assert.equal(ready.summary.edgeCommandTokenConfigured, true);
  assert.equal(ready.summary.edgeTokenSecretConfigured, true);
  assert.equal(ready.summary.edgeSpoolConfigured, true);
  assert.equal(ready.summary.commandPollIntervalMs, 2000);
  assert.equal(ready.summary.commandLeaseMs, 40000);
  assert.equal(ready.summary.commandTimeoutMs, 15000);
  assert.equal(JSON.stringify(ready).includes('edge-secret'), false);
  assert.equal(JSON.stringify(ready).includes('super-secret-adapter-argument'), false);
  assert.equal(JSON.stringify(ready).includes('/opt/opc/bin/disconnect-rustdesk-session'), false);
});

test('RustDesk deployment preflight can require HTTPS launch URLs for production ingress', () => {
  const report = createRustDeskDeploymentPreflightReport({
    ...validPreflightEnv(),
    CONVERACT_BASE_URL: 'http://opc.example.com',
    CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL: '1'
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.httpsLaunchRequired, true);
  assert.equal(failedCheckIds(report).includes('launch_base_url_https'), true);

  const httpsReport = createRustDeskDeploymentPreflightReport({
    ...validPreflightEnv(),
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL: '1'
  });

  assert.equal(httpsReport.ok, true);
  assert.equal(failedCheckIds(httpsReport).includes('launch_base_url_https'), false);
});

test('RustDesk deployment preflight script is wired into package scripts', async () => {
  const packageJson = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile('package.json', 'utf8')));
  assert.equal(packageJson.scripts['rustdesk:deployment-preflight'], 'tsx scripts/rustdesk-deployment-preflight.ts');
});

test('RustDesk deployment env checklist renders required variables without leaking secrets', () => {
  const markdown = renderRustDeskDeploymentEnvChecklist({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_RUSTDESK_PUBLIC_KEY_FILE: '/rustdesk/id_ed25519.pub',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    CONVERACT_RUSTDESK_LAUNCH_BASE_URL: 'https://opc.example.com',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device_123',
    CONVERACT_COLLABORATION_API_KEY: 'collaboration-secret',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}',
    CONVERACT_RUSTDESK_LED_EXAMPLE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID: 'ras_123'
  });

  assert.match(markdown, /^# RustDesk Deployment Env Checklist/m);
  assert.match(markdown, /## Server Readiness/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL \| required \| `https:\/\/opc\.example\.com` \|/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_API_TOKEN \| required \| `configured` \|/);
  assert.match(markdown, /\| CONVERACT_COLLABORATION_API_KEY \| required \| `configured` \|/);
  assert.match(markdown, /## Event Audit/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVENT_TEMPLATE_FILE/);
  assert.match(markdown, /## Final Evidence/);
  assert.match(markdown, /CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE/);
  assert.match(markdown, /CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_PACK_FILE/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE/);
  assert.match(markdown, /## LED Handoff/);
  assert.match(markdown, /CONVERACT_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID/);
  assert.equal(markdown.includes('rustdesk-secret-token'), false);
  assert.equal(markdown.includes('collaboration-secret'), false);
});

test('RustDesk deployment env checklist honors public-key and edge-agent alternatives', () => {
  const inlineKey = renderRustDeskDeploymentEnvChecklist({
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key'
  });
  assert.match(inlineKey, /\| CONVERACT_RUSTDESK_PUBLIC_KEY_FILE \| optional \| `missing` \|/);

  const edgeTarget = renderRustDeskDeploymentEnvChecklist({
    CONVERACT_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1'
  });
  assert.match(edgeTarget, /\| CONVERACT_REMOTE_GATEWAY_TARGET_ID \| optional \| `missing` \|/);

  const result = writeRustDeskDeploymentEnvChecklist('/private/tmp/opc-rustdesk-env-alternatives.md', {
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    CONVERACT_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1'
  });
  assert.equal(result.missing.includes('CONVERACT_RUSTDESK_PUBLIC_KEY_FILE'), false);
  assert.equal(result.missing.includes('CONVERACT_REMOTE_GATEWAY_TARGET_ID'), false);
});

test('RustDesk deployment env checklist honors preflight URL, API key, and strict-check fallbacks', () => {
  const markdown = renderRustDeskDeploymentEnvChecklist({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_REMOTE_GATEWAY_BASE_URL: 'https://remote.example.com',
    CONVERACT_RUSTDESK_EDGE_API_KEY: 'edge-secret',
    CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS: '0',
    CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL: '0'
  });

  assert.match(markdown, /\| CONVERACT_RUSTDESK_LAUNCH_BASE_URL \| required \| `https:\/\/remote\.example\.com` \|/);
  assert.match(markdown, /\| CONVERACT_COLLABORATION_API_KEY \| required \| `configured` \|/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_CHECK_HOST \| optional \| `missing` \|/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE \| optional \| `missing` \|/);
  assert.match(markdown, /CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL/);
  assert.equal(markdown.includes('edge-secret'), false);

  const result = writeRustDeskDeploymentEnvChecklist('/private/tmp/opc-rustdesk-env-fallbacks.md', {
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_REMOTE_GATEWAY_BASE_URL: 'https://remote.example.com',
    CONVERACT_RUSTDESK_EDGE_API_KEY: 'edge-secret',
    CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS: '0',
    CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL: '0'
  });
  assert.equal(result.missing.includes('CONVERACT_RUSTDESK_LAUNCH_BASE_URL'), false);
  assert.equal(result.missing.includes('CONVERACT_COLLABORATION_API_KEY'), false);
  assert.equal(result.missing.includes('CONVERACT_RUSTDESK_CHECK_HOST'), false);
  assert.equal(result.missing.includes('CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE'), false);
});

test('RustDesk deployment env checklist covers client config pack handoff inputs', () => {
  const markdown = renderRustDeskDeploymentEnvChecklist({
    CONVERACT_RUSTDESK_IVEKIT_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_IVEKIT_API_KEY: 'ivekit-secret',
    CONVERACT_RUSTDESK_IVEKIT_TENANT_ID: 'tenant_led',
    CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md',
    CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_TITLE: 'LED RustDesk client config',
    CONVERACT_RUSTDESK_CLIENT_CONFIG_USER_ID: 'agent_1',
    CONVERACT_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rgw_123',
    CONVERACT_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '123456789',
    CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md'
  });

  assert.match(markdown, /## Client Config Pack/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE \| optional \| `\/tmp\/rustdesk-client-config-pack\.md` \|/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_CLIENT_CONFIG_BASE_URL \| optional \| `https:\/\/opc\.example\.com` \|/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_CLIENT_CONFIG_API_KEY \| optional \| `configured` \|/);
  assert.match(markdown, /\| CONVERACT_RUSTDESK_CLIENT_CONFIG_TENANT_ID \| optional \| `tenant_led` \|/);
  assert.match(markdown, /CONVERACT_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID/);
  assert.match(markdown, /CONVERACT_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE/);
  assert.equal(markdown.includes('ivekit-secret'), false);
});

test('RustDesk deployment env checklist writes an artifact and is exposed in env examples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-env-checklist-'));
  const outputFile = join(dir, 'rustdesk-env-checklist.md');
  const result = writeRustDeskDeploymentEnvChecklist(outputFile, {
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token'
  });

  assert.equal(result.outputFile, outputFile);
  assert.equal(result.variables > 20, true);
  assert.equal(result.missing.includes('CONVERACT_RUSTDESK_ID_SERVER'), true);
  assert.match(readFileSync(outputFile, 'utf8'), /RustDesk Deployment Env Checklist/);

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  assert.match(envExample, /^CONVERACT_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE=/m);
  assert.match(infraEnvExample, /^CONVERACT_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL=/m);
  assert.match(infraEnvExample, /^CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL=/m);
});

test('RustDesk deployment preflight writes a sanitized JSON report artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-preflight-report-'));
  const outputFile = join(dir, 'rustdesk-preflight.json');
  const result = writeRustDeskDeploymentPreflightReport(outputFile, {
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_COLLABORATION_API_KEY: 'collaboration-secret',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk_1',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    CONVERACT_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}'
  });

  assert.equal(result.outputFile, outputFile);
  assert.equal(result.ok, true);
  assert.equal(result.checks > 0, true);

  const payload = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.publicKeySource, 'env');
  assert.equal(JSON.stringify(payload).includes('rustdesk-secret-token'), false);
  assert.equal(JSON.stringify(payload).includes('collaboration-secret'), false);

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  assert.match(envExample, /^CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE=/m);
  assert.match(infraEnvExample, /^CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE=/m);
});

test('RustDesk deployment preflight CLI can emit env checklist and JSON report artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-preflight-cli-'));
  const checklistFile = join(dir, 'rustdesk-env-checklist.md');
  const reportFile = join(dir, 'rustdesk-preflight.json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rustdesk-deployment-preflight.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONVERACT_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE: checklistFile,
      CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE: reportFile,
      CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
      CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
      CONVERACT_BASE_URL: 'https://opc.example.com',
      CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
      CONVERACT_COLLABORATION_API_KEY: 'collaboration-secret',
      CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk_1',
      CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
      CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
      CONVERACT_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
      CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}'
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.envChecklist.outputFile, checklistFile);
  assert.equal(payload.envChecklist.variables > 20, true);
  assert.equal(payload.reportFile.outputFile, reportFile);
  assert.equal(payload.reportFile.ok, true);
  assert.match(readFileSync(checklistFile, 'utf8'), /RustDesk Deployment Env Checklist/);
  assert.equal(JSON.parse(readFileSync(reportFile, 'utf8')).ok, true);
  assert.equal(result.stdout.includes('rustdesk-secret-token'), false);
  assert.equal(result.stdout.includes('collaboration-secret'), false);
});

function failedCheckIds(report: ReturnType<typeof createRustDeskDeploymentPreflightReport>): string[] {
  return report.checks
    .filter((check) => check.status === 'fail')
    .map((check) => check.id);
}

function validPreflightEnv(): NodeJS.ProcessEnv {
  return {
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    CONVERACT_BASE_URL: 'https://opc.example.com',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_COLLABORATION_API_KEY: 'collaboration-secret',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk_1',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    CONVERACT_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}'
  };
}

function physicalDisconnectPreflightEnv(): NodeJS.ProcessEnv {
  return {
    ...validPreflightEnv(),
    CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT: '1',
    CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT: '1',
    CONVERACT_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1',
    CONVERACT_RUSTDESK_EDGE_API_KEY: 'edge-secret',
    CONVERACT_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    CONVERACT_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    CONVERACT_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
    CONVERACT_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    CONVERACT_RUSTDESK_EDGE_INSTANCE_ID: 'edge-led-1',
    CONVERACT_RUSTDESK_EDGE_COMMAND_TOKEN: 'signed-device-bound-edge-token',
    CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET: 'rustdesk-preflight-edge-token-secret-32-bytes',
    CONVERACT_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS: '2000',
    CONVERACT_RUSTDESK_EDGE_COMMAND_LEASE_MS: '40000',
    CONVERACT_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS: '15000',
    CONVERACT_RUSTDESK_EDGE_SPOOL_DIR: '/var/lib/opc/rustdesk-edge-spool',
    CONVERACT_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: '/opt/opc/bin/disconnect-rustdesk-session',
    CONVERACT_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: '["super-secret-adapter-argument"]'
  };
}
