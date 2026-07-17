import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  cellAdmissionRuntimeConfig,
  createConfiguredCellAdmissionController
} from '../scripts/ivekit-cell-admission.js';

test('Cell admission runtime config compiles an explicit Cell-10K capacity model', () => {
  const config = cellAdmissionRuntimeConfig(validEnv());
  assert.equal(config.port, 3200);
  assert.equal(config.database_url, 'postgresql://opc_runtime:test@postgres/ivekit');
  assert.equal(config.owner_instance_id, 'cell-admission-a');
  assert.match(config.topology_sha256, /^[a-f0-9]{64}$/);
  assert.equal(config.lease_ttl_ms, 30_000);
  assert.equal(config.lease_claim_retry_interval_ms, 1_000);
  assert.equal(config.terminal_retention_ms, 300_000);
  assert.equal(config.sweep_interval_ms, 1_000);
  assert.deepEqual(config.profile_ids, ['cell-10k-v1']);
  assert.deepEqual(config.interaction_kinds, [
    'livekit_av',
    'livekit_screen',
    'rustdesk_remote',
    'sip_voice',
    'tinode_im'
  ]);
  const controller = createConfiguredCellAdmissionController(config, 7);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.state, 'accepting');
  assert.equal(snapshot.nodes.length, 5);
  assert.equal(snapshot.dimensions['voice.weighted_calls'].safe_capacity, 2_500);
  const reservation = controller.reserve({
    request_id: 'request-runtime-config',
    idempotency_key: 'runtime-config-lease-epoch',
    tenant_id: 'tenant-runtime-config',
    routing_partition_id: 'partition-runtime-config',
    interaction_id: 'interaction-runtime-config',
    profile_id: 'cell-10k-v1',
    interaction_kind: 'sip_voice',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T00:00:00.000Z'));
  assert.equal(Number(BigInt(reservation.owner_epoch) >> 32n), 7);
});

test('Cell admission runtime compiles stable node pools and rejects dual topology authority', () => {
  const env = validEnv();
  delete env.OPC_IVEKIT_CELL_NODES_JSON;
  env.OPC_IVEKIT_CELL_NODE_POOLS_JSON = JSON.stringify([
    {
      component: 'rustpbx',
      node_id_prefix: 'rustpbx-a',
      replica_count: 1,
      endpoint_template: 'http://{node_id}.rustpbx-headless:8080',
      control_endpoint_template: 'http://{node_id}.rustpbx-headless:3210',
      state: 'accepting',
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['sip_voice'],
      dimensions: {
        'voice.weighted_calls': {
          unit: 'calls',
          safe_capacity: 2_500,
          used: 0,
          reserved: 0
        }
      }
    }
  ]);
  env.OPC_IVEKIT_CELL_INTERACTION_KINDS = 'sip_voice';
  env.OPC_IVEKIT_COMPONENT_NODE_TOKEN =
    'component-node-secret-1234567890';
  env.OPC_IVEKIT_CELL_DIMENSIONS_JSON = JSON.stringify({
    'voice.weighted_calls': {
      unit: 'calls',
      safe_capacity: 2_500,
      used: 0,
      reserved: 0
    }
  });

  const config = cellAdmissionRuntimeConfig(env);

  assert.equal(config.nodes[0]?.node_id, 'rustpbx-a-0');
  assert.equal(
    config.nodes[0]?.control_endpoint,
    'http://rustpbx-a-0.rustpbx-headless:3210'
  );
  assert.throws(
    () => cellAdmissionRuntimeConfig({
      ...env,
      OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify(config.nodes)
    }),
    /topology authority/i
  );
});

test('Cell admission runtime hydrates durable reservations before accepting traffic', () => {
  const config = cellAdmissionRuntimeConfig(validEnv());
  const controller = createConfiguredCellAdmissionController(config, 7, [{
    reservation_id: 'reservation-recovered',
    state: 'active',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    owner_epoch: '30064771073',
    endpoint: 'https://rustpbx-a.internal',
    expires_at: '2026-07-16T08:00:10.000Z',
    required_capacity: { 'voice.weighted_calls': 1 },
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    idempotency_key: 'idem-a',
    payload_hash: 'a'.repeat(64),
    created_at: '2026-07-16T08:00:00.000Z',
    updated_at: '2026-07-16T08:00:01.000Z'
  }]);

  assert.equal(controller.snapshot().reservations[0]?.state, 'active');
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].used, 1);
});

