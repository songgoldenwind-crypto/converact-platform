import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const sourceCompose = readFileSync('infra/converact/docker-compose.voice.yml', 'utf8');
const standaloneCompose = readFileSync(
  'services/converact-service/docker-compose.voice.yml',
  'utf8'
);
const envExamples = [
  readFileSync('infra/env.example', 'utf8'),
  readFileSync('infra/converact/env.example', 'utf8'),
  readFileSync('services/converact-service/env.example', 'utf8')
];
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
const rustPbxRecoveryPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-dialog-recovery.patch',
  'utf8'
);

interface ComposeService {
  profiles?: string[];
  depends_on?: string[] | Record<string, unknown>;
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

function assertProfileDependencyClosure(
  source: string,
  label: string,
  profile: string,
  roots: string[]
): void {
  const services = (parse(source) as ComposeDocument).services || {};
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const serviceName = pending.shift() as string;
    if (visited.has(serviceName)) continue;
    visited.add(serviceName);
    const service = services[serviceName];
    assert.ok(service, `${label}:${serviceName} must be defined`);
    assert.ok(
      !service.profiles || service.profiles.includes(profile),
      `${label}:${serviceName} must participate in ${profile}`
    );
    const dependencies = Array.isArray(service.depends_on)
      ? service.depends_on
      : Object.keys(service.depends_on || {});
    pending.push(...dependencies.filter((dependency) => services[dependency]));
  }
}

