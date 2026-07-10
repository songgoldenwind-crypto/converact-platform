/**
 * IVR ↔ ACD bridge — shared enqueue semantics for queue nodes and menu routeType=queue.
 */
import { AcdEngine } from '../call-center/inbound/acd-engine.js';
import { CallQueueStore } from '../call-center/inbound/call-queue.js';
import type { AcdStrategy } from '../call-center/inbound/types.js';
import { AgentSeatStore } from '../call-center/seat-store.js';

export type QueueEnqueueCoreResult =
  | { status: 'connected'; agentId: string; queueEntryId: string }
  | { status: 'pending'; queueEntryId: string };

/** Shared enqueue + findBestSeat — IVR queue 与 inbound-router 单轨（7-A.8）。 */
export function performQueueEnqueueCore(opts: {
  queueStore: CallQueueStore;
  acdEngine: AcdEngine;
  queueId: string;
  callSessionId: string;
  strategy: AcdStrategy;
  priority?: number;
}): QueueEnqueueCoreResult {
  const entry = opts.queueStore.enqueue(opts.queueId, opts.callSessionId, opts.priority ?? 0);
  const seat = opts.acdEngine.findBestSeat(opts.queueId, opts.strategy, {
    vipPriority: opts.priority,
  });
  if (seat) {
    opts.queueStore.assignSeat(entry.id, seat.id);
    return { status: 'connected', agentId: seat.id, queueEntryId: entry.id };
  }
  return { status: 'pending', queueEntryId: entry.id };
}

export type AcdEnqueueResult =
  | { status: 'pending'; queueEntryId: string }
  | { status: 'connected'; agentId: string; queueEntryId?: string }
  | { status: 'at_capacity' }
  | { status: 'error'; reason: string };

export type AcdEnqueueParams = {
  callSessionId: string;
  queueName: string;
  strategy: string;
  priority?: number;
};

export type AcdEnqueueFn = (params: AcdEnqueueParams) => Promise<AcdEnqueueResult>;

/** Map IVR queue node / menu strategy labels to inbound ACD strategy. */
export function mapIvrStrategyToAcd(strategy: string): AcdStrategy {
  switch (strategy) {
    case 'round_robin':
      return 'round_robin';
    case 'random':
      return 'least_calls';
    case 'ring_all':
    case 'fifo':
    default:
      return 'longest_idle';
  }
}

export function createAcdEnqueue(db: unknown, tenantId: string): AcdEnqueueFn {
  const queueStore = new CallQueueStore(db);
  const seatStore = new AgentSeatStore(db);
  const acdEngine = new AcdEngine(db, seatStore, queueStore);

  return async ({ callSessionId, queueName, strategy, priority }) => {
    if (!callSessionId) {
      return { status: 'error', reason: 'missing_call_session' };
    }

    const queue = queueStore.getQueueByName(tenantId, queueName);
    if (!queue) {
      return { status: 'error', reason: 'queue_not_found' };
    }

    if (queueStore.countWaiting(queue.id) >= queue.max_size) {
      return { status: 'at_capacity' };
    }

    try {
      const core = performQueueEnqueueCore({
        queueStore,
        acdEngine,
        queueId: queue.id,
        callSessionId,
        strategy: mapIvrStrategyToAcd(strategy),
        priority,
      });
      if (core.status === 'connected') {
        return {
          status: 'connected',
          agentId: core.agentId,
          queueEntryId: core.queueEntryId,
        };
      }
      return { status: 'pending', queueEntryId: core.queueEntryId };
    } catch (err) {
      return {
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
