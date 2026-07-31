import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { getRedisPubSub, resetRedisPubSubForTests } from '../src/redis-pubsub.js';
import { getRedisClient, setRedisClientForTests } from '../src/agent-runtime/call-center/redis-client.js';

/**
 * Regression: useMemoryRedisForTests() must initialize BOTH the redis-client
 * singleton AND the redis-pubsub singleton to in-memory implementations.
 *
 * Previously it only set the redis-client singleton. The pubsub singleton
 * independently checked `CONVERACT_USE_MEMORY_REDIS === '1'` — which the helper
 * never set — so getRedisPubSub() created a REAL ioredis client. With no
 * Redis running, ioredis emitted unhandled ECONNREFUSED errors on a retry
 * loop, keeping the Node event loop alive and hanging the test runner.
 *
 * This surfaced whenever a code path triggered broadcastOmniMessage (omni
 * chat escalation), e.g. sprint9-omni.test.ts hung indefinitely.
 */
describe('useMemoryRedisForTests', () => {
  const savedEnv = process.env.CONVERACT_USE_MEMORY_REDIS;

  before(() => {
    // Simulate a fresh process: clear any cached singletons and the env flag.
    delete process.env.CONVERACT_USE_MEMORY_REDIS;
    resetRedisPubSubForTests(null);
    setRedisClientForTests(null);
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.CONVERACT_USE_MEMORY_REDIS;
    else process.env.CONVERACT_USE_MEMORY_REDIS = savedEnv;
  });

  it('forces the pubsub singleton into memory mode (no real ioredis)', async () => {
    useMemoryRedisForTests();
    // Must NOT attempt a real ioredis connection — that would hang/retry.
    const pubsub = await getRedisPubSub();
    // Memory pubsub: publish to an unsubscribed channel is a no-op (returns void).
    await pubsub.publish('test:channel', 'hello');
    assert.ok(pubsub, 'pubsub singleton must be initialized after useMemoryRedisForTests()');
  });

  it('forces the redis-client singleton into memory mode (no real ioredis)', async () => {
    useMemoryRedisForTests();
    const client = await getRedisClient();
    await client.setEx('k', 'v', 10);
    const got = await client.get('k');
    assert.equal(got, 'v');
  });

  it('sets CONVERACT_USE_MEMORY_REDIS=1 so getRedisPubSub is consistent without extra setup', () => {
    useMemoryRedisForTests();
    assert.equal(process.env.CONVERACT_USE_MEMORY_REDIS, '1');
  });
});