test('Compose co-locates a durable production dialog-shadow agent with each RustPBX owner', () => {
  for (const compose of [sourceCompose, standaloneCompose]) {
    assert.match(compose, /^  rustpbx-dialog-shadow:/m);
    assert.match(compose, /profiles: \["voice-t1"\]/);
    assert.match(compose, /network_mode: service:rustpbx/);
    assert.match(compose, /IVEKIT_DIALOG_SHADOW_PRODUCTION: "true"/);
    assert.match(compose, /IVEKIT_DIALOG_SHADOW_NODE_ID: \$\{RUSTPBX_OWNER_NODE_ID:/);
    assert.match(compose, /IVEKIT_DIALOG_SHADOW_JOURNAL_PATH: \/app\/dialog-shadow\/dialog-shadow\.wal/);
    assert.match(compose, /IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN_FILE: \/run\/secrets\/dialog-shadow-token/);
    assert.match(compose, /IVEKIT_DIALOG_SHADOW_TLS_KEY_FILE: \/run\/secrets\/dialog-shadow-server-key/);
    assert.match(compose, /IVEKIT_DIALOG_RECOVERY_DATABASE_URL_FILE: \/run\/secrets\/dialog-recovery-database-url/);
    assert.match(compose, /IVEKIT_DIALOG_TERMINAL_REPAIR_INTERVAL_MS: \$\{IVEKIT_DIALOG_TERMINAL_REPAIR_INTERVAL_MS:-1000\}/);
    assert.match(compose, /IVEKIT_DIALOG_TERMINAL_REPAIR_LEASE_TTL_MS: \$\{IVEKIT_DIALOG_TERMINAL_REPAIR_LEASE_TTL_MS:-10000\}/);
    assert.match(compose, /IVEKIT_DIALOG_TERMINAL_REPAIR_TENANT_BATCH_SIZE: \$\{IVEKIT_DIALOG_TERMINAL_REPAIR_TENANT_BATCH_SIZE:-32\}/);
    assert.match(compose, /IVEKIT_DIALOG_SHADOW_NATS_SERVER_FAULT_DOMAINS_FILE: \/run\/secrets\/dialog-shadow-nats-fault-domains/);
    assert.match(compose, /NATS_TLS_MODE: required/);
    assert.match(compose, /NATS_TLS_CA_FILE: \/run\/secrets\/dialog-shadow-nats-ca/);
    assert.match(compose, /- rustpbx-storage:\/app\/dialog-shadow/);
    assert.doesNotMatch(
      compose,
      /IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN:\s+\$\{/
    );
    assert.doesNotMatch(
      compose,
      /IVEKIT_DIALOG_RECOVERY_DATABASE_URL:\s+\$\{/
    );
  }

  assert.match(standaloneCompose, /^  rustpbx-b-dialog-shadow:/m);
  assert.match(standaloneCompose, /network_mode: service:rustpbx-b/);
  assert.match(
    standaloneCompose,
    /IVEKIT_DIALOG_SHADOW_NODE_ID: \$\{RUSTPBX_OWNER_NODE_ID_B:/
  );
  assert.match(
    standaloneCompose,
    /- rustpbx-b-storage:\/app\/dialog-shadow/
  );
});

test('terminal shadow repair tuning is explicit in every supported environment surface', () => {
  for (const example of envExamples) {
    assert.match(example, /^IVEKIT_DIALOG_TERMINAL_REPAIR_INTERVAL_MS=1000$/m);
    assert.match(example, /^IVEKIT_DIALOG_TERMINAL_REPAIR_LEASE_TTL_MS=10000$/m);
    assert.match(example, /^IVEKIT_DIALOG_TERMINAL_REPAIR_TENANT_BATCH_SIZE=32$/m);
  }
});

test('Compose enables RustPBX recovery only through mounted mTLS and rotation secrets', () => {
  for (const compose of [sourceCompose, standaloneCompose]) {
    assert.match(
      compose,
      /IVEKIT_RUSTPBX_DIALOG_SHADOW_ENDPOINT: \$\{RUSTPBX_DIALOG_SHADOW_ENDPOINT:/
    );
    assert.match(
      compose,
      /IVEKIT_RUSTPBX_DIALOG_SHADOW_TOKEN_FILE: \/run\/secrets\/dialog-shadow-token/
    );
    assert.match(
      compose,
      /IVEKIT_RUSTPBX_DIALOG_SHADOW_TLS_IDENTITY_FILE: \/run\/secrets\/dialog-shadow-client-identity/
    );
    assert.match(
      compose,
      /IVEKIT_RUSTPBX_DIALOG_RECOVERY_CURRENT_KEY_FILE: \/run\/secrets\/dialog-recovery-current-key/
    );
    assert.match(
      compose,
      /IVEKIT_RUSTPBX_DIALOG_RECOVERY_PREVIOUS_KEY_FILE: \/run\/secrets\/dialog-recovery-previous-key/
    );
    assert.match(compose, /IVEKIT_RUSTPBX_FAULT_DOMAIN: \$\{RUSTPBX_FAULT_DOMAIN:/);
    assert.match(compose, /- dialog-shadow-client-identity/);
    assert.match(compose, /- dialog-recovery-current-key/);
    assert.match(compose, /- dialog-recovery-previous-key/);
  }
});

test('voice-t1 Compose profile closes every local RustPBX dependency chain', () => {
  assertProfileDependencyClosure(
    sourceCompose,
    'source',
    'voice-t1',
    ['rustpbx-dialog-shadow']
  );
  assertProfileDependencyClosure(
    standaloneCompose,
    'standalone',
    'voice-t1',
    ['rustpbx-dialog-shadow', 'rustpbx-b-dialog-shadow']
  );
});

test('RustPBX accepts group-readable projected secrets without accepting group writes or world access', () => {
  assert.match(helmRustPbx, /defaultMode: 0440/);
  assert.match(
    rustPbxRecoveryPatch,
    /fn production_secret_mode_is_safe\(mode: u32\) -> bool/
  );
  assert.match(
    rustPbxRecoveryPatch,
    /mode & 0o400 != 0 && mode & 0o7137 == 0/
  );
  assert.match(
    rustPbxRecoveryPatch,
    /fn secret_file_metadata\(/
  );
  assert.equal(
    [...rustPbxRecoveryPatch.matchAll(/!production_secret_mode_is_safe\(/g)].length,
    2
  );
  assert.doesNotMatch(
    rustPbxRecoveryPatch,
    /^\+\s*if mode & 0o077 != 0/m
  );
});

test('Helm makes dialog recovery a fail-closed node-local sidecar contract', () => {
  assert.match(helmValues, /^  dialogShadow:\n    enabled: false/m);
  assert.match(helmValues, /serviceTokenKey: ivekit-dialog-shadow-token/);
  assert.match(helmValues, /recoveryDatabaseUrlKey: ivekit-dialog-recovery-database-url/);
  assert.match(helmValues, /serverTlsSecretName: ""/);
  assert.match(helmValues, /clientIdentity:\n      identityFile: identity\.pem/);
  assert.match(helmValues, /csi:\n        driver: ""/);
  assert.match(helmValues, /nats:\n      urls: \[\]/);
  assert.match(helmValues, /tlsSecretName: ""/);
  assert.match(helmValues, /faultDomainsSecretName: ""/);
  assert.match(helmValues, /terminalRepairIntervalMs: "1000"/);
  assert.match(helmValues, /terminalRepairLeaseTtlMs: "10000"/);
  assert.match(helmValues, /terminalRepairTenantBatchSize: "32"/);

  assert.match(
    helmRustPbx,
    /voice\.dialogShadow\.serverTlsSecretName is required/
  );
  assert.match(
    helmRustPbx,
    /voice\.dialogShadow\.clientIdentity\.csi\.driver is required/
  );
  assert.match(
    helmRustPbx,
    /voice\.dialogShadow\.nats\.tlsSecretName is required/
  );
  assert.match(helmRustPbx, /- name: dialog-shadow-agent/);
  assert.match(helmRustPbx, /command: \["node", "dist\/converact-dialog-shadow-agent\.js"\]/);
  assert.match(helmRustPbx, /fieldPath: metadata\.name/);
  assert.match(helmRustPbx, /IVEKIT_DIALOG_SHADOW_PRODUCTION/);
  assert.match(helmRustPbx, /IVEKIT_DIALOG_SHADOW_SPIFFE_TRUST_DOMAIN/);
  assert.match(helmRustPbx, /IVEKIT_DIALOG_RECOVERY_DATABASE_URL_FILE/);
  assert.match(
    helmRustPbx,
    /IVEKIT_DIALOG_TERMINAL_REPAIR_INTERVAL_MS[\s\S]*voice\.dialogShadow\.recovery\.terminalRepairIntervalMs/
  );
  assert.match(
    helmRustPbx,
    /IVEKIT_DIALOG_TERMINAL_REPAIR_LEASE_TTL_MS[\s\S]*voice\.dialogShadow\.recovery\.terminalRepairLeaseTtlMs/
  );
  assert.match(
    helmRustPbx,
    /IVEKIT_DIALOG_TERMINAL_REPAIR_TENANT_BATCH_SIZE[\s\S]*voice\.dialogShadow\.recovery\.terminalRepairTenantBatchSize/
  );
  assert.match(helmRustPbx, /IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_CLUSTER/);
  assert.match(helmRustPbx, /IVEKIT_RUSTPBX_DIALOG_SHADOW_ENDPOINT/);
  assert.match(helmRustPbx, /IVEKIT_RUSTPBX_DIALOG_SHADOW_TLS_IDENTITY_FILE/);
  assert.match(helmRustPbx, /mountPath: \/app\/dialog-shadow/);
  assert.match(helmRustPbx, /mountPath: \/run\/dialog-shadow-server-tls/);
  assert.match(helmRustPbx, /mountPath: \/run\/dialog-shadow-client-tls/);
  assert.match(helmRustPbx, /mountPath: \/run\/dialog-shadow-nats-tls/);
  assert.match(helmRustPbx, /driver: \{\{ \.Values\.voice\.dialogShadow\.clientIdentity\.csi\.driver/);
  assert.match(helmRustPbx, /volumeAttributes:/);
  assert.doesNotMatch(helmRustPbx, /containerPort: 3212/);
});

test('legacy Helm entrypoint carries the same fail-closed T1 recovery contract', () => {
  assert.match(legacyHelmValues, /^  dialogShadow:\n    enabled: false/m);
  assert.match(legacyHelmValues, /terminalRepairIntervalMs: "1000"/);
  assert.match(legacyHelmValues, /terminalRepairLeaseTtlMs: "10000"/);
  assert.match(legacyHelmValues, /terminalRepairTenantBatchSize: "32"/);
  assert.match(
    legacyHelmRustPbx,
    /voice\.dialogShadow\.serverTlsSecretName is required/
  );
  assert.match(
    legacyHelmRustPbx,
    /voice\.dialogShadow\.clientIdentity\.csi\.driver is required/
  );
  assert.match(
    legacyHelmRustPbx,
    /voice\.dialogShadow\.nats\.tlsSecretName is required/
  );
  assert.match(legacyHelmRustPbx, /- name: dialog-shadow-agent/);
  assert.match(
    legacyHelmRustPbx,
    /command: \["node", "dist\/converact-dialog-shadow-agent\.js"\]/
  );
  assert.match(legacyHelmRustPbx, /IVEKIT_DIALOG_RECOVERY_DATABASE_URL_FILE/);
  assert.match(legacyHelmRustPbx, /IVEKIT_DIALOG_TERMINAL_REPAIR_INTERVAL_MS/);
  assert.match(legacyHelmRustPbx, /IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_CLUSTER/);
  assert.match(legacyHelmRustPbx, /IVEKIT_RUSTPBX_DIALOG_SHADOW_ENDPOINT/);
  assert.match(
    legacyHelmRustPbx,
    /IVEKIT_RUSTPBX_DIALOG_SHADOW_TLS_IDENTITY_FILE/
  );
  assert.match(legacyHelmRustPbx, /mountPath: \/app\/dialog-shadow/);
  assert.match(legacyHelmRustPbx, /mountPath: \/run\/dialog-shadow-server-tls/);
  assert.match(legacyHelmRustPbx, /mountPath: \/run\/dialog-shadow-client-tls/);
  assert.match(legacyHelmRustPbx, /mountPath: \/run\/dialog-shadow-nats-tls/);
  assert.doesNotMatch(legacyHelmRustPbx, /containerPort: 3212/);
});
