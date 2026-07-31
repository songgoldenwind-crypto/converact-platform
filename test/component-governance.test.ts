import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  loadComponentGovernance,
  validateComponentGovernance,
  verifyComponentGovernance
} from '../scripts/lib/component-governance.js';

test('component governance defines one carrier baseline with four component overlays', async () => {
  const result = await verifyComponentGovernance(process.cwd(), '2026-07-22');
  const raw = JSON.parse(readFileSync(
    'docs/architecture/component-authority-matrix-v1.json',
    'utf8'
  )) as Record<string, any>;
  const technologyBaseline = JSON.parse(readFileSync(
    'docs/architecture/communication-technology-baseline-v1.json',
    'utf8'
  )) as Record<string, any>;

  assert.deepEqual(result.profiles, ['ai', 'benchmark', 'core', 'observability']);
  assert.equal(result.default_profile, 'core');
  assert.equal(raw.production_baseline_id, 'CARRIER-CELL-V1');
  assert.equal(
    raw.architecture_decision_id,
    'rvoip-rustpbx-unified-authority-r2'
  );
  assert.ok(
    raw.principles.includes(
      'CARRIER-CELL-V1 is the only production voice architecture baseline; overlays do not change voice authority.'
    )
  );
  const components = new Map<string, Record<string, any>>(
    raw.components.map((component: Record<string, any>) => [
      component.id,
      component
    ])
  );
  assert.equal(
    components.get('rustpbx')?.status,
    'implemented'
  );
  assert.equal(
    components.get('rustpbx')?.target_architecture_integration_status,
    'not_run'
  );
  assert.equal(
    components.get('rustpbx')?.target_authority_evidence_status,
    undefined
  );
  assert.equal(
    components.get('rustpbx')?.resource_budget.scope,
    'co-resident Unified RustPBX node'
  );
  assert.match(
    components.get('rustpbx')?.resource_budget.notes ?? '',
    /vos-eq-r4-g711-opus-1k-v1\.json/
  );
  assert.deepEqual(technologyBaseline.topology_identities, [
    {
      identity_id: 'CARRIER-CELL-V1',
      identity_kind: 'production_deployment_profile',
      production_authorizing: true
    },
    {
      identity_id: 'RUST-NATIVE-FAST-PATH-CANDIDATE',
      identity_kind: 'backend_qualification',
      production_authorizing: false
    },
    {
      identity_id: 'UNIFIED-STANDALONE-V1',
      identity_kind: 'diagnostic_topology',
      production_authorizing: false
    }
  ]);
  assert.deepEqual(
    technologyBaseline.topology_identities
      .filter((identity: Record<string, any>) =>
        identity.production_authorizing === true
      )
      .map((identity: Record<string, any>) => identity.identity_id),
    ['CARRIER-CELL-V1']
  );
  const technologyDecisions = new Map<string, Record<string, any>>(
    technologyBaseline.decisions.map((decision: Record<string, any>) => [
      decision.id,
      decision
    ])
  );
  assert.equal(
    technologyDecisions.get('rustpbx')?.current_component_status,
    'implemented'
  );
  assert.equal(
    technologyDecisions.get('rustpbx')?.target_architecture_integration_status,
    'not_run'
  );
  assert.equal(components.get('rtpengine')?.status, 'planned');
  assert.equal(components.get('rtpengine')?.evidence_status, 'not_run');
  assert.equal(components.get('voice-media-rs')?.status, 'planned');
  assert.equal(components.get('voice-media-rs')?.evidence_status, 'not_run');
  assert.equal(components.get('rvoip-low-level-sip-slice')?.status, 'build_only');
  assert.equal(
    components.get('rvoip-low-level-sip-slice')?.evidence_status,
    'not_run'
  );
  assert.ok(result.component_count >= 47);
  assert.equal(result.duplicate_primary_authorities, 0);
  assert.equal(result.poc_delivery_violations, 0);
  assert.equal(result.expired_replacements, 0);
  assert.equal(result.unlocked_image_contracts, 0);
  assert.equal(result.formal_bundle_poc_artifacts, 0);
});

