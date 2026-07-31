import { ContactCenterError } from '../errors.js';

export type ContactCenterPgRow = Record<string, unknown>;

export function ccJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw protocolError();
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function ccNumber(value: unknown): number {
  const output = Number(value);
  if (!Number.isFinite(output)) throw protocolError();
  return output;
}

export function ccTimestamp(value: unknown): string {
  const output = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(output.getTime())) throw protocolError();
  return output.toISOString();
}

export function ccNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : ccTimestamp(value);
}

export function ccRequiredRow<T>(row: T | undefined, code: 'not_found' | 'conflict' = 'not_found'): T {
  if (!row) throw new ContactCenterError({ code, status: code === 'not_found' ? 404 : 409 });
  return row;
}

function protocolError(): ContactCenterError {
  return new ContactCenterError({ code: 'validation_failed', status: 500, message: 'invalid PostgreSQL projection' });
}
