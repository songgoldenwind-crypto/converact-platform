import assert from 'node:assert/strict';
import test from 'node:test';

import { createConveractFabricClient } from '../sdk/converact/src/index.js';
import type { ConveractFabricIntelligencePolicyWrite } from '../sdk/converact/src/intelligence-types.js';

test('SDK policy write supports route-native requests without legacy primary fields', () => {
  const routeNative: ConveractFabricIntelligencePolicyWrite = {
    version: 0,
    ocr_enabled: true,
    asr_enabled: true,
    quality_review_enabled: true,
    translation_enabled: true,
    ocr_profile_ids: ['ocr-a'],
    asr_profile_ids: ['asr-a'],
    quality_profile_ids: ['quality-a'],
    translation_profile_ids: ['translation-a'],
    allow_third_party: false,
    auto_ocr: true,
    auto_asr: true,
    auto_quality_review: true,
    auto_translation: true,
    translation_target_languages: ['en-US'],
    min_ocr_confidence: 0,
    min_asr_confidence: 0
  };
  assert.deepEqual(routeNative.ocr_profile_ids, ['ocr-a']);
});

test('Converact Fabric SDK maps intelligence, review queue, source, and translation workflows', async () => {
  const calls: Array<{ method: string; url: URL; headers: Headers; body: unknown }> = [];
  const client = createConveractFabricClient({
    baseUrl: 'https://converact.example.test',
    tenantId: 'tenant-sdk-v3',
    apiKey: 'sdk-v3-key',
    userId: 'sdk-admin',
    fetch: async (input, init = {}) => {
      calls.push({
        method: init.method || 'GET',
        url: new URL(String(input)),
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null
      });
      return Response.json({ items: [], next_cursor: '', job: {}, source: {}, capabilities: {} });
    }
  });

  assert.equal(typeof client.intelligence.getCapabilities, 'function');
  assert.equal(typeof client.chat.requestMessageTranslation, 'function');
  await client.intelligence.getCapabilities();
  await client.intelligence.getPolicy();
  await client.intelligence.updatePolicy({ version: 2, translation_enabled: true } as never);
  await client.intelligence.listProviders();
  await client.intelligence.listProviderRuntime();
  await client.intelligence.probeProviderHealth({ profile_ids: ['translate-self'] });
  await client.intelligence.importSource('session/1', {
    source_type: 'media_recording', source_ref_id: 'recording/1'
  }, { idempotencyKey: 'source-import-1' });
  await client.intelligence.getSource('session/1', 'source/1');
  await client.intelligence.retrySource('session/1', 'source/1');
  await client.intelligence.listFindings({
    source: 'ai', severity: 'high', review_status: 'pending', session_id: 'session/1', limit: 25
  });
  await client.intelligence.getFinding('finding/1');
  await client.intelligence.reviewFinding('finding/1', {
    review_status: 'confirmed', note: 'Validated'
  });
  await client.chat.requestMessageTranslation('session/1', 'message/1', {
    target_language: 'en-US'
  }, { idempotencyKey: 'translate-message-1' });
  await client.chat.listMessageTranslations('session/1', 'message/1', { target_language: 'en-US' });
  await client.chat.requestAttachmentTranslation('session/1', 'attachment/1', {
    source_language: 'zh-CN', target_language: 'ja-JP'
  }, { idempotencyKey: 'translate-attachment-1' });
  await client.chat.listAttachmentTranslations('session/1', 'attachment/1', { history: true });
  await client.chat.retryTranslation('session/1', 'job/1');
  await client.chat.runTranslation({ limit: 9 });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    'GET /api/ivekit/intelligence/capabilities',
    'GET /api/ivekit/intelligence/policy',
    'PUT /api/ivekit/intelligence/policy',
    'GET /api/ivekit/intelligence/providers',
    'GET /api/ivekit/intelligence/providers/runtime',
    'POST /api/ivekit/intelligence/providers/health',
    'POST /api/ivekit/intelligence/sessions/session%2F1/sources',
    'GET /api/ivekit/intelligence/sessions/session%2F1/sources/source%2F1',
    'POST /api/ivekit/intelligence/sessions/session%2F1/sources/source%2F1/retry',
    'GET /api/ivekit/intelligence/findings',
    'GET /api/ivekit/intelligence/findings/finding%2F1',
    'POST /api/ivekit/intelligence/findings/finding%2F1/review',
    'POST /api/ivekit/chat/sessions/session%2F1/messages/message%2F1/translations',
    'GET /api/ivekit/chat/sessions/session%2F1/messages/message%2F1/translations',
    'POST /api/ivekit/chat/sessions/session%2F1/attachments/attachment%2F1/translations',
    'GET /api/ivekit/chat/sessions/session%2F1/attachments/attachment%2F1/translations',
    'POST /api/ivekit/chat/sessions/session%2F1/translations/job%2F1/retry',
    'POST /api/ivekit/chat/translation/run'
  ]);
  assert.equal(calls[6]?.headers.get('idempotency-key'), 'source-import-1');
  assert.equal(calls[12]?.headers.get('idempotency-key'), 'translate-message-1');
  assert.equal(calls[14]?.headers.get('idempotency-key'), 'translate-attachment-1');
  assert.equal(calls[9]?.url.searchParams.get('severity'), 'high');
  assert.equal(calls[15]?.url.searchParams.get('history'), '1');
});
