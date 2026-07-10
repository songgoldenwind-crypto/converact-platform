import type { RedisLike } from './redis-client.js';
import { getRedisClient } from './redis-client.js';

export interface TaskLockStore {
  lockTask(taskId: string, owner: string, ttlSec?: number): Promise<boolean>;
  unlockTask(taskId: string, owner: string): Promise<void>;
  isDialerPaused(tenantId: string): Promise<boolean>;
  setDialerPause(tenantId: string, paused: boolean): Promise<void>;
  setCallActive(callId: string, fields: Record<string, string>, ttlSec?: number): Promise<void>;
}

export class RedisTaskLockStore implements TaskLockStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly keyPrefix = ''
  ) {}

  async lockTask(taskId: string, owner: string, ttlSec = 60): Promise<boolean> {
    const result = await this.redis.set(`${this.keyPrefix}task:${taskId}:lock`, owner, 'EX', ttlSec, 'NX');
    return result === 'OK';
  }

  async unlockTask(taskId: string, owner: string): Promise<void> {
    const current = await this.redis.get(`${this.keyPrefix}task:${taskId}:lock`);
    if (current === owner) await this.redis.del(`${this.keyPrefix}task:${taskId}:lock`);
  }

  async isDialerPaused(tenantId: string): Promise<boolean> {
    return Boolean(await this.redis.get(`${this.keyPrefix}dialer:pause:${tenantId}`));
  }

  async setDialerPause(tenantId: string, paused: boolean): Promise<void> {
    const key = `${this.keyPrefix}dialer:pause:${tenantId}`;
    if (paused) {
      await this.redis.setEx(key, '1', 30);
    } else {
      await this.redis.del(key);
    }
  }

  async setCallActive(callId: string, fields: Record<string, string>, ttlSec = 3600): Promise<void> {
    const key = `${this.keyPrefix}call:active:${callId}`;
    await this.redis.hset(key, fields);
    await this.redis.expire(key, ttlSec);
  }
}

export async function createTaskLockStore(redis?: RedisLike): Promise<TaskLockStore> {
  return new RedisTaskLockStore(redis || (await getRedisClient()));
}
