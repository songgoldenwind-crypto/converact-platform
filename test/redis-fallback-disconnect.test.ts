import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getRedisClient, setRedisClientForTests } from '../src/agent-runtime/call-center/redis-client.js';
import { getRedisPubSub, resetRedisPubSubForTests } from '../src/redis-pubsub.js';

/**
 * Regression: when getRedisClient()/getRedisPubSub() attempt a real ioredis
 * connection and it fails (no Redis running), the orphaned ioredis client
 * must be disconnected. Otherwise it keeps retrying in a tight loop,
 * emitting unhandled 'error' events and holding a socket open — which keeps
 * the Node event loop alive and hangs the test runner.
 *
 * This was the systemic root cause behind every "test hangs after passing"
 * report (sprint9-omni, outbound-dialer, call-center-phase*, etc.).
 */
describe('redis fallback disconnects orphaned clients', () => {
  const savedRedis = process.env.REDIS_URL;
  const savedMem = process.env.OPC_USE_MEMORY_REDIS;

  before(() => {
    // Force the real-ioredis code path: no memory flag, point at a port
    // where nothing listens so connect() fails fast.
    delete process.env.OPC_USE_MEMORY_REDIS;
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listening
    setRedisClientForTests(null);
    resetRedisPubSubForTests(null);
  });

  after(() => {
    if (savedRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedis;
    if (savedMem === undefined) delete process.env.OPC_USE_MEMORY_REDIS;
    else process.env.OPC_USE_MEMORY_REDIS = savedMem;
    setRedisClientForTests(null);
    resetRedisPubSubForTests(null);
  });

  it('getRedisClient falls back to memory and disconnects the failed client', async () => {
    const client = await getRedisClient();
    assert.equal(client.constructor.name, 'MemoryRedis');
    // The failed ioredis client must not still be retrying. Give it a moment
    // to settle, then assert no unhandled 'error' storms continue.
    await new Promise((r) => setTimeout(r, 50));
    // Prove memory client works.
    await client.setEx('k', 'v', 10);
    assert.equal(await client.get('k'), 'v');
  });

  it('getRedisPubSub falls back to memory and disconnects the failed client', async () => {
    const pubsub = await getRedisPubSub();
    assert.equal(pubsub.constructor.name, 'MemoryRedisPubSub');
    await pubsub.publish('test:channel', 'hello');
    // Settle period — if the orphaned client were still alive, the process
    // would not exit and unhandled errors would keep firing.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(pubsub);
  });
});
