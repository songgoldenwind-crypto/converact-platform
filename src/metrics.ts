/**
 * Prometheus metrics for OPC.
 *
 * Exposes /metrics endpoint for Prometheus scraping.
 * Metrics use opc_ prefix per metrics-design.md naming convention.
 */
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

const register = new Registry();
collectDefaultMetrics({ register, prefix: 'opc_node_' });

// HTTP request metrics
export const httpRequestTotal = new Counter({
  name: 'opc_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register]
});

export const httpRequestDuration = new Histogram({
  name: 'opc_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

// Voice/call metrics
export const activeCalls = new Gauge({
  name: 'opc_active_calls',
  help: 'Currently active calls',
  labelNames: ['tenant_id', 'direction'],
  registers: [register]
});

export const callTotal = new Counter({
  name: 'opc_calls_total',
  help: 'Total calls initiated',
  labelNames: ['tenant_id', 'direction', 'outcome'],
  registers: [register]
});

// LLM metrics
export const llmRequestsTotal = new Counter({
  name: 'opc_llm_requests_total',
  help: 'Total LLM API requests',
  labelNames: ['tenant_id', 'purpose', 'status'],
  registers: [register]
});

export const llmRequestDuration = new Histogram({
  name: 'opc_llm_request_duration_seconds',
  help: 'LLM API request duration',
  labelNames: ['purpose'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30],
  registers: [register]
});

// QM metrics
export const qmScore = new Histogram({
  name: 'opc_qm_score',
  help: 'Quality management score distribution',
  labelNames: ['tenant_id'],
  buckets: [0.2, 0.4, 0.5, 0.6, 0.8, 1.0],
  registers: [register]
});

// Dialer metrics
export const dialerActiveTasks = new Gauge({
  name: 'opc_dialer_active_tasks',
  help: 'Currently active outbound dial tasks',
  labelNames: ['tenant_id'],
  registers: [register]
});

export const dialerCallsTotal = new Counter({
  name: 'opc_dialer_calls_total',
  help: 'Total outbound dial attempts',
  labelNames: ['tenant_id', 'result'],
  registers: [register]
});

// Billing metrics
export const billingUsage = new Gauge({
  name: 'opc_billing_usage',
  help: 'Current billing usage',
  labelNames: ['tenant_id', 'metric'],
  registers: [register]
});

/** Prometheus metrics registry — exposed at /metrics endpoint. */
export const metricsRegistry = register;

/** Middleware: record HTTP request metrics. */
export function recordHttpRequest(method: string, path: string, status: number, durationSec: number) {
  const normalizedPath = path.replace(/\/[a-zA-Z0-9_-]{20,}/g, '/:id').replace(/\?.*$/, '');
  httpRequestTotal.labels(method, normalizedPath, String(status)).inc();
  httpRequestDuration.labels(method, normalizedPath).observe(durationSec);
}
