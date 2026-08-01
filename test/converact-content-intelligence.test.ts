import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PolicyFindingStore } from '../src/agent-runtime/collaboration/policy-finding-store.js';
import {
  AttachmentProcessingService,
  type AttachmentTextProvider
} from '../src/agent-runtime/collaboration/attachment-processing.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { createHttpOcrProvider } from '../src/agent-runtime/collaboration/ocr-provider.js';
import { scanTextPolicy } from '../src/agent-runtime/collaboration/policy-scan.js';
import { SessionPolicyAggregation } from '../src/agent-runtime/collaboration/session-policy-aggregation.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import {
  QualityReviewService,
  type QualityReviewProviderInput
} from '../src/agent-runtime/collaboration/quality-review.js';
import { MemoryPg } from '../src/db-pg.js';

const migrationPath = 'src/migrations/060_ivekit_content_intelligence.sql';

test('contact detector recognizes obfuscated phone and social contact intent without plaintext output', () => {
  const cases: Array<{ text: string; expected: string }> = [
    { text: '手机号：１３８ ００１３ ８０００', expected: 'phone_number' },
    { text: '电话一三八-零零一三-八零零零', expected: 'phone_number' },
    { text: '可以加 微 信：led_service_01', expected: 'wechat' },
    { text: '加V聊，账号稍后发你', expected: 'wechat' },
    { text: 'my wx is led_support', expected: 'wechat' },
    { text: 'message me on Whats App', expected: 'whatsapp' },
    { text: 'Telegram: led_support', expected: 'telegram' },
    { text: '加 QQ 继续沟通', expected: 'qq' },
    { text: '绕过平台直接转账给我', expected: 'pay_directly' }
  ];

  for (const item of cases) {
    const matches = scanTextPolicy(item.text);
    assert.equal(matches.some((match) => match.policy_type === item.expected), true, item.text);
    assert.equal(matches.every((match) => match.detector_version === 'contact-v2'), true);
    assert.equal(matches.every((match) => match.policy_version === 'anti-circumvention-v2'), true);
    assert.equal(matches.every((match) => match.matched_text_hash.length === 64), true);
    assert.doesNotMatch(JSON.stringify(matches), /138|0013|8000|led_service|led_support/i);
  }
});

test('contact detector rejects common numeric false positives without contact intent', () => {
  for (const text of [
    '订单号 202607150001 已发货',
    '服务器地址 192.168.10.20',
    '会议时间 2026-07-15 14:30',
    '金额 13800138000 元需要复核',
    '批次号 9876543210'
  ]) {
    assert.equal(
      scanTextPolicy(text).some((match) => match.policy_type === 'phone_number'),
      false,
      text
    );
  }
});

test('contact detector preserves direct mobile and email detection', () => {
  const matches = scanTextPolicy('联系我 13800138000 或 agent@example.com');
  assert.deepEqual(
    [...new Set(matches.map((match) => match.policy_type))].sort(),
    ['email', 'phone_number']
  );
  assert.equal(matches.every((match) => match.confidence > 0 && match.confidence <= 1), true);
});

test('content intelligence migration versions findings and isolates visual observations', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  for (const column of ['detector_version', 'policy_version', 'evidence_snapshot_hash', 'content_version']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'), column);
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS collaboration_visual_observations/i);
  assert.match(sql, /value_hash TEXT NOT NULL[\s\S]*char_length\(value_hash\) = 64/i);
  assert.match(sql, /ALTER TABLE collaboration_visual_observations ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE collaboration_visual_observations FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_visual_observations/i);
  assert.doesNotMatch(sql, /raw_value|decoded_value|plaintext|payload_value/i);
});

