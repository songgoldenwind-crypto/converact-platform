import type { InteractionPlacementCoordinator } from './interaction-placement.js';

export interface InteractionPlacementWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  tenantLimit: number;
  batchSize: number;
}

export interface InteractionPlacementWorkerSummary {
  tenants: number;
  claimed: number;
  succeeded: number;
  retry_wait: number;
  failed: number;
}

export class InteractionPlacementWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<InteractionPlacementWorkerSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: InteractionPlacementWorkerConfig;
    runBatch: () => Promise<InteractionPlacementWorkerSummary>;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<InteractionPlacementWorkerSummary> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(() => this.input.runBatch());
    const wrapped = running.finally(() => {
      if (this.active === wrapped) this.active = null;
    });
    this.active = wrapped;
    return wrapped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function interactionPlacementWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): InteractionPlacementWorkerConfig {
  const enabled = flag(env.OPC_IVEKIT_PLACEMENT_ENABLED);
  return {
    enabled,
    intervalMs: boundedInteger(
      env.OPC_IVEKIT_PLACEMENT_WORKER_INTERVAL_MS,
      250,
      100,
      60_000,
      'OPC_IVEKIT_PLACEMENT_WORKER_INTERVAL_MS'
    ),
    tenantLimit: boundedInteger(
      env.OPC_IVEKIT_PLACEMENT_WORKER_TENANT_LIMIT,
      100,
      1,
      1_000,
      'OPC_IVEKIT_PLACEMENT_WORKER_TENANT_LIMIT'
    ),
    batchSize: boundedInteger(
      env.OPC_IVEKIT_PLACEMENT_WORKER_BATCH_SIZE,
      50,
      1,
      100,
      'OPC_IVEKIT_PLACEMENT_WORKER_BATCH_SIZE'
    )
  };
}

export function startInteractionPlacementWorker(input: {
  coordinator: InteractionPlacementCoordinator;
  worker_id: string;
  env?: NodeJS.ProcessEnv;
}): InteractionPlacementWorker {
  const config = interactionPlacementWorkerConfig(input.env || process.env);
  const worker = new InteractionPlacementWorker({
    config,
    runBatch: () => input.coordinator.reconcileDue({
      worker_id: input.worker_id,
      tenant_limit: config.tenantLimit,
      batch_size: config.batchSize
    }),
    onError: (error) => {
      console.error(
        '[interaction-placement] worker failed:',
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      );
    }
  });
  worker.start();
  return worker;
}

function flag(value: string | undefined): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (normalized !== '0' && normalized !== '1') {
    throw new Error('OPC_IVEKIT_PLACEMENT_ENABLED must be 0 or 1');
  }
  return normalized === '1';
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  const parsed = String(value || '').trim() ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
