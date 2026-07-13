import { IvrError } from '../errors.js';

export type IvrPgRow = Record<string, unknown>;

export function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export function numberValue(value: unknown): number {
  const output = Number(value);
  if (!Number.isFinite(output)) throw protocolError();
  return output;
}

export function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

export function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const output = new Date(String(value ?? ''));
  if (Number.isNaN(output.getTime())) throw protocolError();
  return output.toISOString();
}

export function requiredRow<T>(row: T | undefined, code: 'not_found' | 'revision_conflict'): T {
  if (!row) throw new IvrError({ code, status: code === 'not_found' ? 404 : 409 });
  return row;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw protocolError();
  }
}

function protocolError(): IvrError {
  return new IvrError({ code: 'internal_error', status: 500 });
}
