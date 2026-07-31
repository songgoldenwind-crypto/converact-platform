import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import test from 'node:test';

import {
  ComponentNodeAdmissionController
} from '../src/agent-runtime/converact/placement/component-node-admission.js';
import {
  createComponentNodeAdmissionHttpServer
} from '../src/agent-runtime/converact/placement/component-node-admission-http.js';
import {
  evaluateRustPbxMediaReadiness,
  renderRustPbxMediaReadinessMetrics,
  RustPbxMediaReadinessProbe,
  type RustPbxMediaReadinessProfile
} from '../src/agent-runtime/converact/voice/rustpbx-media-readiness.js';

const helmValues = readFileSync(
  'services/converact-service/helm/converact/values.yaml',
  'utf8'
);
const helmRustPbx = readFileSync(
  'services/converact-service/helm/converact/templates/rustpbx-deployment.yaml',
  'utf8'
);
const legacyHelmValues = readFileSync('infra/k8s/values.yaml', 'utf8');
const legacyHelmRustPbx = readFileSync(
  'infra/k8s/templates/rustpbx-deployment.yaml',
  'utf8'
);
const rtpengineValues = readFileSync(
  'infra/converact/helm/rtpengine/values.yaml',
  'utf8'
);
const rtpengineDaemonSet = readFileSync(
  'infra/converact/helm/rtpengine/templates/daemonset.yaml',
  'utf8'
);
const canonicalPrometheusRules = readFileSync(
  'services/converact-service/helm/converact/files/prometheus-rules.yaml',
  'utf8'
);
const rustPbxReadme = readFileSync('infra/converact/rustpbx/README.md', 'utf8');
const rustPbxMediaTracingPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-media-tracing.patch',
  'utf8'
);
const mediaControlAgent = readFileSync(
  'scripts/ivekit-media-control-agent.ts',
  'utf8'
);
const voiceCompose = readFileSync(
  'infra/converact/docker-compose.voice.yml',
  'utf8'
);
const voiceEnvExample = readFileSync(
  'infra/converact/env.example',
  'utf8'
);

const profiles: RustPbxMediaReadinessProfile[] = [
  {
    id: 'voice-ordinary-v1',
    required_capacity: { 'voice.weighted_calls': 1 },
    required_for_pod_readiness: true
  },
  {
    id: 'voice-ha-t1-v1',
    required_capacity: { 'voice.t1_shadow_slots': 1 },
    required_for_pod_readiness: false
  },
  {
    id: 'voice-ivr-transcoding-v1',
    required_capacity: { 'voice.transcode_slots': 1 },
    required_for_pod_readiness: false
  },
  {
    id: 'voice-recording-v1',
    required_capacity: { 'voice.recording_slots': 1 },
    required_for_pod_readiness: false
  },
  {
    id: 'voice-ai-tap-v1',
    required_capacity: { 'voice.realtime_asr_streams': 1 },
    required_for_pod_readiness: false
  }
];

test('media readiness isolates optional profiles from ordinary relay', () => {
  const result = evaluateRustPbxMediaReadiness({
    route_snapshot: { ready: true, code: 'fresh' },
    media_control: { ready: true, code: 'available' },
    profiles,
    dimensions: {
      'voice.weighted_calls': capacity(10, 8),
      'voice.t1_shadow_slots': capacity(2, 0),
      'voice.transcode_slots': capacity(4, 1),
      'voice.recording_slots': capacity(2, 2),
      'voice.realtime_asr_streams': capacity(3, 3)
    }
  });

  assert.equal(result.ready, true);
  assert.equal(result.profiles['voice-ordinary-v1']?.ready, true);
  assert.deepEqual(
    result.profiles['voice-recording-v1']?.limiting_dimensions,
    ['voice.recording_slots']
  );
  assert.deepEqual(
    result.profiles['voice-ai-tap-v1']?.limiting_dimensions,
    ['voice.realtime_asr_streams']
  );
});

