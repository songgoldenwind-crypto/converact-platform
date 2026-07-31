import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hotfixRoot = join(
  repositoryRoot,
  'infra',
  'hotfixes',
  'production-media-20260730'
);
const liveKitOverridePath = join(hotfixRoot, 'livekit-owner.override.yml');
const cellOverridePath = join(hotfixRoot, 'cell-owner.override.yml');
const apiOverridePath = join(hotfixRoot, 'api-hotfix.override.yml');
const opcDockerfilePath = join(hotfixRoot, 'Dockerfile.opc');
const envExamplePath = join(hotfixRoot, 'env.example');
const runbookPath = join(hotfixRoot, 'runbook.md');
const validatorPath = join(hotfixRoot, 'validate.mjs');

test('old production media hotfix is isolated, expiring, capacity-bounded, and reversible', async () => {
  for (const path of [
    liveKitOverridePath,
    cellOverridePath,
    apiOverridePath,
    opcDockerfilePath,
    envExamplePath,
    runbookPath,
    validatorPath
  ]) {
    assert.equal(
      existsSync(path),
      true,
      `required production media hotfix artifact is missing: ${path}`
    );
  }

  const liveKitOverride = readFileSync(liveKitOverridePath, 'utf8');
  const cellOverride = readFileSync(cellOverridePath, 'utf8');
  const apiOverride = readFileSync(apiOverridePath, 'utf8');
  const opcDockerfile = readFileSync(opcDockerfilePath, 'utf8');
  const envExample = readFileSync(envExamplePath, 'utf8');
  const runbook = readFileSync(runbookPath, 'utf8');
  const validatorSource = readFileSync(validatorPath, 'utf8');

  const componentNode = serviceBlock(
    liveKitOverride,
    'livekit-component-node'
  );
  const liveKit = serviceBlock(liveKitOverride, 'livekit');
  assert.match(
    componentNode,
    /image: \$\{IVEKIT_CAPACITY_TOOLS_IMAGE:\?immutable digest required\}/
  );
  assert.match(
    componentNode,
    /127\.0\.0\.1:\$\{LIVEKIT_COMPONENT_NODE_LOOPBACK_PORT:-3210\}:3210/
  );
  assert.doesNotMatch(componentNode, /network_mode:\s*["']?host/);
  assert.match(componentNode, /ivekit-owner-control:\s*\{\}/);
  assert.doesNotMatch(componentNode, /aliases:\s*\n\s+- livekit-component-node/);
  assert.match(
    componentNode,
    /OPC_IVEKIT_COMPONENT_NODE_PRODUCTION:\s*["']false["']/
  );
  assert.match(
    componentNode,
    /OPC_IVEKIT_COMPONENT_NODE_REQUIRE_MTLS:\s*["']false["']/
  );
  assert.match(
    componentNode,
    /OPC_IVEKIT_COMPONENT_NODE_INTERACTION_KINDS:\s*livekit_av/
  );
  assert.match(
    componentNode,
    /fetch\('http:\/\/127\.0\.0\.1:3210\/livez'\)/
  );
  assert.doesNotMatch(componentNode, /\/readyz.*condition:\s*service_healthy/s);

  assert.match(
    liveKit,
    /IVEKIT_COMPONENT_NODE_ENDPOINT:\s*http:\/\/127\.0\.0\.1:3210/
  );
  assert.doesNotMatch(
    liveKit,
    /^\s+networks:/m
  );
  assert.match(
    liveKit,
    /IVEKIT_COMPONENT_NODE_ID:\s*\$\{LIVEKIT_OWNER_NODE_ID:\?required\}/
  );
  assert.match(liveKit, /IVEKIT_OWNER_GUARD_REQUIRED:\s*["']1["']/);
  assert.match(
    liveKit,
    /livekit-component-node:\s*\n\s+condition:\s*service_healthy/
  );
  assert.match(
    liveKitOverride,
    /ivekit-owner-control:\s*\n\s+external:\s*true\s*\n\s+name:\s*ivekit-owner-control/
  );

  for (const service of [
    'cell-admission',
    'rustpbx-capacity-projector',
    'rustpbx-placement-snapshot-projector'
  ]) {
    const block = serviceBlock(cellOverride, service);
    assert.match(
      block,
      /image: \$\{IVEKIT_CAPACITY_TOOLS_IMAGE:\?immutable digest required\}/
    );
    assert.match(block, /build:\s*!reset\s+null/);
    if (service !== 'rustpbx-placement-snapshot-projector') {
      assert.match(block, /default:\s*\{\}/);
      assert.match(block, /ivekit-owner-control:\s*\{\}/);
    }
  }
  assert.match(
    cellOverride,
    /ivekit-owner-control:\s*\n\s+external:\s*true\s*\n\s+name:\s*ivekit-owner-control/
  );
  assert.doesNotMatch(cellOverride, /^  livekit:/m);

  for (const service of ['postgres-migrate', 'opc']) {
    const block = serviceBlock(apiOverride, service);
    assert.match(
      block,
      /image: \$\{IVEKIT_OPC_HOTFIX_IMAGE:\?exact hotfix image required\}/
    );
    assert.match(block, /build:\s*!reset\s+null/);
  }
  assert.match(
    serviceBlock(apiOverride, 'opc'),
    /OPC_IVEKIT_MEDIA_CALL_CREATE_ATTEMPT_LEASE_MS:\s*["']30000["']/
  );
  assert.match(opcDockerfile, /^ARG OPC_BASE_IMAGE$/m);
  assert.match(opcDockerfile, /^FROM \$\{OPC_BASE_IMAGE\}$/m);
  assert.match(
    opcDockerfile,
    /COPY src\/migrations\/106_ivekit_media_call_create_commands\.sql/
  );
  assert.match(
    opcDockerfile,
    /COPY src\/agent-runtime\/livekit\/media-call-create-command-store\.ts/
  );
  assert.doesNotMatch(opcDockerfile, /npm (?:ci|install)|COPY (?:src|sdk) \./);
  for (const label of [
    'io.ivekit.hotfix',
    'io.ivekit.hotfix.base-image-id',
    'io.ivekit.hotfix.base-payload-manifest-sha256',
    'io.ivekit.hotfix.payload-manifest-sha256',
    'io.ivekit.hotfix.patch-sha256',
    'io.ivekit.hotfix.payload-file-count'
  ]) {
    assert.match(opcDockerfile, new RegExp(escapeRegex(label)));
  }

  assert.match(
    envExample,
    /^IVEKIT_OPC_BASE_IMAGE=ivekit\/opc:im-final8-[a-f0-9]{12}$/m
  );
  assert.match(
    envExample,
    /^IVEKIT_OPC_HOTFIX_IMAGE=ivekit\/opc:production-media-20260730-[a-f0-9]{12}$/m
  );
  for (const name of [
    'IVEKIT_OPC_HOTFIX_IMAGE_ID',
    'IVEKIT_OPC_BASE_IMAGE_ID'
  ]) {
    assert.match(envExample, new RegExp(`^${name}=sha256:[a-f0-9]{64}$`, 'm'));
  }
  for (const name of [
    'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256',
    'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256',
    'IVEKIT_OPC_HOTFIX_PATCH_SHA256'
  ]) {
    assert.match(envExample, new RegExp(`^${name}=[a-f0-9]{64}$`, 'm'));
  }
  assert.match(
    envExample,
    /^LIVEKIT_SERVER_IMAGE=[^\s]+@sha256:[a-f0-9]{64}$/m
  );
  assert.match(
    envExample,
    /^IVEKIT_CAPACITY_TOOLS_IMAGE=[^\s]+@sha256:[a-f0-9]{64}$/m
  );
  assert.match(
    envExample,
    /^HOTFIX_NON_MTLS_EXPIRES_AT=replace_with_future_utc_at_most_72h$/m
  );
  assert.match(
    envExample,
    /^LIVEKIT_COMPONENT_NODE_DIMENSIONS_JSON=\{"video\.participants":\{"unit":"participants","safe_capacity":2,"used":0,"reserved":0\}\}$/m
  );
  assert.match(
    envExample,
    /^LIVEKIT_COMPONENT_NODE_JSON=.*"interaction_kinds":\["livekit_av"\].*"safe_capacity":2/m
  );
  assert.match(
    envExample,
    /^LIVEKIT_COMPONENT_NODE_PROBE_JSON=.*"component":"livekit".*"metric":"ivekit_component_node_capacity_used".*"safe_capacity":2/m
  );
  assert.doesNotMatch(envExample, /:latest(?:\s|$)/m);

  for (const expected of [
    'POST /api/ivekit/media/calls',
    'Retry-After',
    'livekit_av',
    'active/reserved/call = 0',
    '/livez` returns `200`',
    '/readyz` returns `503`',
    'cell-admission',
    'rustpbx-capacity-projector',
    'rustpbx-placement-snapshot-projector',
    'same Idempotency-Key',
    '106_ivekit_media_call_create_commands',
    'api-hotfix.override.yml',
    '--no-deps postgres-migrate',
    '--no-deps --no-build --force-recreate opc',
    'old source directory remains read-only',
    'freeze the resulting server release for several days',
    'restore placement topology before removing the Cell node',
    'remove `livekit-component-node` last',
    'Do not write `ivekit_runtime_heartbeats`',
    'same Docker host',
    '72 hours'
  ]) {
    assert.match(runbook, new RegExp(escapeRegex(expected), 'i'));
  }

  for (const expected of [
    'docker',
    'image',
    'inspect',
    'io.ivekit.owner-contract',
    'component-node-v1',
    'network',
    'config',
    '--format'
  ]) {
    assert.match(validatorSource, new RegExp(escapeRegex(expected)));
  }

  const validator = await import(pathToFileURL(validatorPath).href) as {
    validateHotfixEnv: (
      env: Record<string, string>,
      options: { now: Date }
    ) => { nodeId: string; expiresAt: string };
    validateLiveKitImageInspect: (
      inspect: unknown,
      expectedImage: string
    ) => void;
    validateInternalNetworkInspect: (
      inspect: unknown,
      expectedName: string
    ) => void;
    validateOpcHotfixImageInspect: (
      inspect: unknown,
      expected: {
        image: string;
        imageId: string;
        baseImageId: string;
        basePayloadManifestSha256: string;
        payloadManifestSha256: string;
        patchSha256: string;
        payloadFileCount: string;
      }
    ) => void;
    validateOpcBaseImageInspect: (
      inspect: unknown,
      expectedImage: string,
      expectedImageId: string
    ) => void;
  };
  const now = new Date('2026-07-30T12:00:00.000Z');
  const valid = validHotfixEnv();
  assert.deepEqual(validator.validateHotfixEnv(valid, { now }), {
    nodeId: 'livekit-node-a',
    expiresAt: '2026-08-01T12:00:00.000Z'
  });
  assert.throws(
    () => validator.validateHotfixEnv({
      ...valid,
      LIVEKIT_COMPONENT_NODE_DIMENSIONS_JSON:
        '{"video.participants":{"unit":"participants","safe_capacity":3,"used":0,"reserved":0}}'
    }, { now }),
    /safe capacity must be exactly 2/
  );
  assert.throws(
    () => validator.validateHotfixEnv({
      ...valid,
      HOTFIX_NON_MTLS_EXPIRES_AT: '2026-08-03T12:00:00.000Z'
    }, { now }),
    /within 72 hours/
  );
  assert.throws(
    () => validator.validateHotfixEnv({
      ...valid,
      LIVEKIT_SERVER_IMAGE: 'registry.example.invalid/ivekit/livekit:latest'
    }, { now }),
    /must match the retained server binary/
  );

  const liveKitDigest = valid.LIVEKIT_SERVER_IMAGE;
  validator.validateLiveKitImageInspect({
    Id: valid.LIVEKIT_SERVER_IMAGE_ID,
    RepoDigests: [liveKitDigest],
    Config: {
      Labels: {
        'io.ivekit.owner-contract': 'component-node-v1'
      }
    }
  }, liveKitDigest);
  assert.throws(
    () => validator.validateLiveKitImageInspect({
      Id: valid.LIVEKIT_SERVER_IMAGE_ID,
      RepoDigests: [liveKitDigest],
      Config: { Labels: {} }
    }, liveKitDigest),
    /owner contract label/
  );
  validator.validateInternalNetworkInspect(
    [{ Name: 'ivekit-owner-control', Internal: true }],
    'ivekit-owner-control'
  );
  assert.throws(
    () => validator.validateInternalNetworkInspect(
      [{ Name: 'ivekit-owner-control', Internal: false }],
      'ivekit-owner-control'
    ),
    /must be internal/
  );
  validator.validateOpcHotfixImageInspect({
    Id: valid.IVEKIT_OPC_HOTFIX_IMAGE_ID,
    RepoTags: [valid.IVEKIT_OPC_HOTFIX_IMAGE],
    Config: {
      Labels: {
        'io.ivekit.hotfix': 'production-media-20260730',
        'io.ivekit.hotfix.base-image-id': valid.IVEKIT_OPC_BASE_IMAGE_ID,
        'io.ivekit.hotfix.base-payload-manifest-sha256':
          valid.IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256,
        'io.ivekit.hotfix.payload-manifest-sha256':
          valid.IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256,
        'io.ivekit.hotfix.patch-sha256':
          valid.IVEKIT_OPC_HOTFIX_PATCH_SHA256,
        'io.ivekit.hotfix.payload-file-count':
          valid.IVEKIT_OPC_PAYLOAD_FILE_COUNT
      }
    }
  }, {
    image: valid.IVEKIT_OPC_HOTFIX_IMAGE,
    imageId: valid.IVEKIT_OPC_HOTFIX_IMAGE_ID,
    baseImageId: valid.IVEKIT_OPC_BASE_IMAGE_ID,
    basePayloadManifestSha256:
      valid.IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256,
    payloadManifestSha256:
      valid.IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256,
    patchSha256: valid.IVEKIT_OPC_HOTFIX_PATCH_SHA256,
    payloadFileCount: valid.IVEKIT_OPC_PAYLOAD_FILE_COUNT
  });
  validator.validateOpcBaseImageInspect({
    Id: valid.IVEKIT_OPC_BASE_IMAGE_ID,
    RepoTags: [valid.IVEKIT_OPC_BASE_IMAGE]
  }, valid.IVEKIT_OPC_BASE_IMAGE, valid.IVEKIT_OPC_BASE_IMAGE_ID);
});

test('Cell topology uses HTTPS while the public LiveKit client URL remains WSS', async () => {
  const validator = await import(pathToFileURL(validatorPath).href) as {
    validateHotfixEnv: (
      env: Record<string, string>,
      options: { now: Date }
    ) => { nodeId: string; expiresAt: string };
  };
  const valid = validHotfixEnv();
  const node = JSON.parse(valid.LIVEKIT_COMPONENT_NODE_JSON!) as {
    endpoint: string;
  };
  node.endpoint = 'https://livekit.example.com';
  valid.LIVEKIT_COMPONENT_NODE_JSON = JSON.stringify(node);
  valid.IVEKIT_CELL_NODES_JSON = JSON.stringify([node]);

  assert.doesNotThrow(() =>
    validator.validateHotfixEnv(valid, {
      now: new Date('2026-07-30T12:00:00.000Z')
    })
  );
  assert.equal(valid.LIVEKIT_PUBLIC_URL, 'wss://livekit.example.com');
  assert.match(
    readFileSync(envExamplePath, 'utf8'),
    /^LIVEKIT_COMPONENT_NODE_JSON=.*"endpoint":"https:\/\/livekit\.example\.com"/m
  );
});

function validHotfixEnv(): Record<string, string> {
  const liveKitImageId =
    'sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963';
  const capacityImageId =
    'sha256:83296c08de7b798cdb753527d216efd5b7dc1ef6ec8a05c1233f16a4f9feece3';
  const liveKitDigest = `ivekit/livekit-server@${liveKitImageId}`;
  const capacityDigest = `ivekit/opc@${capacityImageId}`;
  const dimensions = {
    'video.participants': {
      unit: 'participants',
      safe_capacity: 2,
      used: 0,
      reserved: 0
    }
  };
  const node = {
    node_id: 'livekit-node-a',
    endpoint: 'https://livekit.example.com',
    control_endpoint: 'http://livekit-component-node:3210',
    state: 'accepting',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['livekit_av'],
    dimensions
  };
  const probe = {
    component: 'livekit',
    instance_id: 'livekit-node-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'ivekit-cell-a',
    release_id: `livekit@${liveKitImageId}`,
    hardware_class: 'media-node',
    configuration_class: 'livekit-owner-hotfix-v1',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'c'.repeat(64),
    health_url: 'http://livekit-component-node:3210/operationalz',
    metrics_url: 'http://livekit-component-node:3210/metrics',
    drain_metric: 'ivekit_component_node_route_drain_active',
    dimensions: {
      'video.participants': {
        metric: 'ivekit_component_node_capacity_used',
        aggregation: 'sum',
        unit: 'participants',
        safe_capacity: 2,
        labels: { dimension: 'video.participants' }
      }
    }
  };
  return {
    IVEKIT_OPC_BASE_IMAGE: 'ivekit/opc:im-final8-3f1a7d3ab2f3',
    IVEKIT_OPC_HOTFIX_IMAGE:
      `ivekit/opc:production-media-20260730-${'d'.repeat(12)}`,
    IVEKIT_OPC_HOTFIX_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
    IVEKIT_OPC_BASE_IMAGE_ID:
      'sha256:530e6e3345c0801cfb0ed73b6356b43f78f97344696d12677d567711551484ea',
    IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256: 'f'.repeat(64),
    IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256: '2'.repeat(64),
    IVEKIT_OPC_HOTFIX_PATCH_SHA256: '1'.repeat(64),
    IVEKIT_OPC_PAYLOAD_FILE_COUNT: '13',
    IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_PATH:
      '/secure/base-payload.sha256',
    IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_PATH:
      '/secure/hotfix-payload.sha256',
    IVEKIT_OPC_HOTFIX_PATCH_PATH: '/secure/hotfix.patch',
    LIVEKIT_SERVER_IMAGE: liveKitDigest,
    LIVEKIT_SERVER_IMAGE_ID: liveKitImageId,
    IVEKIT_CAPACITY_TOOLS_IMAGE: capacityDigest,
    IVEKIT_CAPACITY_TOOLS_IMAGE_ID: capacityImageId,
    OPC_IVEKIT_COMPONENT_NODE_TOKEN:
      'test-only-component-node-token-32-bytes',
    LIVEKIT_OWNER_NODE_ID: 'livekit-node-a',
    LIVEKIT_COMPONENT_NODE_PROFILE_IDS: 'cell-10k-v1',
    LIVEKIT_COMPONENT_NODE_LOOPBACK_PORT: '3210',
    LIVEKIT_COMPONENT_NODE_CONTAINER_NAME:
      'opc-ivekit-media-livekit-component-node-1',
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
    IVEKIT_CELL_REGION_ID: 'region-a',
    IVEKIT_CELL_ZONE_ID: 'zone-a',
    IVEKIT_CELL_ID: 'ivekit-cell-a',
    IVEKIT_API_PROJECT_NAME: 'ivekit-goal3-0f9b063',
    IVEKIT_CELL_PROJECT_NAME: 'ivekit-goal3-0f9b063',
    IVEKIT_LIVEKIT_PROJECT_NAME: 'opc-ivekit-media',
    IVEKIT_OPC_CONTAINER_NAME: 'ivekit-goal3-0f9b063-opc-1',
    IVEKIT_CELL_CONTAINER_NAME:
      'ivekit-goal3-0f9b063-cell-admission-1',
    IVEKIT_LIVEKIT_CONTAINER_NAME: 'opc-ivekit-media-livekit-1',
    IVEKIT_API_COMPOSE_WORKING_DIR:
      '/opt/opc-ivekit-goal3/source-im-final2-625c2f973a1d/infra/ivekit',
    IVEKIT_CELL_COMPOSE_WORKING_DIR:
      '/opt/opc-ivekit-goal3/source-7edfcab-bundle/infra/ivekit',
    IVEKIT_LIVEKIT_COMPOSE_WORKING_DIR:
      '/opt/opc-ivekit-led/source/infra/livekit',
    IVEKIT_API_BASE_COMPOSE_PATH: '/retained/api/docker-compose.yml',
    IVEKIT_API_VOICE_COMPOSE_PATH:
      '/retained/api/docker-compose.voice.yml',
    IVEKIT_CELL_BASE_COMPOSE_PATH: '/retained/cell/docker-compose.yml',
    IVEKIT_CELL_VOICE_COMPOSE_PATH:
      '/retained/cell/docker-compose.voice.yml',
    IVEKIT_LIVEKIT_BASE_COMPOSE_PATH:
      '/retained/livekit/docker-compose.yml',
    IVEKIT_LIVEKIT_STORAGE_COMPOSE_PATH:
      '/retained/livekit/docker-compose.storage.yml',
    IVEKIT_API_BASE_COMPOSE_SHA256: '3'.repeat(64),
    IVEKIT_API_VOICE_COMPOSE_SHA256: '4'.repeat(64),
    IVEKIT_CELL_BASE_COMPOSE_SHA256: '5'.repeat(64),
    IVEKIT_CELL_VOICE_COMPOSE_SHA256: '6'.repeat(64),
    IVEKIT_LIVEKIT_BASE_COMPOSE_SHA256: '7'.repeat(64),
    IVEKIT_LIVEKIT_STORAGE_COMPOSE_SHA256: '8'.repeat(64),
    IVEKIT_HOTFIX_MIGRATION_GUARD_PATH:
      'scripts/run-production-media-hotfix-migration.ts',
    OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE: '1',
    OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE_RULE_ID:
      'production-media-20260730',
    OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_TENANT_IDS: '',
    OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_SUBJECTS: '',
    OPC_IVEKIT_MEDIA_CALL_CREATE_REQUIRE_PLACEMENT: '1',
    HOTFIX_NON_MTLS_EXPIRES_AT: '2026-08-01T12:00:00.000Z',
    LIVEKIT_COMPONENT_NODE_DIMENSIONS_JSON: JSON.stringify(dimensions),
    LIVEKIT_COMPONENT_NODE_JSON: JSON.stringify(node),
    LIVEKIT_COMPONENT_NODE_PROBE_JSON: JSON.stringify(probe),
    IVEKIT_CELL_INTERACTION_KINDS: 'sip_voice,tinode_im,livekit_av',
    IVEKIT_CELL_DIMENSIONS_JSON: JSON.stringify(dimensions),
    IVEKIT_CELL_NODES_JSON: JSON.stringify([node]),
    IVEKIT_CELL_CAPACITY_PROBES_JSON: JSON.stringify([probe]),
    OPC_IVEKIT_PLACEMENT_PROFILE_ID: 'cell-10k-v1',
    OPC_IVEKIT_PLACEMENT_MEDIA_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1',
      fixed_capacity: {},
      per_participant_capacity: { 'video.participants': 1 }
    }),
    OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON: JSON.stringify({
      regions: [{
        region_id: 'region-a',
        zones: [{
          zone_id: 'zone-a',
          state: 'accepting',
          cells: [{
            cell_id: 'ivekit-cell-a',
            routing_weight: 1,
            supported_interaction_kinds: ['sip_voice', 'tinode_im', 'livekit_av'],
            supported_profile_ids: ['cell-10k-v1'],
            admission_endpoint: 'http://cell-admission:3200'
          }]
        }]
      }]
    })
  };
}

function serviceBlock(source: string, service: string): string {
  return source.match(
    new RegExp(
      `^  ${escapeRegex(service)}:\\n` +
      '([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^networks:|(?![\\s\\S]))',
      'm'
    )
  )?.[0] || '';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
