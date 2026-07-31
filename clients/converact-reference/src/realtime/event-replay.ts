import type {
  IveKitEvent,
  IveKitEventPage,
  IveKitEventPageInput,
  IveKitEventReplayInput,
  IveKitEventReplayResult,
  IveKitEventSnapshotReason
} from '@converact/sdk';

export type EventReplayStatus = 'idle' | 'syncing' | 'live' | 'snapshot' | 'error' | 'stopped';

export interface EventReplayControllerOptions {
  events: {
    getHeadCursor(): Promise<string>;
    listPage(input: IveKitEventPageInput): Promise<IveKitEventPage>;
    replay(input: IveKitEventReplayInput): Promise<IveKitEventReplayResult>;
  };
  initialCursor?: string;
  pageSize?: number;
  maxPages?: number;
  maxSeenEventIds?: number;
  onEvent(event: IveKitEvent): void | Promise<void>;
  snapshots: {
    chat(): void | Promise<void>;
    media(): void | Promise<void>;
    remote(): void | Promise<void>;
    voice?(): void | Promise<void>;
    ivr?(): void | Promise<void>;
  };
  onStatus?(status: EventReplayStatus, error?: unknown): void;
}

export class EventReplayController {
  private cursor: string;
  private stopped = false;
  private activeSync: Promise<void> | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxSeenEventIds: number;

  constructor(private readonly options: EventReplayControllerOptions) {
    this.cursor = String(options.initialCursor || '').trim();
    this.pageSize = bounded(options.pageSize, 100, 1, 200, 'pageSize');
    this.maxPages = bounded(options.maxPages, 20, 1, 100, 'maxPages');
    this.maxSeenEventIds = bounded(options.maxSeenEventIds, 1_000, 10, 10_000, 'maxSeenEventIds');
  }

  getCursor(): string {
    return this.cursor;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (!this.cursor) {
      this.setStatus('syncing');
      try {
        this.cursor = await this.options.events.getHeadCursor();
        this.setStatus('live');
      } catch (error) {
        this.setStatus('error', error);
        throw error;
      }
      return;
    }
    await this.resume();
  }

  resume(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.synchronize().finally(() => { this.activeSync = null; });
    return this.activeSync;
  }

  stop(): void {
    this.stopped = true;
    this.setStatus('stopped');
  }

  private async synchronize(): Promise<void> {
    if (!this.cursor) return this.start();
    this.setStatus('syncing');
    try {
      const replay = await this.options.events.replay({
        cursor: this.cursor,
        limit: this.pageSize,
        max_pages: this.maxPages
      });
      if (this.stopped) return;
      if (replay.snapshot_required) {
        this.setStatus('snapshot');
        await Promise.all([
          this.options.snapshots.chat(),
          this.options.snapshots.media(),
          this.options.snapshots.remote(),
          this.options.snapshots.voice?.(),
          this.options.snapshots.ivr?.()
        ]);
        if (this.stopped) return;
        this.cursor = await this.options.events.getHeadCursor();
        this.seen.clear();
        this.seenOrder.length = 0;
        this.setStatus('live');
        return;
      }
      for (const event of replay.items) {
        if (this.stopped) return;
        if (this.seen.has(event.event_id)) continue;
        await this.options.onEvent(event);
        this.remember(event.event_id);
      }
      this.cursor = replay.next_cursor;
      this.setStatus('live');
    } catch (error) {
      this.setStatus('error', error);
      throw error;
    }
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    while (this.seenOrder.length > this.maxSeenEventIds) {
      const removed = this.seenOrder.shift();
      if (removed) this.seen.delete(removed);
    }
  }

  private setStatus(status: EventReplayStatus, error?: unknown): void {
    this.options.onStatus?.(status, error);
  }
}

export type EventWorkspace = 'chat' | 'media' | 'voice' | 'remote' | 'ivr' | 'context';

export function eventWorkspace(type: string): EventWorkspace {
  if (type.startsWith('collaboration.')) return 'chat';
  if (type.startsWith('media.') || type.startsWith('livekit.')) return 'media';
  if (type.startsWith('remote.') || type.startsWith('rustdesk.')) return 'remote';
  if (type.startsWith('voice.') || type.startsWith('ivr.session.') || type.startsWith('ivr.pending_action.')) return 'voice';
  if (type.startsWith('ivr.')) return 'ivr';
  return 'context';
}

export function snapshotReason(value: unknown): IveKitEventSnapshotReason | undefined {
  return value === 'invalid_cursor' || value === 'cursor_tenant_mismatch' || value === 'cursor_expired'
    ? value
    : undefined;
}

function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}
