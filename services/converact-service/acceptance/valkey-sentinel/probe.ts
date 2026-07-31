import {
  buildIoRedisConstructorArgs,
  resolveRedisConnectionOptions,
  type IoRedisConnectionOptions
} from '../../../../src/infra/redis-connection-options.js';

interface ProbeRedisClient {
  connect(): Promise<void>;
  disconnect(): void;
  duplicate(): ProbeRedisClient;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<number>;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (channel: string, message: string) => void): void;
}

interface ProbeRedisConstructor {
  new(options: IoRedisConnectionOptions): ProbeRedisClient;
  new(url: string, options: IoRedisConnectionOptions): ProbeRedisClient;
}

const SET_EXPIRY_MODE = 'EX' as const;

async function main(): Promise<void> {
  const phase = required('VALKEY_ACCEPTANCE_PHASE');
  if (phase !== 'before' && phase !== 'after') throw new Error('invalid acceptance phase');
  const config = resolveRedisConnectionOptions(process.env);
  if (config.topology !== 'sentinel') throw new Error('acceptance topology must be sentinel');
  const args = buildIoRedisConstructorArgs(config);
  const module = await import('ioredis');
  const Redis = module.default as unknown as ProbeRedisConstructor;
  const publisher = args.length === 1 ? new Redis(args[0]) : new Redis(args[0], args[1]);
  publisher.on('error', () => { /* surfaced by bounded operations */ });
  let subscriber: ProbeRedisClient | null = null;

  try {
    await withTimeout(publisher.connect(), 10_000, 'publisher connect');
    subscriber = publisher.duplicate();
    subscriber.on('error', () => { /* surfaced by bounded operations */ });
    await withTimeout(subscriber.connect(), 10_000, 'subscriber connect');

    const channel = required('VALKEY_ACCEPTANCE_CHANNEL');
    const message = required('VALKEY_ACCEPTANCE_MESSAGE');
    const received = new Promise<boolean>((resolve) => {
      subscriber?.on('message', (receivedChannel, receivedMessage) => {
        if (receivedChannel === channel && receivedMessage === message) resolve(true);
      });
    });
    await withTimeout(subscriber.subscribe(channel), 5_000, 'subscribe');

    const preKey = required('VALKEY_ACCEPTANCE_PRE_KEY');
    const preValue = required('VALKEY_ACCEPTANCE_PRE_VALUE');
    let preFailoverCanarySurvived = false;
    let postFailoverWriteRead = false;
    if (phase === 'before') {
      await withTimeout(
        publisher.set(preKey, preValue, SET_EXPIRY_MODE, 600),
        5_000,
        'pre-failover write'
      );
      preFailoverCanarySurvived = await publisher.get(preKey) === preValue;
    } else {
      preFailoverCanarySurvived = await publisher.get(preKey) === preValue;
      const postKey = required('VALKEY_ACCEPTANCE_POST_KEY');
      const postValue = required('VALKEY_ACCEPTANCE_POST_VALUE');
      await withTimeout(
        publisher.set(postKey, postValue, SET_EXPIRY_MODE, 600),
        5_000,
        'post-failover write'
      );
      postFailoverWriteRead = await publisher.get(postKey) === postValue;
    }

    await withTimeout(publisher.publish(channel, message), 5_000, 'publish');
    const pubsub = await withTimeout(received, 5_000, 'PubSub delivery');
    if (!preFailoverCanarySurvived || !pubsub || (phase === 'after' && !postFailoverWriteRead)) {
      throw new Error('acceptance assertion failed');
    }
    console.log(JSON.stringify({
      phase,
      topology: config.topology,
      sentinel_count: config.sentinels.length,
      pre_failover_canary_survived: preFailoverCanarySurvived,
      post_failover_write_read: phase === 'after' ? postFailoverWriteRead : null,
      pubsub_verified: pubsub
    }));
  } finally {
    try { subscriber?.disconnect(); } catch { /* best-effort */ }
    try { publisher.disconnect(); } catch { /* best-effort */ }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function required(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch(() => {
  console.error('Valkey Sentinel acceptance probe failed');
  process.exit(1);
});
