import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Tinode inbound worker is configurable in OPC and standalone deployment surfaces', () => {
  const sources = [
    '.env.example',
    'infra/env.example',
    'docker-compose.callcenter.yml',
    'infra/docker-compose.production.yml',
    'infra/k8s/templates/opc-deployment.yaml',
    'services/converact-service/env.example',
    'services/converact-service/docker-compose.yml'
  ].map((path) => ({ path, content: readFileSync(path, 'utf8') }));

  for (const { path, content } of sources) {
    assert.match(content, /CONVERACT_TINODE_INBOUND_WORKER_ENABLED/, path);
    assert.match(content, /CONVERACT_TINODE_INBOUND_INTERVAL_MS/, path);
    assert.match(content, /CONVERACT_TINODE_INBOUND_PULL_LIMIT/, path);
    assert.match(content, /CONVERACT_TINODE_INBOUND_CLAIM_LEASE_MS/, path);
    assert.match(content, /CONVERACT_TINODE_INBOUND_DEAD_LETTER_MAX_ATTEMPTS/, path);
    assert.match(content, /CONVERACT_TINODE_ATTACHMENT_ALLOWED_HOSTS/, path);
  }
  const values = readFileSync('infra/k8s/values.yaml', 'utf8');
  assert.match(values, /^  inboundWorker:/m);
  assert.match(values, /^    enabled: "1"/m);
  assert.match(values, /^    pullLimit: "100"/m);
  assert.match(values, /^    claimLeaseMs: "60000"/m);
  assert.match(values, /^    deadLetterMaxAttempts: "3"/m);
  assert.match(values, /^    attachmentAllowedHosts: ""/m);
  for (const path of [
    'docker-compose.callcenter.yml',
    'infra/docker-compose.production.yml',
    'services/converact-service/docker-compose.yml'
  ]) {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /TINODE_WS_URL/, path);
    assert.match(content, /TINODE_AUTH_TOKEN/, path);
    assert.match(content, /TINODE_BASIC_USER/, path);
    assert.match(content, /TINODE_BASIC_PASSWORD/, path);
    assert.match(content, /TINODE_USER_PASSWORD_SECRET/, path);
    assert.match(content, /TINODE_PUBLIC_WS_URL/, path);
  }
});
