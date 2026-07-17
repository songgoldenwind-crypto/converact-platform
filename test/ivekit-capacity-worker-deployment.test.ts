import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('capacity tools image and package expose the restart-safe worker process', () => {
  const dockerfile = readFileSync('infra/capacity/Dockerfile', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const runtimePackage = JSON.parse(
    readFileSync('infra/capacity/package.json', 'utf8')
  );

  assert.match(
    dockerfile,
    /COPY infra\/capacity\/package\.json infra\/capacity\/package-lock\.json/i
  );
  assert.match(dockerfile, /COPY scripts\/ivekit-capacity-worker\.ts/i);
  assert.match(dockerfile, /COPY scripts\/ivekit-capacity-controller\.ts/i);
  assert.match(dockerfile, /COPY scripts\/ivekit-capacity-finalizer\.ts/i);
  assert.match(dockerfile, /COPY scripts\/ivekit-capacity-scaling-finalizer\.ts/i);
  assert.match(dockerfile, /COPY scripts\/ivekit-capacity-platform-finalizer\.ts/i);
  assert.match(dockerfile, /COPY infra\/capacity\/tsconfig\.json/i);
  assert.match(
    dockerfile,
    /COPY src\/agent-runtime\/ivekit\/placement\/pg-queryable\.ts/i
  );
  assert.doesNotMatch(dockerfile, /COPY src\/db-pg\.ts/i);
  assert.doesNotMatch(
    dockerfile,
    /COPY src\/agent-runtime\/ivekit\/placement \.\/src\/agent-runtime\/ivekit\/placement/i
  );
  assert.match(
    dockerfile,
    /RUN \.\/node_modules\/\.bin\/tsc --noEmit -p infra\/capacity\/tsconfig\.json/i
  );
  assert.match(
    String(packageJson.scripts['ivekit:capacity:worker']),
    /ivekit-capacity-worker\.ts/
  );
  assert.match(
    String(packageJson.scripts['ivekit:capacity:controller']),
    /ivekit-capacity-controller\.ts/
  );
  assert.match(
    String(packageJson.scripts['ivekit:capacity:finalizer']),
    /ivekit-capacity-finalizer\.ts/
  );
  assert.match(
    String(packageJson.scripts['ivekit:capacity:scaling-finalizer']),
    /ivekit-capacity-scaling-finalizer\.ts/
  );
  assert.match(
    String(packageJson.scripts['ivekit:capacity:platform-finalizer']),
    /ivekit-capacity-platform-finalizer\.ts/
  );
  assert.match(
    String(packageJson.scripts['typecheck:ivekit:capacity-runtime']),
    /infra\/capacity\/tsconfig\.json/
  );
  assert.deepEqual(
    Object.keys(runtimePackage.dependencies).sort(),
    ['@aws-sdk/client-s3', 'nats', 'pg', 'tsx', 'ws']
  );
  assert.match(dockerfile, /npm prune --omit=dev --ignore-scripts/i);
});

test('capacity finalizer is a retryable one-shot job with immutable evidence inputs', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/finalizer-job.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: Job/i);
  assert.match(yaml, /backoffLimit: 10/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_EVIDENCE_SUBMISSION_PATH/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_EVIDENCE_S3_BUCKET/i);
  assert.match(yaml, /readOnly: true/i);
});

test('capacity scaling finalizer mounts immutable contract inputs and verifies S3 run evidence', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/scaling-finalizer-job.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: Job/i);
  assert.match(yaml, /ivekit-capacity-scaling-finalizer\.ts/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_SCALING_CONTRACT_PATH/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_SCALING_SUBMISSION_PATH/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_EVIDENCE_S3_BUCKET/i);
  assert.match(yaml, /readOnly: true/i);
});

test('capacity platform finalizer mounts the full release gate and verified source evidence', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/platform-finalizer-job.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: Job/i);
  assert.match(yaml, /ivekit-capacity-platform-finalizer\.ts/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_PLATFORM_CONTRACT_PATH/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_PLATFORM_SUBMISSION_PATH/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_EVIDENCE_S3_BUCKET/i);
  assert.match(yaml, /readOnly: true/i);
});

test('capacity worker deployment uses stable identity, one in-flight shard and durable evidence', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/worker-statefulset.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: StatefulSet/i);
  assert.match(yaml, /fieldPath: metadata\.name/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_DRIVER_SPEC_PATH/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_EVIDENCE_S3_BUCKET/i);
  assert.match(yaml, /readOnlyRootFilesystem: true/i);
  assert.match(yaml, /emptyDir:[\s\S]*sizeLimit: 20Gi/i);
  assert.doesNotMatch(yaml, /hostNetwork:\s*true/i);
});

