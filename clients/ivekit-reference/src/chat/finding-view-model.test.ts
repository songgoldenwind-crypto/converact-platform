import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IveKitPolicyFinding } from '@opc/ivekit-sdk';
import { availableFindingActions, dedupeFindingReviews, projectFindings } from './finding-view-model.js';

test('finding projection labels every source, deduplicates events, and orders risk', () => {
  const projected = projectFindings([
    finding('text-1', 'text', 'low', 'fingerprint-text'),
    finding('ocr-old', 'ocr', 'medium', 'fingerprint-ocr', '2026-07-11T10:00:00.000Z'),
    finding('ocr-new', 'ocr', 'high', 'fingerprint-ocr', '2026-07-11T11:00:00.000Z'),
    finding('asr-1', 'asr', 'medium', 'fingerprint-asr'),
    finding('ai-1', 'ai', 'high', 'fingerprint-ai'),
    finding('aggregate-1', 'aggregate', 'medium', 'fingerprint-aggregate')
  ]);

  assert.deepEqual(projected.map((item) => item.sourceLabel), ['AI quality', 'Image OCR', 'Combined evidence', 'Audio ASR', 'Chat text']);
  assert.equal(projected[1].id, 'ocr-new');
});

test('finding projection exposes only redacted rationale and safe evidence labels', () => {
  const item = projectFindings([{
    ...finding('ai-safe', 'ai', 'high', 'fingerprint-safe'),
    matched_text_hash: 'secret-hash-value',
    rationale: 'Call 13900001111 or user@example.com',
    evidence_refs: [
      { type: 'attachment', id: 'attachment-secret-id', checksum: 'secret-checksum' },
      { type: 'message', id: 'message-secret-id' }
    ],
    metadata: { provider_mode: 'unconfigured', private_prompt: 'never render this' }
  }]);

  assert.equal(item[0].rationale, 'Call [phone] or [email]');
  assert.deepEqual(item[0].evidenceLabels, ['Attachment evidence', 'Message evidence']);
  assert.equal(item[0].providerLabel, 'Provider not configured');
  assert.doesNotMatch(JSON.stringify(item[0]), /secret-hash|secret-checksum|private_prompt|attachment-secret-id/);
});

test('finding review actions follow the server transition state machine', () => {
  assert.deepEqual(availableFindingActions('pending').map((item) => item.status), ['confirmed', 'false_positive', 'escalated']);
  assert.deepEqual(availableFindingActions('confirmed').map((item) => item.status), ['resolved', 'false_positive', 'escalated']);
  assert.deepEqual(availableFindingActions('escalated').map((item) => item.status), ['confirmed', 'resolved', 'false_positive']);
  assert.deepEqual(availableFindingActions('resolved'), []);
  assert.deepEqual(availableFindingActions('false_positive'), []);
});

test('finding review history deduplicates idempotent response entries by audit id', () => {
  const review = {
    id: 'review-1', finding_id: 'finding-1', from_status: 'pending', to_status: 'confirmed'
  } as never;
  assert.deepEqual(dedupeFindingReviews([review, review]), [review]);
});

function finding(
  id: string,
  source: IveKitPolicyFinding['source'],
  severity: IveKitPolicyFinding['severity'],
  fingerprint: string,
  updatedAt = '2026-07-11T12:00:00.000Z'
): IveKitPolicyFinding {
  return {
    id,
    tenant_id: 'tenant-1',
    session_id: 'session-1',
    message_id: `message-${id}`,
    source,
    source_ref_id: `source-${id}`,
    policy_type: 'contact_exchange',
    severity,
    matched_text_hash: `hash-${id}`,
    fingerprint,
    action: 'review',
    confidence: 0.8,
    rationale: 'Redacted rationale',
    review_status: 'pending',
    evidence_refs: [],
    detector_version: 'rules-v1',
    policy_version: 'policy-v1',
    evidence_snapshot_hash: `snapshot-${id}`,
    content_version: 1,
    reviewed_by: '',
    reviewed_at: null,
    review_note: '',
    metadata: {},
    created_at: updatedAt,
    updated_at: updatedAt,
    resolved_at: null
  };
}
