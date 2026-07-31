const BLOCKED_METADATA_KEY = /(?:^|[_.-])(api[_.-]?key|access[_.-]?key|secret|token|password|authorization|cookie|credentials?)(?:$|[_.-])/i;

export interface SanitizeProviderMetadataOptions {
  secretValues?: string[];
  maxDepth?: number;
  maxKeys?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
}

export function sanitizeProviderMetadata(
  value: unknown,
  options: SanitizeProviderMetadataOptions = {}
): Record<string, unknown> {
  const limits = {
    maxDepth: boundedLimit(options.maxDepth, 3, 1, 6),
    maxKeys: boundedLimit(options.maxKeys, 32, 1, 100),
    maxArrayItems: boundedLimit(options.maxArrayItems, 20, 1, 100),
    maxStringLength: boundedLimit(options.maxStringLength, 500, 1, 2_000),
    secrets: (options.secretValues || []).map((secret) => String(secret)).filter(Boolean)
  };
  return sanitizeRecord(value, limits, 0);
}

export function sanitizeProviderRequestId(value: unknown): string {
  return safeIdentifier(value, 200);
}

export function sanitizeProviderErrorCode(value: unknown, fallback = 'provider_error'): string {
  return safeIdentifier(value, 100) || fallback;
}

interface MetadataLimits {
  maxDepth: number;
  maxKeys: number;
  maxArrayItems: number;
  maxStringLength: number;
  secrets: string[];
}

function sanitizeRecord(value: unknown, limits: MetadataLimits, depth: number): Record<string, unknown> {
  if (!isRecord(value) || depth >= limits.maxDepth) return {};
  const output: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, limits.maxKeys)) {
    const key = safeMetadataKey(rawKey);
    if (!key || BLOCKED_METADATA_KEY.test(key)) continue;
    const sanitized = sanitizeValue(rawValue, limits, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeValue(value: unknown, limits: MetadataLimits, depth: number): unknown {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (limits.secrets.some((secret) => value.includes(secret))) return undefined;
    return value.slice(0, limits.maxStringLength);
  }
  if (Array.isArray(value)) {
    if (depth >= limits.maxDepth) return [];
    return value
      .slice(0, limits.maxArrayItems)
      .map((item) => sanitizeValue(item, limits, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isRecord(value)) return sanitizeRecord(value, limits, depth);
  return undefined;
}

function safeMetadataKey(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
}

function safeIdentifier(value: unknown, maxLength: number): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
}

function boundedLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`provider metadata limit must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