test('media readiness fails closed for routing, media-control, or ordinary capacity', () => {
  const dimensions = {
    'voice.weighted_calls': capacity(1, 1),
    'voice.t1_shadow_slots': capacity(2, 0),
    'voice.transcode_slots': capacity(4, 0),
    'voice.recording_slots': capacity(2, 0),
    'voice.realtime_asr_streams': capacity(3, 0)
  };
  const result = evaluateRustPbxMediaReadiness({
    route_snapshot: { ready: false, code: 'expired' },
    media_control: { ready: false, code: 'unavailable' },
    profiles,
    dimensions
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.failure_stages, [
    'route_snapshot',
    'media_control',
    'profile_capacity'
  ]);
  assert.deepEqual(
    result.profiles['voice-ordinary-v1']?.limiting_dimensions,
    ['voice.weighted_calls']
  );
});

test('media readiness metrics use only bounded failure-stage and profile labels', () => {
  const result = evaluateRustPbxMediaReadiness({
    route_snapshot: { ready: true, code: 'fresh' },
    media_control: { ready: false, code: 'unavailable' },
    profiles,
    dimensions: {
      'voice.weighted_calls': capacity(10, 0),
      'voice.t1_shadow_slots': capacity(2, 0),
      'voice.transcode_slots': capacity(4, 0),
      'voice.recording_slots': capacity(2, 2),
      'voice.realtime_asr_streams': capacity(3, 0)
    }
  });

  const metrics = renderRustPbxMediaReadinessMetrics(
    result,
    profiles.map((profile) => profile.id)
  );
  assert.match(metrics, /ivekit_rustpbx_media_ready 0/);
  assert.match(
    metrics,
    /ivekit_rustpbx_media_readiness\{failure_stage="media_control"\} 0/
  );
  assert.match(
    metrics,
    /ivekit_rustpbx_media_readiness\{failure_stage="route_snapshot"\} 1/
  );
  assert.match(
    metrics,
    /ivekit_rustpbx_media_profile_ready\{profile="voice-recording-v1"\} 0/
  );
  assert.doesNotMatch(metrics, /tenant|call_id|phone|sdp|secret/i);
});

test('media readiness coalesces dependency checks while capacity stays live', async () => {
  let routeSnapshotChecks = 0;
  let mediaControlChecks = 0;
  const probe = new RustPbxMediaReadinessProbe({
    route_snapshot_file: '/not-used-by-injected-checks',
    route_snapshot_signing_key: 'test-signing-key',
    route_tenant_id: 'tenant-a',
    route_profile_id: 'voice-ordinary-v1',
    media_control_endpoint: 'https://localhost:3211/',
    media_control_identity: Buffer.from('test-identity'),
    media_control_ca: Buffer.from('test-ca'),
    media_control_timeout_ms: 500,
    refresh_interval_ms: 1_000,
    profiles
  }, {
    route_snapshot: async () => {
      routeSnapshotChecks += 1;
      return { ready: true, code: 'fresh' };
    },
    media_control: async () => {
      mediaControlChecks += 1;
      return { ready: true, code: 'available' };
    }
  });
  const now = new Date('2026-07-27T08:00:00.000Z');
  const readyState = mediaState(10, 0);

  const initial = await Promise.all([
    probe.evaluate(readyState, now),
    probe.evaluate(readyState, now),
    probe.evaluate(readyState, now)
  ]);
  assert.equal(initial.every((result) => result.ready), true);
  assert.equal(routeSnapshotChecks, 1);
  assert.equal(mediaControlChecks, 1);

  const exhausted = await probe.evaluate(
    mediaState(1, 1),
    new Date(now.getTime() + 999)
  );
  assert.equal(exhausted.ready, false);
  assert.deepEqual(exhausted.failure_stages, ['profile_capacity']);
  assert.equal(routeSnapshotChecks, 1);
  assert.equal(mediaControlChecks, 1);

  await probe.evaluate(readyState, new Date(now.getTime() + 1_000));
  assert.equal(routeSnapshotChecks, 2);
  assert.equal(mediaControlChecks, 2);
});

test('component-node liveness ignores media dependencies while readiness fails closed', async (t) => {
  const now = new Date('2026-07-27T08:00:00.000Z');
  const controller = new ComponentNodeAdmissionController({
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a',
    profile_ids: profiles.map((profile) => profile.id),
    interaction_kinds: ['sip_voice'],
    dimensions: {
      'voice.weighted_calls': capacity(10, 0),
      'voice.t1_shadow_slots': capacity(2, 0),
      'voice.transcode_slots': capacity(4, 0),
      'voice.recording_slots': capacity(2, 0),
      'voice.realtime_asr_streams': capacity(3, 0)
    }
  });
  controller.applyLease({
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a',
    cell_lease_epoch: 1,
    state: 'draining',
    recovery_complete: false,
    recovery_reset: true,
    observed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30_000).toISOString()
  }, now);
  controller.applyLease({
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a',
    cell_lease_epoch: 1,
    state: 'accepting',
    recovery_complete: true,
    recovery_reset: false,
    observed_at: new Date(now.getTime() + 1).toISOString(),
    expires_at: new Date(now.getTime() + 30_000).toISOString()
  }, new Date(now.getTime() + 1));
  const readiness = evaluateRustPbxMediaReadiness({
    route_snapshot: { ready: true, code: 'fresh' },
    media_control: { ready: false, code: 'unavailable' },
    profiles,
    dimensions: controller.snapshot(new Date(now.getTime() + 1)).dimensions
  });
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: 'component-node-test-token-123456789',
    now: () => new Date(now.getTime() + 2),
    readiness: () => readiness
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const live = await fetch(`http://127.0.0.1:${address.port}/livez`);
  assert.equal(live.status, 200);
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(ready.status, 503);
  assert.deepEqual(
    (await ready.json() as any).readiness.failure_stages,
    ['media_control']
  );
});

