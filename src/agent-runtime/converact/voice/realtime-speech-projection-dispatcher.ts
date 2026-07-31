import type {
  RealtimeSpeechProjection,
  RealtimeSpeechProjectionContext
} from './realtime-speech-projection.js';
import type {
  RealtimeSpeechTranslationEvent
} from './realtime-speech-translation.js';

export type RealtimeSpeechProjectionDispatchResult =
  | 'accepted'
  | 'dropped_overflow'
  | 'closed';

export interface RealtimeSpeechProjectionDispatchEvent {
  type: 'projection.succeeded' | 'projection.retrying' | 'projection.dropped';
  media_source: 'rustpbx' | 'livekit';
  final: boolean;
  reason: '' | 'projection_failed' | 'projection_queue_overflow' | 'projection_shutdown_timeout';
  attempt: number;
}

export interface RealtimeSpeechProjectionDispatcherOptions {
  projection: Pick<RealtimeSpeechProjection, 'project'>;
  max_queue_items?: number;
  retry_delays_ms?: readonly number[];
  shutdown_timeout_ms?: number;
  on_event?: (
    event: RealtimeSpeechProjectionDispatchEvent
  ) => void | Promise<void>;
}

interface PendingProjection {
  context: RealtimeSpeechProjectionContext;
  event: RealtimeSpeechTranslationEvent;
}

export class RealtimeSpeechProjectionDispatcher {
  readonly #queue: PendingProjection[] = [];
  readonly #projection: Pick<RealtimeSpeechProjection, 'project'>;
  readonly #maxQueueItems: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #shutdownTimeoutMs: number;
  readonly #onEvent?: RealtimeSpeechProjectionDispatcherOptions['on_event'];
  readonly #idleWaiters = new Set<() => void>();
  #pumping = false;
  #closed = false;
  #forceStop = false;

  constructor(options: RealtimeSpeechProjectionDispatcherOptions) {
    if (!options?.projection || typeof options.projection.project !== 'function') {
      throw new Error('projection_dispatcher_invalid');
    }
    this.#projection = options.projection;
    this.#maxQueueItems = boundedInteger(
      options.max_queue_items ?? 4_096,
      1,
      100_000,
      'projection_dispatcher_queue_invalid'
    );
    const retryDelays = options.retry_delays_ms ?? [100, 250, 500, 1_000, 2_000];
    if (!Array.isArray(retryDelays) || retryDelays.length > 20
      || retryDelays.some((delay) =>
        !Number.isSafeInteger(delay) || delay < 0 || delay > 30_000
      )) {
      throw new Error('projection_dispatcher_retry_invalid');
    }
    this.#retryDelaysMs = Object.freeze([...retryDelays]);
    this.#shutdownTimeoutMs = boundedInteger(
      options.shutdown_timeout_ms ?? 1_000,
      10,
      30_000,
      'projection_dispatcher_shutdown_invalid'
    );
    this.#onEvent = options.on_event;
  }

  offer(
    context: RealtimeSpeechProjectionContext,
    event: RealtimeSpeechTranslationEvent
  ): RealtimeSpeechProjectionDispatchResult {
    if (this.#closed) return 'closed';
    const item = {
      context: structuredClone(context),
      event: structuredClone(event)
    };
    if (this.#queue.length >= this.#maxQueueItems) {
      if (!event.final) {
        this.#emit(item, 'projection.dropped', 'projection_queue_overflow', 0);
        return 'dropped_overflow';
      }
      const partialIndex = this.#queue.findIndex(
        (candidate) => !candidate.event.final
      );
      if (partialIndex < 0) {
        this.#emit(item, 'projection.dropped', 'projection_queue_overflow', 0);
        return 'dropped_overflow';
      }
      const [dropped] = this.#queue.splice(partialIndex, 1);
      this.#emit(
        dropped,
        'projection.dropped',
        'projection_queue_overflow',
        0
      );
    }
    this.#queue.push(item);
    this.#schedule();
    return 'accepted';
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#pumping) return;
    const idle = new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    const drained = await settleWithin(idle, this.#shutdownTimeoutMs);
    if (drained) return;
    this.#forceStop = true;
    for (const item of this.#queue.splice(0)) {
      this.#emit(
        item,
        'projection.dropped',
        'projection_shutdown_timeout',
        0
      );
    }
  }

  #schedule(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    queueMicrotask(() => void this.#pump());
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#forceStop && this.#queue.length > 0) {
        const item = this.#queue.shift()!;
        await this.#project(item);
      }
    } finally {
      this.#pumping = false;
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
      if (!this.#closed && !this.#forceStop && this.#queue.length > 0) {
        this.#schedule();
      }
    }
  }

  async #project(item: PendingProjection): Promise<void> {
    let attempt = 0;
    while (!this.#forceStop) {
      try {
        await this.#projection.project(item.context, item.event);
        this.#emit(item, 'projection.succeeded', '', attempt + 1);
        return;
      } catch {
        if (!item.event.final || attempt >= this.#retryDelaysMs.length) {
          this.#emit(item, 'projection.dropped', 'projection_failed', attempt + 1);
          return;
        }
        this.#emit(item, 'projection.retrying', 'projection_failed', attempt + 1);
        const delay = this.#retryDelaysMs[attempt];
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  #emit(
    item: PendingProjection,
    type: RealtimeSpeechProjectionDispatchEvent['type'],
    reason: RealtimeSpeechProjectionDispatchEvent['reason'],
    attempt: number
  ): void {
    try {
      const result = this.#onEvent?.(Object.freeze({
        type,
        media_source: item.context.media_source,
        final: item.event.final,
        reason,
        attempt
      }));
      if (result && typeof result.then === 'function') {
        void result.catch(() => undefined);
      }
    } catch {
      // Observability failure cannot affect projection or media forwarding.
    }
  }
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  code: string
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(code);
  }
  return value;
}

function sleep(delayMs: number): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
