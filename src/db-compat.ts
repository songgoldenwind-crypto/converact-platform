import { randomUUID } from 'node:crypto';

type SqliteValue = string | number | bigint | boolean | null | Uint8Array;
export type SqliteParams = SqliteValue[];

interface StatementLike {
  get: (...params: SqliteValue[]) => any;
  all: (...params: SqliteValue[]) => any[];
  run: (...params: SqliteValue[]) => any;
}

export interface DatabaseLike {
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementLike;
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function one(db: unknown, sql: string, params: SqliteParams = []): any {
  return asDatabase(db).prepare(sql).get(...params);
}

export function all(db: unknown, sql: string, params: SqliteParams = []): any[] {
  return asDatabase(db).prepare(sql).all(...params);
}

export function run(db: unknown, sql: string, params: SqliteParams = []): any {
  return asDatabase(db).prepare(sql).run(...params);
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function parseJson<T>(value: string | null | undefined, fallback: T = {} as T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function asDatabase(db: unknown): DatabaseLike {
  return db as DatabaseLike;
}
