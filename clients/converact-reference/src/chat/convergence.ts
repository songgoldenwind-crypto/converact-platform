import type { IveKitChatMessage, IveKitCursorPage } from '@converact/sdk';
import type { ChatConvergenceProjection, ChatConvergenceTrigger } from './types.js';

export interface ChatConvergenceInput {
  fetchAfter(cursor: string | null): Promise<IveKitCursorPage<IveKitChatMessage>>;
  onProjection?: (projection: ChatConvergenceProjection) => void;
  onFatalAuth?: (status: 401 | 403) => void;
}

export class ChatConvergence {
  private messages = new Map<string, IveKitChatMessage>();
  private cursor: string | null = null;
  private generation = 0;
  private running: Promise<void> | null = null;
  private queued = false;
  private closed = false;

  constructor(private readonly input: ChatConvergenceInput) {}

  invalidate(_trigger: ChatConvergenceTrigger): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Chat convergence is closed'));
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    const running = this.synchronize().finally(() => {
      if (this.running === running) this.running = null;
    });
    this.running = running;
    return running;
  }

  reset(messages: IveKitChatMessage[], cursor: string | null): void {
    this.generation += 1;
    this.messages = new Map(messages.map((message) => [message.id, message]));
    this.cursor = cursor;
    this.emit(messages);
  }

  supersede(): void {
    if (!this.closed) this.generation += 1;
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.queued = false;
  }

  private async synchronize(): Promise<void> {
    do {
      this.queued = false;
      const generation = this.generation;
      const previousCursor = this.cursor;
      try {
        const page = await this.input.fetchAfter(this.cursor);
        if (this.closed || generation !== this.generation) continue;
        for (const message of page.items) this.messages.set(message.id, message);
        if (page.next_cursor) this.cursor = page.next_cursor;
        if (page.has_more && (!page.next_cursor || page.next_cursor === previousCursor)) {
          throw new Error('Chat convergence cursor did not advance');
        }
        this.emit(page.items);
        if (page.has_more) this.queued = true;
      } catch (error) {
        if (this.closed || generation !== this.generation) continue;
        const status = authStatus(error);
        if (status) {
          this.closed = true;
          this.generation += 1;
          this.input.onFatalAuth?.(status);
        }
        throw error;
      }
    } while (this.queued && !this.closed);
  }

  private emit(changed: IveKitChatMessage[]): void {
    const messages = [...this.messages.values()].sort((left, right) =>
      left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
    );
    const changedMessages = [...new Map(changed.map((message) => [message.id, message])).values()].sort((left, right) =>
      left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
    );
    this.input.onProjection?.({ messages, changedMessages, cursor: this.cursor, generation: this.generation });
  }
}

function authStatus(error: unknown): 401 | 403 | null {
  const status = Number((error as { status?: number }).status || 0);
  return status === 401 || status === 403 ? status : null;
}
