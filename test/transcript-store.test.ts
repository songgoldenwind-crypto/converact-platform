import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, run } from '../src/db.js';
import { TranscriptStore } from '../src/agent-runtime/memory/transcript-store.js';

test('transcript store redacts nested string pii without corrupting structured output', () => {
  const db = createDatabase(':memory:');
  const tenantId = 'tenant_transcript_redaction';
  run(db, 'INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Transcript Redaction Tenant']);

  const store = new TranscriptStore(db, null);
  const entry = store.append({
    tenant_id: tenantId,
    workspace_id: 'default',
    session_key: 'transcript-redaction-test',
    role: 'tool',
    content_type: 'tool_result',
    content: {
      output: {
        phone: '+8613600000000',
        email: 'owner@example.com',
        metrics: [12345678, 6],
        nested: {
          note: '请联系 13800001234 并同步 owner@example.com',
          rules: ['继续保留 6 次样本验证过的表达']
        }
      }
    },
    channel: 'test',
    business_object_refs: []
  });

  assert.ok(entry);
  const content = entry.content_redacted as Record<string, unknown>;
  const output = content.output as Record<string, unknown>;
  const nested = output.nested as Record<string, unknown>;
  assert.equal(output.phone, '[REDACTED_PHONE]');
  assert.equal(output.email, '[REDACTED_EMAIL]');
  assert.deepEqual(output.metrics, [12345678, 6]);
  assert.equal(nested.note, '请联系 [REDACTED_PHONE] 并同步 [REDACTED_EMAIL]');
  assert.deepEqual((entry.pii_classes as string[]).sort(), ['email', 'phone']);
});
