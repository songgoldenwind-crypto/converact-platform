import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const contractPath = 'architecture-foundation/rust-migration/authority-route-contract-v1.json';
const schemaPath = 'architecture-foundation/rust-migration/authority-route-contract-v1.schema.json';

const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));
const sha256 = (path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

test('AuthorityRoute contract is closed and bound to the frozen RM01 design', () => {
  const contract = json(contractPath);
  const schema = json(schemaPath);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  for (const source of contract.sources) assert.equal(sha256(source.path), source.sha256);
  assert.deepEqual(contract.route_key, ['tenant_id', 'authority_kind', 'partition_key']);
  assert.deepEqual(contract.route_states, [
    'shadow', 'prepare', 'committed', 'draining', 'active_zero', 'retired'
  ]);
  assert.equal(contract.current_state, 'contract_frozen_no_route_store');
  assert.equal(contract.production_eligible, false);
  assert.equal(contract.server_validation, 'not_run');
  assert.equal(contract.performance_validation, 'not_run');
});

test('prepare, commit, abort and rollback preserve exactly one new-work writer', () => {
  const contract = json(contractPath);

  assert.equal(
    contract.commands.prepare.effect,
    'reserve_next_generation_without_changing_current_writer'
  );
  assert.equal(
    contract.commands.commit.effect,
    'atomically_install_prepared_generation_for_new_work_and_drain_predecessor'
  );
  assert.equal(
    contract.commands.abort.effect,
    'remove_prepared_generation_without_changing_current_writer'
  );
  assert.deepEqual(contract.writer_fence.forbidden_generation_states, [
    'prepared', 'active_zero', 'retired'
  ]);

  const vectors = new Map(contract.transition_vectors.map((vector) => [vector.name, vector]));
  for (const required of [
    'prepare_keeps_typescript_writer',
    'duplicate_prepare_is_exact_replay',
    'abort_before_commit_keeps_writer',
    'commit_installs_one_new_work_writer',
    'stale_generation_fails_closed',
    'rollback_is_new_generation'
  ]) assert.ok(vectors.has(required), `missing ${required}`);
  assert.match(vectors.get('rollback_is_new_generation').expected, /generation_3/u);
});

test('drain, active-zero, idempotency and reconcile are fail-closed', () => {
  const contract = json(contractPath);
  const vectors = new Map(contract.transition_vectors.map((vector) => [vector.name, vector]));

  assert.ok(contract.commands.mark_active_zero.requires.includes('durable_active_count_zero'));
  assert.ok(contract.commands.mark_active_zero.requires.includes('no_nonterminal_claims'));
  assert.equal(
    contract.idempotency.different_hash,
    'reject_idempotency_conflict'
  );
  assert.equal(
    contract.idempotency.unknown_outcome,
    'query_receipt_then_reconcile_never_blind_retry'
  );
  assert.equal(
    contract.writer_fence.enforcement,
    'postgresql_atomic_predicate'
  );
  assert.match(vectors.get('active_zero_requires_durable_zero').expected, /^reject_/u);
  assert.match(vectors.get('retired_route_is_immutable').expected, /^reject_/u);
});
