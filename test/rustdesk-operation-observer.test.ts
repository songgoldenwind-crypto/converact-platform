import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  forwardRustDeskOperationObservations,
  normalizeRustDeskOperationObservation
} from '../scripts/rustdesk-operation-observer.js';

const sha = `sha256:${'a'.repeat(64)}`;

test('operation observer normalizes native evidence without operation contents', () => {
  const event = normalizeRustDeskOperationObservation({
    external_id: 'rdgw-1', actor_identity: 'agent-1', target: '123456789',
    operation_id: 'file-1', operation: 'transfer_file', status: 'observed_succeeded',
    observer: 'native_client', observed_at: '2026-07-12T12:00:00.000Z',
    direction: 'upload', byte_count: 42, checksum_sha256: sha, control_version: 2,
    evidence_refs: [{ type: 'audit_artifact', ref: 'evidence:file-1', sha256: sha }],
    metadata: { operation: 'clipboard', status: 'not_observed' }
  });
  assert.equal(event.event_type, 'remote.rustdesk.operation.observed');
  assert.equal(event.idempotency_key, 'rustdesk-observation:file-1:observed_succeeded');
  assert.equal(event.metadata?.byte_count, 42);
  assert.equal(event.metadata?.operation, 'transfer_file');
  assert.equal(event.metadata?.status, 'observed_succeeded');
  assert.equal(JSON.stringify(event).includes('file_content'), false);
});

test('operation observer keeps missing telemetry explicit as not_observed', () => {
  const event = normalizeRustDeskOperationObservation({
    external_id: 'rdgw-1', actor_identity: 'agent-1', operation_id: 'display-1',
    operation: 'multi_display', status: 'not_observed', observer: 'none'
  });
  assert.deepEqual(event.metadata?.evidence_refs, []);
  assert.equal(event.metadata?.observed_at, null);
});

test('operation observer rejects sensitive content and unverifiable success', () => {
  assert.throws(() => normalizeRustDeskOperationObservation({
    external_id: 'rdgw-1', actor_identity: 'agent-1', operation_id: 'clip-1',
    operation: 'clipboard', status: 'observed_succeeded', observer: 'native_client',
    observed_at: '2026-07-12T12:00:00.000Z', evidence_refs: [{ type: 'audit', ref: 'evidence:clip', sha256: sha }],
    metadata: { clipboard_text: 'secret' }
  }), /metadata.clipboard_text is forbidden/);
  assert.throws(() => normalizeRustDeskOperationObservation({
    external_id: 'rdgw-1', actor_identity: 'agent-1', operation_id: 'screen-1',
    operation: 'view_screen', status: 'observed_succeeded', observer: 'native_client',
    observed_at: '2026-07-12T12:00:00.000Z'
  }), /metadata.evidence_refs is required/);
  assert.throws(() => normalizeRustDeskOperationObservation({
    external_id: 'rdgw-1', actor_identity: 'agent-1', operation_id: 'file-2',
    operation: 'transfer_file', status: 'observed_succeeded', observer: 'native_client',
    observed_at: '2026-07-12T12:00:00.000Z', evidence_refs: [{ type: 'audit', ref: 'evidence:file-2', sha256: sha }]
  }), /metadata.direction is required for transfer_file/);
});

test('operation observer reuses forwarder retry and stable idempotency', async () => {
  const bodies: Record<string, unknown>[] = [];
  const count = await forwardRustDeskOperationObservations([{
    external_id: 'rdgw-1', actor_identity: 'agent-1', operation_id: 'view-1',
    operation: 'view_screen', status: 'not_observed', observer: 'none'
  }], {
    baseUrl: 'https://opc.example', apiToken: 'token', defaultExternalId: '',
    defaultActorIdentity: 'observer', retryAttempts: 0
  }, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{}', { status: 201 });
  });
  assert.equal(count, 1);
  assert.equal(bodies[0]?.idempotency_key, 'rustdesk-observation:view-1:not_observed');
});

test('operation observer is exposed as a package command and deployment input', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['rustdesk:operation-observer'], 'tsx scripts/rustdesk-operation-observer.ts');
  assert.match(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'), /^OPC_RUSTDESK_OBSERVER_FILE=$/m);
  assert.match(readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8'), /^OPC_RUSTDESK_OBSERVER_FILE=$/m);
});