test('component governance rejects duplicate primary authority', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const first = matrix.components.find((component) => component.authority.role === 'primary');
  const second = matrix.components.find(
    (component) => component.authority.role === 'primary' && component.id !== first?.id
  );
  assert.ok(first && second);
  second.authority.domain = first.authority.domain;

  assert.throws(
    () => validateComponentGovernance(matrix, '2026-07-22'),
    /duplicate primary authority/
  );
});

test('component governance keeps POC components benchmark-only and out of delivery', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const poc = matrix.components.find((component) => component.status === 'poc');
  assert.ok(poc);
  poc.profiles = ['core'];
  poc.delivery = 'production';

  assert.throws(
    () => validateComponentGovernance(matrix, '2026-07-22'),
    /POC component .* benchmark-only and excluded/
  );
});

test('component governance requires replacement retirement deadlines', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const replacement = matrix.components.find((component) => component.status === 'replacement');
  assert.ok(replacement?.replacement);
  replacement.replacement.retirement_deadline = '';

  assert.throws(
    () => validateComponentGovernance(matrix, '2026-07-22'),
    /replacement retirement deadline/
  );
});

test('component governance rejects expired replacement windows', async () => {
  const matrix = await loadComponentGovernance(process.cwd());

  assert.throws(
    () => validateComponentGovernance(matrix, '2028-01-01'),
    /replacement retirement deadline expired/
  );
});

test('component governance rejects optional components enabled by default', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const plannedCore = matrix.components.find(
    (component) => component.status === 'planned' && component.profiles.includes('core')
  );
  assert.ok(plannedCore);
  plannedCore.default_enabled = true;

  assert.throws(
    () => validateComponentGovernance(matrix, '2026-07-22'),
    /optional component .* cannot be enabled by default/
  );
});

test('deployment profile overlays are curated and never enable POC components', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const pocIds = new Set(
    matrix.components.filter((component) => component.status === 'poc').map((component) => component.id)
  );

  for (const profile of Object.values(matrix.profiles)) {
    if (profile.id === 'benchmark') continue;
    assert.equal(profile.production_eligible, true);
    assert.equal(profile.components.some((component) => pocIds.has(component)), false);
  }
  assert.equal(matrix.profiles.benchmark.production_eligible, false);
});

test('HOMER is an implemented optional observer with immutable image governance', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const homer = matrix.components.find((component) => component.id === 'homer');

  assert.ok(homer);
  assert.equal(homer.status, 'implemented');
  assert.equal(homer.hot_path, false);
  assert.equal(homer.default_enabled, false);
  assert.deepEqual(homer.profiles, ['observability']);
  assert.ok(homer.dependencies.includes('kamailio'));
  assert.ok(homer.dependencies.includes('postgresql'));
  assert.equal(homer.image_contract?.policy, 'immutable');
  assert.equal(homer.image_contract?.values_path, 'image.digest');
  assert.equal(homer.image_contract?.helper, 'ivekit-homer.image');
  assert.equal(
    homer.image_contract?.chart_root,
    'infra/converact/homer/helm/converact-homer'
  );
});

test('Valkey remains an opt-in replacement after controlled failover evidence', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const valkey = matrix.components.find((component) => component.id === 'redis-to-valkey');

  assert.ok(valkey?.replacement);
  assert.equal(valkey.status, 'replacement');
  assert.equal(valkey.default_enabled, false);
  assert.match(valkey.replacement.exit_gate, /controlled single-host Sentinel failover passed/i);
  assert.match(valkey.replacement.exit_gate, /target Kubernetes/i);
});

test('SeaweedFS is an opt-in S3 implementation with explicit remaining durability gates', async () => {
  const matrix = await loadComponentGovernance(process.cwd());
  const seaweedfs = matrix.components.find((component) => component.id === 'seaweedfs');

  assert.ok(seaweedfs);
  assert.equal(seaweedfs.status, 'implemented');
  assert.equal(seaweedfs.hot_path, false);
  assert.equal(seaweedfs.default_enabled, false);
  assert.match(seaweedfs.resource_budget.notes, /controlled SeaweedFS 4\.40 matrix passed/);
  assert.match(seaweedfs.resource_budget.notes, /target Kubernetes/);
  assert.match(seaweedfs.resource_budget.notes, /WORM requires a verified external provider/);
});
