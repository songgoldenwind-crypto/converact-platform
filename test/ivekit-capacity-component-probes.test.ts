import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createComponentCapacityProbe,
  type CapacityProbeFetch
} from '../scripts/capacity/probes/index.js';
import { parsePrometheusText } from '../scripts/capacity/probes/prometheus.js';

test('unconfigured component probe reports not_run without inventing capacity', async () => {
  let calls = 0;
  const probe = createComponentCapacityProbe({
    component: 'livekit',
    instance_id: 'livekit-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    release_id: 'livekit@abc123',
    hardware_class: 'media-c32-25gbe',
    configuration_class: 'livekit-sfu-v1',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    health_url: '',
    metrics_url: '',
    dimensions: {},
    fetch: async () => {
      calls += 1;
      throw new Error('must not fetch');
    }
  });

  const result = await probe.collect(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(result.outcome, 'not_run');
  assert.equal(result.state, 'offline');
  assert.deepEqual(result.dimensions, {});
  assert.equal(result.evidence.sha256, '');
  assert.equal(calls, 0);
});

test('Tinode probe aggregates labelled Prometheus samples against qualified safe capacity', async () => {
  const fetch = fixtureFetch({
    'https://tinode-a/healthz': response(200, '{"status":"ok"}', 'application/json'),
    'https://tinode-a/metrics': response(200, [
      'tinode_ws_connections{node="a"} 600',
      'tinode_ws_connections{node="b"} 400',
      'tinode_message_rate{node="a"} 120.5',
      'tinode_message_rate{node="b"} 79.5',
      'tinode_draining 0'
    ].join('\n'), 'text/plain')
  });
  const probe = createComponentCapacityProbe({
    component: 'tinode',
    instance_id: 'tinode-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    release_id: 'tinode@abc123',
    hardware_class: 'app-c16-10gbe',
    configuration_class: 'tinode-v1',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    health_url: 'https://tinode-a/healthz',
    metrics_url: 'https://tinode-a/metrics',
    drain_metric: 'tinode_draining',
    dimensions: {
      'im.websocket_connections': {
        metric: 'tinode_ws_connections',
        aggregation: 'sum',
        unit: 'connections',
        safe_capacity: 2_000
      },
      'im.messages_per_second': {
        metric: 'tinode_message_rate',
        aggregation: 'sum',
        unit: 'messages_per_second',
        safe_capacity: 500
      }
    },
    fetch
  });

  const result = await probe.collect(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(result.outcome, 'observed');
  assert.equal(result.state, 'accepting');
  assert.equal(result.dimensions['im.websocket_connections'].used, 1_000);
  assert.equal(result.dimensions['im.websocket_connections'].safe_capacity, 2_000);
  assert.equal(result.dimensions['im.messages_per_second'].used, 200);
  assert.equal(result.dominant_utilization, 0.5);
  assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/);
});

test('component probe fails closed when required metrics disappear and exposes drain state', async () => {
  const missing = createComponentCapacityProbe({
    ...baseConfig('rustpbx'),
    health_url: 'https://rustpbx-a/healthz',
    metrics_url: 'https://rustpbx-a/metrics',
    dimensions: {
      'voice.rtp_legs': {
        metric: 'rustpbx_rtp_legs',
        aggregation: 'sum',
        unit: 'legs',
        safe_capacity: 8_000
      }
    },
    fetch: fixtureFetch({
      'https://rustpbx-a/healthz': response(200, 'ok', 'text/plain'),
      'https://rustpbx-a/metrics': response(200, 'another_metric 1', 'text/plain')
    })
  });
  const missingResult = await missing.collect(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(missingResult.outcome, 'failed');
  assert.equal(missingResult.state, 'degraded');
  assert.match(missingResult.reasons.join('\n'), /rustpbx_rtp_legs/);

  const draining = createComponentCapacityProbe({
    ...baseConfig('rustdesk'),
    health_url: 'https://rustdesk-a/healthz',
    metrics_url: 'https://rustdesk-a/metrics',
    drain_metric: 'rustdesk_draining',
    dimensions: {
      'remote.active_sessions': {
        metric: 'rustdesk_active_sessions',
        aggregation: 'max',
        unit: 'sessions',
        safe_capacity: 500
      }
    },
    fetch: fixtureFetch({
      'https://rustdesk-a/healthz': response(200, 'ok', 'text/plain'),
      'https://rustdesk-a/metrics': response(200, [
        'rustdesk_active_sessions 12',
        'rustdesk_draining 1'
      ].join('\n'), 'text/plain')
    })
  });
  const drainResult = await draining.collect(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(drainResult.outcome, 'observed');
  assert.equal(drainResult.state, 'draining');
});

test('component-specific dimension allowlists reject cross-component capacity wiring', () => {
  assert.throws(() => createComponentCapacityProbe({
    ...baseConfig('livekit'),
    health_url: 'https://livekit-a/healthz',
    metrics_url: 'https://livekit-a/metrics',
    dimensions: {
      'voice.rtp_legs': {
        metric: 'livekit_tracks',
        aggregation: 'sum',
        unit: 'legs',
        safe_capacity: 1_000
      }
    },
    fetch: fixtureFetch({})
  }), /dimension.*livekit/i);
});

test('Prometheus parser skips malformed labels instead of treating them as unlabelled samples', () => {
  assert.deepEqual(parsePrometheusText([
    'tinode_ws_connections{node="a"} 10',
    'tinode_ws_connections{node="broken",oops} 999',
    'tinode_ws_connections 5'
  ].join('\n')), [
    {
      metric: 'tinode_ws_connections',
      labels: { node: 'a' },
      value: 10
    },
    {
      metric: 'tinode_ws_connections',
      labels: {},
      value: 5
    }
  ]);
});

test('component probe stops reading an undeclared oversized response', async () => {
  const probe = createComponentCapacityProbe({
    ...baseConfig('livekit'),
    health_url: 'https://livekit-a/healthz',
    metrics_url: 'https://livekit-a/metrics',
    dimensions: {
      'video.participants': {
        metric: 'livekit_participants',
        aggregation: 'sum',
        unit: 'participants',
        safe_capacity: 1_000
      }
    },
    fetch: fixtureFetch({
      'https://livekit-a/healthz': response(
        200,
        'x'.repeat(65_537),
        'text/plain'
      ),
      'https://livekit-a/metrics': response(
        200,
        'livekit_participants 1',
        'text/plain'
      )
    })
  });
  const result = await probe.collect(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.state, 'offline');
  assert.equal(result.evidence.sha256, '');
});

function baseConfig(component: 'rustpbx' | 'rustdesk' | 'livekit') {
  return {
    component,
    instance_id: `${component}-a`,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    release_id: `${component}@abc123`,
    hardware_class: 'node-c16-10gbe',
    configuration_class: `${component}-v1`,
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64)
  } as const;
}

function fixtureFetch(responses: Record<string, Response>): CapacityProbeFetch {
  return async (url) => {
    const value = responses[String(url)];
    if (!value) throw new Error(`unexpected URL ${url}`);
    return value.clone();
  };
}

function response(status: number, body: string, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType }
  });
}