test('finding fingerprints are idempotent within a detector version and preserve upgrades', async () => {
  const store = new PolicyFindingStore(new MemoryPg());
  const base = {
    tenant_id: 'tenant-versioned-finding',
    session_id: 'session-versioned-finding',
    message_id: 'message-versioned-finding',
    source: 'text' as const,
    source_ref_id: 'message-versioned-finding',
    policy_type: 'phone_number',
    severity: 'high' as const,
    matched_text_hash: createHash('sha256').update('hidden-contact').digest('hex'),
    evidence_refs: [{ type: 'message', id: 'message-versioned-finding', version: 3 }],
    detector_version: 'contact-v2',
    policy_version: 'anti-circumvention-v2',
    content_version: 3
  };

  const first = await store.recordFinding(base);
  const replay = await store.recordFinding(base);
  const upgraded = await store.recordFinding({ ...base, detector_version: 'contact-v3' });

  assert.equal(replay.id, first.id);
  assert.notEqual(upgraded.id, first.id);
  assert.equal(first.detector_version, 'contact-v2');
  assert.equal(first.policy_version, 'anti-circumvention-v2');
  assert.equal(first.content_version, 3);
  assert.equal(first.evidence_snapshot_hash.length, 64);
  assert.doesNotMatch(JSON.stringify([first, upgraded]), /hidden-contact/);
});

