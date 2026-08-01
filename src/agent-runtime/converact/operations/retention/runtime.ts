import type { PgQueryable } from '../../../../db-pg.js';
import { PostgresConveractFabricRetentionStore } from './postgres-store.js';
import type { ConveractFabricRetentionCategoryHandler } from './ports.js';
import { createPostgresConveractFabricRetentionCategoryHandlers } from './category-handlers.js';
import {
  ConveractFabricRetentionWorker,
  converactFabricRetentionWorkerConfig
} from './worker.js';

export function startPostgresConveractFabricRetentionWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  handlers?: Readonly<Record<string, ConveractFabricRetentionCategoryHandler>>;
}): { stop(): Promise<void> } {
  const config = converactFabricRetentionWorkerConfig(input.env);
  if (!config.enabled) return { stop: async () => undefined };
  const defaultHandlers = createPostgresConveractFabricRetentionCategoryHandlers({
    pg: input.pg,
    env: input.env
  });
  const worker = new ConveractFabricRetentionWorker({
    repository: new PostgresConveractFabricRetentionStore(input.pg),
    config,
    handlers: { ...defaultHandlers, ...input.handlers }
  });
  let stopped = false;
  let active: Promise<unknown> | null = null;
  const run = () => {
    if (stopped || active) return;
    active = worker.runOnce()
      .catch((error) => {
        console.error('[converact-retention] worker failed', safeCode((error as Error).message));
      })
      .finally(() => { active = null; });
  };
  run();
  const timer = setInterval(run, config.interval_ms);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    }
  };
}

function safeCode(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 100)
    || 'retention_worker_failed';
}
