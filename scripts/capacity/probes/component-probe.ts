import { createHash } from 'node:crypto';

import {
  aggregatePrometheusMetric,
  parsePrometheusText
} from './prometheus.js';
import type {
  CapacityComponent,
  CapacityProbeFetch,
  ComponentCapacityObservation,
  ComponentCapacityProbe,
  ComponentCapacityProbeConfig
} from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/;
const METRIC = /^[A-Za-z_:][A-Za-z0-9_:]*$/;

const DIMENSION_ALLOWLISTS: Record<CapacityComponent, ReadonlySet<string>> = {
  ivekit_edge: new Set([
    'edge.http_active_requests',
    'edge.websocket_connections',
    'edge.event_publish_rate'
  ]),
  tinode: new Set([
    'im.websocket_connections',
    'im.messages_per_second',
    'im.presence_sessions'
  ]),
  rustpbx: new Set([
    'voice.weighted_calls',
    'voice.t1_shadow_slots',
    'voice.transcode_slots',
    'voice.realtime_asr_streams',
    'voice.registered_endpoints',
    'voice.active_dialogs',
    'voice.rtp_legs',
    'voice.transcoding_sessions',
    'voice.recording_slots',
    'data.local_spool_bytes'
  ]),
  livekit: new Set([
    'video.participants',
    'video.published_tracks',
    'video.forwarded_tracks',
    'video.egress_jobs',
    'video.turn_allocations',
    'video.egress_cpu_slots'
  ]),
  rustdesk: new Set([
    'remote.registered_endpoints',
    'remote.active_sessions',
    'remote.relay_sessions',
    'remote.file_transfers',
    'remote.recording_slots'
  ])
};

export function createComponentCapacityProbe(
  config: ComponentCapacityProbeConfig
): ComponentCapacityProbe {
  const validated = validateConfig(config);
  return {
    collect: (now = new Date()) => collect(validated, now)
  };
}

