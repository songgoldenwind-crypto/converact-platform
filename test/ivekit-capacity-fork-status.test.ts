import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

interface ForkComponent {
  component_id: string;
  lifecycle: string;
  protocols?: Array<{ protocol_id: string; version: string }>;
  upstream?: {
    version?: string;
    release_ref?: string;
    commit?: string;
    source_identity_complete?: boolean;
  };
  runtime_artifact: {
    reference?: string;
    kind: string;
    contains_declared_modifications: boolean;
  };
  patches?: Array<{ path: string; sha256: string }>;
  implemented_changes?: Array<{ change_id: string }>;
  planned_changes?: Array<{ change_id: string }>;
  verification: {
    patch_apply?: string;
    compile?: string;
    unit: string;
    integration: string;
    benchmark?: string;
    real_environment?: string;
    evidence_paths?: string[];
  };
  release_gate: {
    production_eligible: boolean;
    blocking_reasons: string[];
  };
}

const manifest = JSON.parse(
  readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
) as { components: ForkComponent[] };

test('fork manifest satisfies its complete JSON schema', () => {
  const schema = JSON.parse(
    readFileSync('docs/capacity/schemas/fork-manifest.schema.json', 'utf8')
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => !Number.isNaN(Date.parse(value))
  });
  ajv.addFormat('uri', {
    type: 'string',
    validate: (value: string) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }
  });
  const validate = ajv.compile(schema);

  assert.equal(
    validate(manifest),
    true,
    ajv.errorsText(validate.errors, { separator: '\n' })
  );
});

test('fork runtime artifact records stay inside the declared JSON schema', () => {
  const schema = JSON.parse(
    readFileSync('docs/capacity/schemas/fork-manifest.schema.json', 'utf8')
  ) as {
    $defs: {
      runtime_artifact: {
        properties: Record<string, unknown>;
        required: string[];
      };
    };
  };
  const definition = schema.$defs.runtime_artifact;
  const allowed = new Set(Object.keys(definition.properties));
  const kinds = new Set(
    ((definition.properties.kind as { enum?: string[] }).enum || [])
  );

  for (const component of manifest.components) {
    const artifact = component.runtime_artifact;
    if (!artifact) continue;
    for (const field of Object.keys(artifact)) {
      assert.equal(allowed.has(field), true, `${component.component_id}: ${field}`);
    }
    for (const field of definition.required) {
      assert.equal(field in artifact, true, `${component.component_id}: ${field}`);
    }
    assert.equal(
      kinds.has(artifact.kind),
      true,
      `${component.component_id}: ${artifact.kind}`
    );
  }
});

test('fork manifest patch paths exist and match their declared SHA-256', () => {
  for (const component of manifest.components) {
    for (const patch of component.patches || []) {
      assert.equal(existsSync(patch.path), true, `${component.component_id}: ${patch.path}`);
      assert.equal(
        createHash('sha256').update(readFileSync(patch.path)).digest('hex'),
        patch.sha256,
        `${component.component_id}: ${patch.path}`
      );
    }
  }
});

test('HOMER fork status records controlled PostgreSQL/HEP evidence without claiming production capacity', () => {
  const homer = manifest.components.find((component) => component.component_id === 'homer');
  assert.ok(homer);

  assert.equal(
    homer.upstream?.commit,
    'ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b'
  );
  assert.equal(homer.upstream?.source_identity_complete, true);
  assert.equal(homer.runtime_artifact.reference, 'ivekit/homer:11.0.297-ivekit.2-ac4e1ae7');
  assert.equal(homer.runtime_artifact.kind, 'custom_candidate');
  assert.equal(homer.runtime_artifact.contains_declared_modifications, true);
  assert.ok(
    homer.implemented_changes?.some(
      (change) => change.change_id === 'homer-postgres-ducklake-catalog-v1'
    )
  );
  assert.ok(
    homer.implemented_changes?.some(
      (change) => change.change_id === 'homer-cell-local-fail-open-deployment-v1'
    )
  );
  assert.ok(
    homer.implemented_changes?.some(
      (change) => change.change_id === 'homer-hep-ab-and-maintenance-acceptance-v1'
    )
  );
  assert.equal(homer.verification.patch_apply, 'passed');
  assert.equal(homer.verification.compile, 'passed');
  assert.equal(homer.verification.unit, 'passed');
  assert.equal(homer.verification.integration, 'passed');
  assert.equal(homer.verification.benchmark, 'not_run');
  assert.equal(homer.verification.real_environment, 'not_run');
  for (const path of [
    'docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.json',
    'docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.md',
    'docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.json',
    'docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.md',
    'docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.json',
    'docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.md'
  ]) {
    assert.ok(homer.verification.evidence_paths?.includes(path), path);
  }
  assert.equal(homer.release_gate.production_eligible, false);
  assert.ok(
    homer.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('immutable registry digest') &&
        reason.includes('SBOM') &&
        reason.includes('Cosign')
    )
  );
  assert.ok(
    homer.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('live trace disable') &&
        reason.includes('Cell-10K')
    )
  );
  assert.equal(
    homer.release_gate.blocking_reasons.some(
      (reason) => reason.includes('HEP enabled/disabled same-hardware performance A/B')
    ),
    false
  );
});

