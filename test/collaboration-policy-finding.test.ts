import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { AttachmentProcessingService } from '../src/agent-runtime/collaboration/attachment-processing.js';
import { PolicyFindingStore } from '../src/agent-runtime/collaboration/policy-finding-store.js';
import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import {
  QualityReviewService,
  createHttpQualityReviewProvider,
  type QualityReviewProvider
} from '../src/agent-runtime/collaboration/quality-review.js';
import {
  QualityReviewWorker,
  qualityReviewWorkerConfig
} from '../src/agent-runtime/collaboration/quality-review-worker.js';
import { inspectQualityReviewEnv } from '../scripts/quality-review-preflight.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import {
  IntelligencePolicyStore,
  type IntelligencePolicyUpdate
} from '../src/agent-runtime/collaboration/intelligence-policy-store.js';
import { createPolicyQualityReviewProviderResolver } from '../src/agent-runtime/collaboration/intelligence-provider-routing.js';
import { IntelligenceProviderRouteError } from '../src/agent-runtime/collaboration/intelligence-provider-route.js';

const API_KEY = 'policy-finding-api-key';

test('rule scans create idempotent text findings without storing matched plaintext', async () => {
  const pg = new MemoryPg();
  const { store, tenantId, sessionId, messageId } = await createMessage(pg, '请加微信，电话 13800138000');
  const scanInput = {
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'text' as const,
    source_ref_id: messageId,
    evidence_refs: [{ type: 'message', id: messageId }],
    text: '请加微信，电话 13800138000'
  };

  await store.scanPolicy(scanInput);
  await store.scanPolicy(scanInput);

  const findings = await new PolicyFindingStore(pg).listFindings({
    tenant_id: tenantId,
    session_id: sessionId
  });
  assert.equal(findings.length, 2);
  assert.equal(findings.some((finding) => finding.policy_type === 'phone_number'), true);
  assert.equal(findings.some((finding) => finding.policy_type === 'wechat'), true);
  assert.equal(findings.every((finding) => finding.source === 'text'), true);
  assert.equal(findings.every((finding) => finding.review_status === 'pending'), true);
  assert.equal(findings.every((finding) => finding.matched_text_hash.length === 64), true);
  const serialized = JSON.stringify(findings);
  assert.doesNotMatch(serialized, /13800138000/);
  assert.match(serialized, new RegExp(messageId));
});

test('OCR and ASR findings preserve source and attachment evidence references', async () => {
  const pg = new MemoryPg();
  const { store, tenantId, sessionId, messageId } = await createMessage(pg, 'normal message');
  await store.scanPolicy({
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'ocr',
    source_ref_id: 'attachment-image-1',
    evidence_refs: [{ type: 'attachment', id: 'attachment-image-1', processor: 'ocr' }],
    text: '图片号码 13700001111'
  });
  await store.scanPolicy({
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'asr',
    source_ref_id: 'attachment-audio-1',
    evidence_refs: [{ type: 'attachment', id: 'attachment-audio-1', processor: 'asr' }],
    text: '语音说 call me 13600001111'
  });

  const findings = await new PolicyFindingStore(pg).listFindings({
    tenant_id: tenantId,
    session_id: sessionId
  });
  const ocr = findings.find((finding) => finding.source === 'ocr');
  const asr = findings.find((finding) => finding.source === 'asr');
  assert.equal(ocr?.source_ref_id, 'attachment-image-1');
  assert.deepEqual(ocr?.evidence_refs, [{ type: 'attachment', id: 'attachment-image-1', processor: 'ocr' }]);
  assert.equal(asr?.source_ref_id, 'attachment-audio-1');
});

