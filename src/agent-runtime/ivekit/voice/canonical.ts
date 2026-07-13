import { createHash } from 'node:crypto';

import { VoiceError } from './errors.js';

export interface SafeVoiceProviderPayloadLimits {
  max_depth?: number;
  max_string_length?: number;
  max_array_length?: number;
  max_object_entries?: number;
}

const REDACTED = '[redacted]';
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'xapikey',
  'sdp',
  'rawsdp',
  'body',
  'rawbody',
  'rawpayload',
  'phone',
  'phonenumber',
  'rawphone',
  'e164',
  'fromnumber',
  'tonumber',
  'callernumber',
  'calleenumber',
  'sipauthorization',
  'icepassword'
]);

export function canonicalVoicePayloadHash(input: unknown): string {
  let canonical: string;
  try {
    canonical = canonicalJson(input, new Set());
  } catch {
    throw new VoiceError({ code: 'provider_payload_invalid', status: 422 });
  }
  return createHash('sha256').update(canonical).digest('hex');
}

export function safeVoiceProviderPayload(
  input: unknown,
  limits: SafeVoiceProviderPayloadLimits = {}
): Record<string, unknown> {
  const resolved = {
    max_depth: boundedInteger(limits.max_depth, 5, 1, 12),
    max_string_length: boundedInteger(limits.max_string_length, 256, 8, 4096),
    max_array_length: boundedInteger(limits.max_array_length, 25, 1, 200),
    max_object_entries: boundedInteger(limits.max_object_entries, 50, 1, 200)
  };
  const value = sanitize(input, resolved, 0, new Set());
  return isPlainObject(value) ? value : { value };
}

function canonicalJson(input: unknown, ancestors: Set<object>): string {
  if (input === null) return 'null';
  if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('non-finite number');
    return JSON.stringify(input);
  }
  if (typeof input !== 'object') throw new Error('non-JSON value');
  if (ancestors.has(input)) throw new Error('circular value');
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return `[${input.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    if (!isPlainObject(input)) throw new Error('non-plain object');
    return `{${Object.keys(input).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(input[key], ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(input);
  }
}

interface ResolvedLimits {
  max_depth: number;
  max_string_length: number;
  max_array_length: number;
  max_object_entries: number;
}

function sanitize(
  input: unknown,
  limits: ResolvedLimits,
  depth: number,
  ancestors: Set<object>
): unknown {
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') return Number.isFinite(input) ? input : '[invalid-number]';
  if (typeof input === 'string') {
    if (looksLikeAddress(input)) return REDACTED;
    return input.slice(0, limits.max_string_length);
  }
  if (typeof input !== 'object') return '[unsupported]';
  if (Buffer.isBuffer(input)) return `[binary:${input.length}]`;
  if (input instanceof Date) return input.toISOString();
  if (ancestors.has(input)) return '[circular]';
  if (depth >= limits.max_depth) return '[truncated]';

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return input.slice(0, limits.max_array_length)
        .map((item) => sanitize(item, limits, depth + 1, ancestors));
    }
    if (!isPlainObject(input)) return '[unsupported-object]';
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).slice(0, limits.max_object_entries)) {
      output[key] = isSensitiveKey(key)
        ? REDACTED
        : sanitize(input[key], limits, depth + 1, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  return /^sips?:[^\s@]+@[^\s@]+$/i.test(trimmed)
    || /^\+?[\d\s().-]{7,}$/.test(trimmed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}
