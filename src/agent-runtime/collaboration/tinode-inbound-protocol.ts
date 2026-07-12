import { createHash } from 'node:crypto';

import type { CollaborationMessageAttachmentInput } from './collaboration-store.js';

const MAX_BODY_LENGTH = 100_000;
const MAX_ATTACHMENTS = 20;
const MAX_DELETE_SPAN = 10_000;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const SENSITIVE_QUERY_KEY = /(?:api[_-]?key|auth|credential|password|secret|signature|token|x-amz-)/i;

export interface TinodeInboundProtocolOptions {
  expectedTopic: string;
  allowedAttachmentHosts: string[];
}

export interface TinodeInboundDataPayload {
  topic: string;
  seq: number;
  from: string;
  ts: string;
  head: {
    opc_message_id: string;
    opc_idempotency_key: string;
    replace: string;
  };
  body: string;
  attachments: Array<Pick<
    CollaborationMessageAttachmentInput,
    'kind' | 'storage_url' | 'filename' | 'content_type' | 'size_bytes' | 'metadata'
  >>;
}

export interface TinodeInboundDeletePayload {
  topic: string;
  delete_id: number;
  ranges: Array<{ low: number; hi: number }>;
}

export type TinodeInboundNormalizedEvent =
  | {
    kind: 'data';
    provider_sequence: number;
    provider_delete_id: 0;
    dedupe_key: string;
    payload_hash: string;
    payload: TinodeInboundDataPayload;
  }
  | {
    kind: 'delete';
    provider_sequence: 0;
    provider_delete_id: number;
    dedupe_key: string;
    payload_hash: string;
    payload: TinodeInboundDeletePayload;
  };

export interface TinodeInboundRejectedEvent {
  kind: 'data' | 'delete';
  provider_sequence: number;
  provider_delete_id: number;
  dedupe_key: string;
  payload_hash: string;
  payload: {
    rejected: true;
    topic: string;
    provider_sequence: number;
    provider_delete_id: number;
    error_code: string;
  };
  error_code: string;
  error_message: string;
  retryable: boolean;
}

export class TinodeInboundProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

export function normalizeTinodeInboundPacket(
  value: unknown,
  options: TinodeInboundProtocolOptions
): TinodeInboundNormalizedEvent {
  const packet = record(value);
  if (packet.data) return normalizeData(record(packet.data), options);
  const meta = record(packet.meta);
  if (meta.del) return normalizeDelete(meta, record(meta.del), options);
  const pres = record(packet.pres);
  if (String(pres.what || '') === 'del') {
    return normalizeDelete(
      { topic: pres.topic || pres.src },
      { clear: pres.clear, delseq: pres.delseq },
      options
    );
  }
  throw protocolError('unsupported_packet', 'Tinode packet is not data or meta.del');
}

export function describeRejectedTinodePacket(
  value: unknown,
  expected: string,
  error: unknown
): TinodeInboundRejectedEvent {
  const packet = record(value);
  let kind: 'data' | 'delete';
  let topic = '';
  let providerSequence = 0;
  let providerDeleteId = 0;
  if (packet.data) {
    const data = record(packet.data);
    kind = 'data';
    topic = String(data.topic || '').trim();
    providerSequence = safePositiveInteger(data.seq);
  } else {
    const meta = record(packet.meta);
    const pres = record(packet.pres);
    const deletion = meta.del ? record(meta.del) : pres;
    kind = 'delete';
    topic = String(meta.topic || pres.topic || pres.src || '').trim();
    providerDeleteId = safePositiveInteger(deletion.clear);
  }
  if (
    !expected ||
    topic !== expected ||
    (kind === 'data' && !providerSequence) ||
    (kind === 'delete' && !providerDeleteId)
  ) {
    throw protocolError('unidentifiable_packet', 'Rejected Tinode packet has no safe cursor coordinates');
  }
  const errorCode = error instanceof TinodeInboundProtocolError
    ? error.code
    : 'protocol_rejected';
  const payload: TinodeInboundRejectedEvent['payload'] = {
    rejected: true,
    topic,
    provider_sequence: providerSequence,
    provider_delete_id: providerDeleteId,
    error_code: errorCode
  };
  const serialized = stableJson(payload);
  return {
    kind,
    provider_sequence: providerSequence,
    provider_delete_id: providerDeleteId,
    dedupe_key: kind === 'data' ? `data:${providerSequence}` : `delete:${providerDeleteId}`,
    payload_hash: createHash('sha256').update(serialized).digest('hex'),
    payload,
    error_code: errorCode,
    error_message: error instanceof TinodeInboundProtocolError
      ? error.message
      : 'Tinode packet was rejected by the inbound protocol',
    retryable: error instanceof TinodeInboundProtocolError && error.retryable
  };
}

