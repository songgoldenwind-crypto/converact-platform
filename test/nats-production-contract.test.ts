import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync('infra/docker-compose.production.yml', 'utf8');
const composeConfig = readFileSync('infra/config/nats.conf', 'utf8');
const statefulSet = readFileSync('infra/k8s/templates/nats-statefulset.yaml', 'utf8');
const networkPolicy = readFileSync('infra/k8s/templates/nats-network-policy.yaml', 'utf8');
const values = readFileSync('infra/k8s/values.yaml', 'utf8');
const opcDeployment = readFileSync('infra/k8s/templates/opc-deployment.yaml', 'utf8');

test('production Compose pins and authenticates NATS without publishing client or monitor ports', () => {
  const nats = serviceBlock(compose, 'nats');

  assert.match(nats, /image: \$\{CONVERACT_NATS_IMAGE:\?CONVERACT_NATS_IMAGE immutable digest reference is required\}/);
  assert.match(nats, /command: \["-c", "\/etc\/nats\/nats\.conf"\]/);
  assert.match(nats, /NATS_CLIENT_USER: \$\{NATS_USER:\?NATS_USER is required\}/);
  assert.match(nats, /NATS_CLIENT_PASSWORD: \$\{NATS_PASSWORD:\?NATS_PASSWORD is required\}/);
  assert.match(nats, /\.\/config\/nats\.conf:\/etc\/nats\/nats\.conf:ro/);
  assert.match(nats, /http:\/\/127\.0\.0\.1:8222\/healthz\?js-enabled-only=true/);
  assert.doesNotMatch(nats, /\n\s+ports:/);

  assert.match(composeConfig, /authorization\s*\{/);
  assert.match(composeConfig, /user:\s*\$NATS_CLIENT_USER/);
  assert.match(composeConfig, /password:\s*\$NATS_CLIENT_PASSWORD/);
  assert.match(composeConfig, /max_memory_store:\s*256MB/);
  assert.match(composeConfig, /max_file_store:\s*1GB/);

  const opc = serviceBlock(compose, 'opc');
  assert.match(opc, /NATS_USER: \$\{NATS_USER:\?NATS_USER is required\}/);
  assert.match(opc, /NATS_PASSWORD: \$\{NATS_PASSWORD:\?NATS_PASSWORD is required\}/);
  assert.match(opc, /NATS_TLS_MODE: disabled/);
});

test('Kubernetes NATS is a three-node authenticated TLS JetStream quorum', () => {
  assert.match(values, /^  replicaCount: 3$/m);
  assert.match(values, /^  maxMemoryStore: 2GB$/m);
  assert.match(values, /^  maxFileStore: 100GB$/m);
  assert.match(values, /^    existingSecret: ""$/m);
  assert.match(values, /^    enabled: true$/m);
  assert.match(values, /^    secretName: ""$/m);

  assert.match(statefulSet, /kind: StatefulSet/);
  assert.match(statefulSet, /replicas: \{\{ \.Values\.nats\.replicaCount \}\}/);
  assert.match(statefulSet, /podManagementPolicy: Parallel/);
  assert.match(statefulSet, /server_name: \$POD_NAME/);
  assert.match(statefulSet, /cluster\s*\{/);
  assert.match(statefulSet, /listen: 0\.0\.0\.0:6222/);
  assert.match(statefulSet, /routes:\s*\[/);
  assert.match(statefulSet, /authorization\s*\{/);
  assert.match(statefulSet, /jetstream\s*\{/);
  assert.match(statefulSet, /max_memory_store: \{\{ \.Values\.nats\.maxMemoryStore \}\}/);
  assert.match(statefulSet, /max_file_store: \{\{ \.Values\.nats\.maxFileStore \}\}/);
  assert.match(statefulSet, /name: cluster\n\s+containerPort: 6222/);
  assert.match(statefulSet, /healthz\?js-enabled-only=true/);
  assert.match(statefulSet, /kind: PodDisruptionBudget/);
  assert.match(statefulSet, /minAvailable: \{\{ add \(div \(int \.Values\.nats\.replicaCount\) 2\) 1 \}\}/);
  assert.match(statefulSet, /topologySpreadConstraints:/);
  assert.match(statefulSet, /podAntiAffinity:/);
  assert.match(statefulSet, /volumeClaimTemplates:/);
  assert.match(statefulSet, /NATS_CLIENT_PASSWORD[\s\S]*secretKeyRef:/);
  assert.match(statefulSet, /NATS_ROUTE_PASSWORD[\s\S]*secretKeyRef:/);
  assert.match(statefulSet, /mountPath: \/etc\/nats\/tls/);

  assert.match(networkPolicy, /kind: NetworkPolicy/);
  assert.match(networkPolicy, /port: 4222/);
  assert.match(networkPolicy, /port: 6222/);
  assert.match(networkPolicy, /port: 8222/);
  assert.doesNotMatch(networkPolicy, /0\.0\.0\.0\/0/);
});

test('Kubernetes application clients receive secret auth and verified TLS settings', () => {
  for (const name of [
    'NATS_USER',
    'NATS_PASSWORD',
    'NATS_TLS_MODE',
    'NATS_TLS_CA_FILE'
  ]) assert.match(opcDeployment, new RegExp(`- name: ${name}`));
  assert.match(opcDeployment, /value: tls:\/\/\{\{ \.Release\.Name \}\}-nats:4222/);
  assert.match(opcDeployment, /mountPath: \/etc\/nats\/tls/);
  assert.match(opcDeployment, /readOnly: true/);
});

function serviceBlock(source: string, name: string): string {
  return source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|^volumes:)`, 'm'))?.[0] || '';
}
