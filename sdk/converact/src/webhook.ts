import type { ConveractFabricWebhookDeliveryEnvelope } from './event-types.js';

export interface ConveractFabricWebhookReplayClaim {
  key: string;
  expires_at: string;
  body_sha256: string;
  delivery_id: string;
  event_id: string;
  tenant_id: string;
  envelope: ConveractFabricWebhookDeliveryEnvelope<unknown>;
}

export interface ConveractFabricWebhookReplayStore {
  claim(input: ConveractFabricWebhookReplayClaim): Promise<boolean>;
}

export interface VerifyConveractFabricWebhookInput {
  rawBody: string | Uint8Array;
  timestamp: string;
  signature: string;
  secret: string | Uint8Array;
  toleranceSeconds?: number;
  replayRetentionSeconds?: number;
  now?: Date;
  replayStore?: ConveractFabricWebhookReplayStore;
}

export interface VerifyConveractFabricWebhookResult<T = unknown> {
  envelope: ConveractFabricWebhookDeliveryEnvelope<T>;
  duplicate: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function verifyConveractFabricWebhook<T = unknown>(
  input: VerifyConveractFabricWebhookInput
): Promise<VerifyConveractFabricWebhookResult<T>> {
  const rawBody = ownedBytes(
    typeof input.rawBody === 'string' ? encoder.encode(input.rawBody) : input.rawBody
  );
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength < 2 || rawBody.byteLength > 1_048_576) {
    throw new Error('Converact Fabric webhook body is invalid');
  }
  const secret = ownedBytes(
    typeof input.secret === 'string' ? encoder.encode(input.secret) : input.secret
  );
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 4_096) {
    throw new Error('Converact Fabric webhook secret is invalid');
  }
  const tolerance = boundedTolerance(input.toleranceSeconds);
  const now = input.now || new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Converact Fabric webhook timestamp is invalid');
  if (!/^\d{10,11}$/.test(input.timestamp)) throw new Error('Converact Fabric webhook timestamp is invalid');
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)
    || Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds) > tolerance) {
    throw new Error('Converact Fabric webhook timestamp is outside the replay window');
  }
  const match = input.signature.match(/^v1=([a-f0-9]{64})$/);
  if (!match) throw new Error('Converact Fabric webhook signature is invalid');
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error('Web Crypto is required to verify Converact Fabric webhooks');
  const key = await crypto.subtle.importKey(
    'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const signed = concat(encoder.encode(`${input.timestamp}.`), rawBody);
  const valid = await crypto.subtle.verify('HMAC', key, hexBytes(match[1]), signed);
  if (!valid) throw new Error('Converact Fabric webhook signature is invalid');

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(rawBody));
  } catch {
    throw new Error('Converact Fabric webhook envelope is invalid');
  }
  const envelope = validateEnvelope<T>(parsed);
  let duplicate = false;
  if (input.replayStore) {
    const retention = boundedReplayRetention(input.replayRetentionSeconds, tolerance);
    const claimed = await input.replayStore.claim({
      key: `ivekit:${envelope.tenant_id}:${envelope.id}`,
      expires_at: new Date(now.getTime() + retention * 1_000).toISOString(),
      body_sha256: await sha256(rawBody, crypto),
      delivery_id: envelope.id,
      event_id: envelope.data.event_id,
      tenant_id: envelope.tenant_id,
      envelope: envelope as ConveractFabricWebhookDeliveryEnvelope<unknown>
    });
    duplicate = !claimed;
  }
  return { envelope, duplicate };
}

function validateEnvelope<T>(value: unknown): ConveractFabricWebhookDeliveryEnvelope<T> {
  const outer = object(value);
  const data = object(outer.data);
  const visibility = object(data.visibility);
  const business = object(outer.business_ref);
  const id = required(outer.id, 255);
  const event = eventType(outer.event);
  const tenantId = required(outer.tenant_id, 255);
  const timestamp = isoTimestamp(outer.timestamp);
  if (data.schema_version !== 1) throw new Error('Converact Fabric webhook envelope schema is invalid');
  const eventId = required(data.event_id, 255);
  const innerType = eventType(data.event_type);
  const innerTenant = required(data.tenant_id, 255);
  if (event !== innerType || tenantId !== innerTenant) {
    throw new Error('Converact Fabric webhook envelope identity is inconsistent');
  }
  const scope = String(visibility.scope || '');
  if (!['tenant', 'chat_session', 'media_call', 'remote_session'].includes(scope)) {
    throw new Error('Converact Fabric webhook envelope visibility is invalid');
  }
  const refId = String(visibility.ref_id || '');
  if ((scope === 'tenant' && refId) || (scope !== 'tenant' && !refId)) {
    throw new Error('Converact Fabric webhook envelope visibility is inconsistent');
  }
  if (!Array.isArray(visibility.audience_user_ids)
    || visibility.audience_user_ids.some((item) => typeof item !== 'string')) {
    throw new Error('Converact Fabric webhook envelope audience is invalid');
  }
  const innerBusiness = data.business_ref === null ? null : businessRef(data.business_ref);
  return {
    id,
    event,
    tenant_id: tenantId,
    timestamp,
    business_ref: { type: required(business.type, 100), id: required(business.id, 255) },
    data: {
      schema_version: 1,
      event_id: eventId,
      event_type: innerType,
      tenant_id: innerTenant,
      occurred_at: isoTimestamp(data.occurred_at),
      business_ref: innerBusiness,
      visibility: {
        scope: scope as ConveractFabricWebhookDeliveryEnvelope['data']['visibility']['scope'],
        ref_id: refId,
        audience_user_ids: visibility.audience_user_ids.map(String)
      },
      data: data.data as T
    }
  };
}

function businessRef(value: unknown): { type: string; id: string } {
  const input = object(value);
  return { type: required(input.type, 100), id: required(input.id, 255) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Converact Fabric webhook envelope is invalid');
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, max: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('Converact Fabric webhook envelope is invalid');
  }
  return text;
}

function eventType(value: unknown): string {
  const result = required(value, 255);
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(result)) {
    throw new Error('Converact Fabric webhook envelope event is invalid');
  }
  return result;
}

function isoTimestamp(value: unknown): string {
  const text = String(value || '');
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed)) throw new Error('Converact Fabric webhook envelope timestamp is invalid');
  return new Date(parsed).toISOString();
}

function boundedTolerance(value?: number): number {
  const result = value ?? 300;
  if (!Number.isInteger(result) || result < 30 || result > 3_600) {
    throw new Error('Converact Fabric webhook tolerance is invalid');
  }
  return result;
}

function boundedReplayRetention(value: number | undefined, tolerance: number): number {
  const result = value ?? 604_800;
  if (!Number.isInteger(result) || result < Math.max(3_600, tolerance) || result > 7_776_000) {
    throw new Error('Converact Fabric webhook replay retention is invalid');
  }
  return result;
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

async function sha256(
  value: Uint8Array<ArrayBuffer>,
  crypto: typeof globalThis.crypto
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.byteLength);
  result.set(value);
  return result;
}