test('policy findings preserve UUID-shaped evidence identifiers while redacting free text', async () => {
  const pg = new MemoryPg();
  const store = new PolicyFindingStore(pg);
  const evidenceId = 'cmsg_abcd-1234-5678-90ef';

  const finding = await store.recordFinding({
    tenant_id: 'tenant-evidence-id',
    session_id: 'session-evidence-id',
    message_id: evidenceId,
    source: 'ai',
    policy_type: 'evidence_integrity',
    severity: 'medium',
    matched_text_hash: 'a'.repeat(64),
    evidence_refs: [{
      type: 'message',
      id: evidenceId,
      message_id: evidenceId,
      note: 'call 13800138000'
    }]
  });

  assert.equal(finding.evidence_refs[0]?.id, evidenceId);
  assert.equal(finding.evidence_refs[0]?.message_id, evidenceId);
  assert.equal(finding.evidence_refs[0]?.note, 'call [phone]');
});

test('human review enforces transitions, redacts notes, and appends immutable audit history', async () => {
  const pg = new MemoryPg();
  const { store, tenantId, sessionId, messageId } = await createMessage(pg, 'outside the app 13500001111');
  await store.scanPolicy({
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'text',
    source_ref_id: messageId,
    text: 'outside the app 13500001111'
  });
  const findings = new PolicyFindingStore(pg);
  const finding = (await findings.listFindings({ tenant_id: tenantId, session_id: sessionId }))[0];
  assert.ok(finding);

  const confirmed = await findings.reviewFinding({
    tenant_id: tenantId,
    finding_id: finding.id,
    review_status: 'confirmed',
    reviewed_by: 'supervisor-1',
    note: '客户号码 13500001111 需要复核'
  });
  assert.equal(confirmed.review_status, 'confirmed');
  assert.doesNotMatch(confirmed.review_note, /13500001111/);
  assert.match(confirmed.review_note, /\[phone\]/);

  const resolved = await findings.reviewFinding({
    tenant_id: tenantId,
    finding_id: finding.id,
    review_status: 'resolved',
    reviewed_by: 'supervisor-2',
    note: '已完成处置'
  });
  assert.equal(resolved.review_status, 'resolved');
  await assert.rejects(
    () => findings.reviewFinding({
      tenant_id: tenantId,
      finding_id: finding.id,
      review_status: 'escalated',
      reviewed_by: 'supervisor-3'
    }),
    /invalid finding review transition/
  );

  const history = await findings.listReviews({
    tenant_id: tenantId,
    finding_id: finding.id
  });
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((review) => review.to_status), ['confirmed', 'resolved']);
  assert.deepEqual(history.map((review) => review.reviewed_by), ['supervisor-1', 'supervisor-2']);
});

