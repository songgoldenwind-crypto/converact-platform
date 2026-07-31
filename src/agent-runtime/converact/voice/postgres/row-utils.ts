import { VoiceError } from '../errors.js';
import type { VoicePage } from '../types.js';

export type VoicePgRow = Record<string, unknown>;

export function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export function jsonArray(value: unknown): unknown[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

export function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

export function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ''));
  if (Number.isNaN(parsed.getTime())) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
  return parsed.toISOString();
}

export function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : timestamp(value);
}

export function numberValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
  return parsed;
}

export function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

export function boundedLimit(value: number): number {
  return Number.isInteger(value) ? Math.min(200, Math.max(1, value)) : 50;
}

export function cursorTuple(cursor: string | undefined): [string, string] {
  if (!cursor) return ['9999-12-31T23:59:59.999Z', '\uffff'];
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.created_at !== 'string' || typeof value.id !== 'string') throw new Error();
    return [timestamp(value.created_at), value.id];
  } catch {
    throw new VoiceError({ code: 'validation_failed', status: 400 });
  }
}

export function pageFromRows<T extends { id: string; created_at: string }>(
  rows: T[],
  limit: number
): VoicePage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last
      ? Buffer.from(JSON.stringify({ v: 1, created_at: last.created_at, id: last.id }), 'utf8').toString('base64url')
      : null
  };
}

export function requiredRow<T>(
  row: T | undefined,
  code: 'not_found' | 'revision_conflict' | 'idempotency_conflict' = 'not_found'
): T {
  if (!row) throw new VoiceError({ code, status: code === 'not_found' ? 404 : 409 });
  return row;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
  }
}