test('canonical and legacy Helm define independent bounded media profiles', () => {
  for (const values of [helmValues, legacyHelmValues]) {
    assert.match(values, /^  admissionProfiles:\n/m);
    assert.match(values, /^    ordinary:\n      id: voice-ordinary-v1$/m);
    assert.match(values, /^    t1:\n      id: voice-ha-t1-v1$/m);
    assert.match(values, /^    ivrTranscoding:\n      id: voice-ivr-transcoding-v1$/m);
    assert.match(values, /^    recording:\n      id: voice-recording-v1$/m);
    assert.match(values, /^    aiTap:\n      id: voice-ai-tap-v1$/m);
    for (const dimension of [
      'voice.weighted_calls',
      'voice.t1_shadow_slots',
      'voice.transcode_slots',
      'voice.recording_slots',
      'voice.realtime_asr_streams'
    ]) {
      assert.match(values, new RegExp(dimension.replace('.', '\\.')));
    }
  }

  for (const template of [helmRustPbx, legacyHelmRustPbx]) {
    assert.match(template, /RustPBX admission profile ids must be distinct/);
    assert.match(template, /OPC_IVEKIT_COMPONENT_NODE_PROFILE_IDS/);
    assert.match(template, /OPC_IVEKIT_COMPONENT_NODE_PROFILE_REQUIREMENTS_JSON/);
    assert.match(template, /OPC_IVEKIT_COMPONENT_NODE_READINESS_PROFILE_IDS/);
  }
});

test('Compose projects fresh RustPBX capacity into OPC placement admission', () => {
  assert.match(voiceCompose, /^  rustpbx-capacity-projector:\n/m);
  assert.match(
    voiceCompose,
    /rustpbx-capacity-projector:[\s\S]*scripts\/ivekit-cell-capacity-projector\.ts/
  );
  assert.match(voiceCompose, /^  rustpbx-placement-snapshot-projector:\n/m);
  assert.match(
    voiceCompose,
    /rustpbx-placement-snapshot-projector:[\s\S]*src\/ivekit-placement-snapshot-projector\.ts/
  );
  assert.match(
    voiceCompose,
    /rustpbx-placement-snapshot-projector:[\s\S]*ivekit-placement-snapshot:\/run\/ivekit-placement/
  );
  assert.match(
    voiceCompose,
    /OPC_IVEKIT_PLACEMENT_ENABLED: \$\{OPC_IVEKIT_PLACEMENT_ENABLED:-0\}[\s\S]*OPC_IVEKIT_PLACEMENT_SNAPSHOT_FILE: \/run\/ivekit-placement\/placement\.json/
  );
  assert.match(
    voiceCompose,
    /ivekit-placement-snapshot:\/run\/ivekit-placement:ro/
  );
  assert.match(
    voiceCompose,
    /rustpbx-placement-snapshot-projector:[\s\S]*condition: service_healthy/
  );
  for (const variable of [
    'RUSTPBX_CELL_CAPACITY_PROFILE_ID',
    'RUSTPBX_CELL_CAPACITY_PROFILE_SHA256',
    'RUSTPBX_CELL_CAPACITY_PROBES_JSON',
    'OPC_IVEKIT_PLACEMENT_EGRESS_TRACK_POLICY_JSON',
    'OPC_IVEKIT_PLACEMENT_EGRESS_COMPOSITE_POLICY_JSON'
  ]) {
    assert.match(voiceEnvExample, new RegExp(`^${variable}=`, 'm'));
  }
  assert.match(
    voiceEnvExample,
    /"health_url":"http:\/\/rustpbx:3210\/operationalz"/
  );
  assert.match(
    voiceEnvExample,
    /"drain_metric":"ivekit_component_node_route_drain_active"/
  );
});

