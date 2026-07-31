import type {
  ProcessingEventPage,
  ProcessingTerminalEvent
} from './processing.js';

const MAX_UINT64 = (1n << 64n) - 1n;

export interface ProcessingEventSource {
  scanEvents(input: {
    after_sequence: string;
    limit: number;
  }): Promise<ProcessingEventPage>;
  acknowledgeEvent(input: {
    event_sequence: string;
    event_id: string;
  }): Promise<void>;
}

export interface ProcessingTerminalEventSink {
  publishProcessingTerminal(
    event: ProcessingTerminalEvent
  ): Promise<{ replayed: boolean }>;
}

export interface ProcessingEventHandoffOptions {
  source: ProcessingEventSource;
  sink: ProcessingTerminalEventSink;
  batch_size: number;
  poll_interval_ms: number;
  retry_base_ms: number;
  retry_max_ms: number;
  error_observer?: (error: unknown) => void;
}

export interface ProcessingEventHandoffResult {
  scanned: number;
  persisted: number;
  acknowledged: number;
  cursor: string;
}

export class ProcessingEventHandoff {
  readonly #source: ProcessingEventSource;
  readonly #sink: ProcessingTerminalEventSink;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #errorObserver: ((error: unknown) => void) | undefined;
  #cursor = '0';
  #ready = false;
  #runningOnce = false;
  #stopping = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: ProcessingEventHandoffOptions) {
    this.#source = options.source;
    this.#sink = options.sink;
    this.#batchSize = integer(options.batch_size, 1, 10_000, 'batch_size');
    this.#pollIntervalMs = integer(
      options.poll_interval_ms,
      1,
      300_000,
      'poll_interval_ms'
    );
    this.#retryBaseMs = integer(
      options.retry_base_ms,
      1,
      300_000,
      'retry_base_ms'
    );
    this.#retryMaxMs = integer(
      options.retry_max_ms,
      this.#retryBaseMs,
      3_600_000,
      'retry_max_ms'
    );
    this.#errorObserver = options.error_observer;
  }

  cursor(): string {
    return this.#cursor;
  }

  ready(): boolean {
    return this.#ready && !this.#stopping;
  }

  start(): void {
    if (this.#loop) throw new Error('processing_event_handoff_started');
    this.#stopping = false;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#ready = false;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }

  async runOnce(): Promise<ProcessingEventHandoffResult> {
    if (this.#runningOnce) {
      throw new Error('processing_event_handoff_concurrent_run');
    }
    this.#runningOnce = true;
    try {
      const page = await this.#source.scanEvents({
        after_sequence: this.#cursor,
        limit: this.#batchSize
      });
      const acknowledgedThrough = uint64(
        page.acknowledged_through,
        true,
        'acknowledged_through'
      );
      if (BigInt(acknowledgedThrough) < BigInt(this.#cursor)) {
        throw new Error('processing_event_handoff_cursor_regressed');
      }
      this.#cursor = acknowledgedThrough;
      let expected = BigInt(this.#cursor) + 1n;
      let persisted = 0;
      let acknowledged = 0;
      if (page.items.length > this.#batchSize) {
        throw new Error('processing_event_handoff_batch_exceeded');
      }
      for (const event of page.items) {
        const eventSequence = uint64(
          event.event_sequence,
          false,
          'event_sequence'
        );
        if (BigInt(eventSequence) !== expected) {
          throw new Error('processing_event_handoff_sequence_gap');
        }
        await this.#sink.publishProcessingTerminal(event);
        persisted += 1;
        await this.#source.acknowledgeEvent({
          event_sequence: eventSequence,
          event_id: event.event_id
        });
        acknowledged += 1;
        this.#cursor = eventSequence;
        expected += 1n;
      }
      this.#ready = true;
      return {
        scanned: page.items.length,
        persisted,
        acknowledged,
        cursor: this.#cursor
      };
    } catch (error) {
      this.#ready = false;
      throw error;
    } finally {
      this.#runningOnce = false;
    }
  }

  async #run(): Promise<void> {
    let retryMs = this.#retryBaseMs;
    while (!this.#stopping) {
      try {
        const result = await this.runOnce();
        retryMs = this.#retryBaseMs;
        if (result.scanned < this.#batchSize) {
          await this.#sleep(this.#pollIntervalMs);
        }
      } catch (error) {
        this.#errorObserver?.(error);
        await this.#sleep(retryMs);
        retryMs = Math.min(this.#retryMaxMs, retryMs * 2);
      }
    }
  }

  #sleep(milliseconds: number): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, milliseconds);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }
}

function integer(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`processing_event_handoff_${name}_invalid`);
  }
  return value;
}

function uint64(
  value: unknown,
  allowZero: boolean,
  name: string
): string {
  if (typeof value !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error(`processing_event_handoff_${name}_invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64 || (!allowZero && parsed === 0n)) {
    throw new Error(`processing_event_handoff_${name}_invalid`);
  }
  return value;
}
