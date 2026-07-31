import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskHandoffPackConfigFromEnv,
  renderRustDeskHandoffPack,
  writeRustDeskHandoffPack
} from '../scripts/rustdesk-handoff-pack.js';

test('RustDesk handoff pack config maps environment without requiring network credentials', () => {
  const config = createRustDeskHandoffPackConfigFromEnv({
    CONVERACT_RUSTDESK_HANDOFF_FILE: '/tmp/rustdesk-handoff.md',
    CONVERACT_RUSTDESK_HANDOFF_TITLE: 'LED RustDesk handoff',
    CONVERACT_RUSTDESK_HANDOFF_AUDIENCE: 'LED team',
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    CONVERACT_RUSTDESK_API_TOKEN: 'secret-token',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device_123',
    CONVERACT_RUSTDESK_PUBLIC_KEY_FILE: '/rustdesk/id_ed25519.pub',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}'
  });

  assert.equal(config.outputFile, '/tmp/rustdesk-handoff.md');
  assert.equal(config.title, 'LED RustDesk handoff');
  assert.equal(config.audience, 'LED team');
  assert.equal(config.controlPlaneBaseUrl, 'https://opc.example.com');
  assert.equal(config.tokenConfigured, true);
  assert.equal(config.idServer, 'rustdesk-id.example.com');
  assert.equal(config.relayServer, 'rustdesk-relay.example.com');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.targetId, 'device_123');
  assert.equal(config.publicKeySource, 'file:/rustdesk/id_ed25519.pub');
  assert.equal(config.protocolTemplateConfigured, true);
});

test('RustDesk handoff pack renders command sequence without leaking secrets', () => {
  const markdown = renderRustDeskHandoffPack(createRustDeskHandoffPackConfigFromEnv({
    CONVERACT_RUSTDESK_HANDOFF_TITLE: 'RustDesk server handoff',
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'secret-token',
    CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'other-secret',
    CONVERACT_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    CONVERACT_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device_123',
    CONVERACT_RUSTDESK_PUBLIC_KEY: 'public-key-value',
    CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE: 'rustdesk://connect/{rustdesk_id}'
  }));

  assert.match(markdown, /^# RustDesk server handoff/m);
  assert.match(markdown, /control-plane base URL: `https:\/\/opc\.example\.com`/);
  assert.match(markdown, /control-plane token: `configured`/);
  assert.match(markdown, /public key: `env`/);
  assert.match(markdown, /tenant: `tenant_led`/);
  assert.match(markdown, /target: `device_123`/);
  assert.match(markdown, /npm run rustdesk:deployment-preflight/);
  assert.match(markdown, /npm run rustdesk:server-evidence/);
  assert.match(markdown, /npm run rustdesk:readiness/);
  assert.match(markdown, /npm run rustdesk:client-config-pack/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVENT_TEMPLATE_FILE=.*npm run rustdesk:event-forwarder/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVENT_VALIDATE_ONLY=1.*npm run rustdesk:event-forwarder/);
  assert.match(markdown, /CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=.*npm run rustdesk:client-acceptance/);
  assert.match(markdown, /CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE=\/tmp\/rustdesk-audit-export\.jsonl/);
  assert.match(markdown, /CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id>/);
  assert.match(markdown, /npm run rustdesk:audit-export/);
  assert.match(markdown, /npm run rustdesk:audit-coverage/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_PACK_FILE=.*npm run rustdesk:evidence-pack/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=\/tmp\/rustdesk-server-evidence\.json/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=\/tmp\/rustdesk-client-config-pack\.md/);
  assert.match(markdown, /ready_for_customer_review/);
  assert.match(markdown, /npm run rustdesk:led-example/);
  assert.match(markdown, /真实客户端验收仍需要人工完成/);
  assert.equal(markdown.includes('secret-token'), false);
  assert.equal(markdown.includes('other-secret'), false);
});

test('RustDesk handoff pack writes markdown artifact and exposes package/env wiring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-handoff-'));
  const outputFile = join(dir, 'rustdesk-handoff.md');
  const result = writeRustDeskHandoffPack(createRustDeskHandoffPackConfigFromEnv({
    CONVERACT_RUSTDESK_HANDOFF_FILE: outputFile,
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'secret-token'
  }));

  assert.deepEqual(result, {
    outputFile,
    sections: [
      'configuration',
      'server-validation',
      'event-audit',
      'client-acceptance',
      'final-evidence',
      'led-integration'
    ]
  });
  const markdown = readFileSync(outputFile, 'utf8');
  assert.match(markdown, /## Server Validation/);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:handoff-pack'], 'tsx scripts/rustdesk-handoff-pack.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of [
    'CONVERACT_RUSTDESK_HANDOFF_FILE=',
    'CONVERACT_RUSTDESK_HANDOFF_TITLE=',
    'CONVERACT_RUSTDESK_HANDOFF_AUDIENCE='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
  }
});