test('policy finding migration defines fingerprints, review audit, and forced tenant RLS', () => {
  const migration = readFileSync('src/migrations/028_collaboration_policy_findings.sql', 'utf8');
  assert.match(migration, /collaboration_policy_findings/);
  assert.match(migration, /fingerprint/);
  assert.match(migration, /matched_text_hash/);
  assert.match(migration, /evidence_refs/);
  assert.match(migration, /review_status/);
  assert.match(migration, /collaboration_policy_finding_reviews/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
});

test('collaboration HTTP lists, reviews, and audits tenant-scoped findings', async () => {
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_finding_http';
  const headers = {
    'x-api-key': API_KEY,
    'x-tenant-id': tenantId,
    'x-user-id': 'supervisor-http'
  };
  const route = (method: string, path: string, body: unknown) => routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers
  );
  try {
    const opened = await route('POST', '/api/collaboration/sessions', {
      business_ref: { type: 'service_order', id: 'order-finding-http' }
    }) as { data: { id: string } };
    await route('POST', `/api/collaboration/sessions/${opened.data.id}/participants`, {
      identity: 'supervisor-http', role: 'supervisor'
    });
    await route('POST', `/api/collaboration/sessions/${opened.data.id}/participants`, {
      identity: 'customer-review', role: 'customer'
    });
    const posted = await route(
      'POST',
      `/api/collaboration/sessions/${opened.data.id}/messages`,
      { sender_identity: 'customer', body: '请加微信，号码 13900001111' }
    ) as { data: { policy: { findings: Array<{ id: string }> } } };
    assert.equal(posted.data.policy.findings.length, 2);

    const list = await route(
      'GET',
      `/api/collaboration/sessions/${opened.data.id}/findings?source=text&review_status=pending`,
      null
    ) as { data: { findings: Array<{ id: string; review_status: string }> } };
    assert.equal(list.data.findings.length, 2);
    const findingId = list.data.findings[0]!.id;

    const denied = await routeCollaborationApi(
      pg,
      'POST',
      `/api/collaboration/sessions/${opened.data.id}/findings/${findingId}/review`,
      new URL(`http://localhost/api/collaboration/sessions/${opened.data.id}/findings/${findingId}/review`),
      { review_status: 'confirmed', note: 'Customer cannot review policy findings' },
      '',
      { 'x-api-key': API_KEY, 'x-tenant-id': tenantId, 'x-user-id': 'customer-review' }
    ) as { status: number; data: { error: string } };
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /authorized active participant/);

    const reviewed = await route(
      'POST',
      `/api/collaboration/sessions/${opened.data.id}/findings/${findingId}/review`,
      { review_status: 'false_positive', note: '误报，联系邮箱 user@example.com' }
    ) as { status: number; data: { finding: { review_status: string; review_note: string } } };
    assert.equal(reviewed.status, 201);
    assert.equal(reviewed.data.finding.review_status, 'false_positive');
    assert.doesNotMatch(reviewed.data.finding.review_note, /user@example\.com/);

    const replayed = await route(
      'POST',
      `/api/collaboration/sessions/${opened.data.id}/findings/${findingId}/review`,
      { review_status: 'false_positive', note: 'Idempotent replay' }
    ) as { status: number; data: { review: unknown } };
    assert.equal(replayed.status, 200);
    assert.equal(replayed.data.review, null);

    const detail = await route(
      'GET',
      `/api/collaboration/sessions/${opened.data.id}/findings/${findingId}`,
      null
    ) as { data: { finding: { id: string }; reviews: Array<{ reviewed_by: string }> } };
    assert.equal(detail.data.finding.id, findingId);
    assert.equal(detail.data.reviews[0]?.reviewed_by, 'supervisor-http');

    const crossTenant = await routeCollaborationApi(
      pg,
      'GET',
      `/api/collaboration/sessions/${opened.data.id}/findings`,
      new URL(`http://localhost/api/collaboration/sessions/${opened.data.id}/findings`),
      null,
      '',
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant_finding_other',
        'x-user-id': 'other'
      }
    );
    assert.deepEqual(crossTenant, {
      status: 404,
      data: { error: 'collaboration session not found' }
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.CONVERACT_API_KEY;
    else process.env.CONVERACT_API_KEY = previousApiKey;
  }
});