test('OCR provider normalizes video frame QR and barcode observations', async () => {
  let sentForm: FormData | null = null;
  const provider = createHttpOcrProvider({
    mode: 'self_hosted',
    baseUrl: 'http://ocr.internal',
    fetch: async (_url, init) => {
      sentForm = init?.body as FormData;
      return new Response(JSON.stringify({
        text: 'visual text',
        observations: [
          {
            type: 'qr_code', value: 'wx:private-account', symbology: 'QR_CODE',
            confidence: 0.98, frame_timestamp_ms: 2400,
            metadata: { model: 'controlled', authorization: 'must-not-survive' }
          },
          { type: 'barcode', value: '13800138000', symbology: 'CODE_128', frame_timestamp_ms: 4400 }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.extract({
    attachment_id: 'attachment-video-observation',
    tenant_id: 'tenant-video-observation',
    session_id: 'session-video-observation',
    message_id: 'message-video-observation',
    filename: 'screen.webm',
    content_type: 'video/webm',
    source_ref: 'ivekit://attachment/attachment-video-observation',
    content: Buffer.from('controlled-video'),
    media_mode: 'video_frame_sampling',
    frame_interval_ms: 2_000,
    max_frames: 120
  });

  assert.equal(sentForm?.get('media_mode'), 'video_frame_sampling');
  assert.equal(sentForm?.get('frame_interval_ms'), '2000');
  assert.equal(sentForm?.get('max_frames'), '120');
  assert.deepEqual(result.observations, [
    {
      type: 'qr_code', value: 'wx:private-account', symbology: 'QR_CODE',
      confidence: 0.98, frame_timestamp_ms: 2400,
      metadata: { model: 'controlled' }
    },
    { type: 'barcode', value: '13800138000', symbology: 'CODE_128', frame_timestamp_ms: 4400 }
  ]);
});

test('OCR provider rejects oversized or invalid visual observations', async () => {
  const provider = createHttpOcrProvider({
    mode: 'third_party',
    baseUrl: 'https://ocr.example.test',
    fetch: async () => new Response(JSON.stringify({
      text: '',
      observations: Array.from({ length: 501 }, () => ({ type: 'qr_code', value: 'bounded' }))
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(
    () => provider.extract({
      attachment_id: 'attachment-observation-limit',
      tenant_id: 'tenant-observation-limit',
      session_id: 'session-observation-limit',
      message_id: 'message-observation-limit',
      filename: 'qr.png',
      content_type: 'image/png',
      source_ref: 'ivekit://attachment/attachment-observation-limit',
      content: Buffer.from('controlled-image')
    }),
    (error: any) => error?.code === 'provider_invalid_response' && error?.retryable === false
  );
});

test('screen recordings run independent ASR and frame OCR without persisting observation plaintext', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant-video-dual-processing';
  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'video-dual-processing' }
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-video',
    message_type: 'text', body: '可以加微信，画面里给你看'
  });
  const message = await collaboration.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer-video',
    message_type: 'video',
    body: '',
    attachments: [{
      kind: 'screen_recording', storage_url: 's3://controlled/screen.webm',
      filename: 'screen.webm', content_type: 'video/webm', size_bytes: 32,
      checksum: 'sha256:controlled-video', processing_status: 'pending'
    }]
  });
  const asr: AttachmentTextProvider = {
    processor: 'asr', name: 'controlled-asr', mode: 'self_hosted',
    extract: async () => ({ text: '语音中说请加微信' })
  };
  const ocr: AttachmentTextProvider = {
    processor: 'ocr', name: 'controlled-frame-ocr', mode: 'self_hosted',
    extract: async (input) => {
      assert.equal(input.media_mode, 'video_frame_sampling');
      return {
        text: '画面联系方式',
        observations: [{
          type: 'barcode', value: '手机号 13800138000', symbology: 'CODE_128',
          confidence: 0.96, frame_timestamp_ms: 2_500
        }]
      };
    }
  };
  const service = new AttachmentProcessingService({
    pg,
    providers: { asr, ocr },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('controlled-video') })
  });

  const jobs = await service.enqueueMessage(message);
  assert.deepEqual(jobs.map((job) => job.processor).sort(), ['asr', 'video_frame_ocr']);
  assert.deepEqual(await service.runDue({ tenant_id: tenantId, limit: 10 }), {
    candidates: 2, claimed: 2, succeeded: 2, retry_wait: 0, failed: 0
  });

  const attachment = await service.getAttachment({
    tenant_id: tenantId,
    attachment_id: message.attachments[0]!.id
  });
  assert.equal(attachment?.processing_status, 'ready');
  assert.match(attachment?.ocr_text || '', /画面联系方式/);
  assert.match(attachment?.asr_text || '', /语音中说/);
  const observations = await service.listVisualObservations({
    tenant_id: tenantId,
    attachment_id: message.attachments[0]!.id
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.value_hash.length, 64);
  assert.equal(observations[0]?.frame_timestamp_ms, 2_500);
  assert.deepEqual((await service.listJobsForAttachment({
    tenant_id: tenantId,
    attachment_id: message.attachments[0]!.id
  })).map((job) => job.processor).sort(), ['asr', 'video_frame_ocr']);
  assert.doesNotMatch(JSON.stringify([attachment, observations]), /13800138000/);
  const findings = await new PolicyFindingStore(pg).listFindings({
    tenant_id: tenantId,
    session_id: session.id
  });
  assert.equal(findings.some((finding) => finding.policy_type === 'phone_number'), true);
  assert.equal(findings.some((finding) =>
    finding.source === 'aggregate' &&
    finding.metadata.match_kind === 'visual_code' &&
    finding.evidence_refs.some((ref) => ref.type === 'visual_observation')
  ), true);
  assert.doesNotMatch(JSON.stringify(findings), /13800138000/);
});

test('video processing preserves successful ASR when frame OCR fails', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant-video-partial-processing';
  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'video-partial-processing' }
  });
  const message = await collaboration.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer-video',
    message_type: 'video',
    body: '',
    attachments: [{
      kind: 'video', storage_url: 's3://controlled/video.webm', filename: 'video.webm',
      content_type: 'video/webm', size_bytes: 32, checksum: 'sha256:controlled-video-partial',
      processing_status: 'pending'
    }]
  });
  const service = new AttachmentProcessingService({
    pg,
    providers: {
      asr: {
        processor: 'asr', name: 'controlled-asr', mode: 'self_hosted',
        extract: async () => ({ text: '保留下来的语音结果' })
      },
      ocr: {
        processor: 'ocr', name: 'controlled-ocr', mode: 'self_hosted',
        extract: async () => {
          throw Object.assign(new Error('unsupported codec'), {
            code: 'provider_invalid_media', retryable: false
          });
        }
      }
    },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('controlled-video') })
  });

  await service.enqueueMessage(message);
  assert.deepEqual(await service.runDue({ tenant_id: tenantId, limit: 10 }), {
    candidates: 2, claimed: 2, succeeded: 1, retry_wait: 0, failed: 1
  });
  const attachment = await service.getAttachment({
    tenant_id: tenantId,
    attachment_id: message.attachments[0]!.id
  });
  assert.equal(attachment?.processing_status, 'ready');
  assert.equal(attachment?.processing_error_code, 'partial_processing_failure');
  assert.equal(attachment?.asr_text, '保留下来的语音结果');
  assert.equal(attachment?.ocr_text, '');
});

