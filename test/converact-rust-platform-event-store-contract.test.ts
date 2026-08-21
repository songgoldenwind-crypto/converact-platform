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
    /CREATE ROLE converact_event_runtime NOLOGIN NOSUPERUSER[\s\S]*NOBYPASSRLS/i
  );
  assert.match(postgresVerifier, /converact-init-event-runtime-role\.ts/i);
  const rollingRoleReplay = postgresVerifier.indexOf('src/converact-init-runtime-role.ts');
  const targetRoleActivation = postgresVerifier.indexOf('src/converact-init-event-runtime-role.ts');
  assert.ok(
    rollingRoleReplay >= 0 && targetRoleActivation > rollingRoleReplay,
    'legacy rolling role replay must run before target role activation'
  );
  assert.match(
    postgresVerifier,
    /writer_fenced_event_and_outbox_lifecycle_is_physically_idempotent[\s\S]*--ignored --exact/i
  );
  assert.match(postgresVerifier, /CONVERACT_TEST_POSTGRES_URL/);
  assert.match(postgresVerifier, /CONVERACT_TEST_POSTGRES_ADMIN_URL/);
});

test('focused event-role verification owns a migration-only PostgreSQL prerequisite', () => {
  const focusedBranch = postgresVerifier.match(
    /if \[ "\$\{CONVERACT_POSTGRES_EVENT_ROLE_ONLY:-0\}" = '1' \]; then([\s\S]*?)else/i
  )?.[1] || '';
  assert.match(
    focusedBranch,
    /test\/converact-platform-event-runtime-role-postgres\.test\.ts/,
    'focused role verification must use its dedicated fresh/upgrade migration test'
  );
  assert.doesNotMatch(
    focusedBranch,
    /test\/converact-standalone-postgres\.test\.ts/,
    'focused role verification must not borrow the unrelated full product suite'
  );
  assert.match(postgresVerifier, /server-rs\/rust-toolchain\.toml/);
  assert.match(postgresVerifier, /rustup[\s\S]*which[\s\S]*--toolchain/);
  assert.match(postgresVerifier, /RUSTDOC="\$RUST_RUSTDOC"/);
  assert.match(postgresVerifier, /--locked --manifest-path server-rs\/Cargo\.toml/);
  assert.match(postgresVerifier, /DROP DATABASE converact_upgrade/);
  assert.match(
    postgresVerifier,
    /REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC/
  );
  assert.match(
    postgresVerifier,
    /REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC/
  );
  assert.doesNotMatch(
    postgresVerifier,
    /\ncargo test --manifest-path server-rs\/Cargo\.toml/,
    'physical verification must not depend on the caller default cargo'
  );
});
