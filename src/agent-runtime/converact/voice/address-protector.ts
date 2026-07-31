import { resolveFabricEnv } from '../../../config/converact-env.js';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import { VoiceError } from './errors.js';
import type { VoiceAddressProtector } from './ports.js';
import type { VoiceAddressKind } from './types.js';

export interface EncryptedVoiceAddressProtectorOptions {
  encryption_key: string;
  hmac_key: string;
}

export class EncryptedVoiceAddressProtector {
  readonly #encryptionRoot: Buffer;
  readonly #hmacRoot: Buffer;

  constructor(options: EncryptedVoiceAddressProtectorOptions) {
    this.#encryptionRoot = decodeRootKey(options.encryption_key);
    this.#hmacRoot = decodeRootKey(options.hmac_key);
    if (timingSafeEqual(this.#encryptionRoot, this.#hmacRoot)) {
      throw new VoiceError({ code: 'validation_failed', status: 500 });
    }
  }

  async protect(
    tenantId: string,
    value: string,
    kind: VoiceAddressKind
  ): Promise<{ ciphertext: string; hmac: string; redacted: string }> {
    const normalized = normalizeAddress(value, kind);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveTenantKey(this.#encryptionRoot, tenantId, 'encryption'), nonce);
    cipher.setAAD(addressAad(tenantId, kind));
    const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const lookupKey = deriveTenantKey(this.#hmacRoot, tenantId, 'hmac');
    const hmac = createHmac('sha256', lookupKey)
      .update(kind)
      .update('\0')
      .update(normalized)
      .digest('hex');

    return {
      ciphertext: `v1.${nonce.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`,
      hmac,
      redacted: redactAddress(normalized, kind)
    };
  }

  async reveal(tenantId: string, envelope: string, kind: VoiceAddressKind): Promise<string> {
    try {
      const [version, noncePart, tagPart, ciphertextPart, extra] = envelope.split('.');
      if (version !== 'v1' || !noncePart || !tagPart || !ciphertextPart || extra) throw new Error('invalid envelope');
      const nonce = decodeBase64Url(noncePart, 12);
      const tag = decodeBase64Url(tagPart, 16);
      const ciphertext = decodeBase64Url(ciphertextPart);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        deriveTenantKey(this.#encryptionRoot, tenantId, 'encryption'),
        nonce
      );
      decipher.setAAD(addressAad(tenantId, kind));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new VoiceError({ code: 'address_decryption_failed', status: 422 });
    }
  }
}

export function configuredVoiceAddressProtector(
  env: NodeJS.ProcessEnv = process.env
): VoiceAddressProtector {
  const encryptionKey = String(
    resolveFabricEnv(env, 'VOICE_ADDRESS_KEY')
    || resolveFabricEnv(env, 'VOICE_ADDRESS_ENCRYPTION_KEY')
    || ''
  );
  const hmacKey = String(resolveFabricEnv(env, 'VOICE_ADDRESS_HMAC_KEY') || '');
  if (encryptionKey && hmacKey) {
    return new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: hmacKey });
  }
  const unavailable = async (): Promise<never> => {
    throw new VoiceError({ code: 'secret_unavailable', retryable: true, status: 503 });
  };
  return { protect: unavailable, reveal: unavailable };
}

function decodeRootKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new VoiceError({ code: 'validation_failed', status: 500 });
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new VoiceError({ code: 'validation_failed', status: 500 });
  }
  return decoded;
}

function deriveTenantKey(root: Buffer, tenantId: string, purpose: 'encryption' | 'hmac'): Buffer {
  if (!tenantId) throw new VoiceError({ code: 'validation_failed' });
  return Buffer.from(hkdfSync(
    'sha256',
    root,
    Buffer.from('ivekit-voice-address-v1', 'utf8'),
    Buffer.from(`${purpose}:${tenantId}`, 'utf8'),
    32
  ));
}

function addressAad(tenantId: string, kind: VoiceAddressKind): Buffer {
  return Buffer.from(`ivekit-voice-address:v1\0${tenantId}\0${kind}`, 'utf8');
}

function decodeBase64Url(value: string, exactLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== value) throw new Error('invalid base64url');
  if (exactLength !== undefined && decoded.length !== exactLength) throw new Error('invalid length');
  return decoded;
}

function normalizeAddress(value: string, kind: VoiceAddressKind): string {
  if (typeof value !== 'string') throw new VoiceError({ code: 'invalid_address', status: 422 });
  const trimmed = value.trim();
  if (kind === 'e164') {
    const normalized = trimmed.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      throw new VoiceError({ code: 'invalid_address', status: 422 });
    }
    return normalized;
  }
  if (kind === 'extension') {
    if (!/^\d{2,12}$/.test(trimmed)) {
      throw new VoiceError({ code: 'invalid_address', status: 422 });
    }
    return trimmed;
  }
  if (kind === 'sip_uri') {
    const match = trimmed.match(/^sip:([^@\s:]+)@([a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/i);
    if (!match) throw new VoiceError({ code: 'invalid_address', status: 422 });
    const port = match[3] ? Number(match[3]) : null;
    if (port !== null && port > 65535) throw new VoiceError({ code: 'invalid_address', status: 422 });
    return `sip:${match[1]}@${match[2].toLowerCase()}${port === null ? '' : `:${port}`}`;
  }
  throw new VoiceError({ code: 'invalid_address', status: 422 });
}

function redactAddress(value: string, kind: VoiceAddressKind): string {
  if (kind === 'e164') return `${value.slice(0, 3)}******${value.slice(-4)}`;
  if (kind === 'extension') return `${'*'.repeat(Math.max(2, value.length - 2))}${value.slice(-2)}`;
  const match = value.match(/^sip:([^@]+)@(.+)$/)!;
  return `sip:${match[1].slice(0, 1)}***@${match[2]}`;
}
