import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskAcceptanceBundleConfigFromEnv,
  writeRustDeskAcceptanceBundle
} from '../scripts/rustdesk-acceptance-bundle.js';

test('RustDesk acceptance bundle writes the server handoff artifact set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-acceptance-bundle-'));
  const config = createRustDeskAcceptanceBundleConfigFromEnv({
    OPC_RUSTDESK_ACCEPTANCE_BUNDLE_DIR: dir,
    OPC_RUSTDESK_ACCEPTANCE_BUNDLE_TITLE: 'RustDesk customer delivery',
    ...bundleEnv()
  });

  const result = writeRustDeskAcceptanceBundle(config, bundleEnv());

  assert.equal(result.outputDir, dir);
  assert.equal(result.artifacts.length, 13);
  assert.equal(result.evidencePackOk, false);
  assert.deepEqual(result.missingRequired.includes('readiness_report'), true);
  for (const artifact of result.artifacts) {
    assert.equal(existsSync(artifact.path), true, `${artifact.key} should exist`);
  }

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.title, 'RustDesk customer delivery');
  assert.equal(manifest.status, 'awaiting_real_environment_evidence');
  assert.equal(manifest.artifacts.deployment_commands.path, join(dir, 'deployment-commands.md'));
  assert.equal(manifest.artifacts.server_readiness_runbook.path, join(dir, 'server-readiness-runbook.md'));
  assert.equal(manifest.expected_artifacts.server_evidence.expected_path, join(dir, 'server-evidence.json'));
  assert.equal(manifest.expected_artifacts.client_config_pack.expected_path, join(dir, 'client-config-pack.md'));
  assert.match(manifest.expected_artifacts.client_config_pack.command, /OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE=<bundle>\/client-config-pack\.md/);
  assert.match(manifest.expected_artifacts.client_config_pack.command, /npm run rustdesk:client-config-pack/);
  assert.equal(manifest.artifacts.led_integration_quickstart.path, join(dir, 'led-integration-quickstart.md'));
  assert.equal(manifest.artifacts.led_sdk_minimal_example.path, join(dir, 'led-sdk-minimal-example.ts'));
  assert.equal(manifest.artifacts.client_acceptance_runbook.path, join(dir, 'client-acceptance-runbook.md'));
  assert.equal(manifest.artifacts.event_forwarder_runbook.path, join(dir, 'event-forwarder-runbook.md'));
  assert.equal(manifest.artifacts.readiness_report.expected_path, join(dir, 'readiness.json'));
  assert.equal(manifest.expected_artifacts.audit_export.expected_path, join(dir, 'audit-export.jsonl'));
  assert.match(manifest.expected_artifacts.filled_client_acceptance_report.command, /OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=<bundle>\/audit-export\.jsonl/);
  assert.match(manifest.expected_artifacts.audit_export.command, /OPC_RUSTDESK_AUDIT_EXPORT_FILE=<bundle>\/audit-export\.jsonl/);
  assert.match(manifest.expected_artifacts.audit_export.command, /npm run rustdesk:audit-export/);
  assert.match(manifest.expected_artifacts.audit_coverage_report.command, /OPC_RUSTDESK_AUDIT_COVERAGE_FILE=<bundle>\/audit-export\.jsonl/);
  assert.match(readFileSync(join(dir, 'deployment-commands.md'), 'utf8'), /rustdesk:readiness/);
  const serverRunbook = readFileSync(join(dir, 'server-readiness-runbook.md'), 'utf8');
  assert.match(serverRunbook, /^# RustDesk Server Readiness Runbook/m);
  assert.match(serverRunbook, /OPC_RUSTDESK_PREFLIGHT_REPORT_FILE=.*preflight\.json/);
  assert.match(serverRunbook, /OPC_RUSTDESK_SERVER_EVIDENCE_FILE=.*server-evidence\.json/);
  assert.match(serverRunbook, /OPC_RUSTDESK_READINESS_REPORT_FILE=.*readiness\.json/);
  assert.match(serverRunbook, /OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE=.*client-config-pack\.md/);
  assert.match(serverRunbook, /npm run rustdesk:deployment-preflight/);
  assert.match(serverRunbook, /npm run rustdesk:server-evidence/);
  assert.match(serverRunbook, /npm run rustdesk:readiness/);
  assert.match(serverRunbook, /npm run rustdesk:client-config-pack/);
  assert.match(serverRunbook, /npm run rustdesk:ivekit-smoke/);
  assert.match(serverRunbook, /npm run rustdesk:client-acceptance/);
  assert.match(serverRunbook, /OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=.*audit-export\.jsonl/);
  assert.match(serverRunbook, /OPC_RUSTDESK_AUDIT_EXPORT_FILE=.*audit-export\.jsonl/);
  assert.match(serverRunbook, /OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id>/);
  assert.match(serverRunbook, /npm run rustdesk:audit-export/);
  assert.match(serverRunbook, /OPC_RUSTDESK_AUDIT_COVERAGE_FILE=.*audit-export\.jsonl/);
  assert.match(serverRunbook, /OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=.*audit-coverage\.json/);
  assert.match(serverRunbook, /npm run rustdesk:audit-coverage/);
  assert.match(serverRunbook, /OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE=.*deployment-commands\.md/);
  assert.match(serverRunbook, /OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=.*client-config-pack\.md/);
  assert.match(serverRunbook, /OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_AUDIT_FILE=.*audit-export\.jsonl/);
  assert.match(serverRunbook, /OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE=.*audit-coverage\.json/);
  assert.match(serverRunbook, /npm run rustdesk:evidence-pack/);
  const ledQuickstart = readFileSync(join(dir, 'led-integration-quickstart.md'), 'utf8');
  assert.match(ledQuickstart, /^# RustDesk LED Integration Quickstart/m);
  assert.match(ledQuickstart, /createIveKitRustDeskLedSdk/);
  assert.match(ledQuickstart, /npm run rustdesk:led-example/);
  assert.match(ledQuickstart, /OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID/);
  assert.match(ledQuickstart, /\/api\/ivekit\/rustdesk\/client-config/);
  assert.match(ledQuickstart, /\/api\/ivekit\/rustdesk\/gateway-sessions/);
  assert.match(ledQuickstart, /sdk\.recordControlAction/);
  assert.match(ledQuickstart, /sdk\.recordFileTransfer/);
  assert.match(ledQuickstart, /sdk\.recordScreenRecording/);
  assert.match(ledQuickstart, /sdk\.recordClipboardSync/);
  assert.match(ledQuickstart, /remote\.rustdesk\.control_action\.performed/);
  assert.match(ledQuickstart, /operation_id/);
  assert.match(ledQuickstart, /permission: 'control_mouse_keyboard'/);
  assert.match(ledQuickstart, /does not prove real RustDesk client control/);
  const ledSdkExample = readFileSync(join(dir, 'led-sdk-minimal-example.ts'), 'utf8');
  assert.match(ledSdkExample, /createIveKitRustDeskLedSdk/);
  assert.match(ledSdkExample, /sdk\.startSession/);
  assert.match(ledSdkExample, /session\.launch\.openUrl/);
  assert.match(ledSdkExample, /sdk\.recordControlAction/);
  assert.match(ledSdkExample, /operationId/);
  assert.match(ledSdkExample, /sdk\.endGatewaySession/);
  assert.equal(ledSdkExample.includes('rustdesk-secret-token'), false);
  assert.equal(ledSdkExample.includes('collaboration-secret'), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'preflight.json'), 'utf8')).ok, true);
  assert.match(readFileSync(join(dir, 'client-acceptance-template.json'), 'utf8'), /keyboard\/mouse/);
  assert.match(readFileSync(join(dir, 'client-acceptance-runbook.md'), 'utf8'), /old signed launch URL returns 409/);
  assert.match(readFileSync(join(dir, 'events-template.jsonl'), 'utf8'), /remote\.rustdesk\.clipboard\.synced/);
  const eventRunbook = readFileSync(join(dir, 'event-forwarder-runbook.md'), 'utf8');
  assert.match(eventRunbook, /^# RustDesk Operation Event Forwarder Runbook/m);
  assert.match(eventRunbook, /OPC_RUSTDESK_EVENT_TEMPLATE_FILE=.*events-template\.jsonl/);
  assert.match(eventRunbook, /OPC_RUSTDESK_EVENT_FILE=.*events-template\.jsonl/);
  assert.match(eventRunbook, /OPC_RUSTDESK_EVENT_VALIDATE_ONLY=1/);
  assert.match(eventRunbook, /OPC_RUSTDESK_EVENT_DEAD_LETTER_FILE=.*event-forwarder-dead-letter\.jsonl/);
  assert.match(eventRunbook, /OPC_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE=.*event-forwarder-dead-letter\.jsonl/);
  assert.match(eventRunbook, /OPC_RUSTDESK_EVENT_REPLAY_REMAINING_FILE=.*event-forwarder-remaining\.jsonl/);
  assert.match(eventRunbook, /OPC_RUSTDESK_AUDIT_EXPORT_FILE=.*audit-export\.jsonl/);
  assert.match(eventRunbook, /OPC_RUSTDESK_AUDIT_COVERAGE_FILE=.*audit-export\.jsonl/);
  assert.match(eventRunbook, /npm run rustdesk:audit-coverage/);
  assert.match(eventRunbook, /does not prove real RustDesk client operation/);
  const evidencePack = readFileSync(join(dir, 'evidence-pack.md'), 'utf8');
  assert.match(evidencePack, /Status: `incomplete`/);
  assert.match(evidencePack, /client_config_pack/);
  assert.match(evidencePack, /client_acceptance_audit/);
  assert.match(evidencePack, /audit-export\.jsonl/);
  assert.equal(JSON.stringify(manifest).includes('rustdesk-secret-token'), false);
  assert.equal(JSON.stringify(manifest).includes('collaboration-secret'), false);
});

