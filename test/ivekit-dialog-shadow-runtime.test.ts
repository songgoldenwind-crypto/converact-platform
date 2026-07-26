import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadDialogShadowAgentConfig
} from '../src/agent-runtime/ivekit/voice/dialog-shadow-runtime.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  IVEKIT_DIALOG_SHADOW_CELL_ID: 'cell-a',
  IVEKIT_DIALOG_SHADOW_NODE_ID: 'rustpbx-a',
  IVEKIT_DIALOG_SHADOW_FAULT_DOMAIN: 'zone-a-rack-1',
  IVEKIT_DIALOG_SHADOW_JOURNAL_PATH: '/var/lib/ivekit/dialog-shadow.wal',
  IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN_FILE: '/run/secrets/dialog-shadow-token',
  IVEKIT_DIALOG_SHADOW_TLS_KEY_FILE: '/run/tls/tls.key',
  IVEKIT_DIALOG_SHADOW_TLS_CERT_FILE: '/run/tls/tls.crt',
  IVEKIT_DIALOG_SHADOW_TLS_CA_FILE: '/run/tls/ca.crt',
  IVEKIT_DIALOG_SHADOW_NATS_SERVER_FAULT_DOMAINS_FILE:
    '/etc/ivekit/nats-fault-domains.json',
  IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_CLUSTER: 'cell-a',
  IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_TAGS: 'cell:cell-a,role:dialog-shadow',
  NATS_URL: 'tls://nats-a.internal:4222,tls://nats-b.internal:4222,tls://nats-c.internal:4222',
  NATS_TLS_MODE: 'required',
  NATS_TLS_CA_FILE: '/run/nats/ca.crt',
  NATS_TLS_CERT_FILE: '/run/nats/tls.crt',
  NATS_TLS_KEY_FILE: '/run/nats/tls.key'
};

const FILES: Record<string, string> = {
  '/run/secrets/dialog-shadow-token':
    'dialog-shadow-service-token-production-aa',
  '/etc/ivekit/nats-fault-domains.json': JSON.stringify({
    'nats-a': 'zone-a-rack-1',
    'nats-b': 'zone-b-rack-1',
    'nats-c': 'zone-c-rack-1'
  })
};

test('dialog shadow runtime loads production identity, mTLS, and NATS placement', () => {
  const config = loadDialogShadowAgentConfig(BASE_ENV, readFixture);
  assert.equal(config.production, true);
  assert.equal(config.service_token, FILES['/run/secrets/dialog-shadow-token']);
  assert.equal(config.nats.stream_replicas, 3);
  assert.deepEqual(config.nats.server_fault_domains, {
    'nats-a': 'zone-a-rack-1',
    'nats-b': 'zone-b-rack-1',
    'nats-c': 'zone-c-rack-1'
  });
  assert.deepEqual(
    config.nats.placement_tags,
    ['cell:cell-a', 'role:dialog-shadow']
  );
});

test('dialog shadow production runtime rejects plaintext and inline secrets', () => {
  assert.throws(
    () => loadDialogShadowAgentConfig({
      ...BASE_ENV,
      IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN:
        'inline-dialog-shadow-service-token-aa'
    }, readFixture),
    /inline service token/
  );
  assert.throws(
    () => loadDialogShadowAgentConfig({
      ...BASE_ENV,
      NATS_URL: 'nats://nats-a.internal:4222',
      NATS_TLS_MODE: 'disabled',
      NATS_TLS_CA_FILE: undefined,
      NATS_TLS_CERT_FILE: undefined,
      NATS_TLS_KEY_FILE: undefined
    }, readFixture),
    /production NATS TLS is required/
  );
});

function readFixture(path: string): Buffer {
  const value = FILES[path];
  if (!value) throw new Error(`unexpected fixture path ${path}`);
  return Buffer.from(value);
}
