import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('secure file OpenAPI documents every upload, resume, lifecycle, and download route', () => {
  const yaml = readFileSync('docs/openapi.yaml', 'utf8');
  const markdown = readFileSync('docs/ivekit-openapi.md', 'utf8');
  for (const path of [
    '/api/ivekit/chat/sessions/{session_id}/files:',
    '/api/ivekit/chat/sessions/{session_id}/files/{file_id}:',
    '/api/ivekit/chat/sessions/{session_id}/files/{file_id}/content:',
    '/api/ivekit/chat/sessions/{session_id}/files/{file_id}/parts:',
    '/api/ivekit/chat/sessions/{session_id}/files/{file_id}/parts/{part_number}:',
    '/api/ivekit/chat/sessions/{session_id}/files/{file_id}/complete:',
    '/api/ivekit/chat/sessions/{session_id}/files/{file_id}/download:'
  ]) assert.match(yaml, new RegExp(escapeRegExp(path)));
  assert.match(yaml, /IveKitSecureFile:/);
  assert.match(yaml, /X-Content-SHA256/);
  assert.match(markdown, /安全文件与断点续传/);
  assert.match(markdown, /scanning.*processing.*ready/s);
  assert.match(markdown, /createSecureFile/);
  assert.doesNotMatch(
    schemaBlock(yaml, 'IveKitSecureFile'),
    /^        (?:object_key|upload_id|storage_url|metadata):/m
  );
});

test('Tinode operations contract documents file gating and safe dead-letter replay', () => {
  const yaml = readFileSync('docs/openapi.yaml', 'utf8');
  const markdown = readFileSync('docs/ivekit-openapi.md', 'utf8');
  const collaborationHttp = readFileSync(
    'src/agent-runtime/collaboration/collaboration-http.ts',
    'utf8'
  );
  for (const path of [
    '/api/ivekit/chat/operations/tinode:',
    '/api/ivekit/chat/operations/tinode/dead-letters:',
    '/api/ivekit/chat/operations/tinode/dead-letters/{dead_letter_id}/replay:'
  ]) assert.match(yaml, new RegExp(escapeRegExp(path)));
  const deadLetterSchema = schemaBlock(yaml, 'IveKitTinodeDeadLetter');
  assert.doesNotMatch(deadLetterSchema, /^        (?:payload|storage_url|source_url):/m);
  assert.match(markdown, /blocked_by_file_security/);
  assert.match(markdown, /replayTinodeDeadLetter/);
  assert.match(markdown, /opc_ivekit_tinode_inbound_dead_letters/);
  assert.match(collaborationHttp, /deliveryStatus === 'blocked_by_file_security'[\s\S]*\? 202/);
  assert.match(collaborationHttp, /deliveryStatus === 'blocked'[\s\S]*\? 422/);
});

function schemaBlock(source: string, name: string): string {
  const start = source.indexOf(`    ${name}:`);
  assert.notEqual(start, -1);
  const tail = source.slice(start + 4);
  const next = tail.search(/\n    [A-Za-z][A-Za-z0-9]+:\n/);
  return next === -1 ? tail : tail.slice(0, next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
