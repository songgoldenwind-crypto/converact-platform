import { AsyncLocalStorage } from 'node:async_hooks';

import { MemoryPg, withPgTransaction, type PgQueryable } from '../../db-pg.js';

const SESSION_LOCK_NAMESPACE = 'opc.collaboration.session.v1';
const PARTICIPANT_LOCK_NAMESPACE = 'opc.collaboration.participant.v1';

type SessionLockMode = 'shared' | 'exclusive';

interface MemorySessionLock {
  readers: number;
  writer: boolean;
}

const memorySessionLocks = new WeakMap<MemoryPg, Map<string, MemorySessionLock>>();
const memoryParticipantLocks = new WeakMap<MemoryPg, Set<string>>();
const heldSessionLocks = new AsyncLocalStorage<Map<string, SessionLockMode>>();
const heldParticipantLocks = new AsyncLocalStorage<Set<string>>();

/**
 * Pass a Pool, or a PoolClient that is already inside its caller-owned transaction.
 * Advisory xact locks are only useful when every protected write shares that transaction.
 */
export async function withCollaborationSessionLock<T>(
  pg: PgQueryable,
  input: {
    tenantId: string;
    sessionId: string;
    mode: SessionLockMode;
  },
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  const lockKey = `${input.tenantId}\u0000${input.sessionId}`;
  const held = heldSessionLocks.getStore();
  const heldMode = held?.get(lockKey);
  if (heldMode) {
    if (heldMode === 'shared' && input.mode === 'exclusive') {
      throw sessionBusyError('cannot upgrade a shared collaboration session lock');
    }
    return fn(pg);
  }

  const nextHeld = new Map(held || []);
  nextHeld.set(lockKey, input.mode);
  return heldSessionLocks.run(nextHeld, async () => {
    if (pg instanceof MemoryPg) {
      return withMemorySessionLock(pg, lockKey, input.mode, fn);
    }
    return withPgTransaction(pg, async (transactionPg) => {
      const lockFunction = input.mode === 'shared'
        ? 'pg_try_advisory_xact_lock_shared'
        : 'pg_try_advisory_xact_lock';
      const lock = await transactionPg.query<{ acquired: boolean }>(
        `SELECT ${lockFunction}(
           hashtext($1),
           hashtext($2 || ':' || length($2)::text || ':' || $3)
         ) AS acquired`,
        [SESSION_LOCK_NAMESPACE, input.tenantId, input.sessionId]
      );
      if (lock.rows[0]?.acquired !== true) throw sessionBusyError();
      return fn(transactionPg);
    });
  });
}

export async function withCollaborationParticipantLock<T>(
  pg: PgQueryable,
  input: { tenantId: string; sessionId: string; identity: string },
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  return withCollaborationSessionLock(pg, {
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    mode: 'shared'
  }, (sessionPg) => withCollaborationParticipantIdentityLock(sessionPg, input, fn));
}

async function withCollaborationParticipantIdentityLock<T>(
  pg: PgQueryable,
  input: { tenantId: string; sessionId: string; identity: string },
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  const lockKey = `${input.tenantId}\u0000${input.sessionId}\u0000${input.identity}`;
  const held = heldParticipantLocks.getStore();
  if (held?.has(lockKey)) return fn(pg);

  const nextHeld = new Set(held || []);
  nextHeld.add(lockKey);
  return heldParticipantLocks.run(nextHeld, async () => {
    if (pg instanceof MemoryPg) {
      let locks = memoryParticipantLocks.get(pg);
      if (!locks) {
        locks = new Set();
        memoryParticipantLocks.set(pg, locks);
      }
      if (locks.has(lockKey)) throw participantBusyError();
      locks.add(lockKey);
      try {
        return await fn(pg);
      } finally {
        locks.delete(lockKey);
        if (locks.size === 0) memoryParticipantLocks.delete(pg);
      }
    }
    return withPgTransaction(pg, async (transactionPg) => {
      const lock = await transactionPg.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(
           hashtext($1),
           hashtext(
             $2 || ':' || length($2)::text || ':' ||
             $3 || ':' || length($3)::text || ':' || $4
           )
         ) AS acquired`,
        [PARTICIPANT_LOCK_NAMESPACE, input.tenantId, input.sessionId, input.identity]
      );
      if (lock.rows[0]?.acquired !== true) throw participantBusyError();
      return fn(transactionPg);
    });
  });
}

async function withMemorySessionLock<T>(
  pg: MemoryPg,
  lockKey: string,
  mode: SessionLockMode,
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  let locks = memorySessionLocks.get(pg);
  if (!locks) {
    locks = new Map();
    memorySessionLocks.set(pg, locks);
  }
  const state = locks.get(lockKey) || { readers: 0, writer: false };
  if (mode === 'shared') {
    if (state.writer) throw sessionBusyError();
    state.readers += 1;
  } else {
    if (state.writer || state.readers > 0) throw sessionBusyError();
    state.writer = true;
  }
  locks.set(lockKey, state);
  try {
    return await fn(pg);
  } finally {
    if (mode === 'shared') state.readers -= 1;
    else state.writer = false;
    if (!state.writer && state.readers === 0) locks.delete(lockKey);
    if (locks.size === 0) memorySessionLocks.delete(pg);
  }
}

function sessionBusyError(message = 'collaboration session update in progress; retry request'): Error {
  return Object.assign(new Error(message), {
    status: 409,
    code: 'collaboration_session_busy',
    retryable: true
  });
}

function participantBusyError(): Error {
  return Object.assign(new Error('collaboration participant update in progress; retry request'), {
    status: 409,
    code: 'collaboration_participant_busy',
    retryable: true
  });
}
