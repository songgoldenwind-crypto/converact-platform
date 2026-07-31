import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  attachPostgresPoolErrorHandler,
  type PostgresPoolErrorEvent
} from '../src/db-pg.js';

test('idle PostgreSQL client errors are observed without terminating the process', () => {
  const pool = new EventEmitter();
  const observed: PostgresPoolErrorEvent[] = [];
  attachPostgresPoolErrorHandler(pool, (event) => {
    observed.push(event);
  });

  pool.emit(
    'error',
    Object.assign(new Error('terminating connection for password=must-not-leak'), {
      code: '57P01'
    })
  );

  assert.deepEqual(observed, [{
    event: 'postgres.pool.idle_client_error',
    error_code: '57P01',
    action: 'connection_discarded'
  }]);
  assert.doesNotMatch(JSON.stringify(observed), /password|must-not-leak/i);
});

test('a failing PostgreSQL pool error reporter cannot recreate the crash path', () => {
  const pool = new EventEmitter();
  attachPostgresPoolErrorHandler(pool, () => {
    throw new Error('reporter failed');
  });

  assert.doesNotThrow(() => {
    pool.emit('error', Object.assign(new Error('database stopped'), { code: '57P01' }));
  });
});

test('an asynchronously failing PostgreSQL pool reporter is also contained', async (t) => {
  const pool = new EventEmitter();
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', observe);
  t.after(() => process.off('unhandledRejection', observe));
  attachPostgresPoolErrorHandler(pool, async () => {
    throw new Error('async reporter failed');
  });

  pool.emit('error', Object.assign(new Error('database stopped'), { code: '57P01' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(unhandled, []);
});
