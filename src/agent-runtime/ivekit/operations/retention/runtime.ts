import type { PgQueryable } from '../../../../db-pg.js';
import { PostgresIveKitRetentionStore } from './postgres-store.js';
import type { IveKitRetentionCategoryHandler } from './ports.js';
import { createPostgresIveKitRetentionCategoryHandlers } from './category-handlers.js';
import {
  IveKitRetentionWorker,
  iveKitRetentionWorkerConfig
} from './worker.js';

export function startPostgresIveKitRetentionWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  handlers?: Readonly<Record<string, IveKitRetentionCategoryHandler>>;
}): { stop(): Promise<void> } {
  const config = iveKitRetentionWorkerConfig(input.env);
  if (!config.enabled) return { stop: async () => undefined };
  const defaultHandlers = createPostgresIveKitRetentionCategoryHandlers({
    pg: input.pg,
    env: input.env
  });
  const worker = new IveKitRetentionWorker({
    repository: new PostgresIveKitRetentionStore(input.pg),
    config,
    handlers: { ...defaultHandlers, ...input.handlers }
  });
  let stopped = false;
  let active: Promise<unknown> | null = null;
  const run = () => {
    if (stopped || active) return;
    active = worker.runOnce()
      .catch((error) => {
        console.error('[ivekit-retention] worker failed', safeCode((error as Error).message));
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
