import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  componentNodeAdmissionRuntimeConfig,
  createConfiguredComponentNodeAdmissionController,
  createConfiguredRustPbxRecordingSpoolCapacityGate
} from '../scripts/ivekit-component-node-admission.js';

test('component node runtime config creates an explicit LiveKit sidecar identity', () => {
  const config = componentNodeAdmissionRuntimeConfig(validEnv());
  assert.equal(config.component, 'livekit');
  assert.equal(config.node_id, 'livekit-a');
  assert.deepEqual(config.interaction_kinds, ['livekit_av', 'livekit_screen']);
  assert.equal(config.sweep_interval_ms, 1_000);

  const controller = createConfiguredComponentNodeAdmissionController(config);
  const snapshot = controller.snapshot(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(snapshot.state, 'draining');
  assert.equal(snapshot.lease_fresh, false);
  assert.equal(snapshot.dimensions['video.participants'].safe_capacity, 2_000);
});

test('component node runtime rejects placeholder secrets and cross-component kinds', () => {
  assert.throws(
    () => componentNodeAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_COMPONENT_NODE_TOKEN: 'replace-with-node-token-123456'
    }),
    /token/i
  );
  assert.throws(
    () => componentNodeAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_COMPONENT_NODE_INTERACTION_KINDS: 'tinode_im'
    }),
    /interaction kind/i
  );
  assert.throws(
    () => componentNodeAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_COMPONENT_NODE_DIMENSIONS_JSON: '{}'
    }),
    /capacity dimensions/i
  );
});

test('RustPBX component node runtime wires a fresh local recording spool gate', () => {
  const env = {
    ...validEnv(),
    OPC_IVEKIT_COMPONENT_NODE_COMPONENT: 'rustpbx',
    OPC_IVEKIT_COMPONENT_NODE_ID: 'rustpbx-a',
    OPC_IVEKIT_COMPONENT_NODE_INTERACTION_KINDS: 'sip_voice',
    OPC_IVEKIT_COMPONENT_NODE_DIMENSIONS_JSON: JSON.stringify({
      'voice.weighted_calls': {
        unit: 'calls', safe_capacity: 2_500, used: 0, reserved: 0
      },
      'data.local_spool_bytes': {
        unit: 'bytes', safe_capacity: 900_000_000, used: 0, reserved: 0
      }
    }),
    OPC_IVEKIT_COMPONENT_NODE_RECORDING_SPOOL_METRICS_FILE: '/app/recording-state/metrics.json',
    OPC_IVEKIT_COMPONENT_NODE_RECORDING_SPOOL_REFRESH_MS: '1000',
    OPC_IVEKIT_COMPONENT_NODE_RECORDING_SPOOL_STALE_MS: '5000'
  };
  const config = componentNodeAdmissionRuntimeConfig(env);
  assert.equal(config.recording_spool_metrics_file, '/app/recording-state/metrics.json');
  assert.equal(config.recording_spool_refresh_ms, 1_000);
  assert.equal(config.recording_spool_stale_ms, 5_000);
  const gate = createConfiguredRustPbxRecordingSpoolCapacityGate(config);
  assert.ok(gate);
  assert.throws(
    () => gate.assertReservation({ 'data.local_spool_bytes': 1 }),
    (error: any) => error?.code === 'component_recording_spool_observation_stale'
  );

  assert.throws(
    () => componentNodeAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_COMPONENT_NODE_RECORDING_SPOOL_METRICS_FILE: '/tmp/metrics.json'
    }),
    /RustPBX/i
  );
});

test('capacity image and deployment templates ship the component node agent', () => {
  const dockerfile = readFileSync('infra/capacity/Dockerfile', 'utf8');
  const compose = readFileSync('infra/capacity/docker-compose.yml', 'utf8');
  const kubernetes = readFileSync(
    'infra/capacity/kubernetes/component-node-admission-sidecar.yaml',
    'utf8'
  );
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.match(dockerfile, /ivekit-component-node-admission\.ts/);
  assert.match(
    dockerfile,
    /COPY src\/ivekit-component-node-admission\.ts \.\/src\/ivekit-component-node-admission\.ts/
  );
  assert.match(
    dockerfile,
    /COPY src\/agent-runtime\/ivekit\/recordings\/recording-manifest\.ts \.\/src\/agent-runtime\/ivekit\/recordings\/recording-manifest\.ts/
  );
  assert.match(
    dockerfile,
    /COPY src\/agent-runtime\/ivekit\/recordings\/rustpbx-recording-spool-capacity\.ts \.\/src\/agent-runtime\/ivekit\/recordings\/rustpbx-recording-spool-capacity\.ts/
  );
  assert.match(compose, /component-node-admission:/);
  assert.match(compose, /profiles: \["component-node"\]/);
  assert.match(compose, /OPC_IVEKIT_COMPONENT_NODE_COMPONENT/);
  assert.match(kubernetes, /name: node-admission/);
  assert.match(kubernetes, /OPC_IVEKIT_COMPONENT_NODE_ID/);
  assert.match(kubernetes, /readOnlyRootFilesystem: true/);
  assert.match(kubernetes, /path: \/readyz/);
  assert.equal(
    packageJson.scripts['ivekit:capacity:component-node'],
    'node --import tsx scripts/ivekit-component-node-admission.ts'
  );
});

function validEnv(): NodeJS.ProcessEnv {
  return {
    OPC_IVEKIT_COMPONENT_NODE_HOST: '0.0.0.0',
    OPC_IVEKIT_COMPONENT_NODE_PORT: '3210',
    OPC_IVEKIT_COMPONENT_NODE_TOKEN: 'component-node-secret-1234567890',
    OPC_IVEKIT_COMPONENT_NODE_COMPONENT: 'livekit',
    OPC_IVEKIT_COMPONENT_NODE_REGION_ID: 'region-a',
    OPC_IVEKIT_COMPONENT_NODE_ZONE_ID: 'zone-a',
    OPC_IVEKIT_COMPONENT_NODE_CELL_ID: 'cell-a',
    OPC_IVEKIT_COMPONENT_NODE_ID: 'livekit-a',
    OPC_IVEKIT_COMPONENT_NODE_PROFILE_IDS: 'cell-10k-v1',
    OPC_IVEKIT_COMPONENT_NODE_INTERACTION_KINDS: 'livekit_av,livekit_screen',
    OPC_IVEKIT_COMPONENT_NODE_TERMINAL_RETENTION_MS: '300000',
    OPC_IVEKIT_COMPONENT_NODE_SWEEP_INTERVAL_MS: '1000',
    OPC_IVEKIT_COMPONENT_NODE_DIMENSIONS_JSON: JSON.stringify({
      'video.participants': {
        unit: 'participants',
        safe_capacity: 2_000,
        used: 0,
        reserved: 0
      }
    })
  };
}