test('AI quality review jobs aggregate content and create advisory redacted findings', async () => {
  const pg = new MemoryPg();
  const { store, tenantId, sessionId, messageId } = await createMessage(
    pg,
    '我们可以换个平台继续聊'
  );
  await store.scanPolicy({
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'text',
    source_ref_id: messageId,
    text: '我们可以换个平台继续聊'
  });
  const providerInputs: string[] = [];
  const provider: QualityReviewProvider = {
    name: 'self-hosted-quality',
    mode: 'self_hosted',
    review: async (input) => {
      providerInputs.push(input.content);
      return {
        findings: [{
          policy_type: 'suspected_off_platform_intent',
          severity: 'high',
          confidence: 0.91,
          recommended_action: 'block_order',
          rationale: '用户可能要求线下联系 13800138000，邮箱 qa@example.com',
          matched_text: '换个平台继续聊',
          metadata: { provider_note: '联系 13900139000 或 ai-meta@example.com' }
        }],
        metadata: { summary: '可能涉及 13700137000 和 job-meta@example.com' }
      };
    }
  };
  const service = new QualityReviewService({ pg, provider });
  const job = await service.enqueueMessage({ tenant_id: tenantId, message_id: messageId });
  assert.equal(job?.status, 'pending');

  const summary = await service.runDue({ tenant_id: tenantId });
  assert.deepEqual(summary, { candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0 });
  assert.match(providerInputs[0] || '', /\[message source=text/);
  assert.match(providerInputs[0] || '', /我们可以换个平台继续聊/);
  const aiFindings = await new PolicyFindingStore(pg).listFindings({
    tenant_id: tenantId,
    session_id: sessionId,
    source: 'ai'
  });
  assert.equal(aiFindings.length, 1);
  assert.equal(aiFindings[0]?.action, 'review');
  assert.equal(aiFindings[0]?.metadata.recommended_action, 'block_order');
  assert.equal(aiFindings[0]?.review_status, 'pending');
  assert.match(aiFindings[0]?.rationale || '', /\[phone\]/);
  assert.match(aiFindings[0]?.rationale || '', /\[email\]/);
  assert.doesNotMatch(
    JSON.stringify(aiFindings),
    /13800138000|qa@example\.com|13900139000|ai-meta@example\.com|换个平台继续聊/
  );
  const completedJob = await service.getJob({ tenant_id: tenantId, message_id: messageId });
  assert.doesNotMatch(JSON.stringify(completedJob), /13700137000|job-meta@example\.com/);
  assert.match(JSON.stringify(completedJob), /\[phone\]|\[email\]/);
});

test('finding filters are applied before limit so matching review work is not hidden', async () => {
  const pg = new MemoryPg();
  const { tenantId, sessionId, messageId } = await createMessage(pg, 'filter test');
  const findings = new PolicyFindingStore(pg);
  await findings.recordFinding({
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'text',
    policy_type: 'text-first',
    severity: 'low',
    matched_text_hash: '1'.repeat(64)
  });
  await findings.recordFinding({
    tenant_id: tenantId,
    session_id: sessionId,
    message_id: messageId,
    source: 'ai',
    policy_type: 'ai-second',
    severity: 'medium',
    matched_text_hash: '2'.repeat(64)
  });

  const result = await findings.listFindings({
    tenant_id: tenantId,
    session_id: sessionId,
    source: 'ai',
    limit: 1
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.policy_type, 'ai-second');
});

test('quality review requeues a changed OCR input before calling the provider', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_quality_input_change';
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-quality-change' }
  });
  const message = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer',
    message_type: 'image',
    body: '先检查文本',
    attachments: [{
      kind: 'image',
      storage_url: 's3://quality/change.png',
      content_type: 'image/png',
      processing_status: 'pending'
    }]
  });
  let providerCalls = 0;
  const quality = new QualityReviewService({
    pg,
    provider: {
      name: 'quality-change-provider',
      mode: 'self_hosted',
      review: async () => {
        providerCalls += 1;
        return { findings: [] };
      }
    }
  });
  const original = await quality.enqueueMessage({ tenant_id: tenantId, message_id: message.id });
  const attachments = new AttachmentProcessingService({
    pg,
    providers: {
      ocr: {
        processor: 'ocr',
        name: 'quality-change-ocr',
        mode: 'self_hosted',
        extract: async () => ({ text: '图片后来识别出手机号 13800138000' })
      }
    },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('image') })
  });
  await attachments.enqueueMessage(message);
  await attachments.runDue({ tenant_id: tenantId });

  const first = await quality.runDue({ tenant_id: tenantId });
  assert.equal(first.retry_wait, 1);
  assert.equal(providerCalls, 0);
  const refreshed = await quality.getJob({ tenant_id: tenantId, message_id: message.id });
  assert.equal(refreshed?.status, 'pending');
  assert.notEqual(refreshed?.input_hash, original?.input_hash);

  const second = await quality.runDue({ tenant_id: tenantId });
  assert.equal(second.succeeded, 1);
  assert.equal(providerCalls, 1);
});

test('unconfigured AI quality provider keeps hashed durable work pending', async () => {
  const pg = new MemoryPg();
  const { tenantId, messageId } = await createMessage(pg, '普通会话文本');
  const service = new QualityReviewService({ pg, provider: null });
  const job = await service.enqueueMessage({ tenant_id: tenantId, message_id: messageId });
  assert.equal(job?.status, 'pending');
  assert.equal(job?.input_hash.length, 64);
  assert.equal(JSON.stringify(job).includes('普通会话文本'), false);
  const summary = await service.runDue({ tenant_id: tenantId });
  assert.equal(summary.candidates, 1);
  assert.equal(summary.claimed, 0);
});

