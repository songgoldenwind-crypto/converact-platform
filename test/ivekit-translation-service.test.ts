import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { AttachmentProcessingService } from '../src/agent-runtime/collaboration/attachment-processing.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import {
  TranslationService,
  type TranslationProviderResolution
} from '../src/agent-runtime/collaboration/translation-service.js';
import {
  TranslationProviderError,
  type TranslationProvider,
  type TranslationProviderInput
} from '../src/agent-runtime/collaboration/translation-provider.js';
import {
  TranslationWorker,
  translationWorkerConfig
} from '../src/agent-runtime/collaboration/translation-worker.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import {
  IntelligencePolicyStore,
  type IntelligencePolicyUpdate
} from '../src/agent-runtime/collaboration/intelligence-policy-store.js';
import { createPolicyTranslationProviderResolver } from '../src/agent-runtime/collaboration/intelligence-provider-routing.js';

test('translation jobs derive message source and enforce idempotency payload identity', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-message', '需要翻译的消息');
  const inputs: TranslationProviderInput[] = [];
  const service = new TranslationService({ pg, resolveProvider: resolver(provider(inputs)) });

  const requested = await service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'EN-us',
    idempotency_key: 'message-translation-key'
  });
  assert.equal(requested.replayed, false);
  assert.equal(requested.job.status, 'pending');
  assert.equal(requested.job.target_language, 'en-US');
  assert.equal(requested.job.source_hash.length, 64);
  assert.equal(JSON.stringify(requested.job).includes('需要翻译的消息'), false);

  const replay = await service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'en-US',
    idempotency_key: 'message-translation-key'
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, requested.job.id);
  await assert.rejects(
    () => service.requestTranslation({
      tenant_id: source.tenantId,
      session_id: source.sessionId,
      source_type: 'message',
      source_ref_id: source.messageId,
      target_language: 'ja-JP',
      idempotency_key: 'message-translation-key'
    }),
    (error: unknown) => errorStatus(error) === 409
  );

  assert.equal((await service.runDue({ tenant_id: source.tenantId })).succeeded, 1);
  assert.equal(inputs[0]?.text, '需要翻译的消息');
  assert.equal(inputs[0]?.source_ref, `ivekit://message/${source.messageId}`);
  const results = await service.listTranslations({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId
  });
  assert.equal(results.items[0]?.translated_text, 'translated result');
  assert.equal(results.items[0]?.source_hash, requested.job.source_hash);
});

test('tenant policy selects translation profile and enforces its automatic switch', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-policy', 'policy source');
  const registry = createIntelligenceProviderRegistry({
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'translation-policy-profile', capability: 'translation', mode: 'self_hosted',
      base_url: 'http://translation-worker:8080'
    }])
  });
  const policies = new IntelligencePolicyStore(pg, registry);
  await policies.updatePolicy({
    tenant_id: source.tenantId,
    actor_identity: 'translation-admin',
    expected_version: 0,
    policy: translationPolicy('translation-policy-profile', false)
  });
  const service = new TranslationService({
    pg,
    resolveProvider: createPolicyTranslationProviderResolver({
      pg,
      registry,
      fetch: async () => new Response(JSON.stringify({ translated_text: 'policy translation' }), { status: 200 })
    })
  });
  const disabled = await service.requestTranslation({
    tenant_id: source.tenantId, session_id: source.sessionId, source_type: 'message',
    source_ref_id: source.messageId, target_language: 'en-US', idempotency_key: 'policy-auto-off',
    automatic: true
  });
  assert.equal(disabled.job.status, 'cancelled');
  assert.equal(disabled.job.error_code, 'automatic_translation_disabled');

  await policies.updatePolicy({
    tenant_id: source.tenantId,
    actor_identity: 'translation-admin',
    expected_version: 1,
    policy: translationPolicy('translation-policy-profile', true)
  });
  const enabled = await service.requestTranslation({
    tenant_id: source.tenantId, session_id: source.sessionId, source_type: 'message',
    source_ref_id: source.messageId, target_language: 'ja-JP', idempotency_key: 'policy-auto-on',
    automatic: true
  });
  assert.equal(enabled.job.provider_profile_id, 'translation-policy-profile');
  assert.equal((await service.runDue({ tenant_id: source.tenantId })).succeeded, 1);
  assert.equal(
    (await service.getJob({ tenant_id: source.tenantId, job_id: enabled.job.id }))?.provider_profile_id,
    'translation-policy-profile'
  );
});

