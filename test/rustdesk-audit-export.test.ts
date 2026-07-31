import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskAuditExportConfigFromEnv,
  writeRustDeskAuditExport,
  type RustDeskAuditExportClient
} from '../scripts/rustdesk-audit-export.js';

test('RustDesk audit export config maps focused env and iveKit fallbacks', () => {
  const config = createRustDeskAuditExportConfigFromEnv({
    CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE: '/tmp/audit-export.jsonl',
    CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID: 'rdgw_1',
    CONVERACT_RUSTDESK_IVEKIT_BASE_URL: 'https://opc.example.com/',
    CONVERACT_COLLABORATION_API_KEY: 'api-key',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_RUSTDESK_AUDIT_EXPORT_USER_ID: 'qa_operator',
    CONVERACT_RUSTDESK_AUDIT_EXPORT_SINCE: '2026-07-06T00:00:00.000Z'
  });

  assert.equal(config.outputFile, '/tmp/audit-export.jsonl');
  assert.equal(config.externalId, 'rdgw_1');
  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiKey, 'api-key');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.userId, 'qa_operator');
  assert.equal(config.since, '2026-07-06T00:00:00.000Z');
});

test('RustDesk audit export requires output file, external id, and iveKit credentials', () => {
  assert.throws(
    () => createRustDeskAuditExportConfigFromEnv({}),
    /CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE is required/
  );
  assert.throws(
    () => createRustDeskAuditExportConfigFromEnv({
      CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE: '/tmp/audit-export.jsonl'
    }),
    /CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID is required/
  );
  assert.throws(
    () => createRustDeskAuditExportConfigFromEnv({
      CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE: '/tmp/audit-export.jsonl',
      CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID: 'rdgw_1'
    }),
    /CONVERACT_RUSTDESK_AUDIT_EXPORT_BASE_URL, CONVERACT_RUSTDESK_IVEKIT_BASE_URL, CONVERACT_BASE_URL, or CONVERACT_COLLABORATION_BASE_URL is required/
  );
});

test('RustDesk audit export writes JSONL from iveKit gateway audit events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-audit-export-'));
  const outputFile = join(dir, 'nested', 'audit-export.jsonl');
  const calls: string[] = [];
  const client: RustDeskAuditExportClient = {
    async listGatewayAuditEvents(externalId, input) {
      calls.push(`${externalId}:${input?.since || ''}`);
      return [
        {
          external_id: externalId,
          event_type: 'remote.rustdesk.control_action.performed',
          actor_identity: 'agent_led',
          target: '123456789',
          metadata: {
            operation_id: 'op-1',
            action: 'mouse.click',
            permission: 'control_mouse_keyboard'
          },
          occurred_at: '2026-07-06T00:00:00.000Z'
        },
        {
          external_id: externalId,
          event_type: 'remote.gateway_session.ended',
          actor_identity: 'agent_led',
          target: '123456789',
          metadata: {},
          occurred_at: '2026-07-06T00:05:00.000Z'
        }
      ];
    }
  };

  const result = await writeRustDeskAuditExport({
    outputFile,
    externalId: 'rdgw_1',
    baseUrl: 'https://opc.example.com',
    apiKey: 'api-key',
    tenantId: 'tenant_led',
    since: '2026-07-06T00:00:00.000Z'
  }, client);

  assert.deepEqual(calls, ['rdgw_1:2026-07-06T00:00:00.000Z']);
  assert.equal(result.outputFile, outputFile);
  assert.equal(result.externalId, 'rdgw_1');
  assert.equal(result.events, 2);
  assert.equal(result.format, 'jsonl');
  const lines = readFileSync(outputFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event_type, 'remote.rustdesk.control_action.performed');
  assert.equal(lines[1].event_type, 'remote.gateway_session.ended');
});

test('RustDesk audit export is exposed as a runnable package script with env samples', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['rustdesk:audit-export'], 'tsx scripts/rustdesk-audit-export.ts');

  const rootEnv = readFileSync('.env.example', 'utf8');
  const infraEnv = readFileSync('infra/env.example', 'utf8');
  for (const key of [
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE=',
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=',
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_BASE_URL=',
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_API_KEY=',
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_TENANT_ID=',
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_SINCE='
  ]) {
    assert.match(rootEnv, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnv, new RegExp(`^${key}`, 'm'));
  }
});
