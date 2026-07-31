import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { IveKitClient, IveKitTranslationListResult, IveKitTranslationRequestInput } from '@converact/sdk';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { installTestDom } from '../test-dom.js';
import { TranslationPanel } from './translation-panel.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('translation panel requests the selected language and preserves surrounding source text', async () => {
  const requests: Array<{ target_language: string; idempotencyKey: string }> = [];
  const lists: IveKitTranslationListResult[] = [
    { items: [], jobs: [] },
    { items: [], jobs: [translationJob('pending')] }
  ];
  const client = fakeClient({
    listMessageTranslations: async () => lists.shift() || { items: [], jobs: [translationJob('pending')] },
    requestMessageTranslation: async (
      _sessionId: string,
      _messageId: string,
      input: IveKitTranslationRequestInput,
      options: { idempotencyKey: string }
    ) => {
      requests.push({ target_language: input.target_language, idempotencyKey: options.idempotencyKey });
      return { job: translationJob('pending'), replayed: false };
    }
  });
  const view = render(<div><p>Original source</p><TranslationPanel
    client={client}
    sessionId="session-1"
    sourceType="message"
    sourceRefId="message-1"
  /></div>);

  fireEvent.click(view.getByTitle('Translate message'));
  fireEvent.change(view.getByLabelText('Target language'), { target: { value: 'zh-CN' } });
  fireEvent.click(view.getByRole('button', { name: 'Translate' }));

  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal(requests[0].target_language, 'zh-CN');
  assert.ok(requests[0].idempotencyKey);
  assert.ok(view.getByText('Original source'));
  await waitFor(() => assert.ok(view.getByText('Queued')));
});

test('translation panel shows translated text and only retryable failures expose retry', async () => {
  const retries: string[] = [];
  const client = fakeClient({
    listMessageTranslations: async () => ({
      items: [translationResult('zh-CN', '已翻译')],
      jobs: [
        translationJob('succeeded', { target_language: 'zh-CN' }),
        translationJob('failed', { id: 'job-timeout', target_language: 'de-DE', error_code: 'provider_timeout' }),
        translationJob('failed', { id: 'job-invalid', target_language: 'fr-FR', error_code: 'invalid_response' })
      ]
    }),
    retryTranslation: async (_sessionId: string, jobId: string) => {
      retries.push(jobId);
      return { job: translationJob('pending', { id: jobId }) };
    }
  });
  const view = render(<TranslationPanel client={client} sessionId="session-1" sourceType="message" sourceRefId="message-1" />);

  fireEvent.click(view.getByTitle('Translate message'));
  await waitFor(() => assert.ok(view.getByText('已翻译')));
  assert.equal(view.getAllByRole('button', { name: 'Retry translation' }).length, 1);
  fireEvent.click(view.getByRole('button', { name: 'Retry translation' }));
  await waitFor(() => assert.deepEqual(retries, ['job-timeout']));
});

function fakeClient(chat: Record<string, unknown>): IveKitClient {
  return { chat } as unknown as IveKitClient;
}

function translationJob(status: 'pending' | 'succeeded' | 'failed', overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', tenant_id: 'tenant-1', session_id: 'session-1', message_id: 'message-1',
    source_type: 'message', source_ref_id: 'message-1', source_language: 'auto', target_language: 'zh-CN',
    source_hash: 'source-hash', status, attempt_count: 0, max_attempts: 3, provider_profile_id: '',
    provider_mode: 'unconfigured', provider_name: '', provider_request_id: '', error_code: '', automatic: false,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z', completed_at: null,
    ...overrides
  } as const;
}

function translationResult(targetLanguage: string, translatedText: string) {
  return {
    id: `result-${targetLanguage}`, tenant_id: 'tenant-1', message_id: 'message-1', source_type: 'message',
    source_ref_id: 'message-1', source_hash: 'source-hash', source_language: 'auto', target_language: targetLanguage,
    translated_text: translatedText, provider_profile_id: '', provider_mode: 'unconfigured', provider_name: '',
    provider_request_id: '', confidence: null, output_metadata: {}, created_at: '2026-07-13T00:00:01.000Z',
    updated_at: '2026-07-13T00:00:01.000Z'
  } as const;
}