test('RustPBX fork manifest tracks the complete ivekit.21 patch queue', () => {
  const rustpbx = manifest.components.find((component) => component.component_id === 'rustpbx');
  assert.ok(rustpbx);

  const expectedReference = 'ivekit/rustpbx:0.4.11-ivekit.21-6c49ee76';
  assert.equal(rustpbx.runtime_artifact.reference, expectedReference);
  for (const path of [
    'infra/ivekit/rustpbx/patches/rustpbx-local-rustrtc.patch',
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-callrecord-database-policy.patch',
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-callrecord-runtime-isolation.patch',
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-callrecord-failure-telemetry.patch',
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-webphone-edge-auth.patch',
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-realtime-audio-tap.patch',
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-http-client-capacity.patch'
  ]) {
    assert.ok(rustpbx.patches?.some((patch) => patch.path === path), path);
  }
  for (const changeId of [
    'rustpbx-rustrtc-udp-socket-capacity-v1',
    'rustpbx-callrecord-database-policy-v1',
    'rustpbx-callrecord-runtime-isolation-v1',
    'rustpbx-callrecord-failure-telemetry-v1',
    'rustpbx-webphone-edge-auth-v1',
    'rustpbx-realtime-audio-tap-v1',
    'rustpbx-http-client-capacity-v1'
  ]) {
    assert.ok(
      rustpbx.implemented_changes?.some((change) => change.change_id === changeId),
      changeId
    );
  }
});

test('rustrtc fork manifest pins the UDP socket-capacity patch', () => {
  const rustrtc = manifest.components.find(
    (component) => component.component_id === 'rustrtc'
  );
  assert.ok(rustrtc);
  assert.equal(
    rustrtc.upstream.commit,
    '166c6d22984429eb6b509920c14fcd69f974f0b3'
  );
  assert.ok(
    rustrtc.patches?.some(
      (patch) => patch.path ===
        'infra/ivekit/rustpbx/patches/rustrtc-ivekit-udp-socket-capacity.patch'
    )
  );
  assert.ok(
    rustrtc.implemented_changes?.some(
      (change) => change.change_id === 'rustrtc-udp-socket-capacity-v1'
    )
  );
  assert.equal(rustrtc.verification.compile, 'passed');
  assert.equal(rustrtc.verification.integration, 'passed');
  assert.equal(rustrtc.verification.benchmark, 'partial');
  for (const evidencePath of [
    'docs/evidence/wave3-rustpbx-ivekit19-image-inspect-2026-07-24.json',
    'docs/evidence/wave3-rustpbx-udp-socket-host-observation-2026-07-24.txt',
    'docs/evidence/wave3-rustpbx-rtp-throughput-600-800-ivekit19-2026-07-24.json',
    'docs/evidence/wave3-rustpbx-rtp-throughput-900-mixed-ivekit19-2026-07-24.json'
  ]) {
    assert.ok(
      rustrtc.verification.evidence_paths?.includes(evidencePath),
      evidencePath
    );
  }
  assert.equal(rustrtc.release_gate.production_eligible, false);
});