function normalizeData(
  data: Record<string, unknown>,
  options: TinodeInboundProtocolOptions
): TinodeInboundNormalizedEvent & { kind: 'data' } {
  const topic = expectedTopic(data.topic, options.expectedTopic);
  const seq = positiveInteger(data.seq, 'invalid_data_sequence');
  const from = boundedRequiredString(data.from, 128, 'invalid_sender');
  const head = normalizeHead(data.head, seq);
  const content = normalizeContent(data.content, options.allowedAttachmentHosts);
  if (!content.body.trim() && content.attachments.length === 0) {
    throw protocolError('empty_message', 'Tinode data has no text or supported attachments');
  }
  if (head.replace && content.attachments.length > 0) {
    throw protocolError('unsupported_replacement', 'Tinode replacements must contain text only');
  }
  const payload: TinodeInboundDataPayload = {
    topic,
    seq,
    from,
    ts: optionalTimestamp(data.ts),
    head,
    body: content.body,
    attachments: content.attachments
  };
  return eventEnvelope('data', seq, 0, `data:${seq}`, payload);
}

function normalizeDelete(
  meta: Record<string, unknown>,
  deletion: Record<string, unknown>,
  options: TinodeInboundProtocolOptions
): TinodeInboundNormalizedEvent & { kind: 'delete' } {
  const topic = expectedTopic(meta.topic, options.expectedTopic);
  const deleteId = positiveInteger(deletion.clear, 'invalid_delete_id');
  if (!Array.isArray(deletion.delseq) || deletion.delseq.length === 0 || deletion.delseq.length > 1000) {
    throw protocolError('invalid_delete_range', 'Tinode delete ranges are required and bounded');
  }
  const ranges = deletion.delseq.map((item) => {
    const range = record(item);
    const low = positiveInteger(range.low, 'invalid_delete_range');
    const hi = range.hi == null ? low + 1 : positiveInteger(range.hi, 'invalid_delete_range');
    if (hi <= low || hi - low > MAX_DELETE_SPAN) {
      throw protocolError('invalid_delete_range', 'Tinode delete range is invalid or too large');
    }
    return { low, hi };
  }).sort((left, right) => left.low - right.low || left.hi - right.hi);
  const total = ranges.reduce((sum, range) => sum + range.hi - range.low, 0);
  if (total > MAX_DELETE_SPAN) {
    throw protocolError('invalid_delete_range', 'Tinode delete range total is too large');
  }
  const payload: TinodeInboundDeletePayload = { topic, delete_id: deleteId, ranges };
  return eventEnvelope('delete', 0, deleteId, `delete:${deleteId}`, payload);
}

function normalizeHead(value: unknown, sequence: number): TinodeInboundDataPayload['head'] {
  const head = record(value);
  const replace = safeHeader(head.replace);
  if (replace) {
    const match = replace.match(/^msg:([1-9]\d{0,15})$/);
    const target = Number(match?.[1] || 0);
    if (!match || !Number.isSafeInteger(target) || target >= sequence) {
      throw protocolError('invalid_replacement', 'Tinode replacement target is invalid');
    }
  }
  return {
    opc_message_id: safeHeader(head['x-opc-message-id']),
    opc_idempotency_key: safeHeader(head['x-opc-idempotency-key']),
    replace
  };
}