test('RustPBX reaches node-local media-control through mTLS and file secrets only', () => {
  for (const values of [helmValues, legacyHelmValues]) {
    assert.match(values, /^  mediaControl:\n    enabled: true/m);
    assert.match(values, /endpoint: https:\/\/localhost:3211\//);
    assert.match(values, /clientTlsSecretName: ""/);
    assert.match(values, /serviceTokenKey: rustpbx-media-control-token/);
  }

  for (const template of [helmRustPbx, legacyHelmRustPbx]) {
    assert.match(
      template,
      /voice\.mediaControl\.endpoint must be https:\/\/localhost:3211\//
    );
    assert.match(
      template,
      /IVEKIT_RUSTPBX_MEDIA_CONTROL_ENDPOINT[\s\S]*voice\.mediaControl\.endpoint/
    );
    assert.match(
      template,
      /IVEKIT_RUSTPBX_MEDIA_CONTROL_TOKEN_FILE[\s\S]*\/run\/media-control-secrets\/service-token/
    );
    assert.match(
      template,
      /IVEKIT_RUSTPBX_MEDIA_CONTROL_TLS_IDENTITY_FILE[\s\S]*\/run\/media-control-client-tls\/%s[\s\S]*mediaControl\.identityFile/
    );
    assert.match(
      template,
      /IVEKIT_RUSTPBX_MEDIA_CONTROL_TLS_CA_FILE[\s\S]*\/run\/media-control-client-tls\/%s[\s\S]*mediaControl\.caFile/
    );
    assert.doesNotMatch(
      template,
      /IVEKIT_RUSTPBX_MEDIA_CONTROL_TOKEN[\s\S]{0,120}secretKeyRef/
    );
  }

  assert.match(rtpengineValues, /host: 127\.0\.0\.1/);
  assert.match(
    rtpengineDaemonSet,
    /IVEKIT_MEDIA_CONTROL_HOST[\s\S]*mediaControl\.host/
  );
  assert.doesNotMatch(
    rtpengineDaemonSet,
    /IVEKIT_MEDIA_CONTROL_HOST[\s\S]{0,100}value: "0\.0\.0\.0"/
  );

  assert.match(
    voiceCompose,
    /IVEKIT_RUSTPBX_MEDIA_CONTROL_ENDPOINT: https:\/\/localhost:3211\//
  );
  assert.match(
    voiceCompose,
    /IVEKIT_RUSTPBX_MEDIA_CONTROL_TOKEN_FILE: \/run\/secrets\/media-control-token/
  );
  assert.match(
    voiceCompose,
    /IVEKIT_RUSTPBX_MEDIA_CONTROL_TLS_IDENTITY_FILE: \/run\/secrets\/media-control-client-identity/
  );
  assert.match(
    voiceCompose,
    /IVEKIT_RUSTPBX_MEDIA_CONTROL_TLS_CA_FILE: \/run\/secrets\/media-control-ca/
  );
  assert.match(voiceCompose, /IVEKIT_MEDIA_CONTROL_PRODUCTION: "true"/);
  assert.match(voiceCompose, /IVEKIT_MEDIA_CONTROL_REQUIRE_MTLS: "true"/);
  assert.match(voiceCompose, /IVEKIT_MEDIA_CONTROL_HOST: 127\.0\.0\.1/);
  assert.match(
    voiceCompose,
    /IVEKIT_MEDIA_CONTROL_TOKEN_FILE: \/run\/secrets\/media-control-token/
  );
  assert.match(
    voiceCompose,
    /IVEKIT_MEDIA_CONTROL_TLS_KEY_FILE: \/run\/secrets\/media-control-server-key/
  );
  assert.match(
    voiceCompose,
    /IVEKIT_MEDIA_CONTROL_TLS_CERT_FILE: \/run\/secrets\/media-control-server-cert/
  );
  assert.match(
    voiceCompose,
    /IVEKIT_MEDIA_CONTROL_TLS_CA_FILE: \/run\/secrets\/media-control-ca/
  );
  assert.doesNotMatch(
    voiceCompose,
    /IVEKIT_MEDIA_CONTROL_TOKEN: \$\{OPC_IVEKIT_MEDIA_CONTROL_TOKEN/
  );
  for (const secret of [
    'media-control-token',
    'media-control-server-key',
    'media-control-server-cert',
    'media-control-client-identity',
    'media-control-ca'
  ]) {
    assert.match(voiceCompose, new RegExp(`- ${secret}`));
    assert.match(voiceCompose, new RegExp(`^  ${secret}:\\n    file:`, 'm'));
  }
  for (const variable of [
    'RUSTPBX_MEDIA_CONTROL_TOKEN_FILE',
    'RUSTPBX_MEDIA_CONTROL_SERVER_KEY_FILE',
    'RUSTPBX_MEDIA_CONTROL_SERVER_CERT_FILE',
    'RUSTPBX_MEDIA_CONTROL_CLIENT_IDENTITY_FILE',
    'RUSTPBX_MEDIA_CONTROL_CA_FILE'
  ]) {
    assert.match(voiceEnvExample, new RegExp(`^${variable}=`, 'm'));
  }
});

test('media-control tracing is bounded, configurable, and excludes sensitive media data', () => {
  for (const values of [helmValues, legacyHelmValues]) {
    assert.match(values, /traceSampleRatio: "0\.01"/);
  }
  for (const template of [helmRustPbx, legacyHelmRustPbx]) {
    assert.match(
      template,
      /IVEKIT_RUSTPBX_MEDIA_CONTROL_TRACE_SAMPLE_RATIO[\s\S]*mediaControl\.traceSampleRatio/
    );
  }
  assert.match(
    rustPbxMediaTracingPatch,
    /IVEKIT_RUSTPBX_MEDIA_CONTROL_TRACE_SAMPLE_RATIO/
  );
  assert.match(rustPbxMediaTracingPatch, /traceparent/);
  assert.match(rustPbxMediaTracingPatch, /media_control_traceparent/);
  assert.match(rustPbxMediaTracingPatch, /trace_digest/);
  assert.match(rustPbxMediaTracingPatch, /span_digest/);
  assert.match(rustPbxMediaTracingPatch, /traceparent_is_stable_per_call_and_bounded_by_sampling/);
  assert.doesNotMatch(
    rustPbxMediaTracingPatch,
    /tracing::(?:debug|info|warn|error)!\([^)]*(?:sdp|service_token|phone|authorization)/i
  );

  assert.match(mediaControlAgent, /import '\.\.\/src\/telemetry\.js';/);
  assert.match(rtpengineValues, /^  telemetry:\n    enabled: false/m);
  assert.match(rtpengineValues, /sampleRatio: "0\.01"/);
  assert.match(rtpengineDaemonSet, /OPC_OTEL_ENABLED/);
  assert.match(rtpengineDaemonSet, /OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
  assert.match(rtpengineDaemonSet, /OPC_OTEL_TRACE_SAMPLE_RATIO/);
});

test('deployment wires composite readiness, ordered drain, and fault-domain gates', () => {
  for (const values of [helmValues, legacyHelmValues]) {
    assert.match(values, /readinessRefreshMs: "1000"/);
  }
  for (const template of [helmRustPbx, legacyHelmRustPbx]) {
    assert.match(template, /OPC_IVEKIT_COMPONENT_NODE_ROUTE_SNAPSHOT_FILE/);
    assert.match(template, /OPC_IVEKIT_COMPONENT_NODE_MEDIA_CONTROL_ENDPOINT/);
    assert.match(template, /OPC_IVEKIT_COMPONENT_NODE_MEDIA_CONTROL_TLS_IDENTITY_FILE/);
    assert.match(
      template,
      /OPC_IVEKIT_COMPONENT_NODE_MEDIA_READINESS_REFRESH_MS[\s\S]*mediaControl\.readinessRefreshMs/
    );
    assert.match(template, /readinessProbe:[\s\S]*path: \/readyz/);
    assert.match(template, /POST \/v1\/drain/);
    assert.match(template, /wait_for_reservations_ms/);
    assert.match(template, /voice\.componentNode\.drainPollMs/);
    assert.match(template, /voice\.drainPropagationSeconds/);
    assert.match(template, /topologySpreadConstraints:/);
    assert.match(template, /podAntiAffinity:/);
    assert.match(template, /kind: PodDisruptionBudget/);
    assert.match(template, /ivekit\.io\/t1-shadow-fault-domain/);
  }

  assert.match(
    voiceCompose,
    /OPC_IVEKIT_COMPONENT_NODE_MEDIA_READINESS_ENABLED: "true"/
  );
  for (const variable of [
    'OPC_IVEKIT_COMPONENT_NODE_PROFILE_REQUIREMENTS_JSON',
    'OPC_IVEKIT_COMPONENT_NODE_READINESS_PROFILE_IDS',
    'OPC_IVEKIT_COMPONENT_NODE_ROUTE_SNAPSHOT_FILE',
    'OPC_IVEKIT_COMPONENT_NODE_ROUTE_SNAPSHOT_HMAC_KEY_FILE',
    'OPC_IVEKIT_COMPONENT_NODE_ROUTE_TENANT_ID',
    'OPC_IVEKIT_COMPONENT_NODE_ROUTE_PROFILE_ID',
    'OPC_IVEKIT_COMPONENT_NODE_MEDIA_CONTROL_ENDPOINT',
    'OPC_IVEKIT_COMPONENT_NODE_MEDIA_CONTROL_TLS_IDENTITY_FILE',
    'OPC_IVEKIT_COMPONENT_NODE_MEDIA_CONTROL_TLS_CA_FILE',
    'OPC_IVEKIT_COMPONENT_NODE_MEDIA_CONTROL_TIMEOUT_MS',
    'OPC_IVEKIT_COMPONENT_NODE_MEDIA_READINESS_REFRESH_MS'
  ]) {
    assert.match(voiceCompose, new RegExp(`${variable}:`));
  }
  assert.match(
    voiceCompose,
    /fetch\('http:\/\/127\.0\.0\.1:3210\/operationalz'\)/
  );
  assert.doesNotMatch(
    voiceCompose,
    /fetch\('http:\/\/127\.0\.0\.1:3210\/(?:readyz|livez)'\)/
  );
  assert.match(
    voiceCompose,
    /https\.request\('https:\/\/localhost:3211\/readyz'/
  );
  for (const profile of [
    'voice-ordinary-v1',
    'voice-ha-t1-v1',
    'voice-ivr-transcoding-v1',
    'voice-recording-v1',
    'voice-ai-tap-v1'
  ]) {
    assert.match(voiceEnvExample, new RegExp(profile));
  }
});

test('recording, AI tap, and ordinary relay have independent capacity alerts and rollback rules', () => {
  for (const values of [helmValues, legacyHelmValues]) {
    assert.match(values, /recordingChannelCapacity: 256/);
    assert.match(values, /recordingWorkerQueueCapacity: 4096/);
    assert.match(values, /rustPbxChannelCapacity: "256"/);
    assert.match(values, /maxInflight: "2048"/);
  }
  for (const rules of [canonicalPrometheusRules, legacyHelmRustPbx]) {
    assert.match(rules, /IveKitRustPbxOrdinaryRelayCapacityUnavailable/);
    assert.match(rules, /IveKitRustPbxRecordingProfileExhausted/);
    assert.match(rules, /IveKitRustPbxAiTapProfileExhausted/);
    assert.match(rules, /profile="voice-ordinary-v1"/);
    assert.match(rules, /profile="voice-recording-v1"/);
    assert.match(rules, /profile="voice-ai-tap-v1"/);
  }
  assert.match(rustPbxReadme, /Goal 3 rolling rollback contract/);
  assert.match(rustPbxReadme, /must not restart the entire Cell RTPengine/i);
  assert.match(rustPbxReadme, /existing RTPengine sessions remain\s+authoritative/i);
});

function capacity(safeCapacity: number, used: number, reserved = 0) {
  return {
    unit: 'count',
    safe_capacity: safeCapacity,
    used,
    reserved
  };
}

function mediaState(weightedCallCapacity: number, weightedCallUsed: number) {
  return {
    component: 'rustpbx' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a',
    state: 'accepting' as const,
    state_sequence: 1,
    drain_started_at: '',
    cell_lease_epoch: 1,
    lease_observed_at: '2026-07-27T08:00:00.000Z',
    lease_expires_at: '2026-07-27T08:01:00.000Z',
    lease_fresh: true,
    recovery_pending: false,
    dimensions: {
      'voice.weighted_calls': capacity(weightedCallCapacity, weightedCallUsed),
      'voice.t1_shadow_slots': capacity(2, 0),
      'voice.transcode_slots': capacity(4, 0),
      'voice.recording_slots': capacity(2, 0),
      'voice.realtime_asr_streams': capacity(3, 0)
    },
    reservations: {
      reserved: 0,
      active: 0,
      expired: 0,
      closed: 0
    }
  };
}