test('Tinode fork status records native mutation and exact-release owner overlay truthfully', () => {
  const tinode = manifest.components.find((component) => component.component_id === 'tinode-server');
  assert.ok(tinode);

  assert.equal(tinode.lifecycle, 'active_engineering');
  assert.ok(
    tinode.implemented_changes?.some((change) => change.change_id === 'tinode-native-mutation-v1')
  );
  assert.equal(
    tinode.planned_changes?.some((change) => change.change_id === 'tinode-native-mutation-v1'),
    false
  );
  assert.ok(
    tinode.implemented_changes?.some(
      (change) => change.change_id === 'tinode-cell-topic-owner-v1'
    )
  );
  assert.equal(
    tinode.planned_changes?.some(
      (change) => change.change_id === 'tinode-cell-topic-owner-v1'
    ),
    false
  );
  assert.equal(
    tinode.upstream?.commit,
    '22a7c18e9cd695e9a061bf1b8c84175196ef5a15'
  );
  assert.equal(tinode.upstream?.source_identity_complete, true);
  assert.equal(tinode.verification.patch_apply, 'passed');
  assert.equal(tinode.verification.compile, 'passed');
  assert.equal(tinode.verification.unit, 'passed');
  assert.equal(tinode.verification.integration, 'partial');
  assert.equal(tinode.verification.benchmark, 'partial');
  assert.ok(
    tinode.implemented_changes?.some(
      (change) => change.change_id === 'tinode-session-fanout-hot-path-v1'
    )
  );
  assert.ok(
    tinode.implemented_changes?.some(
      (change) => change.change_id === 'tinode-three-node-cluster-runtime-v1'
    )
  );
  assert.ok(
    tinode.verification.evidence_paths?.includes(
      'infra/ivekit/tinode/apply-overlay.mjs'
    )
  );
  assert.ok(
    tinode.patches?.some(
      (patch) => patch.path === 'infra/ivekit/tinode/apply-overlay.mjs'
    )
  );
  assert.ok(
    tinode.patches?.some(
      (patch) =>
        patch.path ===
        'infra/ivekit/tinode/patches/tinode-ivekit-postgres-bootstrap.patch'
    )
  );
  assert.ok(
    tinode.verification.evidence_paths?.includes(
      'docs/evidence/wave2-tinode-three-node-cluster-validation-2026-07-23.md'
    )
  );
  for (const componentId of ['rustpbx', 'rsipstack']) {
    const component = manifest.components.find(
      (candidate) => candidate.component_id === componentId
    );
    assert.equal(
      component?.patches?.some(
        (patch) => patch.path === 'infra/ivekit/tinode/apply-overlay.mjs'
      ),
      false
    );
  }
  assert.equal(tinode.release_gate.production_eligible, false);
  assert.equal(
    tinode.runtime_artifact.reference,
    'ghcr.io/songgoldenwind-crypto/opc-ivekit-tinode-server:v0.25.3-ivekit.3-22a7c18e'
  );
  assert.ok(
    tinode.verification.evidence_paths?.includes(
      '.github/workflows/ivekit-tinode-server-image.yml'
    )
  );
  assert.ok(
    tinode.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('GHCR workflow has not executed') &&
        reason.includes('immutable registry digest')
    )
  );
  assert.ok(
    tinode.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('Controlled three-node bootstrap') &&
        reason.includes('target Kubernetes rollout') &&
        reason.includes('reconnect') &&
        reason.includes('native-client convergence') &&
        reason.includes('capacity evidence remain not_run')
    )
  );
});

test('LiveKit fork status records the owner overlay without claiming a built production image', () => {
  const livekit = manifest.components.find(
    (component) => component.component_id === 'livekit-server'
  );
  assert.ok(livekit);

  assert.ok(
    livekit.implemented_changes?.some(
      (change) => change.change_id === 'livekit-cell-admission-v1'
    )
  );
  assert.equal(
    livekit.planned_changes?.some(
      (change) => change.change_id === 'livekit-cell-admission-v1'
    ),
    false
  );
  assert.ok(
    livekit.implemented_changes?.some(
      (change) => change.change_id === 'livekit-room-rebuild-v1'
    )
  );
  assert.equal(
    livekit.planned_changes?.some(
      (change) => change.change_id === 'livekit-room-rebuild-v1'
    ),
    false
  );
  assert.ok(
    livekit.implemented_changes?.some(
      (change) => change.change_id === 'livekit-small-room-hot-path-v1'
    )
  );
  assert.equal(
    livekit.planned_changes?.some(
      (change) => change.change_id === 'livekit-small-room-hot-path-v1'
    ),
    false
  );
  assert.equal(livekit.verification.patch_apply, 'passed');
  assert.equal(livekit.verification.compile, 'passed');
  assert.equal(livekit.verification.benchmark, 'partial');
  assert.equal(livekit.verification.unit, 'passed');
  assert.equal(livekit.verification.integration, 'partial');
  assert.ok(
    livekit.verification.evidence_paths?.includes(
      'infra/ivekit/livekit/apply-overlay.mjs'
    )
  );
  assert.ok(
    livekit.patches?.some(
      (patch) => patch.path === 'infra/ivekit/livekit/apply-overlay.mjs'
    )
  );
  assert.equal(livekit.runtime_artifact.kind, 'custom_candidate');
  assert.equal(livekit.runtime_artifact.contains_declared_modifications, true);
  assert.equal(livekit.release_gate.production_eligible, false);
  assert.ok(
    livekit.release_gate.blocking_reasons.some(
      (reason) => reason.includes('immutable registry digest')
    )
  );
});

