import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeRejectedTinodePacket,
  normalizeTinodeInboundPacket,
  TinodeInboundProtocolError
} from '../src/agent-runtime/collaboration/tinode-inbound-protocol.js';

const options = {
  expectedTopic: 'grpTinode',
  allowedAttachmentHosts: ['files.example.com']
};

test('normalizes Tinode plain data with a bounded head allowlist', () => {
  const event = normalizeTinodeInboundPacket({
    data: {
      topic: 'grpTinode',
      seq: 17,
      from: 'usrCustomer',
      ts: '2026-07-12T12:00:00.000Z',
      head: {
        'x-opc-message-id': 'cmsg_local',
        'x-opc-idempotency-key': 'client-17',
        secret: 'must-not-persist'
      },
      content: 'hello from Tinode'
    }
  }, options);

  assert.equal(event.kind, 'data');
  assert.equal(event.dedupe_key, 'data:17');
  assert.match(event.payload_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(event.payload, {
    topic: 'grpTinode',
    seq: 17,
    from: 'usrCustomer',
    ts: '2026-07-12T12:00:00.000Z',
    head: {
      opc_message_id: 'cmsg_local',
      opc_idempotency_key: 'client-17',
      replace: ''
    },
    body: 'hello from Tinode',
    attachments: []
  });
  assert.equal(JSON.stringify(event).includes('must-not-persist'), false);
});

test('extracts Drafty attachment references without persisting embedded bytes', () => {
  const event = normalizeTinodeInboundPacket({
    data: {
      topic: 'grpTinode',
      seq: 18,
      from: 'usrCustomer',
      content: {
        txt: 'photo',
        fmt: [{ at: 0, len: 5, key: 0 }],
        ent: [{
          tp: 'IM',
          data: {
            ref: 'https://files.example.com/photo.jpg',
            preref: 'https://files.example.com/photo-preview.jpg',
            mime: 'image/jpeg',
            name: 'photo.jpg',
            size: 1234,
            width: 640,
            height: 480,
            val: 'base64-image-bytes',
            preview: 'base64-preview-bytes',
            arbitrary: 'drop-me'
          }
        }]
      }
    }
  }, options);

  assert.equal(event.kind, 'data');
  assert.deepEqual(event.payload.attachments, [{
    kind: 'image',
    storage_url: 'https://files.example.com/photo.jpg',
    filename: 'photo.jpg',
    content_type: 'image/jpeg',
    size_bytes: 1234,
    metadata: {
      duration_ms: 0,
      width: 640,
      height: 480,
      preview_url: 'https://files.example.com/photo-preview.jpg',
      tinode_entity_type: 'IM'
    }
  }]);
  const serialized = JSON.stringify(event);
  for (const forbidden of ['base64-image-bytes', 'base64-preview-bytes', 'drop-me', '"val"', '"preview"']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('normalizes Tinode replacement and delete ranges', () => {
  const replacement = normalizeTinodeInboundPacket({
    data: {
      topic: 'grpTinode',
      seq: 21,
      from: 'usrCustomer',
      head: { replace: 'msg:17' },
      content: 'edited body'
    }
  }, options);
  assert.equal(replacement.kind, 'data');
  assert.equal(replacement.payload.head.replace, 'msg:17');

  const deletion = normalizeTinodeInboundPacket({
    meta: {
      topic: 'grpTinode',
      del: {
        clear: 9,
        delseq: [{ low: 17 }, { low: 20, hi: 23 }]
      }
    }
  }, options);
  assert.equal(deletion.kind, 'delete');
  assert.equal(deletion.dedupe_key, 'delete:9');
  assert.deepEqual(deletion.payload.ranges, [
    { low: 17, hi: 18 },
    { low: 20, hi: 23 }
  ]);
  const presenceDeletion = normalizeTinodeInboundPacket({
    pres: { topic: 'grpTinode', what: 'del', clear: 10, delseq: [{ low: 23 }] }
  }, options);
  assert.equal(presenceDeletion.kind, 'delete');
  assert.equal(presenceDeletion.dedupe_key, 'delete:10');
});

test('rejects wrong topics, unsafe attachment URLs, and malformed delete ranges', () => {
  assert.throws(
    () => normalizeTinodeInboundPacket({ data: { topic: 'grpOther', seq: 1, from: 'usr', content: 'x' } }, options),
    (error: unknown) => error instanceof TinodeInboundProtocolError && error.code === 'topic_mismatch'
  );
  assert.throws(
    () => normalizeTinodeInboundPacket({
      data: {
        topic: 'grpTinode',
        seq: 2,
        from: 'usr',
        content: {
          txt: 'file',
          fmt: [{ at: -1, len: 0, key: 0 }],
          ent: [{ tp: 'EX', data: { ref: 'http://files.example.com/file.zip' } }]
        }
      }
    }, options),
    (error: unknown) => error instanceof TinodeInboundProtocolError && error.code === 'attachment_url_not_allowed'
  );
  assert.throws(
    () => normalizeTinodeInboundPacket({
      meta: { topic: 'grpTinode', del: { clear: 1, delseq: [{ low: 5, hi: 4 }] } }
    }, options),
    (error: unknown) => error instanceof TinodeInboundProtocolError && error.code === 'invalid_delete_range'
  );
});

test('describes a rejected packet using coordinates and a safe payload only', () => {
  const packet = {
    data: {
      topic: 'grpSafeReject',
      seq: 9,
      from: 'usrReject',
      content: {
        txt: '',
        ent: [{ tp: 'IM', data: { val: 'secret-inline-bytes' } }]
      }
    }
  };
  let error: unknown;
  try {
    normalizeTinodeInboundPacket(packet, {
      expectedTopic: 'grpSafeReject',
      allowedAttachmentHosts: []
    });
  } catch (caught) {
    error = caught;
  }
  const rejected = describeRejectedTinodePacket(packet, 'grpSafeReject', error);

  assert.equal(rejected.kind, 'data');
  assert.equal(rejected.provider_sequence, 9);
  assert.equal(rejected.dedupe_key, 'data:9');
  assert.equal(rejected.error_code, 'embedded_attachment_not_supported');
  assert.equal(JSON.stringify(rejected).includes('secret-inline-bytes'), false);
});
