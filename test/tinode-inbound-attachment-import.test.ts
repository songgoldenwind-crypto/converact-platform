import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileService } from '../src/agent-runtime/collaboration/secure-file-service.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import {
  SecureTinodeInboundAttachmentImporter,
  TinodeInboundAttachmentImportError
} from '../src/agent-runtime/collaboration/tinode-inbound-attachment-import.js';
import { normalizeTinodeInboundPacket } from '../src/agent-runtime/collaboration/tinode-inbound-protocol.js';
import { MemoryPg } from '../src/db-pg.js';
import { LocalObjectStorage } from '../src/storage/object-storage.js';

const claim = {
  tenant_id: 'tenant-inbound-file',
  session_id: 'session-inbound-file',
  binding_id: 'binding-inbound-file',
  provider_topic_id: 'grpInboundFile',
  claim_token: 'claim-token',
  lease_until: '2026-07-15T00:01:00.000Z',
  cursor: { id: 'cursor-inbound-file', last_data_seq: 0, last_del_id: 0 }
};

test('Tinode inbound attachment importer creates an idempotent scan-gated secure file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'converact-tinode-inbound-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pg = new MemoryPg();
  const files = new SecureFileStore(pg);
  const secureFiles = new SecureFileService({
    files,
    derivatives: new SecureFileDerivativeStore(pg),
    storage: new LocalObjectStorage(root)
  });
  const source = Buffer.from('\x89PNG\r\n\x1a\ncontrolled-image');
  let fetchCalls = 0;
  const importer = new SecureTinodeInboundAttachmentImporter({
    secureFiles,
    allowedHosts: ['files.example.com'],
    fetch: async (input, init) => {
      fetchCalls += 1;
      assert.equal(String(input), 'https://files.example.com/photo.png');
      assert.equal(init?.redirect, 'manual');
      return new Response(source, {
        headers: { 'content-type': 'text/plain', 'content-length': String(source.length) }
      });
    }
  });
  const event = normalizeTinodeInboundPacket({
    data: {
      topic: 'grpInboundFile',
      seq: 11,
      from: 'usrCustomer',
      content: {
        txt: 'photo',
        ent: [{
          tp: 'IM',
          data: {
            ref: 'https://files.example.com/photo.png',
            preref: 'https://files.example.com/preview.png',
            name: 'photo.png',
            mime: 'text/plain',
            size: source.length
          }
        }]
      }
    }
  }, { expectedTopic: 'grpInboundFile', allowedAttachmentHosts: ['files.example.com'] });
  const prepared = await importer.prepare(claim, event);
  assert.equal(prepared.kind, 'data');
  if (prepared.kind !== 'data') return;
  const attachment = prepared.payload.attachments[0];
  assert.ok(attachment?.secure_file_id);
  assert.equal(attachment?.storage_url, undefined);
  assert.equal(JSON.stringify(prepared).includes('files.example.com'), false);
  assert.equal(JSON.stringify(prepared).includes('preview.png'), false);
  const file = await files.getFile('tenant-inbound-file', attachment!.secure_file_id!);
  assert.equal(file.status, 'scanning');
  assert.equal(file.declared_mime, 'text/plain');
  assert.equal(file.size_bytes, source.length);

  const replay = await importer.prepare(claim, prepared);
  assert.deepEqual(replay, prepared);
  assert.equal(fetchCalls, 1);
});

test('Tinode inbound attachment importer bounds bytes and rejects redirects', async () => {
  const secureFiles = {
    createUpload: async () => { throw new Error('must not create'); },
    uploadContent: async () => { throw new Error('must not upload'); }
  };
  const event = normalizeTinodeInboundPacket({
    data: {
      topic: 'grpInboundFile', seq: 12, from: 'usrCustomer',
      content: {
        txt: 'file',
        ent: [{ tp: 'EX', data: { ref: 'https://files.example.com/file.bin', name: 'file.bin' } }]
      }
    }
  }, { expectedTopic: 'grpInboundFile', allowedAttachmentHosts: ['files.example.com'] });

  const oversized = new SecureTinodeInboundAttachmentImporter({
    secureFiles: secureFiles as never,
    allowedHosts: ['files.example.com'],
    maxBytes: 4,
    fetch: async () => new Response(Buffer.from('12345'))
  });
  await assert.rejects(
    () => oversized.prepare(claim, event),
    (error: unknown) => error instanceof TinodeInboundAttachmentImportError &&
      error.code === 'attachment_too_large' && !error.retryable
  );

  const redirected = new SecureTinodeInboundAttachmentImporter({
    secureFiles: secureFiles as never,
    allowedHosts: ['files.example.com'],
    fetch: async () => new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example.com/file.bin' }
    })
  });
  await assert.rejects(
    () => redirected.prepare(claim, event),
    (error: unknown) => error instanceof TinodeInboundAttachmentImportError &&
      error.code === 'attachment_redirect_rejected' && !error.retryable
  );
});
