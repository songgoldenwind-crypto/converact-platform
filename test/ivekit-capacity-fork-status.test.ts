import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

interface ForkComponent {
  component_id: string;
  lifecycle: string;
  protocols?: Array<{ protocol_id: string; version: string }>;
  upstream?: {
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
    tinode.verification.evidence_paths?.includes(
      'infra/ivekit/tinode/apply-overlay.mjs'
    )
  );
  assert.ok(
    tinode.patches?.some(
      (patch) => patch.path === 'infra/ivekit/tinode/apply-overlay.mjs'
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
  assert.ok(
    tinode.release_gate.blocking_reasons.some(
      (reason) =>
        reason.includes('custom image') &&
        reason.includes('immutable registry digest')
    )
  );
  assert.ok(
    tinode.release_gate.blocking_reasons.some(
      (reason) => reason.includes('Multi-node reconnect')
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
    'ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0'
  );
  assert.ok(
    egress.verification.evidence_paths?.includes(
      'infra/ivekit/livekit-egress/apply-overlay.mjs'
    )
  );
  assert.equal(egress.release_gate.production_eligible, false);
  assert.ok(
    egress.release_gate.blocking_reasons.some(
      (reason) => reason.includes('not an immutable registry artifact')
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
    '02179d2eebe1493ad8c6a7961ceee84c34f8aca3'
  );
  assert.equal(sip.upstream?.source_identity_complete, true);
  assert.equal(sip.verification.patch_apply, 'not_applicable');
  assert.equal(sip.verification.compile, 'passed');
  assert.equal(sip.verification.unit, 'partial');
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
  assert.equal(sip.runtime_artifact.contains_declared_modifications, false);
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

  assert.match(build, /git -C "\$\{LIVEKIT_SIP_SOURCE_DIR\}" rev-parse HEAD/);
  assert.match(build, /02179d2eebe1493ad8c6a7961ceee84c34f8aca3/);
  assert.match(build, /build\/sip\/Dockerfile/);
  assert.match(build, /org\.opencontainers\.image\.revision/);
  assert.match(build, /io\.ivekit\.component=livekit-sip/);
  assert.match(build, /--version/);
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
    '0c86d4616298f09435f6236599b300964aa61460'
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
    '9bae9f2f39d92c4b4ba2e28e089da5071897b22e'
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
  assert.equal(rustdeskServer.verification.benchmark, 'partial');
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
      (reason) =>
        reason.includes('custom image') &&
        reason.includes('immutable registry digest')
    )
  );
  assert.ok(
    rustdeskServer.release_gate.blocking_reasons.some(
      (reason) => reason.includes('Two-Windows-machine')
    )
  );
});
