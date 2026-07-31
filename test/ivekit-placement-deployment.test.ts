import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('standalone Helm deploys placement as a signed snapshot sidecar with a read-only API mount', () => {
  const deployment = readFileSync(
    'services/ivekit-service/helm/ivekit/templates/deployment.yaml',
    'utf8'
  );
  const values = readFileSync(
    'services/ivekit-service/helm/ivekit/values.yaml',
    'utf8'
  );
  assert.match(deployment, /name: placement-snapshot-projector/);
  assert.match(deployment, /dist\/ivekit-placement-snapshot-projector\.js/);
  assert.match(deployment, /OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON/);
  assert.match(deployment, /OPC_IVEKIT_PLACEMENT_TOKEN_HMAC_KEYS_JSON/);
  assert.match(deployment, /OPC_IVEKIT_CELL_ADMISSION_TOKEN/);
  assert.match(deployment, /name: placement-snapshot[\s\S]*readOnly: true/);
  assert.match(deployment, /emptyDir:[\s\S]*medium: Memory/);
  assert.match(values, /^placement:\n  enabled: false/m);
  assert.match(values, /mediaPolicyJson:/);
  assert.match(values, /egressTrackPolicyJson:/);
  assert.match(values, /egressCompositePolicyJson:/);
  assert.match(values, /voicePolicyJson:/);
  assert.match(values, /tinodePolicyJson:/);
  assert.match(values, /rustdeskPolicyJson:/);
  assert.match(values, /snapshotHmacKeysKey:/);
  assert.match(values, /tokenHmacKeysKey:/);
});

test('standalone Compose and source policy ship the placement projector and migration', () => {
  const compose = readFileSync(
    'services/ivekit-service/docker-compose.yml',
    'utf8'
  );
  const policy = JSON.parse(readFileSync(
    'services/ivekit-service/source-policy.json',
    'utf8'
  )) as { entrypoints: string[]; migrations: string[] };
  const servicePackage = JSON.parse(readFileSync(
    'services/ivekit-service/package.json',
    'utf8'
  )) as { scripts: Record<string, string> };
  assert.match(compose, /placement-projector:/);
  assert.match(compose, /placement_snapshot:\/run\/ivekit-placement/);
  assert.match(compose, /OPC_IVEKIT_PLACEMENT_ENABLED/);
  assert.match(compose, /OPC_IVEKIT_PLACEMENT_EGRESS_TRACK_POLICY_JSON/);
  assert.match(compose, /OPC_IVEKIT_PLACEMENT_EGRESS_COMPOSITE_POLICY_JSON/);
  assert.equal(
    policy.entrypoints.includes('src/ivekit-placement-snapshot-projector.ts'),
    true
  );
  assert.equal(
    policy.migrations.includes('080_ivekit_interaction_placements.sql'),
    true
  );
  assert.equal(
    policy.migrations.includes('083_ivekit_cell_admission_reservations.sql'),
    true
  );
  assert.equal(
    policy.migrations.includes('084_ivekit_cell_lease_topology.sql'),
    true
  );
  assert.equal(
    servicePackage.scripts['project:placement'],
    'node dist/ivekit-placement-snapshot-projector.js'
  );
});