test('LiveKit Egress fork status records hard pool fencing without claiming a deployed image', () => {
  const egress = manifest.components.find(
    (component) => component.component_id === 'livekit-egress'
  );
  assert.ok(egress);

  assert.equal(egress.lifecycle, 'active_engineering');
  assert.equal(
    egress.upstream?.commit,
    '7d3572a0bf1959cbbc452f5ba390b6a90b7dc249'
  );
  assert.equal(egress.upstream?.source_identity_complete, true);
  assert.ok(
    egress.implemented_changes?.some(
      (change) => change.change_id === 'livekit-egress-capacity-v1'
    )
  );
  assert.equal(
    egress.planned_changes?.some(
      (change) => change.change_id === 'livekit-egress-capacity-v1'
    ),
    false
  );
  assert.equal(egress.verification.unit, 'passed');
  assert.equal(egress.verification.compile, 'passed');
  assert.equal(egress.verification.integration, 'partial');
  assert.equal(egress.verification.benchmark, 'not_run');
  assert.equal(egress.verification.real_environment, 'not_run');
  assert.equal(
    egress.runtime_artifact?.reference,
    'ghcr.io/songgoldenwind-crypto/opc-ivekit-livekit-egress:v1.13.0-ivekit.1-7d3572a0'
  );
  assert.ok(
    egress.verification.evidence_paths?.includes(
      'infra/ivekit/livekit-egress/apply-overlay.mjs'
    )
  );
  assert.equal(egress.release_gate.production_eligible, false);
  assert.ok(
    egress.verification.evidence_paths?.includes(
      '.github/workflows/ivekit-livekit-egress-image.yml'
    )
  );
  assert.ok(
    egress.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('GHCR workflow has not executed') &&
        reason.includes('immutable registry digest')
    )
  );
});

test('LiveKit Ingress fork status records exact-source delivery without claiming real media', () => {
  const ingress = manifest.components.find(
    (component) => component.component_id === 'livekit-ingress'
  );
  assert.ok(ingress);

  assert.equal(ingress.lifecycle, 'active_engineering');
  assert.equal(
    ingress.upstream?.commit,
    '363f6090d572db8eef5b60c273c0970826fb7ca6'
  );
  assert.equal(ingress.upstream?.version, 'v1.5.0');
  assert.equal(ingress.upstream?.source_identity_complete, true);
  assert.ok(
    ingress.implemented_changes?.some(
      (change) => change.change_id === 'livekit-ingress-foundation-v1'
    )
  );
  assert.equal(ingress.verification.patch_apply, 'passed');
  assert.equal(ingress.verification.compile, 'passed');
  assert.equal(ingress.verification.unit, 'passed');
  assert.equal(ingress.verification.integration, 'partial');
  assert.equal(ingress.verification.benchmark, 'not_run');
  assert.equal(ingress.verification.real_environment, 'not_run');
  assert.equal(
    ingress.runtime_artifact.reference,
    'ghcr.io/songgoldenwind-crypto/opc-ivekit-livekit-ingress:v1.5.0-ivekit.1-363f6090'
  );
  for (const path of [
    'infra/ivekit/livekit-ingress/apply-overlay.mjs',
    'infra/ivekit/livekit-ingress/build.sh'
  ]) {
    assert.ok(ingress.patches?.some((patch) => patch.path === path), path);
  }
  assert.ok(
    ingress.verification.evidence_paths?.includes(
      '.github/workflows/ivekit-livekit-ingress-image.yml'
    )
  );
  assert.equal(ingress.release_gate.production_eligible, false);
  assert.ok(
    ingress.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('GHCR workflow has not executed') &&
        reason.includes('immutable registry digest')
    )
  );
  assert.ok(
    ingress.release_gate.blocking_reasons.some(
      (reason) => reason.includes('Real RTMP') && reason.includes('not_run')
    )
  );
});