test('session aggregation detects split contact details with stable secret-safe evidence', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant-aggregate-split';
  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'aggregate-split' }
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-a',
    message_type: 'text', body: '手机号分开发：13800'
  });
  const second = await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-a',
    message_type: 'text', body: '138000'
  });
  const aggregation = new SessionPolicyAggregation(pg);

  const scanInput = {
    tenant_id: tenantId, session_id: session.id, message_id: second.id,
    source: 'text' as const, source_ref_id: second.id,
    evidence_refs: [{ type: 'message', id: second.id, version: 1 }], text: second.body
  };
  const first = await collaboration.scanPolicy(scanInput);
  const replay = await collaboration.scanPolicy(scanInput);
  assert.equal(first.findings.some((finding) => finding.policy_type === 'phone_number'), true);
  assert.equal(first.findings.every((finding) => finding.source === 'aggregate'), true);
  assert.equal(first.findings.every((finding) => finding.message_id === ''), true);
  assert.equal(first.findings[0]?.fingerprint, replay.findings[0]?.fingerprint);
  assert.deepEqual(first.findings[0]?.evidence_refs, replay.findings[0]?.evidence_refs);
  assert.equal(new Set(first.findings[0]?.evidence_refs.map((ref) => ref.id)).size, 2);
  assert.doesNotMatch(JSON.stringify([first, replay]), /13800|138000/);

  const otherTenant = await collaboration.openSession({
    tenant_id: 'tenant-aggregate-other',
    business_ref: { tenant_id: 'tenant-aggregate-other', type: 'service_order', id: 'other' }
  });
  const isolated = await aggregation.scan({
    tenant_id: 'tenant-aggregate-other', session_id: otherTenant.id
  });
  assert.equal(isolated.findings.length, 0);
});

test('session aggregation excludes deleted and out-of-window messages', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const aggregation = new SessionPolicyAggregation(pg);
  const tenantId = 'tenant-aggregate-bounds';
  const deletedSession = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'aggregate-deleted' }
  });
  await collaboration.addParticipant({
    tenant_id: tenantId, session_id: deletedSession.id, identity: 'customer-delete', role: 'customer'
  });
  const deleted = await collaboration.postMessage({
    tenant_id: tenantId, session_id: deletedSession.id, sender_identity: 'customer-delete',
    message_type: 'text', body: '手机号 13800'
  });
  await new CollaborationMessageStateStore(pg).deleteMessage({
    tenant_id: tenantId, session_id: deletedSession.id, message_id: deleted.id,
    actor_identity: 'customer-delete'
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: deletedSession.id, sender_identity: 'customer-delete',
    message_type: 'text', body: '138000'
  });
  assert.equal((await aggregation.scan({
    tenant_id: tenantId, session_id: deletedSession.id
  })).findings.length, 0);

  const windowSession = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'aggregate-window' }
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: windowSession.id, sender_identity: 'customer-window',
    message_type: 'text', body: '手机号 13800'
  });
  for (let index = 0; index < 20; index += 1) {
    await collaboration.postMessage({
      tenant_id: tenantId, session_id: windowSession.id, sender_identity: 'customer-window',
      message_type: 'text', body: index === 0 ? '138000' : `正常消息 ${index}`
    });
  }
  assert.equal((await aggregation.scan({
    tenant_id: tenantId, session_id: windowSession.id
  })).findings.length, 0);
});