test('attachment translation waits for extracted text and sends only the current extraction', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-attachment', '', true);
  const service = new TranslationService({ pg, resolveProvider: resolver(provider([])) });

  await assert.rejects(
    () => service.requestTranslation({
      tenant_id: source.tenantId,
      session_id: source.sessionId,
      source_type: 'attachment',
      source_ref_id: source.attachmentId,
      target_language: 'ja-JP',
      idempotency_key: 'attachment-before-extraction'
    }),
    (error: unknown) => errorStatus(error) === 409
  );

  const message = await new CollaborationStore(pg).getMessage({
    tenant_id: source.tenantId,
    message_id: source.messageId
  });
  assert.ok(message);
  const attachments = new AttachmentProcessingService({
    pg,
    providers: {
      ocr: {
        processor: 'ocr',
        name: 'test-ocr',
        mode: 'self_hosted',
        extract: async () => ({ text: '图片提取后的文字' })
      }
    },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('image') })
  });
  await attachments.enqueueMessage(message);
  await attachments.runDue({ tenant_id: source.tenantId });

  const inputs: TranslationProviderInput[] = [];
  const readyService = new TranslationService({ pg, resolveProvider: resolver(provider(inputs)) });
  await readyService.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'attachment',
    source_ref_id: source.attachmentId,
    target_language: 'ja-JP',
    idempotency_key: 'attachment-after-extraction'
  });
  assert.equal((await readyService.runDue({ tenant_id: source.tenantId })).succeeded, 1);
  assert.equal(inputs[0]?.text, '图片提取后的文字');
  assert.equal(inputs[0]?.source_ref, `ivekit://attachment/${source.attachmentId}`);
});

test('translation jobs retry transient provider errors and converge to one result', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-retry', 'retry source');
  let calls = 0;
  const retryProvider: TranslationProvider = {
    name: 'retry-translation',
    mode: 'self_hosted',
    profile_id: 'retry-profile',
    translate: async () => {
      calls += 1;
      if (calls === 1) throw new TranslationProviderError('temporary', 'provider_http_503', true, 503);
      return { translated_text: 'retry succeeded', provider_request_id: 'retry-request' };
    }
  };
  const service = new TranslationService({
    pg,
    resolveProvider: resolver(retryProvider),
    retryDelaysMs: [0]
  });
  await service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'fr-FR',
    idempotency_key: 'retry-key'
  });

  assert.equal((await service.runDue({ tenant_id: source.tenantId })).retry_wait, 1);
  assert.equal((await service.runDue({ tenant_id: source.tenantId })).succeeded, 1);
  assert.equal(calls, 2);
  const results = await service.listTranslations({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    history: true
  });
  assert.equal(results.items.length, 1);
  assert.equal(results.items[0]?.provider_request_id, 'retry-request');
});

test('terminal transient failures can be retried but terminal validation failures cannot', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-manual-retry', 'manual retry source');
  let calls = 0;
  const service = new TranslationService({
    pg,
    maxAttempts: 1,
    provider: {
      name: 'manual-retry-provider',
      mode: 'self_hosted',
      translate: async () => {
        calls += 1;
        if (calls === 1) throw new TranslationProviderError('temporary', 'provider_http_503', true, 503);
        return { translated_text: 'manual retry succeeded' };
      }
    }
  });
  const requested = await service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'en-US',
    idempotency_key: 'manual-retry-key'
  });
  assert.equal((await service.runDue({ tenant_id: source.tenantId })).failed, 1);
  assert.equal((await service.retryJob({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    job_id: requested.job.id
  })).status, 'pending');
  assert.equal((await service.runDue({ tenant_id: source.tenantId })).succeeded, 1);

  const invalidService = new TranslationService({
    pg,
    maxAttempts: 1,
    provider: {
      name: 'invalid-provider',
      mode: 'self_hosted',
      translate: async () => {
        throw new TranslationProviderError('invalid', 'provider_invalid_response', false);
      }
    }
  });
  const invalid = await invalidService.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'ja-JP',
    idempotency_key: 'invalid-retry-key'
  });
  await invalidService.runDue({ tenant_id: source.tenantId });
  await assert.rejects(
    () => invalidService.retryJob({
      tenant_id: source.tenantId,
      session_id: source.sessionId,
      job_id: invalid.job.id
    }),
    (error: unknown) => errorStatus(error) === 409
  );
});

test('deleted messages cancel unfinished jobs and hide completed translations', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-delete', 'delete source');
  const service = new TranslationService({ pg, resolveProvider: resolver(provider([])) });
  const queued = await service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'de-DE',
    idempotency_key: 'delete-key'
  });
  await new CollaborationMessageStateStore(pg).deleteMessage({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    message_id: source.messageId,
    actor_identity: 'customer',
    reason: 'deleted'
  });

  assert.equal((await service.runDue({ tenant_id: source.tenantId })).claimed, 0);
  assert.equal((await service.getJob({ tenant_id: source.tenantId, job_id: queued.job.id }))?.status, 'cancelled');
  assert.deepEqual(await service.listTranslations({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    history: true
  }), { items: [], jobs: [] });
});

