import { getRedisClient, setRedisClientForTests, type RedisLike } from './redis-client.js';

export interface RedisPubSubLike {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<void>;
}

interface RedisSubscriber {
  connect(): Promise<void>;
  disconnect(): void;
  on(event: 'error', listener: (err: Error) => void): void;
  subscribe(channel: string): Promise<number>;
  on(event: 'message', listener: (channel: string, message: string) => void): void;
}

class MemoryRedisPubSub implements RedisPubSubLike {
  private readonly channels = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string): Promise<void> {
    const handlers = this.channels.get(channel);
    if (!handlers) return;
    for (const handler of handlers) handler(message);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<void> {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(onMessage);
  }
}

class IoRedisPubSub implements RedisPubSubLike {
  constructor(
    private readonly publisher: {
      publish(channel: string, message: string): Promise<number>;
    },
    private readonly subscriber: {
      subscribe(channel: string): Promise<number>;
      on(event: 'message', listener: (channel: string, message: string) => void): void;
    }
  ) {}

  async publish(channel: string, message: string): Promise<void> {
    await this.publisher.publish(channel, message);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, message) => {
      if (ch === channel) onMessage(message);
    });
  }
}

let sharedPubSub: RedisPubSubLike | null = null;

export async function getRedisPubSub(): Promise<RedisPubSubLike> {
  if (sharedPubSub) return sharedPubSub;

  if (process.env.OPC_USE_MEMORY_REDIS === '1') {
    sharedPubSub = new MemoryRedisPubSub();
    return sharedPubSub;
  }

  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    const mod = await import('ioredis');
    const RedisCtor = mod.default as unknown as new (
      url: string,
      opts: { maxRetriesPerRequest: number; lazyConnect: boolean }
    ) => {
      connect(): Promise<void>;
      disconnect(): void;
      on(event: 'error', listener: (err: Error) => void): void;
      publish(channel: string, message: string): Promise<number>;
      duplicate(): {
        connect(): Promise<void>;
        disconnect(): void;
        on(event: 'error', listener: (err: Error) => void): void;
        subscribe(channel: string): Promise<number>;
        on(event: 'message', listener: (channel: string, message: string) => void): void;
      };
    };

    // ioredis emits 'error' on every failed (re)connection attempt. Without a
    // listener these become unhandled and crash/hang the process. Attach a
    // no-op listener so failures surface only via the connect() rejection.
    const publisher = new RedisCtor(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    publisher.on('error', () => { /* handled via connect() rejection */ });
    let subscriber: RedisSubscriber | null = null;
    try {
      await publisher.connect();
      subscriber = publisher.duplicate();
      subscriber.on('error', () => { /* handled via connect() rejection */ });
      await subscriber.connect();
    } catch (err) {
      // connect() failed (e.g. no Redis running). ioredis otherwise keeps
      // retrying forever in the background, emitting 'error' storms and
      // holding a socket open — which keeps the Node event loop alive and
      // hangs the test runner. Force-disconnect the orphaned clients so the
      // memory fallback leaves no lingering handles.
      try { subscriber?.disconnect(); } catch { /* best-effort */ }
      try { publisher.disconnect(); } catch { /* best-effort */ }
      throw err;
    }
    sharedPubSub = new IoRedisPubSub(publisher, subscriber);
    return sharedPubSub;
  } catch {
    sharedPubSub = new MemoryRedisPubSub();
    return sharedPubSub;
  }
}

export function resetRedisPubSubForTests(client: RedisPubSubLike | null = null): void {
  sharedPubSub = client;
}

export { getRedisClient, setRedisClientForTests, type RedisLike };