test('route reservation denial reschedules quality review without consuming an attempt', async () => {
  const pg = new MemoryPg();
  const { tenantId, messageId } = await createMessage(pg, 'quality quota input');
  const retryAt = '2026-07-10T00:01:00.000Z';
  const service = new QualityReviewService({
    pg,
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    provider: {
      name: 'quota-quality', mode: 'self_hosted',
      review: async () => {
        throw new IntelligenceProviderRouteError([{
          profile_id: 'quota-quality', status: 'skipped',
          code: 'concurrency_exhausted', retry_at: retryAt
        }]);
      }
    }
  });
  await service.enqueueMessage({ tenant_id: tenantId, message_id: messageId });
  assert.equal((await service.runDue({ tenant_id: tenantId })).retry_wait, 1);
  const job = await service.getJob({ tenant_id: tenantId, message_id: messageId });
  assert.equal(job?.attempt_count, 0);
  assert.equal(job?.next_attempt_at, retryAt);
  assert.equal(job?.output_metadata.ivekit_route_provider_invoked, false);
});

test('tenant intelligence policy selects and retains the quality provider profile', async () => {
  const pg = new MemoryPg();
  const { tenantId, messageId } = await createMessage(pg, '请判断是否存在私下联系意图');
  const requests: string[] = [];
  const registry = createIntelligenceProviderRegistry({
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'quality-tenant-profile',
      capability: 'quality_review',
      mode: 'self_hosted',
      base_url: 'http://quality-worker:8080'
    }])
  });
  await new IntelligencePolicyStore(pg, registry).updatePolicy({
    tenant_id: tenantId,
    actor_identity: 'quality-admin',
    expected_version: 0,
    policy: qualityPolicy('quality-tenant-profile', true)
  });
  const service = new QualityReviewService({
    pg,
    resolveProvider: createPolicyQualityReviewProviderResolver({
      pg,
      registry,
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ findings: [] }), { status: 200 });
      }
    })
  });

  const job = await service.enqueueMessage({ tenant_id: tenantId, message_id: messageId });
  assert.equal(job?.provider_profile_id, 'quality-tenant-profile');
  assert.equal(job?.status, 'pending');
  assert.equal((await service.runDue({ tenant_id: tenantId })).succeeded, 1);
  assert.equal(requests[0], 'http://quality-worker:8080/v1/quality-review');
  assert.equal(
    (await service.getJob({ tenant_id: tenantId, message_id: messageId }))?.provider_profile_id,
    'quality-tenant-profile'
  );
});

test('quality policy can disable automatic review while retaining manual review', async () => {
  const pg = new MemoryPg();
  const { tenantId, messageId } = await createMessage(pg, 'manual quality review');
  const registry = createIntelligenceProviderRegistry({
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'quality-manual-profile',
      capability: 'quality_review',
      mode: 'self_hosted',
      base_url: 'http://quality-worker:8080'
    }])
  });
  const policies = new IntelligencePolicyStore(pg, registry);
  await policies.updatePolicy({
    tenant_id: tenantId,
    actor_identity: 'quality-admin',
    expected_version: 0,
    policy: qualityPolicy('quality-manual-profile', true)
  });
  const service = new QualityReviewService({
    pg,
    resolveProvider: createPolicyQualityReviewProviderResolver({
      pg,
      registry,
      fetch: async () => new Response(JSON.stringify({ findings: [] }), { status: 200 })
    })
  });

  const queued = await service.enqueueMessage({ tenant_id: tenantId, message_id: messageId });
  assert.equal(queued?.status, 'pending');
  await policies.updatePolicy({
    tenant_id: tenantId,
    actor_identity: 'quality-admin',
    expected_version: 1,
    policy: qualityPolicy('quality-manual-profile', false)
  });
  assert.equal((await service.runDue({ tenant_id: tenantId })).claimed, 0);
  assert.equal(
    (await service.getJob({ tenant_id: tenantId, message_id: messageId }))?.error_code,
    'automatic_quality_review_disabled'
  );

  const automatic = await service.enqueueMessage({ tenant_id: tenantId, message_id: messageId });
  assert.equal(automatic?.status, 'cancelled');
  assert.equal(automatic?.error_code, 'automatic_quality_review_disabled');

  const manual = await service.enqueueMessage(
    { tenant_id: tenantId, message_id: messageId },
    { automatic: false }
  );
  assert.equal(manual?.status, 'pending');
  assert.equal(manual?.error_code, '');
  assert.equal((await service.runDue({ tenant_id: tenantId })).succeeded, 1);
});

