import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TranslationProviderError,
  configuredTranslationProvider,
  createHttpTranslationProvider
} from '../src/agent-runtime/collaboration/translation-provider.js';

test('translation provider sends bounded opaque-source JSON and normalizes output', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createHttpTranslationProvider({
    mode: 'third_party',
    name: 'translation-cloud',
    profileId: 'translation-cloud-profile',
    baseUrl: 'https://translation.example.test/',
    endpoint: '/v2/translate',
    token: 'translation-secret',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        translated_text: ` translated ${'x'.repeat(210_000)} `,
        detected_language: 'ZH-cn',
        confidence: 0.97,
        provider_request_id: ' request id with spaces ',
        metadata: {
          model: 'translate-v3',
          api_key: 'must-not-survive',
          note: 'translation-secret'
        }
      }), { status: 200 });
    }
  });

  const output = await provider.translate({
    tenant_id: 'tenant-translate',
    session_id: 'session-translate',
    message_id: 'message-translate',
    source_type: 'message',
    source_ref_id: 'message-translate',
    source_ref: 'ivekit://message/message-translate',
    text: '你好',
    source_language: 'auto',
    target_language: 'EN-us'
  });

  assert.equal(requests[0]?.url, 'https://translation.example.test/v2/translate');
  assert.equal(requests[0]?.init?.redirect, 'manual');
  assert.equal(new Headers(requests[0]?.init?.headers).get('authorization'), 'Bearer translation-secret');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    source_ref: 'ivekit://message/message-translate',
    text: '你好',
    source_language: 'auto',
    target_language: 'en-US'
  });
  assert.equal(provider.profile_id, 'translation-cloud-profile');
  assert.equal(output.translated_text.length, 200_000);
  assert.equal(output.detected_language, 'zh-CN');
  assert.equal(output.confidence, 0.97);
  assert.equal(output.provider_request_id, 'request_id_with_spaces');
  assert.deepEqual(output.metadata, { model: 'translate-v3' });
});

test('translation provider validates opaque source refs and language tags before transport', async () => {
  let calls = 0;
  const provider = createHttpTranslationProvider({
    mode: 'self_hosted',
    baseUrl: 'http://translation-worker:8080',
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ translated_text: 'ok' }), { status: 200 });
    }
  });
  const base = {
    tenant_id: 'tenant-translate',
    session_id: 'session-translate',
    message_id: 'message-translate',
    source_type: 'attachment' as const,
    source_ref_id: 'attachment-translate',
    source_ref: 'ivekit://attachment/attachment-translate',
    text: 'source',
    source_language: 'auto',
    target_language: 'ja-JP'
  };

  await assert.rejects(
    () => provider.translate({ ...base, source_ref: 'https://storage.example/private-object' }),
    (error: unknown) => providerCode(error) === 'provider_source_ref_invalid'
  );
  await assert.rejects(
    () => provider.translate({ ...base, target_language: 'auto' }),
    (error: unknown) => providerCode(error) === 'target_language_invalid'
  );
  await assert.rejects(
    () => provider.translate({ ...base, source_language: 'not_a_locale' }),
    (error: unknown) => providerCode(error) === 'source_language_invalid'
  );
  assert.equal(calls, 0);
});

test('translation provider classifies HTTP, invalid, oversized, and timeout failures safely', async () => {
  for (const [status, retryable] of [[400, false], [408, true], [429, true], [503, true]] as const) {
    const provider = createHttpTranslationProvider({
      mode: 'self_hosted',
      baseUrl: 'http://translation-worker:8080',
      fetch: async () => new Response('failure body with private source', { status })
    });
    await assert.rejects(
      () => provider.translate(validInput('private source must not leak')),
      (error: unknown) =>
        error instanceof TranslationProviderError &&
        error.code === `provider_http_${status}` &&
        error.retryable === retryable &&
        !error.message.includes('private source')
    );
  }

  const invalid = createHttpTranslationProvider({
    mode: 'self_hosted',
    baseUrl: 'http://translation-worker:8080',
    fetch: async () => new Response('{invalid-json', { status: 200 })
  });
  await assert.rejects(
    () => invalid.translate(validInput('private invalid source')),
    (error: unknown) => providerCode(error) === 'provider_invalid_response'
  );

  const oversized = createHttpTranslationProvider({
    mode: 'self_hosted',
    baseUrl: 'http://translation-worker:8080',
    fetch: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': '1048577' }
    })
  });
  await assert.rejects(
    () => oversized.translate(validInput('private oversized source')),
    (error: unknown) => providerCode(error) === 'provider_response_too_large'
  );

  const timeout = createHttpTranslationProvider({
    mode: 'self_hosted',
    baseUrl: 'http://translation-worker:8080',
    timeoutMs: 1_000,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      const requestHandle = setTimeout(() => reject(new Error('request did not abort')), 2_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(requestHandle);
        reject(new Error('aborted'));
      }, { once: true });
    })
  });
  await assert.rejects(
    () => timeout.translate(validInput('private timeout source')),
    (error: unknown) => providerCode(error) === 'provider_timeout'
  );
});

test('legacy translation environment becomes a provider without enabling tenant automation', () => {
  const provider = configuredTranslationProvider({
    OPC_TRANSLATION_BASE_URL: 'http://translation-worker:8080',
    OPC_TRANSLATION_PROVIDER_NAME: 'legacy-translation-provider',
    OPC_TRANSLATION_TOKEN: 'legacy-translation-secret'
  });
  assert.equal(provider?.name, 'legacy-translation-provider');
  assert.equal(provider?.profile_id, 'legacy-translation');
  assert.equal(provider?.mode, 'self_hosted');
  assert.equal(JSON.stringify(provider).includes('legacy-translation-secret'), false);
});

function validInput(text: string) {
  return {
    tenant_id: 'tenant-translate',
    session_id: 'session-translate',
    message_id: 'message-translate',
    source_type: 'message' as const,
    source_ref_id: 'message-translate',
    source_ref: 'ivekit://message/message-translate',
    text,
    source_language: 'auto',
    target_language: 'en-US'
  };
}

function providerCode(error: unknown): string {
  return String((error as { code?: unknown })?.code || '');
}
