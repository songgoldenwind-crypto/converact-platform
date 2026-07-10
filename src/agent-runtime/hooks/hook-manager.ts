import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export type HookPayload = JsonRecord;
export type HookHandler = (payload: HookPayload) => HookPayload | void | Promise<HookPayload | void>;

export class HookManager {
  handlers: Map<string, HookHandler[]>;

  constructor() {
    this.handlers = new Map();
  }

  on(hookName: string, handler: HookHandler): () => void {
    if (typeof handler !== 'function') throw new Error(`hook handler is required for ${hookName}`);
    const handlers = this.handlers.get(hookName) || [];
    handlers.push(handler);
    this.handlers.set(hookName, handlers);
    return () => this.off(hookName, handler);
  }

  off(hookName: string, handler: HookHandler): void {
    const handlers = this.handlers.get(hookName) || [];
    this.handlers.set(
      hookName,
      handlers.filter((candidate) => candidate !== handler)
    );
  }

  async run(hookName: string, payload: HookPayload = {}): Promise<HookPayload> {
    const handlers = this.handlers.get(hookName) || [];
    let current = payload;
    for (const handler of handlers) {
      const next = await handler(current);
      if (next !== undefined) current = next as HookPayload;
    }
    return current;
  }

  runSync(hookName: string, payload: HookPayload = {}): HookPayload {
    const handlers = this.handlers.get(hookName) || [];
    let current = payload;
    for (const handler of handlers) {
      const next = handler(current);
      if (isPromiseLike(next)) {
        throw new Error(`async hook not allowed in sync lifecycle: ${hookName}`);
      }
      if (next !== undefined) current = next as HookPayload;
    }
    return current;
  }

  list(): Array<{ hookName: string; handlers: number }> {
    return [...this.handlers.entries()].map(([hookName, handlers]) => ({
      hookName,
      handlers: handlers.length
    }));
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof value === 'object' && 'then' in value && typeof value.then === 'function');
}
