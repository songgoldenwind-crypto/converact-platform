import { createHash } from 'node:crypto';

import { ContactCenterError } from './errors.js';

export function canonicalContactCenterPayloadHash(value: unknown): string {
  try {
    return createHash('sha256').update(canonical(value, new Set())).digest('hex');
  } catch {
    throw new ContactCenterError({ code: 'validation_failed', status: 422 });
  }
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('non-JSON value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ancestors)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain object');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