function normalizeContent(
  value: unknown,
  allowedHosts: string[]
): { body: string; attachments: TinodeInboundDataPayload['attachments'] } {
  if (typeof value === 'string') {
    return { body: boundedBody(value), attachments: [] };
  }
  const drafty = record(value);
  const body = boundedBody(typeof drafty.txt === 'string' ? drafty.txt : '');
  const entities = Array.isArray(drafty.ent) ? drafty.ent : [];
  if (entities.length > 100) {
    throw protocolError('too_many_entities', 'Tinode Drafty entity count exceeds the limit');
  }
  const attachments: TinodeInboundDataPayload['attachments'] = [];
  for (const rawEntity of entities) {
    const entity = record(rawEntity);
    const type = String(entity.tp || '').trim().toUpperCase();
    if (!['IM', 'VD', 'AU', 'EX'].includes(type)) continue;
    if (attachments.length >= MAX_ATTACHMENTS) {
      throw protocolError('too_many_attachments', 'Tinode attachment count exceeds the limit');
    }
    const data = record(entity.data);
    const ref = String(data.ref || '').trim();
    if (!ref) {
      throw protocolError('embedded_attachment_not_supported', 'Tinode embedded attachment bytes are not accepted');
    }
    const storageUrl = allowedAttachmentUrl(ref, allowedHosts);
    const previewUrl = data.preref ? allowedAttachmentUrl(String(data.preref), allowedHosts) : '';
    attachments.push({
      kind: attachmentKind(type),
      storage_url: storageUrl,
      filename: boundedString(data.name || data.fn, 512),
      content_type: boundedString(data.mime, 255),
      size_bytes: nonNegativeInteger(data.size, 'invalid_attachment_size'),
      metadata: {
        duration_ms: nonNegativeInteger(data.duration, 'invalid_attachment_duration'),
        width: nonNegativeInteger(data.width, 'invalid_attachment_width'),
        height: nonNegativeInteger(data.height, 'invalid_attachment_height'),
        preview_url: previewUrl,
        tinode_entity_type: type
      }
    });
  }
  return { body, attachments };
}

function attachmentKind(type: string): CollaborationMessageAttachmentInput['kind'] {
  if (type === 'IM') return 'image';
  if (type === 'VD') return 'video';
  if (type === 'AU') return 'audio';
  return 'file';
}

function allowedAttachmentUrl(value: string, allowedHosts: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError('attachment_url_not_allowed', 'Tinode attachment URL is invalid');
  }
  const hosts = new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (
    url.protocol !== 'https:' ||
    Boolean(url.username || url.password) ||
    !hosts.has(url.hostname.toLowerCase())
  ) {
    throw protocolError('attachment_url_not_allowed', 'Tinode attachment URL is not allowed');
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw protocolError('attachment_url_contains_credential', 'Tinode attachment URL contains credential-like parameters');
    }
  }
  url.hash = '';
  return url.toString();
}

function eventEnvelope<K extends 'data' | 'delete', P extends TinodeInboundDataPayload | TinodeInboundDeletePayload>(
  kind: K,
  providerSequence: number,
  providerDeleteId: number,
  dedupeKey: string,
  payload: P
): TinodeInboundNormalizedEvent & { kind: K; payload: P } {
  const serialized = stableJson(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw protocolError('payload_too_large', 'Tinode normalized payload exceeds the limit');
  }
  return {
    kind,
    provider_sequence: providerSequence,
    provider_delete_id: providerDeleteId,
    dedupe_key: dedupeKey,
    payload_hash: createHash('sha256').update(serialized).digest('hex'),
    payload
  } as TinodeInboundNormalizedEvent & { kind: K; payload: P };
}

function expectedTopic(value: unknown, expected: string): string {
  const topic = boundedRequiredString(value, 256, 'invalid_topic');
  if (!expected || topic !== expected) throw protocolError('topic_mismatch', 'Tinode packet topic does not match binding');
  return topic;
}

function positiveInteger(value: unknown, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw protocolError(code, 'Tinode integer field is invalid');
  return number;
}

function safePositiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (value == null || value === '') return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw protocolError(code, 'Tinode numeric field is invalid');
  return number;
}

function boundedBody(value: string): string {
  if (value.length > MAX_BODY_LENGTH) throw protocolError('body_too_large', 'Tinode message body exceeds the limit');
  return value;
}

function boundedRequiredString(value: unknown, max: number, code: string): string {
  const normalized = boundedString(value, max).trim();
  if (!normalized) throw protocolError(code, 'Tinode required string is missing');
  return normalized;
}

function boundedString(value: unknown, max: number): string {
  return String(value || '').replace(/[\r\n\0]/g, '').slice(0, max);
}

function safeHeader(value: unknown): string {
  return boundedString(value, 128).trim();
}

function optionalTimestamp(value: unknown): string {
  if (value == null || value === '') return '';
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw protocolError('invalid_timestamp', 'Tinode timestamp is invalid');
  return parsed.toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function protocolError(code: string, message: string): TinodeInboundProtocolError {
  return new TinodeInboundProtocolError(code, message);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