test('LiveKit SIP is reproducibly built from the exact upstream commit without claiming production traffic', () => {
  const sip = manifest.components.find(
    (component) => component.component_id === 'livekit-sip'
  );
  assert.ok(sip);

  assert.equal(
    sip.upstream?.commit,
    'd5d1e09bbe826baaae9c335d8f42523192c7ce29'
  );
  assert.equal(sip.upstream?.version, 'v1.7.0');
  assert.equal(sip.upstream?.release_ref, 'v1.7.0');
  assert.equal(sip.upstream?.source_identity_complete, true);
  assert.equal(sip.verification.patch_apply, 'not_applicable');
  assert.equal(sip.verification.compile, 'not_run');
  assert.equal(sip.verification.unit, 'not_run');
  assert.equal(sip.verification.integration, 'not_run');
  assert.ok(
    sip.implemented_changes?.some(
      (change) => change.change_id === 'livekit-sip-role-boundary-v1'
    )
  );
  assert.equal(
    sip.planned_changes?.some(
      (change) => change.change_id === 'livekit-sip-role-boundary-v1'
    ),
    false
  );
  assert.ok(
    sip.verification.evidence_paths?.includes(
      'infra/ivekit/livekit-sip/build.sh'
    )
  );
  assert.equal(existsSync('infra/ivekit/livekit-sip/build.sh'), true);
  assert.equal(existsSync('infra/ivekit/livekit-sip/README.md'), true);
  assert.equal(sip.runtime_artifact.kind, 'custom_candidate');
  assert.equal(sip.runtime_artifact.contains_declared_modifications, true);
  assert.equal(sip.release_gate.production_eligible, false);
  assert.ok(
    sip.release_gate.blocking_reasons.some(
      (reason) => reason.includes('immutable registry digest')
    )
  );
  assert.ok(
    sip.release_gate.blocking_reasons.some(
      (reason) => /real SIP media/i.test(reason)
    )
  );
});