test('generic HTTP AI quality provider supports self-hosted and third-party endpoints', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createHttpQualityReviewProvider({
    mode: 'third_party',
    name: 'quality-http',
    baseUrl: 'https://quality.example.test/',
    token: 'quality-secret',
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        findings: [{
          policy_type: 'contact_exchange',
          severity: 'medium',
          confidence: 0.8,
          rationale: 'suspected contact exchange'
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const output = await provider.review({
    tenant_id: 'tenant-ai',
    session_id: 'session-ai',
    message_id: 'message-ai',
    content: 'review me',
    content_hash: 'a'.repeat(64),
    rule_findings: [],
    evidence_refs: []
  });
  assert.equal(requests[0]?.url, 'https://quality.example.test/v1/quality-review');
  assert.equal(requests[0]?.init?.redirect, 'manual');
  assert.equal(new Headers(requests[0]?.init?.headers).get('authorization'), 'Bearer quality-secret');
  assert.equal(output.findings[0]?.policy_type, 'contact_exchange');
});

test('generic HTTP AI quality provider bounds and sanitizes untrusted output', async () => {
  const provider = createHttpQualityReviewProvider({
    mode: 'self_hosted',
    baseUrl: 'http://quality-worker:8080',
    fetch: async () => new Response(JSON.stringify({
      findings: Array.from({ length: 150 }, (_, index) => ({
        policy_type: `policy-${index}-${'p'.repeat(150)}`,
        severity: 'critical',
        confidence: 5,
        recommended_action: 'a'.repeat(150),
        rationale: 'r'.repeat(1_500),
        matched_text: 'm'.repeat(2_500),
        metadata: { model: 'quality-v3', api_key: 'must-not-survive' }
      })),
      metadata: { summary: 'bounded', token: 'must-not-survive' }
    }), { status: 200 })
  });

  const output = await provider.review({
    tenant_id: 'tenant-bounds',
    session_id: 'session-bounds',
    message_id: 'message-bounds',
    content: 'review me',
    content_hash: 'b'.repeat(64),
    rule_findings: [],
    evidence_refs: []
  });
  assert.equal(output.findings.length, 100);
  assert.equal(output.findings[0]?.policy_type.length, 100);
  assert.equal(output.findings[0]?.recommended_action?.length, 100);
  assert.equal(output.findings[0]?.rationale?.length, 1_000);
  assert.equal(output.findings[0]?.matched_text?.length, 2_000);
  assert.equal(output.findings[0]?.severity, 'medium');
  assert.equal(output.findings[0]?.confidence, undefined);
  assert.doesNotMatch(JSON.stringify(output), /must-not-survive|api_key|token/);
});

test('quality review migration defines hashed leased jobs and forced tenant RLS', () => {
  const migration = readFileSync('src/migrations/029_collaboration_quality_review.sql', 'utf8');
  assert.match(migration, /collaboration_quality_review_jobs/);
  assert.match(migration, /input_hash/);
  assert.match(migration, /lease_until/);
  assert.match(migration, /retry_wait/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(readFileSync('src/agent-runtime/collaboration/policy-finding-store.ts', 'utf8'), /FOR UPDATE/);
});

test('collaboration HTTP automatically enqueues and runs AI quality review jobs', async () => {
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_quality_http';
  const headers = {
    'x-api-key': API_KEY,
    'x-tenant-id': tenantId,
    'x-user-id': 'quality-supervisor'
  };
  const provider: QualityReviewProvider = {
    name: 'quality-http-provider',
    mode: 'self_hosted',
    review: async () => ({
      findings: [{
        policy_type: 'off_platform_intent',
        severity: 'medium',
        confidence: 0.83,
        rationale: '建议人工检查',
        recommended_action: 'warn_agent'
      }]
    })
  };
  const options = { qualityReview: { provider } };
  const route = (method: string, path: string, body: unknown) => routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers,
    options
  );
  try {
    const opened = await route('POST', '/api/collaboration/sessions', {
      business_ref: { type: 'service_order', id: 'order-quality-http' }
    }) as { data: { id: string } };
    const posted = await route(
      'POST',
      `/api/collaboration/sessions/${opened.data.id}/messages`,
      { sender_identity: 'customer', body: '我们换个平台继续沟通' }
    ) as {
      data: {
        message: { id: string };
        quality_review_job: { status: string; input_hash: string };
      };
    };
    assert.equal(posted.data.quality_review_job.status, 'pending');
    assert.equal(posted.data.quality_review_job.input_hash.length, 64);

    const run = await route('POST', '/api/collaboration/quality-review/run', { limit: 10 }) as {
      data: { succeeded: number };
    };
    assert.equal(run.data.succeeded, 1);

    const status = await route(
      'GET',
      `/api/collaboration/sessions/${opened.data.id}/messages/${posted.data.message.id}/quality-review`,
      null
    ) as { data: { job: { status: string } } };
    assert.equal(status.data.job.status, 'succeeded');

    const findings = await route(
      'GET',
      `/api/collaboration/sessions/${opened.data.id}/findings?source=ai`,
      null
    ) as { data: { findings: Array<{ source: string }> } };
    assert.equal(findings.data.findings[0]?.source, 'ai');
  } finally {
    if (previousApiKey === undefined) delete process.env.CONVERACT_API_KEY;
    else process.env.CONVERACT_API_KEY = previousApiKey;
  }
});

test('quality review worker validates config and coalesces concurrent batches', async () => {
  assert.equal(qualityReviewWorkerConfig({}).enabled, false);
  const config = qualityReviewWorkerConfig({
    CONVERACT_QUALITY_REVIEW_BASE_URL: 'http://quality.internal:8080',
    CONVERACT_QUALITY_REVIEW_WORKER_ENABLED: '1',
    CONVERACT_QUALITY_REVIEW_INTERVAL_MS: '3000',
    CONVERACT_QUALITY_REVIEW_BATCH_SIZE: '9',
    CONVERACT_QUALITY_REVIEW_MAX_ATTEMPTS: '4',
    CONVERACT_QUALITY_REVIEW_CLAIM_LEASE_MS: '90000',
    CONVERACT_QUALITY_REVIEW_RETRY_DELAYS_MS: '2000,9000'
  });
  assert.equal(config.enabled, true);
  assert.equal(config.batchSize, 9);
  let resolveRun!: (value: { candidates: number; claimed: number; succeeded: number; retry_wait: number; failed: number }) => void;
  let calls = 0;
  const worker = new QualityReviewWorker({
    config,
    runBatch: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    }
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  resolveRun({ candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0 });
  await first;
  assert.equal(calls, 1);
  await worker.stop();
});

test('quality worker claim lease covers the longest configured provider reservation', () => {
  const config = qualityReviewWorkerConfig({
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'slow-quality', capability: 'quality_review', mode: 'self_hosted',
      base_url: 'http://slow-quality:8080', timeout_ms: 300_000,
      reservation_ttl_ms: 305_000
    }]),
    CONVERACT_QUALITY_REVIEW_CLAIM_LEASE_MS: '120000'
  });
  assert.equal(config.claimLeaseMs >= 310_000, true);
});

test('production server starts quality worker and refreshes review after attachment extraction', () => {
  const server = readFileSync('src/server.ts', 'utf8');
  const application = readFileSync('src/agent-runtime/converact/application.ts', 'utf8');
  assert.match(server, /startIveKitApplication/);
  assert.match(server, /await iveKitApplication\.stop\(\)/);
  assert.match(application, /startQualityReviewWorker/);
  assert.match(application, /qualityReviewEnqueuer\.enqueueMessage/);
});

test('quality review preflight validates PostgreSQL and provider settings without leaking secrets', () => {
  const missing = inspectQualityReviewEnv({});
  assert.equal(missing.ready, false);
  assert.equal(missing.issues.some((issue) => issue.includes('DATABASE_URL')), true);
  assert.equal(missing.issues.some((issue) => issue.includes('provider base URL')), true);

  const configured = inspectQualityReviewEnv({
    DATABASE_URL: 'postgres://opc:database-secret@postgres:5432/opc',
    CONVERACT_QUALITY_REVIEW_PROVIDER_MODE: 'third_party',
    CONVERACT_QUALITY_REVIEW_PROVIDER_NAME: 'quality-vendor',
    CONVERACT_QUALITY_REVIEW_BASE_URL: 'https://quality.example.test',
    CONVERACT_QUALITY_REVIEW_ENDPOINT: '/v2/review',
    CONVERACT_QUALITY_REVIEW_TOKEN: 'quality-super-secret',
    CONVERACT_QUALITY_REVIEW_TIMEOUT_MS: '15000',
    CONVERACT_QUALITY_REVIEW_AUTO_ENQUEUE: '1',
    CONVERACT_QUALITY_REVIEW_WORKER_ENABLED: '1'
  });
  assert.equal(configured.ready, true);
  assert.equal(configured.provider.mode, 'third_party');
  assert.equal(configured.worker?.enabled, true);
  const serialized = JSON.stringify(configured);
  assert.doesNotMatch(serialized, /database-secret|quality-super-secret|postgres:\/\/opc:/);
  assert.match(serialized, /\[configured\]/);
});

test('quality review deployment surfaces expose provider, enqueue, and worker settings', () => {
  const sources = [
    readFileSync('.env.example', 'utf8'),
    readFileSync('infra/env.example', 'utf8'),
    readFileSync('docker-compose.callcenter.yml', 'utf8'),
    readFileSync('infra/docker-compose.production.yml', 'utf8'),
    readFileSync('infra/k8s/values.yaml', 'utf8'),
    readFileSync('infra/k8s/templates/opc-deployment.yaml', 'utf8')
  ];
  for (const source of sources) {
    assert.match(source, /CONVERACT_QUALITY_REVIEW_BASE_URL|qualityReview:\s*\n[\s\S]*baseUrl/);
    assert.match(source, /CONVERACT_QUALITY_REVIEW_AUTO_ENQUEUE|autoEnqueue/);
    assert.match(source, /CONVERACT_QUALITY_REVIEW_WORKER_ENABLED|qualityReview:[\s\S]*worker:\s*\n\s*enabled/);
  }
  const secrets = readFileSync('infra/k8s/templates/secrets.yaml', 'utf8');
  assert.match(secrets, /quality-review-token/);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['quality:deployment-preflight'], 'tsx scripts/quality-review-preflight.ts');
});

async function createMessage(pg: MemoryPg, body: string) {
  const tenantId = `tenant_finding_${Math.random().toString(36).slice(2, 8)}`;
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: `order-${tenantId}` }
  });
  const message = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer',
    message_type: 'text',
    body
  });
  return { store, tenantId, sessionId: session.id, messageId: message.id };
}

function qualityPolicy(profileId: string, automatic: boolean): IntelligencePolicyUpdate {
  return {
    ocr_enabled: false,
    asr_enabled: false,
    quality_review_enabled: true,
    translation_enabled: false,
    ocr_profile_id: '',
    asr_profile_id: '',
    quality_profile_id: profileId,
    translation_profile_id: '',
    allow_third_party: false,
    auto_ocr: false,
    auto_asr: false,
    auto_quality_review: automatic,
    auto_translation: false,
    translation_target_languages: [],
    min_ocr_confidence: 0,
    min_asr_confidence: 0
  };
}