test('Cell admission runtime rejects recovery when a topology removed an active owner node', () => {
  const config = cellAdmissionRuntimeConfig(validEnv());
  assert.throws(
    () => createConfiguredCellAdmissionController(config, 8, [{
      reservation_id: 'reservation-orphaned',
      state: 'active',
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      owner_node_id: 'rustpbx-removed',
      owner_epoch: '30064771073',
      endpoint: 'https://rustpbx-removed.internal',
      expires_at: '2026-07-16T08:00:10.000Z',
      required_capacity: { 'voice.weighted_calls': 1 },
      tenant_id: 'tenant-a',
      routing_partition_id: 'tenant-a:call-a',
      interaction_id: 'call-a',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      idempotency_key: 'idem-orphaned',
      payload_hash: 'b'.repeat(64),
      created_at: '2026-07-16T08:00:00.000Z',
      updated_at: '2026-07-16T08:00:01.000Z'
    }]),
    /owner node is missing/i
  );
});

test('Cell admission runtime enables component-node sync only for explicit control endpoints', () => {
  const disabled = cellAdmissionRuntimeConfig(validEnv());
  assert.equal(disabled.component_node_sync.enabled, false);

  const controlledNodes = JSON.parse(
    String(validEnv().OPC_IVEKIT_CELL_NODES_JSON)
  ).map((value: Record<string, unknown>) => ({
    ...value,
    control_endpoint: `http://${String(value.node_id)}:3210`
  }));
  const enabled = cellAdmissionRuntimeConfig({
    ...validEnv(),
    OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify(controlledNodes.slice(0, 4)),
    OPC_IVEKIT_COMPONENT_NODE_TOKEN: 'component-node-secret-1234567890',
    OPC_IVEKIT_COMPONENT_NODE_LEASE_TTL_MS: '10000',
    OPC_IVEKIT_COMPONENT_NODE_HEARTBEAT_INTERVAL_MS: '3000',
    OPC_IVEKIT_COMPONENT_NODE_TIMEOUT_MS: '1000'
  });

  assert.equal(enabled.component_node_sync.enabled, true);
  if (!enabled.component_node_sync.enabled) return;
  assert.equal(enabled.component_node_sync.lease_ttl_ms, 10_000);
  assert.equal(enabled.component_node_sync.heartbeat_interval_ms, 3_000);
  assert.equal(enabled.component_node_sync.timeout_ms, 1_000);
});

test('Cell admission runtime requires a production token for controlled component nodes', () => {
  const nodes = JSON.parse(String(validEnv().OPC_IVEKIT_CELL_NODES_JSON));
  for (const node of nodes) {
    node.control_endpoint = `http://${String(node.node_id)}:3210`;
  }
  assert.throws(
    () => cellAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify(nodes)
    }),
    /COMPONENT_NODE_TOKEN/
  );
});

test('Cell admission runtime refuses missing, placeholder or invented capacity', () => {
  assert.throws(
    () => cellAdmissionRuntimeConfig({}),
    /required/i
  );
  assert.throws(
    () => cellAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_CELL_ADMISSION_TOKEN: 'replace-with-production-token-12345'
    }),
    /token/i
  );
  assert.throws(
    () => cellAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_CELL_DIMENSIONS_JSON: '{}'
    }),
    /capacity dimensions/i
  );
  assert.throws(
    () => cellAdmissionRuntimeConfig({
      ...validEnv(),
      OPC_IVEKIT_CELL_NODES_JSON: '[]'
    }),
    /at least one node/i
  );
});

