import type { NotificationEndpoint } from './types.js';

export type NotificationEndpointProbeOutcome = 'healthy' | 'degraded' | 'unhealthy';

export interface NotificationEndpointProbeResult {
  outcome: NotificationEndpointProbeOutcome;
  code: string;
  latency_ms: number;
}

export interface NotificationEndpointHealthRepository {
  listHealthTenants(now: Date, staleBefore: Date, limit: number): Promise<string[]>;
  claimHealthEndpoints(input: {
    tenant_id: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
    stale_before: Date;
    lease_ms: number;
    limit: number;
  }): Promise<NotificationEndpoint[]>;
  finishHealthProbe(input: {
    endpoint: NotificationEndpoint;
    worker_id: string;
    lease_token_hash: string;
    result: NotificationEndpointProbeResult;
    now: Date;
  }): Promise<void>;
}
