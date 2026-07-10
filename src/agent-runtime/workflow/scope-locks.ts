import { id, one, run } from '../../db.js';

export interface ScopeLockInput {
  tenant_id: string;
  scope_key: string;
  owner_run_id: string;
  ttl_seconds?: number;
}

export interface ScopeLock {
  id: string;
  tenant_id: string;
  scope_key: string;
  owner_run_id: string;
  expires_at: string;
}

export class ScopeLockManager {
  db: unknown;

  constructor(db: unknown) {
    this.db = db;
  }

  acquire({ tenant_id, scope_key, owner_run_id, ttl_seconds = 300 }: ScopeLockInput): ScopeLock {
    const active = one(
      this.db,
      `SELECT * FROM scope_locks
       WHERE tenant_id = ? AND scope_key = ? AND status = 'active' AND datetime(expires_at) > CURRENT_TIMESTAMP
       LIMIT 1`,
      [tenant_id, scope_key]
    );
    if (active) {
      const error = new Error(`scope is locked: ${scope_key}`);
      error.status = 409;
      throw error;
    }
    const lock = {
      id: id('lock'),
      tenant_id,
      scope_key,
      owner_run_id,
      expires_at: new Date(Date.now() + ttl_seconds * 1000).toISOString()
    };
    run(
      this.db,
      `INSERT INTO scope_locks (id, tenant_id, scope_key, owner_run_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [lock.id, lock.tenant_id, lock.scope_key, lock.owner_run_id, lock.expires_at]
    );
    return lock;
  }

  release(tenantId: string, lockId: string): void {
    run(
      this.db,
      `UPDATE scope_locks
       SET status = 'released', released_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ? AND status = 'active'`,
      [tenantId, lockId]
    );
  }
}
