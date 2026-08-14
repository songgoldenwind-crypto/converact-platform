import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(goalDirectory));

function read(path) {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

function json(path) {
  return JSON.parse(read(path));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(join(repositoryRoot, path))).digest('hex');
}

test('RM01 manifest binds exact program rules and full objective', () => {
  const manifest = json('goals/rust-migration/manifest.json');
  const schema = json('goals/rust-migration/manifest.schema.json');
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(sha256(manifest.global_rules.path), manifest.global_rules.sha256);
  assert.equal(sha256(manifest.goal.path), manifest.goal.sha256);
  assert.equal(manifest.goal.id, 'RM01');
  assert.deepEqual(manifest.goal.does_not_start, ['G04']);
  assert.equal(
    sha256('goals/manifest.json'),
    '11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912',
    'the frozen 18-Goal manifest must not change',
  );
});

test('migration contract is closed and freezes the approved architecture', () => {
  const contract = json(
    'architecture-foundation/rust-migration/server-runtime-migration-contract-v1.json',
  );
  const schema = json(
    'architecture-foundation/rust-migration/server-runtime-migration-contract-v1.schema.json',
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.equal(contract.target.owned_online_runtime_language, 'rust');
  assert.equal(contract.target.architecture, 'multi_region_cell_based');
  assert.equal(contract.target.writer_policy, 'one_cell_one_owner_generation_one_writer');
  assert.equal(contract.cell.global_hot_path_dependency, 'forbidden');
  assert.equal(contract.cell.active_multi_writer, 'forbidden');
  assert.ok(contract.hard_invariants.includes('no_durable_dual_write'));
  assert.ok(
    contract.hard_invariants.includes(
      'optional_ai_recording_connector_or_storage_failure_cannot_interrupt_established_human_communication',
    ),
  );
  assert.equal(contract.repository_runtime_implementation_authorized, true);
  assert.equal(contract.running_server_change_authorized, false);
  assert.equal(contract.performance_claim_authorized, false);
  assert.equal(contract.production_eligible, false);
});

test('runtime inventory pins the exact initial source boundary', () => {
  const inventory = json('architecture-foundation/rust-migration/runtime-inventory-v1.json');

  assert.equal(inventory.baseline_commit, '43fcbefacbdae679090caed704c05ddc761f0361');
  assert.deepEqual(inventory.counts, {
    tracked_typescript_files: 1977,
    tracked_rust_files: 175,
    tracked_src_typescript_files: 816,
    tracked_src_typescript_lines: 247038,
    tracked_agent_runtime_typescript_files: 732,
    tracked_agent_runtime_typescript_lines: 226836,
  });
  assert.ok(inventory.current_online_entrypoints.includes('src/converact-server.ts'));
  assert.ok(inventory.current_online_entrypoints.includes('services/provider-gateway-go'));
  assert.equal(
    inventory.inventory_status,
    'initial_source_inventory_requires_runtime_reachability_audit',
  );
  assert.equal(inventory.production_eligible, false);
});

test('all RM01 requirements start not_run and map to a concrete artifact', () => {
  const trace = json('architecture-foundation/rust-migration/traceability-v1.json');

  assert.equal(trace.items.length, 15);
  assert.equal(new Set(trace.items.map((item) => item.id)).size, trace.items.length);
  for (const item of trace.items) {
    assert.match(item.id, /^RM01-T[0-9]{2}$/u);
    assert.ok(item.requirement.length > 0);
    assert.ok(item.artifact.length > 0);
    assert.equal(item.evidence_status, 'not_run');
  }
});

test('design and plan cover Cell HA, vertical migration and final deletion', () => {
  const design = read('docs/architecture/2026-08-14-rust-server-runtime-cell-migration-r1.md');
  const plan = read('docs/plans/2026-08-14-rust-server-runtime-cell-migration-r1.md');

  for (const required of [
    'multi-region',
    'Cell',
    'one writer',
    'active-zero',
    'HF/GPU',
    'Human Communication',
    'No legacy runtime is deleted',
  ]) {
    assert.match(`${design}\n${plan}`, new RegExp(required, 'u'));
  }
  assert.match(plan, /Checkpoint R10 — deletion and closure/u);
  assert.match(plan, /cargo test --locked --manifest-path server-rs\/Cargo\.toml/u);
  assert.doesNotMatch(`${design}\n${plan}`, /\bTBD\b|\bTODO\b/u);
});

test('create_goal summary is bounded and preserves all critical restrictions', () => {
  const goal = read('goals/rust-migration/goal-rm01-server-runtime-cell-migration.md');
  const marker = '## 9. create_goal summary\n';
  const start = goal.indexOf(marker);
  assert.notEqual(start, -1);
  const summary = goal.slice(start + marker.length).trim();

  assert.ok(Buffer.byteLength(summary, 'utf8') <= 4000);
  assert.match(summary, /Anything unproved remains `not_run`/u);
  assert.match(summary, /multi-region Cell-based Rust architecture/u);
  assert.match(summary, /one Cell, one owner generation and one writer/u);
  assert.match(summary, /No running-server\s+changes/u);
  assert.match(summary, /Do not start G04 automatically/u);
});
