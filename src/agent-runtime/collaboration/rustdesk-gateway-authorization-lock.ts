import { MemoryPg, withPgTransaction, type PgQueryable } from '../../db-pg.js';

const memoryLockTails = new WeakMap<MemoryPg, Map<string, Promise<void>>>();

export function rustDeskConsentAuthorizationLock(tenantId: string, remoteSessionId: string): string {
  return `consent:${tenantId}:${remoteSessionId}`;
}

export function rustDeskPolicyAuthorizationLock(tenantId: string, deviceId: string): string {
  return `policy:${tenantId}:${deviceId}`;
}

export async function withRustDeskAuthorizationLocks<T>(
  pg: PgQueryable,
  lockKeys: readonly string[],
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  const keys = [...new Set(lockKeys.filter(Boolean))].sort();
  if (pg instanceof MemoryPg) return withMemoryLocks(pg, keys, () => fn(pg));
  return withPgTransaction(pg, async (client) => {
    for (const key of keys) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['rustdesk_gateway_authorization', key]
      );
    }
    return fn(client);
  });
}

async function withMemoryLocks<T>(
  pg: MemoryPg,
  keys: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  let locks = memoryLockTails.get(pg);
  if (!locks) {
    locks = new Map();
    memoryLockTails.set(pg, locks);
  }
  const held: Array<{ key: string; current: Promise<void>; release: () => void }> = [];
  try {
    for (const key of keys) {
      const previous = locks.get(key) || Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(key, current);
      await previous;
      held.push({ key, current, release });
    }
    return await fn();
  } finally {
    for (const lock of held.reverse()) {
      lock.release();
      if (locks.get(lock.key) === lock.current) locks.delete(lock.key);
    }
  }
}