test('capacity deployment templates contain a dedicated admission process', () => {
  const compose = readFileSync('infra/capacity/docker-compose.yml', 'utf8');
  assert.match(compose, /capacity-admission:/);
  assert.match(compose, /capacity-projector:/);
  assert.match(compose, /ivekit-cell-admission\.ts/);
  assert.match(compose, /ivekit-cell-capacity-projector\.ts/);
  assert.match(compose, /OPC_IVEKIT_CELL_DIMENSIONS_JSON/);
  assert.match(compose, /OPC_IVEKIT_CELL_NODES_JSON/);
  assert.match(compose, /OPC_IVEKIT_CELL_NODE_POOLS_JSON/);
  assert.match(compose, /OPC_IVEKIT_COMPONENT_NODE_TOKEN/);
  assert.doesNotMatch(compose, /sqlite/i);

  const kubernetes = readFileSync(
    'infra/capacity/kubernetes/cell-admission-deployment.yaml',
    'utf8'
  );
  assert.match(kubernetes, /kind: Deployment/);
  assert.match(kubernetes, /replicas: 2/);
  assert.match(kubernetes, /type: RollingUpdate/);
  assert.match(kubernetes, /maxUnavailable: 1/);
  assert.match(kubernetes, /maxSurge: 1/);
  assert.match(kubernetes, /readinessProbe:/);
  assert.match(kubernetes, /livenessProbe:[\s\S]*path: \/livez/);
  assert.match(kubernetes, /OPC_DATABASE_URL/);
  assert.match(kubernetes, /OPC_IVEKIT_CELL_INSTANCE_ID/);
  assert.match(kubernetes, /OPC_IVEKIT_CELL_LEASE_CLAIM_RETRY_MS/);
  assert.doesNotMatch(kubernetes, /OPC_IVEKIT_CELL_LEASE_EPOCH/);
  assert.match(kubernetes, /secretKeyRef:[\s\S]*admission-token/);
  assert.match(kubernetes, /readOnlyRootFilesystem: true/);
  assert.match(kubernetes, /name: capacity-projector/);
  assert.match(kubernetes, /OPC_IVEKIT_CELL_PROBES_JSON/);
  assert.match(kubernetes, /OPC_IVEKIT_COMPONENT_NODE_TOKEN/);
  assert.match(kubernetes, /OPC_IVEKIT_CELL_NODE_POOLS_JSON/);
  assert.match(kubernetes, /topologySpreadConstraints:/);
  assert.match(kubernetes, /podAntiAffinity:/);
  assert.match(kubernetes, /kind: PodDisruptionBudget/);
  assert.match(kubernetes, /minAvailable: 1/);
  assert.doesNotMatch(kubernetes, /publishNotReadyAddresses: true/);
});

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    OPC_IVEKIT_CELL_ADMISSION_HOST: '0.0.0.0',
    OPC_IVEKIT_CELL_ADMISSION_PORT: '3200',
    OPC_IVEKIT_CELL_ADMISSION_TOKEN: 'cell-admission-secret-1234567890',
    OPC_IVEKIT_CELL_REGION_ID: 'region-a',
    OPC_IVEKIT_CELL_ZONE_ID: 'zone-a',
    OPC_IVEKIT_CELL_ID: 'cell-a',
    OPC_DATABASE_URL: 'postgresql://opc_runtime:test@postgres/ivekit',
    OPC_IVEKIT_CELL_INSTANCE_ID: 'cell-admission-a',
    OPC_IVEKIT_CELL_LEASE_TTL_MS: '30000',
    OPC_IVEKIT_CELL_LEASE_CLAIM_RETRY_MS: '1000',
    OPC_IVEKIT_CELL_TERMINAL_RETENTION_MS: '300000',
    OPC_IVEKIT_CELL_SWEEP_INTERVAL_MS: '1000',
    OPC_IVEKIT_CELL_PROFILE_IDS: 'cell-10k-v1',
    OPC_IVEKIT_CELL_INTERACTION_KINDS:
      'tinode_im,sip_voice,livekit_av,livekit_screen,rustdesk_remote',
    OPC_IVEKIT_CELL_RESERVATION_TTL_MS: '10000',
    OPC_IVEKIT_CELL_INITIAL_STATE: 'accepting',
    OPC_IVEKIT_CELL_DIMENSIONS_JSON: JSON.stringify({
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 2_500,
        used: 0,
        reserved: 0
      },
      'video.participants': {
        unit: 'participants',
        safe_capacity: 2_000,
        used: 0,
        reserved: 0
      }
    }),
    OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify([
      node('tinode-a'),
      node('rustpbx-a'),
      node('livekit-a'),
      node('rustdesk-a'),
      node('edge-a')
    ])
  };
}

function node(nodeId: string) {
  const interactionKinds = nodeId.startsWith('tinode')
    ? ['tinode_im']
    : nodeId.startsWith('rustpbx')
      ? ['sip_voice']
      : nodeId.startsWith('livekit')
        ? ['livekit_av', 'livekit_screen']
        : nodeId.startsWith('rustdesk')
          ? ['rustdesk_remote']
          : ['tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote'];
  return {
    node_id: nodeId,
    endpoint: `https://${nodeId}.internal`,
    state: 'accepting',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: interactionKinds,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 2_500,
        used: 0,
        reserved: 0
      },
      'video.participants': {
        unit: 'participants',
        safe_capacity: 2_000,
        used: 0,
        reserved: 0
      }
    }
  };
}