test('session aggregation links contact intent to the next account without exposing it', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant-aggregate-account';
  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'aggregate-account' }
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-account',
    message_type: 'text', body: '可以加微信'
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-account',
    message_type: 'text', body: 'led_service_01'
  });

  const result = await new SessionPolicyAggregation(pg).scan({
    tenant_id: tenantId, session_id: session.id
  });
  const finding = result.findings.find((item) => item.policy_type === 'wechat');
  assert.ok(finding);
  assert.equal(finding.source, 'aggregate');
  assert.equal(finding.metadata.match_kind, 'aggregate');
  assert.equal(new Set(finding.evidence_refs.map((ref) => ref.id)).size, 2);
  assert.doesNotMatch(JSON.stringify(result), /led_service_01/i);
});

test('session aggregation does not bridge contact intent across distant empty messages', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant-aggregate-distance';
  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'aggregate-distance' }
  });
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-distance',
    message_type: 'text', body: '可以加微信'
  });
  for (let index = 0; index < 3; index += 1) {
    await collaboration.postMessage({
      tenant_id: tenantId, session_id: session.id, sender_identity: 'system',
      message_type: 'system', body: ''
    });
  }
  await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-distance',
    message_type: 'text', body: 'led_service_01'
  });

  const result = await new SessionPolicyAggregation(pg).scan({
    tenant_id: tenantId, session_id: session.id
  });
  assert.equal(result.findings.some((finding) => finding.policy_type === 'wechat'), false);
});

test('AI quality review hashes and reviews the bounded session context with all evidence', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant-quality-session-context';
  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'quality-session-context' }
  });
  const first = await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-quality',
    message_type: 'text', body: '前一条上下文'
  });
  const target = await collaboration.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'agent-quality',
    message_type: 'text', body: '当前质检目标'
  });
  const providerInputs: QualityReviewProviderInput[] = [];
  const quality = new QualityReviewService({
    pg,
    provider: {
      name: 'controlled-session-quality', mode: 'self_hosted',
      review: async (input) => {
        providerInputs.push(input);
        return {
          findings: [{ policy_type: 'session_quality_risk', severity: 'medium', confidence: 0.8 }]
        };
      }
    }
  });
  const original = await quality.enqueueMessage({ tenant_id: tenantId, message_id: target.id });
  assert.ok(original);
  await new PolicyFindingStore(pg).recordFinding({
    tenant_id: tenantId, session_id: session.id, message_id: first.id, source: 'text',
    source_ref_id: first.id, policy_type: 'context_rule', severity: 'medium',
    matched_text_hash: 'a'.repeat(64), detector_version: 'contact-v2',
    policy_version: 'anti-circumvention-v2', evidence_refs: [{ type: 'message', id: first.id, version: 1 }]
  });

  assert.equal((await quality.runDue({ tenant_id: tenantId })).retry_wait, 1);
  assert.equal(providerInputs.length, 0);
  const refreshed = await quality.getJob({ tenant_id: tenantId, message_id: target.id });
  assert.notEqual(refreshed?.input_hash, original.input_hash);
  assert.equal((await quality.runDue({ tenant_id: tenantId })).succeeded, 1);
  assert.equal(providerInputs.length, 1);
  assert.match(providerInputs[0]?.content || '', /\[message source=text/);
  assert.match(providerInputs[0]?.content || '', /前一条上下文/);
  assert.match(providerInputs[0]?.content || '', /当前质检目标/);
  assert.equal(providerInputs[0]?.rule_findings.some((finding) =>
    finding.policy_type === 'context_rule' && finding.detector_version === 'contact-v2'
  ), true);
  assert.deepEqual(
    new Set(providerInputs[0]?.evidence_refs.filter((ref) => ref.type === 'message').map((ref) => ref.id)),
    new Set([first.id, target.id])
  );
  const findings = await new PolicyFindingStore(pg).listFindings({
    tenant_id: tenantId, session_id: session.id, source: 'ai'
  });
  const qualityFinding = findings.find((finding) => finding.policy_type === 'session_quality_risk');
  assert.equal(qualityFinding?.evidence_refs.some((ref) => ref.id === first.id), true);
  assert.equal(qualityFinding?.evidence_refs.some((ref) => ref.id === target.id), true);
});
