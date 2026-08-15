import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-event-store-v1.json', import.meta.url),
  'utf8'
)) as any;
const postgresVerifier = readFileSync(
  new URL('../scripts/verify-converact-postgres.sh', import.meta.url),
  'utf8'
);

test('Rust durable event store corpus is bound to the exact current sources', () => {
  assert.equal(fixture.contract_version, 1);
  for (const source of fixture.current_sources) {
    const bytes = readFileSync(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.path);
  }
});

test('target hardening does not confuse effect and AuthorityRoute generations', () => {
  assert.equal(fixture.current_state.authority_writer_fence, false);
  assert.equal(fixture.current_state.complete_retry_dead_letter_query_reconcile, false);
  assert.equal(fixture.target_contract.route_generation_is_distinct_from_effect_generation, true);
  assert.equal(fixture.target_contract.writer_fence_authority, 'postgresql_transaction_time');
  assert.equal(fixture.target_contract.commit_unknown, 'exact_query_and_reconcile_without_blind_retry');
  assert.equal(fixture.target_contract.aggregate_plus_outbox, 'private_domain_adapter_transaction_only');
});

test('physical event-store verification uses an isolated non-bypass target role', () => {
  assert.match(
    postgresVerifier,
    /CREATE ROLE converact_event_runtime LOGIN NOSUPERUSER[\s\S]*NOBYPASSRLS/i
  );
  assert.match(
    postgresVerifier,
    /writer_fenced_event_and_outbox_lifecycle_is_physically_idempotent[\s\S]*--ignored --exact/i
  );
  assert.match(postgresVerifier, /CONVERACT_TEST_POSTGRES_URL/);
  assert.match(postgresVerifier, /CONVERACT_TEST_POSTGRES_ADMIN_URL/);
});
