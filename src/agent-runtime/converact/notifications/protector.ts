import { resolveFabricEnv } from '../../../config/converact-env.js';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import { canonicalNotificationJson } from './canonical.js';
import { NotificationError } from './errors.js';
import type { NotificationChannel } from './types.js';
import type { NotificationContentProtector } from './ports.js';

export interface EncryptedNotificationProtectorOptions {
  encryption_key: string;
  hmac_key: string;
}

export interface ProtectedNotificationRecipient {
  ciphertext: string;
  hmac: string;
  redacted: string;
}

export class EncryptedNotificationProtector {
  readonly #encryptionRoot: Buffer;
  readonly #hmacRoot: Buffer;

  constructor(options: EncryptedNotificationProtectorOptions) {
    this.#encryptionRoot = decodeRootKey(options.encryption_key);
    this.#hmacRoot = decodeRootKey(options.hmac_key);
    if (timingSafeEqual(this.#encryptionRoot, this.#hmacRoot)) {
      throw validationError();
    }
  }

  async protectContent(
    tenantId: string,
    content: unknown
  ): Promise<{ ciphertext: string; hash: string }> {
    const canonical = canonicalContent(content);
    return {
      ciphertext: this.#encrypt(tenantId, 'content', canonical),
      hash: createHash('sha256').update(canonical).digest('hex')
    };
  }

  async revealContent(tenantId: string, ciphertext: string): Promise<unknown> {
    try {
      return JSON.parse(this.#decrypt(tenantId, 'content', ciphertext));
    } catch {
      throw decryptionError();
    }
  }

  async protectRecipient(
    tenantId: string,
    channel: NotificationChannel,
    recipient: string
  ): Promise<ProtectedNotificationRecipient> {
    const normalized = normalizeRecipient(channel, recipient);
    const lookupKey = deriveTenantKey(this.#hmacRoot, tenantId, 'hmac');
    return {
      ciphertext: this.#encrypt(tenantId, `recipient:${channel}`, normalized),
      hmac: createHmac('sha256', lookupKey)
        .update(channel)
        .update('\0')
        .update(normalized)
        .digest('hex'),
      redacted: redactRecipient(channel, normalized)
    };
  }

  async revealRecipient(
    tenantId: string,
    channel: NotificationChannel,
    ciphertext: string
  ): Promise<string> {
    try {
      return this.#decrypt(tenantId, `recipient:${channel}`, ciphertext);
    } catch {
      throw decryptionError();
    }
  }

  #encrypt(tenantId: string, scope: string, plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      deriveTenantKey(this.#encryptionRoot, tenantId, 'encryption'),
      nonce
    );
    cipher.setAAD(notificationAad(tenantId, scope));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  #decrypt(tenantId: string, scope: string, envelope: string): string {
    const [version, noncePart, tagPart, ciphertextPart, extra] = envelope.split('.');
    if (version !== 'v1' || !noncePart || !tagPart || !ciphertextPart || extra) throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveTenantKey(this.#encryptionRoot, tenantId, 'encryption'),
      decodeBase64Url(noncePart, 12)
    );
    decipher.setAAD(notificationAad(tenantId, scope));
    decipher.setAuthTag(decodeBase64Url(tagPart, 16));
    return Buffer.concat([
      decipher.update(decodeBase64Url(ciphertextPart)),
      decipher.final()
    ]).toString('utf8');
  }
}

export function configuredNotificationProtector(
  env: NodeJS.ProcessEnv = process.env
): NotificationContentProtector {
  const encryptionKey = String(resolveFabricEnv(env, 'NOTIFICATION_ENCRYPTION_KEY') || '');
  const hmacKey = String(resolveFabricEnv(env, 'NOTIFICATION_HMAC_KEY') || '');
  if (encryptionKey && hmacKey) {
    return new EncryptedNotificationProtector({
      encryption_key: encryptionKey,
      hmac_key: hmacKey
    });
  }
  const unavailable = async (): Promise<never> => {
    throw new NotificationError({ code: 'secret_unavailable', retryable: true, status: 503 });
  };
  return {
    protectContent: unavailable,
    revealContent: unavailable,
    protectRecipient: unavailable,
    revealRecipient: unavailable
  };
}

function canonicalContent(content: unknown): string {
  try {
    const canonical = canonicalNotificationJson(content);
    if (Buffer.byteLength(canonical) > 786_432) throw new Error();
    return canonical;
  } catch {
    throw validationError();
  }
}

function normalizeRecipient(channel: NotificationChannel, value: string): string {
  if (typeof value !== 'string') throw validationError();
  const trimmed = value.trim();
  if (channel === 'email') {
    const match = trimmed.match(/^([^\s@]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/);
    if (!match || !match[2].includes('.')) throw validationError();
    return `${match[1]}@${match[2].toLowerCase()}`;
  }
  if (channel === 'sms') {
    const normalized = trimmed.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw validationError();
    return normalized;
  }
  if (channel === 'webhook') {
    try {
      const url = new URL(trimmed);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error();
      }
      return url.toString();
    } catch {
      throw validationError();
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/.test(trimmed)) throw validationError();
  return trimmed;
}

function redactRecipient(channel: NotificationChannel, value: string): string {
  if (channel === 'email') {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (channel === 'sms') return `${value.slice(0, 3)}******${value.slice(-4)}`;
  if (channel === 'webhook') return new URL(value).origin;
  return `${value.slice(0, 1)}***${value.slice(-2)}`;
}

function decodeRootKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw validationError();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw validationError();
  return decoded;
}

function deriveTenantKey(root: Buffer, tenantId: string, purpose: 'encryption' | 'hmac'): Buffer {
  if (!tenantId) throw validationError();
  return Buffer.from(hkdfSync(
    'sha256',
    root,
    Buffer.from('ivekit-notification-v1', 'utf8'),
    Buffer.from(`${purpose}:${tenantId}`, 'utf8'),
    32
  ));
}

function notificationAad(tenantId: string, scope: string): Buffer {
  return Buffer.from(`ivekit-notification:v1\0${tenantId}\0${scope}`, 'utf8');
}

function decodeBase64Url(value: string, exactLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== value) throw new Error();
  if (exactLength !== undefined && decoded.length !== exactLength) throw new Error();
  return decoded;
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}

function decryptionError(): NotificationError {
  return new NotificationError({ code: 'secret_unavailable', retryable: true, status: 503 });
}
