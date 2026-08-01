import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConveractFabricTranslationJob, ConveractFabricTranslationResult } from '@converact/sdk';
import { projectTranslations } from './translation-view-model.js';

test('translation projection prefers a current result over its completed job', () => {
  const projection = projectTranslations({
    items: [result({ translated_text: '你好', target_language: 'zh-CN' })],
    jobs: [job({ status: 'succeeded', target_language: 'zh-CN' })]
  });

  assert.deepEqual(projection, [{
    targetLanguage: 'zh-CN',
    status: 'succeeded',
    statusLabel: 'Translated',
    translatedText: '你好',
    jobId: 'job-1',
    retryable: false,
    errorCode: ''
  }]);
});

test('translation projection exposes retry only for retryable terminal failures', () => {
  const projection = projectTranslations({
    items: [],
    jobs: [
      job({ id: 'job-validation', target_language: 'fr-FR', status: 'failed', error_code: 'invalid_response' }),
      job({ id: 'job-timeout', target_language: 'de-DE', status: 'failed', error_code: 'provider_timeout' })
    ]
  });

  assert.equal(projection.find((item) => item.targetLanguage === 'fr-FR')?.retryable, false);
  assert.equal(projection.find((item) => item.targetLanguage === 'de-DE')?.retryable, true);
  assert.equal(projection.find((item) => item.targetLanguage === 'de-DE')?.statusLabel, 'Translation failed');
});

test('translation projection never renders a stale result for a newer source hash', () => {
  const projection = projectTranslations({
    items: [result({ source_hash: 'old-source', translated_text: 'stale text' })],
    jobs: [job({ source_hash: 'new-source', status: 'pending' })]
  });

  assert.equal(projection[0].status, 'pending');
  assert.equal(projection[0].translatedText, '');
});

function job(overrides: Partial<ConveractFabricTranslationJob> = {}): ConveractFabricTranslationJob {
  return {
    id: 'job-1', tenant_id: 'tenant-1', session_id: 'session-1', message_id: 'message-1',
    source_type: 'message', source_ref_id: 'message-1', source_language: 'auto', target_language: 'zh-CN',
    source_hash: 'source-hash', status: 'pending', attempt_count: 0, max_attempts: 3,
    provider_profile_id: '', provider_mode: 'unconfigured', provider_name: '', provider_request_id: '',
    error_code: '', automatic: false, created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', completed_at: null,
    ...overrides
  };
}

function result(overrides: Partial<ConveractFabricTranslationResult> = {}): ConveractFabricTranslationResult {
  return {
    id: 'result-1', tenant_id: 'tenant-1', message_id: 'message-1', source_type: 'message',
    source_ref_id: 'message-1', source_hash: 'source-hash', source_language: 'auto', target_language: 'zh-CN',
    translated_text: 'translated', provider_profile_id: '', provider_mode: 'unconfigured', provider_name: '',
    provider_request_id: '', confidence: null, output_metadata: {}, created_at: '2026-07-13T00:00:01.000Z',
    updated_at: '2026-07-13T00:00:01.000Z',
    ...overrides
  };
}
