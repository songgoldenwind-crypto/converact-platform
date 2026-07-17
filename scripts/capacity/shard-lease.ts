export interface ShardLease {
  shard_id: string;
  worker_id: string;
  lease_epoch: number;
  granted_at_ms: number;
  expires_at_ms: number;
}

interface AcquireLeaseInput {
  shardId: string;
  workerId: string;
  nowMs: number;
  ttlMs: number;
}

interface RenewLeaseInput extends AcquireLeaseInput {
  leaseEpoch: number;
}

export class ShardLeaseRegistry {
  readonly #knownShards: Set<string>;
  readonly #leases = new Map<string, ShardLease>();
  readonly #lastEpoch = new Map<string, number>();

  constructor(shardIds: Iterable<string>) {
    this.#knownShards = new Set(shardIds);
    if (this.#knownShards.size === 0) throw new Error('at least one shard is required');
  }

  acquire(input: AcquireLeaseInput): Readonly<ShardLease> {
    this.#assertInput(input);
    const current = this.#leases.get(input.shardId);
    if (current && input.nowMs < current.expires_at_ms) {
      if (current.worker_id === input.workerId) return Object.freeze({ ...current });
      throw new Error(`shard ${input.shardId} has an active lease owned by ${current.worker_id}`);
    }
    const epoch = (this.#lastEpoch.get(input.shardId) ?? 0) + 1;
    const lease: ShardLease = {
      shard_id: input.shardId,
      worker_id: input.workerId,
      lease_epoch: epoch,
      granted_at_ms: input.nowMs,
      expires_at_ms: input.nowMs + input.ttlMs
    };
    this.#lastEpoch.set(input.shardId, epoch);
    this.#leases.set(input.shardId, lease);
    return Object.freeze({ ...lease });
  }

  renew(input: RenewLeaseInput): Readonly<ShardLease> {
    this.#assertInput(input);
    const current = this.#leases.get(input.shardId);
    if (!current || current.worker_id !== input.workerId || current.lease_epoch !== input.leaseEpoch) {
      throw new Error(`stale shard lease for ${input.shardId}`);
    }
    if (input.nowMs >= current.expires_at_ms) throw new Error(`shard lease ${input.shardId} has expired`);
    const renewed: ShardLease = { ...current, expires_at_ms: input.nowMs + input.ttlMs };
    this.#leases.set(input.shardId, renewed);
    return Object.freeze({ ...renewed });
  }

  assertMayEmit(shardId: string, workerId: string, leaseEpoch: number, nowMs: number): void {
    this.#assertKnownShard(shardId);
    const current = this.#leases.get(shardId);
    if (!current) throw new Error(`shard ${shardId} has no lease`);
    if (nowMs >= current.expires_at_ms) throw new Error(`shard lease ${shardId} has expired`);
    if (current.worker_id !== workerId) throw new Error(`worker ${workerId} is not the owner of shard ${shardId}`);
    if (current.lease_epoch !== leaseEpoch) throw new Error(`stale lease epoch for shard ${shardId}`);
  }

  snapshot(): ReadonlyArray<Readonly<ShardLease>> {
    return [...this.#leases.values()]
      .sort((left, right) => left.shard_id.localeCompare(right.shard_id))
      .map((lease) => Object.freeze({ ...lease }));
  }

  #assertInput(input: AcquireLeaseInput): void {
    this.#assertKnownShard(input.shardId);
    if (!input.workerId) throw new Error('worker ID is required');
    if (!Number.isFinite(input.nowMs)) throw new Error('nowMs must be finite');
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error('lease TTL must be positive');
  }

  #assertKnownShard(shardId: string): void {
    if (!this.#knownShards.has(shardId)) throw new Error(`unknown shard ${shardId}`);
  }
}