test('Cell admission examples declare component capabilities instead of interchangeable nodes', () => {
  const env = readFileSync('infra/capacity/env.example', 'utf8');
  assert.match(env, /"node_id":"rustpbx-a"[\s\S]*"interaction_kinds":\["sip_voice"\]/);
  assert.match(env, /"node_id":"livekit-a"[\s\S]*"interaction_kinds":\["livekit_av","livekit_screen"\]/);
  assert.match(env, /"node_id":"tinode-a"[\s\S]*"interaction_kinds":\["tinode_im"\]/);
  assert.match(
    env,
    /"node_id":"ivekit-rustdesk-cell-0"[\s\S]*"interaction_kinds":\["rustdesk_remote"\]/
  );
  assert.match(
    env,
    /"ivekit-rustdesk-cell-0":\{"id_server":"rustdesk-0\.example\.com"[\s\S]*"owner_binding_endpoint":"http:\/\/ivekit-rustdesk-cell-0\.ivekit-rustdesk-cell:3211"/
  );
  assert.match(env, /"component":"tinode"[\s\S]*"im\.presence_sessions"/);
  assert.match(env, /"component":"rustdesk"[\s\S]*"remote\.active_sessions"/);
  assert.match(env, /OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON=/);
});

test('RustPBX deployment admits the configured voice placement profile', () => {
  const env = readFileSync('infra/ivekit/env.example', 'utf8');
  const policy = JSON.parse(envValue(
    env,
    'OPC_IVEKIT_PLACEMENT_VOICE_POLICY_JSON'
  )) as {
    profile_id: string;
    fixed_capacity: Record<string, number>;
  };
  const profileIds = envValue(
    env,
    'RUSTPBX_COMPONENT_NODE_PROFILE_IDS'
  ).split(',');
  const requirements = JSON.parse(envValue(
    env,
    'RUSTPBX_COMPONENT_NODE_PROFILE_REQUIREMENTS_JSON'
  )) as Record<string, Record<string, number>>;
  const cellNodes = JSON.parse(envValue(
    env,
    'RUSTPBX_CELL_NODES_JSON'
  )) as Array<{ node_id: string; profile_ids: string[] }>;
  const rustPbxNode = cellNodes.find((node) => node.node_id === 'rustpbx-node-a');

  assert.equal(profileIds.includes(policy.profile_id), true);
  assert.deepEqual(requirements[policy.profile_id], policy.fixed_capacity);
  assert.equal(rustPbxNode?.profile_ids.includes(policy.profile_id), true);
});

test('standalone Cell deployment admits Tinode through its native owner guard', () => {
  const compose = readFileSync(
    'infra/ivekit/docker-compose.voice.yml',
    'utf8'
  );
  const env = readFileSync('infra/ivekit/env.example', 'utf8');

  const tinode = serviceBlock(compose, 'tinode');
  const componentNode = serviceBlock(compose, 'tinode-component-node');
  const admission = serviceBlock(compose, 'cell-admission');
  const capacity = serviceBlock(compose, 'rustpbx-capacity-projector');

  assert.match(tinode, /IVEKIT_COMPONENT_NODE_ENDPOINT: http:\/\/127\.0\.0\.1:3210/);
  assert.match(tinode, /IVEKIT_COMPONENT_NODE_ID: \$\{TINODE_OWNER_NODE_ID/);
  assert.match(tinode, /IVEKIT_OWNER_GUARD_REQUIRED: "1"/);
  assert.match(tinode, /IVEKIT_TINODE_OWNER_API_TOKEN:/);
  assert.match(tinode, /IVEKIT_TINODE_CLUSTER_MODE: standalone/);

  assert.match(componentNode, /network_mode: service:tinode/);
  assert.match(componentNode, /OPC_IVEKIT_COMPONENT_NODE_COMPONENT: tinode/);
  assert.match(componentNode, /OPC_IVEKIT_COMPONENT_NODE_INTERACTION_KINDS: tinode_im/);
  assert.match(componentNode, /OPC_IVEKIT_COMPONENT_NODE_DIMENSIONS_JSON:/);
  assert.match(componentNode, /fetch\('http:\/\/127\.0\.0\.1:3210\/operationalz'\)/);

  assert.match(admission, /OPC_IVEKIT_CELL_INTERACTION_KINDS: \$\{IVEKIT_CELL_INTERACTION_KINDS/);
  assert.match(admission, /OPC_IVEKIT_CELL_DIMENSIONS_JSON: \$\{IVEKIT_CELL_DIMENSIONS_JSON/);
  assert.match(admission, /OPC_IVEKIT_CELL_NODES_JSON: \$\{IVEKIT_CELL_NODES_JSON/);
  assert.match(capacity, /OPC_IVEKIT_CELL_PROBES_JSON: \$\{IVEKIT_CELL_CAPACITY_PROBES_JSON/);
  assert.match(capacity, /tinode-component-node:[\s\S]*condition: service_healthy/);

  const kinds = envValue(env, 'IVEKIT_CELL_INTERACTION_KINDS').split(',');
  const nodes = JSON.parse(envValue(env, 'IVEKIT_CELL_NODES_JSON')) as Array<{
    node_id: string;
    interaction_kinds: string[];
  }>;
  const probes = JSON.parse(
    envValue(env, 'IVEKIT_CELL_CAPACITY_PROBES_JSON')
  ) as Array<{
    component: string;
    metrics_url: string;
    dimensions: Record<string, { labels?: Record<string, string> }>;
  }>;
  const tinodeNode = nodes.find((node) => node.node_id === 'tinode-node-a');
  const tinodeProbe = probes.find((probe) => probe.component === 'tinode');

  assert.equal(kinds.includes('sip_voice'), true);
  assert.equal(kinds.includes('tinode_im'), true);
  assert.deepEqual(tinodeNode?.interaction_kinds, ['tinode_im']);
  assert.equal(tinodeProbe?.metrics_url, 'http://tinode:3210/metrics');
  assert.deepEqual(
    tinodeProbe?.dimensions['im.presence_sessions']?.labels,
    { dimension: 'im.presence_sessions' }
  );
});

test('Tinode production StatefulSet explicitly enables clustered identity', () => {
  const statefulSet = readFileSync(
    'infra/capacity/kubernetes/tinode-statefulset.yaml',
    'utf8'
  );

  assert.match(
    statefulSet,
    /name: IVEKIT_TINODE_CLUSTER_MODE[\s\S]*value: "clustered"/
  );
});

function envValue(source: string, name: string): string {
  const line = source.split('\n').find((entry) => entry.startsWith(`${name}=`));
  assert.ok(line, `${name} is missing`);
  return line.slice(name.length + 1);
}

function serviceBlock(source: string, name: string): string {
  const block = source.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|^volumes:)`, 'm')
  )?.[0];
  assert.ok(block, `${name} service is missing`);
  return block;
}