test('capacity controller deployment uses two fenced replicas and an immutable manifest volume', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/controller-deployment.yaml',
    'utf8'
  );

  assert.match(yaml, /replicas: 2/i);
  assert.match(yaml, /fieldPath: metadata\.name/i);
  assert.match(yaml, /OPC_IVEKIT_CAPACITY_MANIFEST_PATH/i);
  assert.match(yaml, /persistentVolumeClaim:[\s\S]*ivekit-capacity-manifests/i);
  assert.match(yaml, /minAvailable: 1/i);
});

test('LiveKit Cell deployment uses stable owner identity and a local admission sidecar', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/livekit-statefulset.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: StatefulSet/i);
  assert.match(yaml, /podManagementPolicy: Parallel/i);
  assert.match(yaml, /IVEKIT_COMPONENT_NODE_ENDPOINT[\s\S]*127\.0\.0\.1:3210/i);
  assert.match(yaml, /IVEKIT_OWNER_GUARD_REQUIRED[\s\S]*"1"/i);
  assert.match(yaml, /IVEKIT_COMPONENT_NODE_ID[\s\S]*fieldPath: metadata\.name/i);
  assert.match(yaml, /OPC_IVEKIT_COMPONENT_NODE_ID[\s\S]*fieldPath: metadata\.name/i);
  assert.match(yaml, /component-node-admission/i);
  assert.match(yaml, /kind: PodDisruptionBudget/i);
  assert.doesNotMatch(yaml, /hostNetwork:\s*true/i);
});

test('Tinode Cell deployment uses a three-node stable cluster and local owner sidecars', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/tinode-statefulset.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: StatefulSet/i);
  assert.match(yaml, /replicas: 3/i);
  assert.match(yaml, /publishNotReadyAddresses: true/i);
  assert.match(yaml, /name: cluster[\s\S]*containerPort: 12000/i);
  assert.match(yaml, /IVEKIT_COMPONENT_NODE_ENDPOINT[\s\S]*127\.0\.0\.1:3210/i);
  assert.match(yaml, /IVEKIT_COMPONENT_NODE_ID[\s\S]*fieldPath: metadata\.name/i);
  assert.match(yaml, /OPC_IVEKIT_COMPONENT_NODE_ID[\s\S]*fieldPath: metadata\.name/i);
  assert.match(yaml, /IVEKIT_TINODE_OWNER_API_TOKEN/i);
  assert.match(yaml, /minAvailable: 2/i);
  assert.doesNotMatch(yaml, /hostNetwork:\s*true/i);
});

test('RustDesk Cell deployment keeps each hbbs and hbbr pair on one stable owner ordinal', () => {
  const yaml = readFileSync(
    'infra/capacity/kubernetes/rustdesk-statefulset.yaml',
    'utf8'
  );

  assert.match(yaml, /kind: StatefulSet/i);
  assert.match(yaml, /podManagementPolicy: Parallel/i);
  assert.match(yaml, /name: hbbs[\s\S]*name: hbbr/i);
  assert.match(yaml, /IVEKIT_COMPONENT_NODE_ID[\s\S]*fieldPath: metadata\.name/i);
  assert.match(yaml, /OPC_IVEKIT_COMPONENT_NODE_ID[\s\S]*fieldPath: metadata\.name/i);
  assert.match(yaml, /IVEKIT_RUSTDESK_OWNER_BINDING_ENDPOINT[\s\S]*127\.0\.0\.1:3211/i);
  assert.match(yaml, /ivekit-rustdesk-owner-binding\.ts/i);
  assert.match(yaml, /volumeClaimTemplates:[\s\S]*ReadWriteOnce/i);
  assert.match(yaml, /minAvailable: 1/i);
  assert.doesNotMatch(yaml, /type:\s*LoadBalancer/i);
  assert.doesNotMatch(yaml, /hostNetwork:\s*true/i);
});

test('controlled Compose worker is opt-in and mounts an immutable driver bundle read-only', () => {
  const compose = readFileSync('infra/capacity/docker-compose.yml', 'utf8');

  assert.match(compose, /capacity-worker:[\s\S]*profiles: \["worker"\]/i);
  assert.match(
    compose,
    /OPC_IVEKIT_CAPACITY_WORKER_BUNDLE_HOST_PATH[\s\S]*\/opt\/ivekit-capacity-worker:ro/i
  );
  assert.match(compose, /scripts\/ivekit-capacity-worker\.ts/i);
});