test('LiveKit SIP build script rejects source drift and verifies its runtime identity', () => {
  const build = readFileSync('infra/ivekit/livekit-sip/build.sh', 'utf8');
  const dockerfile = readFileSync('infra/ivekit/livekit-sip/Dockerfile', 'utf8');
  const workflow = readFileSync('.github/workflows/ivekit-livekit-sip-image.yml', 'utf8');

  assert.match(build, /git -C "\$\{LIVEKIT_SIP_SOURCE_DIR\}" rev-parse HEAD/);
  assert.match(build, /d5d1e09bbe826baaae9c335d8f42523192c7ce29/);
  assert.match(build, /EXPECTED_VERSION="v1\.7\.0"/);
  assert.match(build, /LIVEKIT_SIP_BUILDER_IMAGE/);
  assert.match(build, /LIVEKIT_SIP_RUNTIME_IMAGE/);
  assert.match(build, /@sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(build, /infra\/ivekit\/livekit-sip\/Dockerfile|\$\{SCRIPT_DIR\}\/Dockerfile/);
  assert.match(build, /org\.opencontainers\.image\.revision/);
  assert.match(build, /io\.ivekit\.component=livekit-sip/);
  assert.match(build, /--version/);

  assert.match(dockerfile, /ARG LIVEKIT_SIP_BUILDER_IMAGE/);
  assert.match(dockerfile, /FROM \$\{LIVEKIT_SIP_BUILDER_IMAGE\} AS builder/);
  assert.match(dockerfile, /go test \.\/pkg\/\.\.\./);
  assert.match(dockerfile, /ARG LIVEKIT_SIP_RUNTIME_IMAGE/);
  assert.match(dockerfile, /FROM \$\{LIVEKIT_SIP_RUNTIME_IMAGE\}/);
  assert.match(dockerfile, /USER 10001:10001/);

  assert.match(workflow, /LIVEKIT_SIP_UPSTREAM_TAG: v1\.7\.0/);
  assert.match(workflow, /LIVEKIT_SIP_UPSTREAM_COMMIT: d5d1e09bbe826baaae9c335d8f42523192c7ce29/);
  assert.match(workflow, /IVEKIT_LIVEKIT_SIP_BUILDER_IMAGE/);
  assert.match(workflow, /IVEKIT_LIVEKIT_SIP_RUNTIME_IMAGE/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(workflow, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);
  for (const match of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/, `mutable action reference: ${match[0]}`);
  }
});

test('RustDesk client fork status records durable owner epoch fencing without claiming Windows acceptance', () => {
  const rustdesk = manifest.components.find(
    (component) => component.component_id === 'rustdesk-client'
  );
  assert.ok(rustdesk);

  assert.ok(
    rustdesk.implemented_changes?.some(
      (change) => change.change_id === 'rustdesk-client-owner-epoch-v1'
    )
  );
  assert.equal(
    rustdesk.planned_changes?.some(
      (change) => change.change_id === 'rustdesk-client-owner-epoch-v1'
    ),
    false
  );
  assert.ok(
    rustdesk.protocols?.some(
      (protocol) =>
        protocol.protocol_id === 'ivekit-rustdesk-native-control-v2' &&
        protocol.version === '2'
    )
  );
  assert.equal(
    rustdesk.upstream?.commit,
    '6c578292e8ebbbec708b76986ba8c4bc7c509747'
  );
  assert.equal(rustdesk.upstream?.source_identity_complete, true);
  assert.equal(rustdesk.verification.patch_apply, 'passed');
  assert.equal(rustdesk.verification.unit, 'passed');
  assert.equal(rustdesk.verification.integration, 'partial');
  assert.ok(
    rustdesk.verification.evidence_paths?.includes(
      'scripts/rustdesk-owner-epoch-fence.ts'
    )
  );
  assert.equal(rustdesk.release_gate.production_eligible, false);
  assert.ok(
    rustdesk.release_gate.blocking_reasons.some(
      (reason) => reason.includes('Two-Windows-machine')
    )
  );
});

test('RustDesk Server fork status records the compiled relay hot path without claiming a production image', () => {
  const rustdeskServer = manifest.components.find(
    (component) => component.component_id === 'rustdesk-server'
  );
  assert.ok(rustdeskServer);

  assert.equal(
    rustdeskServer.upstream?.commit,
    '73523b31cfd25d77dee862e6fc9f5e1fb5e485ef'
  );
  assert.equal(rustdeskServer.upstream?.source_identity_complete, true);
  assert.ok(
    rustdeskServer.implemented_changes?.some(
      (change) => change.change_id === 'rustdesk-relay-hot-path-v1'
    )
  );
  assert.equal(
    rustdeskServer.planned_changes?.some(
      (change) => change.change_id === 'rustdesk-relay-hot-path-v1'
    ),
    false
  );
  assert.equal(rustdeskServer.verification.patch_apply, 'passed');
  assert.equal(rustdeskServer.verification.compile, 'passed');
  assert.equal(rustdeskServer.verification.unit, 'passed');
  assert.equal(rustdeskServer.verification.integration, 'partial');
  assert.equal(rustdeskServer.verification.benchmark, 'not_run');
  assert.ok(
    rustdeskServer.verification.evidence_paths?.includes(
      'infra/ivekit/rustdesk-server/patches/rustdesk-server-ivekit-relay-hot-path.patch'
    )
  );
  assert.ok(
    rustdeskServer.patches?.some(
      (patch) => patch.path === 'infra/ivekit/rustdesk-server/Dockerfile'
    )
  );
  for (const componentId of ['rustpbx', 'rsipstack', 'tinode-server']) {
    const component = manifest.components.find(
      (candidate) => candidate.component_id === componentId
    );
    assert.equal(
      component?.patches?.some(
        (patch) => patch.path === 'infra/ivekit/rustdesk-server/Dockerfile'
      ),
      false
    );
  }
  assert.equal(rustdeskServer.release_gate.production_eligible, false);
  assert.ok(
    rustdeskServer.release_gate.blocking_reasons.some(
      (reason) => reason.includes('immutable registry digest')
    )
  );
  assert.ok(
    rustdeskServer.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('1.1.15') &&
        reason.includes('historical') &&
        reason.includes('not promoted')
    )
  );
  assert.ok(
    rustdeskServer.release_gate.blocking_reasons.some(
      (reason) => reason.includes('Two-Windows-machine')
    )
  );
});