async function collect(
  config: ValidatedConfig,
  now: Date
): Promise<ComponentCapacityObservation> {
  const observedAt = validDate(now);
  if (!config.health_url || !config.metrics_url) {
    return baseObservation(config, observedAt, {
      outcome: 'not_run',
      state: 'offline',
      reasons: ['component capacity endpoints are not configured']
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms);
  try {
    const [health, metrics] = await Promise.all([
      config.fetch(config.health_url, {
        signal: controller.signal,
        headers: { accept: 'application/json, text/plain;q=0.9' }
      }),
      config.fetch(config.metrics_url, {
        signal: controller.signal,
        headers: { accept: 'text/plain; version=0.0.4' }
      })
    ]);
    const [healthBody, metricsBody] = await Promise.all([
      readBounded(health, 65_536),
      readBounded(metrics, 5_242_880)
    ]);
    const evidence = evidenceFor(healthBody, metricsBody, health.status, metrics.status, observedAt);
    if (!health.ok || !metrics.ok) {
      return baseObservation(config, observedAt, {
        outcome: 'failed',
        state: 'offline',
        reasons: [
          `health endpoint returned ${health.status}`,
          `metrics endpoint returned ${metrics.status}`
        ].filter((reason) => !reason.endsWith(' 200')),
        evidence
      });
    }

    const samples = parsePrometheusText(metricsBody);
    const dimensions: ComponentCapacityObservation['dimensions'] = {};
    const reasons: string[] = [];
    for (const [dimension, binding] of Object.entries(config.dimensions)) {
      const used = aggregatePrometheusMetric({
        samples,
        metric: binding.metric,
        aggregation: binding.aggregation,
        labels: binding.labels
      });
      if (used === null) {
        reasons.push(`required metric ${binding.metric} is missing for ${dimension}`);
        continue;
      }
      if (used < 0) {
        reasons.push(`required metric ${binding.metric} is negative`);
        continue;
      }
      dimensions[dimension] = {
        unit: binding.unit,
        safe_capacity: binding.safe_capacity,
        used,
        reserved: 0,
        utilization: used / binding.safe_capacity
      };
    }
    if (reasons.length > 0) {
      return baseObservation(config, observedAt, {
        outcome: 'failed',
        state: 'degraded',
        dimensions,
        reasons,
        evidence
      });
    }

    let draining = false;
    if (config.drain_metric) {
      const value = aggregatePrometheusMetric({
        samples,
        metric: config.drain_metric,
        aggregation: 'max'
      });
      if (value === null) {
        return baseObservation(config, observedAt, {
          outcome: 'failed',
          state: 'degraded',
          dimensions,
          reasons: [`required drain metric ${config.drain_metric} is missing`],
          evidence
        });
      }
      draining = value > 0;
    }
    const dominant = dominantUtilization(dimensions);
    return baseObservation(config, observedAt, {
      outcome: 'observed',
      state: draining ? 'draining' : dominant >= 1 ? 'degraded' : 'accepting',
      dimensions,
      dominant_utilization: dominant,
      evidence
    });
  } catch (error) {
    return baseObservation(config, observedAt, {
      outcome: 'failed',
      state: 'offline',
      reasons: [probeError(error)]
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ValidatedConfig extends ComponentCapacityProbeConfig {
  fetch: CapacityProbeFetch;
  timeout_ms: number;
}

function validateConfig(config: ComponentCapacityProbeConfig): ValidatedConfig {
  for (const [field, value] of Object.entries({
    instance_id: config.instance_id,
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    release_id: config.release_id,
    hardware_class: config.hardware_class,
    configuration_class: config.configuration_class,
    profile_id: config.profile_id
  })) {
    if (!SAFE_ID.test(value)) throw new Error(`invalid component capacity ${field}`);
  }
  if (!SHA256.test(config.profile_sha256)) throw new Error('invalid component capacity profile_sha256');
  if (!DIMENSION_ALLOWLISTS[config.component]) throw new Error('invalid capacity component');
  if ((config.health_url && !config.metrics_url) || (!config.health_url && config.metrics_url)) {
    throw new Error('health_url and metrics_url must be configured together');
  }
  for (const url of [config.health_url, config.metrics_url]) {
    if (url) checkedHttpUrl(url);
  }
  if (config.drain_metric && !METRIC.test(config.drain_metric)) {
    throw new Error('invalid drain metric');
  }
  const allowlist = DIMENSION_ALLOWLISTS[config.component];
  for (const [dimension, binding] of Object.entries(config.dimensions)) {
    if (!allowlist.has(dimension)) {
      throw new Error(`dimension ${dimension} is not allowed for ${config.component}`);
    }
    if (!METRIC.test(binding.metric)) throw new Error(`invalid metric for ${dimension}`);
    if (!binding.unit || binding.unit.length > 64) throw new Error(`invalid unit for ${dimension}`);
    if (!Number.isFinite(binding.safe_capacity) || binding.safe_capacity <= 0) {
      throw new Error(`invalid safe capacity for ${dimension}`);
    }
    if (binding.labels && (Object.keys(binding.labels).length > 16 ||
        Object.entries(binding.labels).some(([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length > 255))) {
      throw new Error(`invalid labels for ${dimension}`);
    }
  }
  if (config.health_url && Object.keys(config.dimensions).length === 0) {
    throw new Error(`at least one capacity dimension is required for ${config.component}`);
  }
  const timeout = config.timeout_ms ?? 5_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new Error('invalid component capacity timeout');
  }
  return {
    ...config,
    dimensions: structuredClone(config.dimensions),
    fetch: config.fetch || globalThis.fetch,
    timeout_ms: timeout
  };
}

function baseObservation(
  config: ValidatedConfig,
  observedAt: string,
  overrides: Partial<ComponentCapacityObservation>
): ComponentCapacityObservation {
  const dimensions = overrides.dimensions || {};
  return {
    schema_version: '1.0.0',
    outcome: overrides.outcome || 'failed',
    component: config.component,
    instance_id: config.instance_id,
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    release_id: config.release_id,
    hardware_class: config.hardware_class,
    configuration_class: config.configuration_class,
    profile_id: config.profile_id,
    profile_sha256: config.profile_sha256,
    state: overrides.state || 'offline',
    observed_at: observedAt,
    dominant_utilization: overrides.dominant_utilization ?? dominantUtilization(dimensions),
    dimensions,
    reasons: overrides.reasons || [],
    evidence: overrides.evidence || {
      sha256: '',
      byte_size: 0,
      health_status: 0,
      metrics_status: 0,
      captured_at: ''
    }
  };
}

function dominantUtilization(
  dimensions: ComponentCapacityObservation['dimensions']
): number {
  return Math.max(0, ...Object.values(dimensions).map((value) => value.utilization));
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) throw new Error('component capacity response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteSize += chunk.length;
      if (byteSize > maximumBytes) {
        void reader.cancel('component capacity response is too large').catch(() => undefined);
        throw new Error('component capacity response is too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteSize).toString('utf8');
}

function evidenceFor(
  health: string,
  metrics: string,
  healthStatus: number,
  metricsStatus: number,
  capturedAt: string
): ComponentCapacityObservation['evidence'] {
  const payload = Buffer.concat([
    Buffer.from(`${healthStatus}\n${metricsStatus}\n`, 'utf8'),
    Buffer.from(health, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from(metrics, 'utf8')
  ]);
  return {
    sha256: createHash('sha256').update(payload).digest('hex'),
    byte_size: payload.length,
    health_status: healthStatus,
    metrics_status: metricsStatus,
    captured_at: capturedAt
  };
}

function validDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid component capacity observation time');
  }
  return value.toISOString();
}

function checkedHttpUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid component capacity endpoint');
  }
}

function probeError(error: unknown): string {
  if ((error as { name?: unknown })?.name === 'AbortError') return 'component capacity probe timed out';
  const code = String((error as { code?: unknown })?.code || '');
  return code && /^[A-Za-z0-9._:-]{1,255}$/.test(code)
    ? `component capacity probe failed: ${code}`
    : 'component capacity probe failed';
}
