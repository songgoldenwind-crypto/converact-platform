export interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttl: number, flag: 'NX'): Promise<string | null>;
  setEx(key: string, value: string, ttl: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  hset(key: string, fields: Record<string, string>): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
  quit(): Promise<void>;
}

export class MemoryRedis implements RedisLike {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async set(key: string, value: string, mode: 'EX', ttl: number, flag: 'NX'): Promise<string | null> {
    if (mode !== 'EX' || flag !== 'NX') throw new Error('MemoryRedis only supports SET key value EX ttl NX');
    this.cleanup();
    if (this.store.has(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }

  async setEx(key: string, value: string, ttl: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }

  async get(key: string): Promise<string | null> {
    this.cleanup();
    return this.store.get(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    const existing = (await this.get(key)) || '{}';
    const parsed = JSON.parse(existing) as Record<string, string>;
    Object.assign(parsed, fields);
    this.store.set(key, { value: JSON.stringify(parsed), expiresAt: null });
    return Object.keys(fields).length;
  }

  async expire(key: string, ttl: number): Promise<number> {
    const row = this.store.get(key);
    if (!row) return 0;
    row.expiresAt = Date.now() + ttl * 1000;
    return 1;
  }

  async quit(): Promise<void> {
    this.store.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, row] of this.store.entries()) {
      if (row.expiresAt !== null && row.expiresAt <= now) this.store.delete(key);
    }
  }
}

let sharedClient: RedisLike | null = null;

export async function getRedisClient(): Promise<RedisLike> {
  if (sharedClient) return sharedClient;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  if (process.env.OPC_USE_MEMORY_REDIS === '1') {
    sharedClient = new MemoryRedis();
    return sharedClient;
  }
  try {
    const mod = await import('ioredis');
    const RedisCtor = mod.default as unknown as new (
      url: string,
      opts: { maxRetriesPerRequest: number; lazyConnect: boolean }
    ) => {
      connect(): Promise<void>;
      disconnect(): void;
      on(event: 'error', listener: (err: Error) => void): void;
      set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
      get(key: string): Promise<string | null>;
      del(key: string): Promise<number>;
      hset(key: string, ...args: string[]): Promise<number>;
      expire(key: string, ttl: number): Promise<number>;
      quit(): Promise<string>;
    };
    const client = new RedisCtor(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    client.on('error', () => { /* handled via connect() rejection */ });
    try {
      await client.connect();
    } catch (error) {
      try { client.disconnect(); } catch { /* best-effort */ }
      throw error;
    }
    sharedClient = {
      set: (key, value, mode, ttl, flag) => client.set(key, value, mode, ttl, flag),
      setEx: async (key, value, ttl) => {
        await client.set(key, value, 'EX', ttl);
      },
      get: (key) => client.get(key),
      del: (key) => client.del(key),
      hset: async (key, fields) => {
        const args: string[] = [];
        for (const [field, value] of Object.entries(fields)) args.push(field, value);
        return client.hset(key, ...args);
      },
      expire: (key, ttl) => client.expire(key, ttl),
      quit: () => client.quit().then(() => undefined)
    };
    return sharedClient;
  } catch {
    sharedClient = new MemoryRedis();
    return sharedClient;
  }
}

export function setRedisClientForTests(client: RedisLike | null): void {
  sharedClient = client;
}
