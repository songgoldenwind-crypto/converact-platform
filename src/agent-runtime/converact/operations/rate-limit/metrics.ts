import { Counter } from 'prom-client';

import { metricsRegistry } from '../../../../metrics.js';
import type { IveKitRateLimitScope } from './types.js';

const checks = new Counter({
  name: 'opc_ivekit_rate_limit_checks_total',
  help: 'Total distributed iveKit rate limit decisions',
  labelNames: ['route', 'result'],
  registers: [metricsRegistry]
});

const rejections = new Counter({
  name: 'opc_ivekit_rate_limit_rejections_total',
  help: 'Total distributed iveKit rate limit rejections by bounded scope',
  labelNames: ['route', 'scope'],
  registers: [metricsRegistry]
});

export const iveKitRateLimitMetricDefinitions = [
  { name: 'opc_ivekit_rate_limit_checks_total', labels: ['route', 'result'] },
  { name: 'opc_ivekit_rate_limit_rejections_total', labels: ['route', 'scope'] }
] as const;

export function observeIveKitRateLimit(input: {
  route_group: string;
  allowed: boolean;
  denied_scope: IveKitRateLimitScope | null;
}): void {
  const route = routeLabel(input.route_group);
  checks.labels(route, input.allowed ? 'allowed' : 'rejected').inc();
  if (!input.allowed && input.denied_scope) rejections.labels(route, input.denied_scope).inc();
}

function routeLabel(value: string): string {
  return /^[a-z0-9_.-]{1,100}$/.test(value) ? value : 'unknown';
}
