export type MediaRejoinAttemptResult = 'succeeded' | 'retry' | 'stopped';

export interface MediaRejoinScheduler {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MediaRejoinControllerInput {
  readonly run: () => Promise<MediaRejoinAttemptResult>;
  readonly onExhausted?: () => void;
  readonly delaysMs?: readonly number[];
  readonly scheduler?: MediaRejoinScheduler;
}

const DEFAULT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

export class MediaRejoinController {
  private readonly delaysMs: readonly number[];
  private readonly scheduler: MediaRejoinScheduler;
  private requested = false;
  private online = true;
  private visible = true;
  private disposed = false;
  private running = false;
  private attempt = 0;
  private timer: unknown = null;

  constructor(private readonly input: MediaRejoinControllerInput) {
    this.delaysMs = validateDelays(input.delaysMs || DEFAULT_DELAYS_MS);
    this.scheduler = input.scheduler || browserScheduler;
  }

  request(): void {
    if (this.disposed) return;
    if (!this.requested && this.attempt >= this.delaysMs.length) this.attempt = 0;
    this.requested = true;
    this.schedule();
  }

  setOnline(online: boolean): void {
    if (this.online === online || this.disposed) return;
    this.online = online;
    if (!online) this.cancelTimer();
    else this.schedule();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) return;
    this.visible = visible;
    if (!visible) this.cancelTimer();
    else this.schedule();
  }

  reset(): void {
    this.requested = false;
    this.attempt = 0;
    this.cancelTimer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requested = false;
    this.cancelTimer();
  }

  private schedule(): void {
    if (this.disposed || !this.requested || !this.online || !this.visible || this.running || this.timer !== null) return;
    if (this.attempt >= this.delaysMs.length) {
      this.requested = false;
      this.input.onExhausted?.();
      return;
    }
    this.timer = this.scheduler.setTimeout(() => this.execute(), this.delaysMs[this.attempt]);
  }

  private async execute(): Promise<void> {
    this.timer = null;
    if (this.disposed || !this.requested) return;
    if (!this.online || !this.visible) {
      this.schedule();
      return;
    }
    this.running = true;
    let result: MediaRejoinAttemptResult = 'retry';
    try {
      result = await this.input.run();
    } catch {
      result = 'retry';
    } finally {
      this.running = false;
    }
    if (this.disposed) return;
    if (result === 'succeeded' || result === 'stopped') {
      this.reset();
      return;
    }
    this.attempt += 1;
    this.schedule();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

const browserScheduler: MediaRejoinScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(() => { void callback(); }, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

function validateDelays(value: readonly number[]): readonly number[] {
  if (!value.length || value.length > 10 || value.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 60_000)) {
    throw new Error('Media rejoin delays must contain 1-10 integer values from 0 to 60000ms');
  }
  return Object.freeze([...value]);
}
