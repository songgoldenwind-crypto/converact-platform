import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { VoiceError } from './errors.js';
import type { VoiceSecretResolver } from './ports.js';
import type { VoiceAdapter } from './types.js';

export interface VoiceProfileWebhookContext {
  tenant_id: string;
  profile_id: string;
  adapter: VoiceAdapter;
  secret_refs: {
    webhook_hmac?: string;
    webhook_service_key?: string;
  };
}

export interface VoiceProfileContextResolver {
  resolve(profileId: string): Promise<VoiceProfileWebhookContext | null>;
}

export class PostgresVoiceProfileContextResolver implements VoiceProfileContextResolver {
  constructor(private readonly pg: PgQueryable) {}

  async resolve(profileIdInput: string): Promise<VoiceProfileWebhookContext | null> {
    const profileId = boundedIdentifier(profileIdInput);
    const result = await this.pg.query<Record<string, unknown>>(
      `SELECT tenant_id, profile_id, adapter, secret_refs
       FROM opc_ivekit_voice_profile_context($1)`,
      [profileId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const adapter = voiceAdapter(row.adapter);
    const secretRefs = stringRecord(row.secret_refs);
    return {
      tenant_id: boundedIdentifier(row.tenant_id),
      profile_id: boundedIdentifier(row.profile_id),
      adapter,
      secret_refs: {
        webhook_hmac: optionalSecretRef(secretRefs.webhook_hmac),
        webhook_service_key: optionalSecretRef(secretRefs.webhook_service_key)
      }
    };
  }
}

export interface VoiceWebhookAuthenticatorOptions {
  context_resolver: VoiceProfileContextResolver;
  secret_resolver: VoiceSecretResolver;
  max_body_bytes?: number;
  max_skew_seconds?: number;
  now?: () => Date;
}

export interface VoiceWebhookAuthentication extends VoiceProfileWebhookContext {
  method: 'hmac' | 'service_key';
}

type HeaderValue = string | readonly string[] | undefined;

export class VoiceWebhookAuthenticator {
  readonly #contextResolver: VoiceProfileContextResolver;
  readonly #secretResolver: VoiceSecretResolver;
  readonly #maxBodyBytes: number;
  readonly #maxSkewSeconds: number;
  readonly #now: () => Date;

  constructor(options: VoiceWebhookAuthenticatorOptions) {
    this.#contextResolver = options.context_resolver;
    this.#secretResolver = options.secret_resolver;
    this.#maxBodyBytes = boundedInteger(options.max_body_bytes, 256 * 1024, 1, 4 * 1024 * 1024);
    this.#maxSkewSeconds = boundedInteger(options.max_skew_seconds, 300, 1, 3_600);
    this.#now = options.now ?? (() => new Date());
  }

  async authenticate(input: {
    profile_id: string;
    raw_body: Buffer | Uint8Array | string;
    headers: Readonly<Record<string, HeaderValue>>;
  }): Promise<VoiceWebhookAuthentication> {
    const profileId = boundedIdentifier(input.profile_id);
    const body = rawBody(input.raw_body, this.#maxBodyBytes);
    const context = await this.#resolveContext(profileId);
    const timestamp = header(input.headers, 'x-ivekit-timestamp');
    const signature = header(input.headers, 'x-ivekit-signature');

    if (timestamp || signature) {
      await this.#verifyHmac(context, timestamp, signature, body);
      return { ...context, method: 'hmac' };
    }

    const serviceKey = header(input.headers, 'x-pbx-key');
    if (!serviceKey || !context.secret_refs.webhook_service_key) throw authFailure();
    const expected = await this.#resolveSecret(context.secret_refs.webhook_service_key, 'webhook_service_key');
    if (!constantTimeTextEqual(serviceKey, expected)) throw authFailure();
    return { ...context, method: 'service_key' };
  }

  async #resolveContext(profileId: string): Promise<VoiceProfileWebhookContext> {
    try {
      const context = await this.#contextResolver.resolve(profileId);
      if (!context || context.profile_id !== profileId) {
        throw authFailure();
      }
      boundedIdentifier(context.tenant_id);
      return context;
    } catch {
      throw authFailure();
    }
  }

  async #verifyHmac(
    context: VoiceProfileWebhookContext,
    timestamp: string,
    signature: string,
    body: Buffer
  ): Promise<void> {
    if (!timestamp || !signature || !/^\d{10}$/.test(timestamp)
      || !/^sha256=[a-f0-9]{64}$/i.test(signature)
      || !context.secret_refs.webhook_hmac) {
      throw authFailure();
    }
    const eventSeconds = Number(timestamp);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (!Number.isSafeInteger(eventSeconds)
      || Math.abs(nowSeconds - eventSeconds) > this.#maxSkewSeconds) {
      throw authFailure();
    }
    const secret = await this.#resolveSecret(context.secret_refs.webhook_hmac, 'webhook_hmac');
    const expected = createHmac('sha256', secret)
      .update(timestamp)
      .update('.')
      .update(body)
      .digest('hex');
    if (!constantTimeTextEqual(signature.slice(7).toLowerCase(), expected)) throw authFailure();
  }

  async #resolveSecret(ref: string, purpose: string): Promise<string> {
    try {
      return await this.#secretResolver.resolve(ref, purpose);
    } catch {
      throw authFailure();
    }
  }
}

function header(headers: Readonly<Record<string, HeaderValue>>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value.length === 1 ? String(value[0] ?? '').trim() : '';
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

function rawBody(value: Buffer | Uint8Array | string, maxBytes: number): Buffer {
  const body = Buffer.isBuffer(value)
    ? value
    : typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : null;
  if (!body || body.byteLength > maxBytes) {
    throw new VoiceError({ code: 'provider_payload_invalid', status: 413 });
  }
  return body;
}

function constantTimeTextEqual(actual: string, expected: string): boolean {
  const actualDigest = createHmac('sha256', 'ivekit-webhook-compare').update(actual).digest();
  const expectedDigest = createHmac('sha256', 'ivekit-webhook-compare').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw authFailure();
  }
  return value;
}

function voiceAdapter(value: unknown): VoiceAdapter {
  if (value === 'rustpbx' || value === 'livekit_sip' || value === 'active_call'
    || value === 'livekit_agents' || value === 'controlled') return value;
  throw authFailure();
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authFailure();
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw authFailure();
    output[key] = item;
  }
  return output;
}

function optionalSecretRef(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 512) throw authFailure();
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function authFailure(): VoiceError {
  return new VoiceError({ code: 'webhook_auth_failed', status: 401 });
}