test('message edits create a new source version while preserving authorized history', async () => {
  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-edit', 'first version');
  let version = 0;
  const versionedProvider: TranslationProvider = {
    name: 'versioned-translation',
    mode: 'self_hosted',
    translate: async () => ({ translated_text: `translation-${++version}` })
  };
  const service = new TranslationService({ pg, resolveProvider: resolver(versionedProvider) });
  const request = (key: string) => service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'en-US',
    idempotency_key: key
  });
  await request('edit-v1');
  await service.runDue({ tenant_id: source.tenantId });
  await new CollaborationMessageStateStore(pg).editMessage({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    message_id: source.messageId,
    actor_identity: 'customer',
    body: 'second version'
  });
  await request('edit-v2');
  await service.runDue({ tenant_id: source.tenantId });

  const query = {
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message' as const,
    source_ref_id: source.messageId
  };
  assert.deepEqual((await service.listTranslations(query)).items.map((item) => item.translated_text), [
    'translation-2'
  ]);
  assert.deepEqual(
    new Set((await service.listTranslations({ ...query, history: true })).items.map((item) => item.translated_text)),
    new Set(['translation-1', 'translation-2'])
  );
});

test('translation workers coalesce batches and concurrent scans claim a job once', async () => {
  assert.equal(translationWorkerConfig({}).enabled, false);
  const config = translationWorkerConfig({
    OPC_TRANSLATION_BASE_URL: 'http://translation-worker:8080',
    OPC_TRANSLATION_WORKER_ENABLED: '1',
    OPC_TRANSLATION_BATCH_SIZE: '7'
  });
  assert.equal(config.enabled, true);
  assert.equal(config.batchSize, 7);

  let release!: (summary: { candidates: number; claimed: number; succeeded: number; retry_wait: number; failed: number }) => void;
  let batches = 0;
  const worker = new TranslationWorker({
    config,
    runBatch: () => {
      batches += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  await Promise.resolve();
  release({ candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0 });
  await first;
  assert.equal(batches, 1);

  const pg = new MemoryPg();
  const source = await createSourceMessage(pg, 'tenant-translation-concurrent', 'concurrent source');
  let providerCalls = 0;
  const concurrentProvider: TranslationProvider = {
    name: 'concurrent-translation',
    mode: 'self_hosted',
    translate: async () => {
      providerCalls += 1;
      await Promise.resolve();
      return { translated_text: 'one result' };
    }
  };
  const service = new TranslationService({ pg, resolveProvider: resolver(concurrentProvider) });
  await service.requestTranslation({
    tenant_id: source.tenantId,
    session_id: source.sessionId,
    source_type: 'message',
    source_ref_id: source.messageId,
    target_language: 'en-US',
    idempotency_key: 'concurrent-key'
  });
  const summaries = await Promise.all([
    service.runDue({ tenant_id: source.tenantId }),
    service.runDue({ tenant_id: source.tenantId })
  ]);
  assert.equal(summaries.reduce((sum, item) => sum + item.claimed, 0), 1);
  assert.equal(providerCalls, 1);
  await worker.stop();
});

function provider(inputs: TranslationProviderInput[]): TranslationProvider {
  return {
    name: 'translation-test',
    mode: 'self_hosted',
    profile_id: 'translation-test-profile',
    translate: async (input) => {
      inputs.push(input);
      return {
        translated_text: 'translated result',
        detected_language: 'zh-CN',
        confidence: 0.9,
        provider_request_id: 'translation-request',
        metadata: { model: 'translation-test' }
      };
    }
  };
}

function resolver(providerValue: TranslationProvider) {
  return async (): Promise<TranslationProviderResolution> => ({
    enabled: true,
    automatic: true,
    profile_id: providerValue.profile_id || '',
    provider: providerValue,
    error_code: ''
  });
}

async function createSourceMessage(
  pg: MemoryPg,
  tenantId: string,
  body: string,
  attachment = false
) {
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: `${tenantId}-order` }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'customer',
    role: 'customer'
  });
  const message = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer',
    message_type: attachment ? 'image' : 'text',
    body,
    attachments: attachment ? [{
      kind: 'image',
      storage_url: 's3://translation/source.png',
      content_type: 'image/png',
      processing_status: 'pending'
    }] : undefined
  });
  return {
    tenantId,
    sessionId: session.id,
    messageId: message.id,
    attachmentId: message.attachments[0]?.id || ''
  };
}

function errorStatus(error: unknown): number {
  return Number((error as { status?: unknown })?.status || 0);
}

function translationPolicy(profileId: string, automatic: boolean): IntelligencePolicyUpdate {
  return {
    ocr_enabled: false, asr_enabled: false, quality_review_enabled: false,
    translation_enabled: true, ocr_profile_id: '', asr_profile_id: '', quality_profile_id: '',
    translation_profile_id: profileId, allow_third_party: false, auto_ocr: false, auto_asr: false,
    auto_quality_review: false, auto_translation: automatic,
    translation_target_languages: automatic ? ['en-US', 'ja-JP'] : [],
    min_ocr_confidence: 0, min_asr_confidence: 0
  };
}