test('RustDesk acceptance bundle CLI writes a bundle directory and exposes package/env wiring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-acceptance-bundle-cli-'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rustdesk-acceptance-bundle.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPC_RUSTDESK_ACCEPTANCE_BUNDLE_DIR: dir,
      ...bundleEnv()
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputDir, dir);
  assert.equal(payload.artifacts.length, 13);
  assert.equal(payload.evidencePackOk, false);
  assert.equal(existsSync(join(dir, 'manifest.json')), true);
  assert.equal(result.stdout.includes('rustdesk-secret-token'), false);
  assert.equal(result.stdout.includes('collaboration-secret'), false);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:acceptance-bundle'], 'tsx scripts/rustdesk-acceptance-bundle.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'OPC_RUSTDESK_ACCEPTANCE_BUNDLE_DIR=',
    'OPC_RUSTDESK_ACCEPTANCE_BUNDLE_TITLE='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});

function bundleEnv(): NodeJS.ProcessEnv {
  return {
    OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    OPC_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
    OPC_BASE_URL: 'https://opc.example.com',
    OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    OPC_COLLABORATION_API_KEY: 'collaboration-secret',
    OPC_REMOTE_GATEWAY_TARGET_ID: 'rdesk_1',
    OPC_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    OPC_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    OPC_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    OPC_RUSTDESK_CHECK_HOST: 'rustdesk-id.example.com',
    OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}?session={external_id}',
    OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID: 'rdgw_bundle_1',
    OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_ACCEPTANCE_OPERATOR: 'qa_operator',
    OPC_RUSTDESK_EVENT_TEMPLATE_TARGET: '123456789'
  };
}
