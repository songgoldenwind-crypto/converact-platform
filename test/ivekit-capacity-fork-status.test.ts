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
  patches?: Array<{ path: string; sha256: string }>;
  implemented_changes?: Array<{ change_id: string }>;
  planned_changes?: Array<{ change_id: string }>;
  verification: {
    patch_apply?: string;
    compile?: string;
    unit: string;
    integration: string;
    benchmark?: string;
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
  assert.equal(tinode.release_gate.production_eligible, false);
  assert.ok(
    tinode.release_gate.blocking_reasons.some(
      (reason) => reason.includes('custom image') && reason.includes('immutable digest')
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
  assert.equal(livekit.release_gate.production_eligible, false);
  assert.ok(
    livekit.release_gate.blocking_reasons.some(
      (reason) => reason.includes('immutable digest')
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
  assert.equal(egress.verification.integration, 'partial');
  assert.ok(
    egress.verification.evidence_paths?.includes(
      'infra/ivekit/livekit-egress/apply-overlay.mjs'
    )
  );
  assert.equal(egress.release_gate.production_eligible, false);
  assert.ok(
    egress.release_gate.blocking_reasons.some(
      (reason) => reason.includes('real upstream checkout')
    )
  );
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
  assert.equal(rustdeskServer.release_gate.production_eligible, false);
  assert.ok(
    rustdeskServer.release_gate.blocking_reasons.some(
      (reason) => reason.includes('custom image') && reason.includes('immutable digest')
    )
  );
  assert.ok(
    rustdeskServer.release_gate.blocking_reasons.some(
      (reason) => reason.includes('Two-Windows-machine')
    )
  );
});
