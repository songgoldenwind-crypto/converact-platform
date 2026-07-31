import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RustDeskAuthorizationCodeStore } from '../src/agent-runtime/collaboration/rustdesk-authorization-code-store.js';
import { MemoryPg } from '../src/db-pg.js';

const secret = 'stage3-authorization-code-test-secret-64-bytes-minimum-value';

test('RustDesk authorization code migration stores only HMAC material with forced tenant RLS', () => {
  const migrationUrl = new URL('../src/migrations/064_rustdesk_authorization_codes.sql', import.meta.url);
  assert.equal(existsSync(migrationUrl), true);
  const migration = readFileSync(migrationUrl, 'utf8');
  const schema = readFileSync(new URL('../src/migrations/005_full_schema.sql', import.meta.url), 'utf8');

  for (const source of [migration, schema]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rustdesk_authorization_codes \(/);
    assert.match(source, /code_salt TEXT NOT NULL/);
    assert.match(source, /code_hmac TEXT NOT NULL/);
    assert.match(source, /status TEXT NOT NULL[\s\S]*pending[\s\S]*verified[\s\S]*consumed[\s\S]*expired[\s\S]*locked/);
    assert.match(source, /idempotency_key TEXT NOT NULL/);
    assert.match(source, /request_hash TEXT NOT NULL/);
    assert.match(source, /status NOT IN \('pending', 'locked'\) OR verified_by IS NULL/);
    assert.match(source, /CONSTRAINT rustdesk_authorization_codes_claim_actor_check/);
    assert.match(source, /status <> 'claimed' OR claimed_by = verified_by/);
    assert.match(source, /rustdesk_authorization_codes_claim_state_check CHECK \(\s*\(\s*status = 'claimed'\s+AND claim_id IS NOT NULL\s+AND claimed_by IS NOT NULL\s+AND claimed_at IS NOT NULL\s+AND claim_expires_at IS NOT NULL\s*\)\s+OR\s+\(\s*status <> 'claimed'\s+AND claim_id IS NULL\s+AND claimed_by IS NULL\s+AND claimed_at IS NULL\s+AND claim_expires_at IS NULL/);
    assert.doesNotMatch(source, /raw_code|plain(?:text)?_code|rustdesk_password/i);
  }
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /ADD CONSTRAINT rustdesk_authorization_codes_remote_session_fk/);
  assert.match(migration, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/);
});

test('RustDesk authorization claim upgrade preserves the verified actor invariant', () => {
  const migration = readFileSync(
    new URL('../src/migrations/095_rustdesk_authorization_claims.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /DROP CONSTRAINT IF EXISTS rustdesk_authorization_codes_claim_actor_check/);
  assert.match(migration, /ADD CONSTRAINT rustdesk_authorization_codes_claim_actor_check/);
  assert.match(migration, /status <> 'claimed' OR claimed_by = verified_by/);
  assert.match(migration, /rustdesk_authorization_codes_claim_state_check CHECK \(\s*\(\s*status = 'claimed'\s+AND claim_id IS NOT NULL\s+AND claimed_by IS NOT NULL\s+AND claimed_at IS NOT NULL\s+AND claim_expires_at IS NOT NULL\s*\)\s+OR\s+\(\s*status <> 'claimed'\s+AND claim_id IS NULL\s+AND claimed_by IS NULL\s+AND claimed_at IS NULL\s+AND claim_expires_at IS NULL/);
});

test('RustDesk authorization code is returned once and idempotency never replays plaintext', async () => {
  const store = new RustDeskAuthorizationCodeStore(new MemoryPg(), { secret });
  const input = createInput('once');
  const created = await store.create(input);
  const replayed = await store.create(input);

  assert.match(created.code, /^\d{8}$/);
  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.code, null);
  assert.deepEqual(replayed.authorization, created.authorization);
  assert.doesNotMatch(JSON.stringify(created.authorization), new RegExp(created.code));
  assert.doesNotMatch(JSON.stringify(created.authorization), /code_hmac|code_salt|request_hash|idempotency_key/);

  await assert.rejects(
    () => store.create({ ...input, scopes: ['view_screen'] }),
    /idempotency key was already used/i
  );
  assert.equal((await store.get({ tenant_id: 'another-tenant', authorization_id: created.authorization.id })), null);
});

test('RustDesk authorization code verifies, binds the engineer, and is consumed exactly once', async () => {
  const store = new RustDeskAuthorizationCodeStore(new MemoryPg(), { secret });
  const created = await store.create(createInput('consume'));
  const verified = await store.verify({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    code: created.code!,
    verified_by: 'engineer-a',
    now: '2026-07-15T01:01:00.000Z'
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verified_by, 'engineer-a');

  const consumed = await store.consume({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-a',
    external_id: 'rdgw-consume',
    now: '2026-07-15T01:02:00.000Z'
  });
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.consumed_external_id, 'rdgw-consume');
  assert.deepEqual(await store.consume({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-a',
    external_id: 'rdgw-consume',
    now: '2026-07-15T01:02:01.000Z'
  }), consumed);

  await assert.rejects(() => store.consume({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-b',
    external_id: 'rdgw-other',
    now: '2026-07-15T01:02:02.000Z'
  }), /not verified for this actor|already consumed/i);
});

test('RustDesk authorization code claim fences upstream creation and is owner-releasable', async () => {
  const store = new RustDeskAuthorizationCodeStore(new MemoryPg(), { secret });
  const created = await store.create(createInput('claim'));
  await store.verify({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    code: created.code!,
    verified_by: 'engineer-claim',
    now: '2026-07-15T01:01:00.000Z'
  });

  const claimed = await store.claim({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-claim',
    now: '2026-07-15T01:01:10.000Z'
  });
  assert.equal(claimed.authorization.status, 'claimed');
  assert.match(claimed.claim_id, /^rdclaim_/);
  await assert.rejects(() => store.claim({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-claim',
    now: '2026-07-15T01:01:11.000Z'
  }), /already claimed|unavailable/i);
  await assert.rejects(() => store.releaseClaim({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-claim',
    claim_id: 'rdclaim_wrong',
    now: '2026-07-15T01:01:12.000Z'
  }), /claim is stale|claim owner/i);

  const released = await store.releaseClaim({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    verified_by: 'engineer-claim',
    claim_id: claimed.claim_id,
    now: '2026-07-15T01:01:13.000Z'
  });
  assert.equal(released.status, 'verified');
});

test('RustDesk authorization code locks after bounded failures and expires fail closed', async () => {
  const store = new RustDeskAuthorizationCodeStore(new MemoryPg(), { secret });
  const created = await store.create({ ...createInput('locked'), max_attempts: 2 });

  for (const now of ['2026-07-15T01:01:00.000Z', '2026-07-15T01:01:01.000Z']) {
    await assert.rejects(() => store.verify({
      tenant_id: created.authorization.tenant_id,
      authorization_id: created.authorization.id,
      code: '00000000' === created.code ? '00000001' : '00000000',
      verified_by: 'engineer-a',
      now
    }), /invalid or unavailable/i);
  }
  const locked = await store.get({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    now: '2026-07-15T01:01:02.000Z'
  });
  assert.equal(locked?.status, 'locked');
  assert.equal(locked?.attempt_count, 2);
  await assert.rejects(() => store.verify({
    tenant_id: created.authorization.tenant_id,
    authorization_id: created.authorization.id,
    code: created.code!,
    verified_by: 'engineer-a',
    now: '2026-07-15T01:01:03.000Z'
  }), /invalid or unavailable/i);

  const expiring = await store.create({ ...createInput('expired'), ttl_seconds: 60 });
  const expired = await store.get({
    tenant_id: expiring.authorization.tenant_id,
    authorization_id: expiring.authorization.id,
    now: '2026-07-15T01:01:01.000Z'
  });
  assert.equal(expired?.status, 'expired');
  await assert.rejects(() => store.verify({
    tenant_id: expiring.authorization.tenant_id,
    authorization_id: expiring.authorization.id,
    code: expiring.code!,
    verified_by: 'engineer-a',
    now: '2026-07-15T01:01:01.000Z'
  }), /invalid or unavailable/i);

  const verifiedExpiring = await store.create({ ...createInput('verified-expired'), ttl_seconds: 60 });
  await store.verify({
    tenant_id: verifiedExpiring.authorization.tenant_id,
    authorization_id: verifiedExpiring.authorization.id,
    code: verifiedExpiring.code!,
    verified_by: 'engineer-expiring',
    now: '2026-07-15T01:00:30.000Z'
  });
  const verifiedExpired = await store.get({
    tenant_id: verifiedExpiring.authorization.tenant_id,
    authorization_id: verifiedExpiring.authorization.id,
    now: '2026-07-15T01:01:01.000Z'
  });
  assert.equal(verifiedExpired?.status, 'expired');
  assert.equal(verifiedExpired?.verified_by, 'engineer-expiring');
});

test('RustDesk authorization code rejects weak pepper and invalid limits before database writes', async () => {
  assert.throws(
    () => new RustDeskAuthorizationCodeStore(new MemoryPg(), { secret: 'too-short' }),
    /at least 32 bytes/i
  );
  const store = new RustDeskAuthorizationCodeStore(new MemoryPg(), { secret });
  await assert.rejects(() => store.create({ ...createInput('ttl'), ttl_seconds: 59 }), /ttl_seconds/);
  await assert.rejects(() => store.create({ ...createInput('attempts'), max_attempts: 11 }), /max_attempts/);
});

function createInput(suffix: string) {
  return {
    tenant_id: `tenant-auth-${suffix}`,
    remote_session_id: `remote-auth-${suffix}`,
    device_id: `rddev-auth-${suffix}`,
    scopes: ['control_mouse_keyboard', 'view_screen'] as const,
    requested_by: `customer-${suffix}`,
    idempotency_key: `auth-code-${suffix}`,
    now: '2026-07-15T01:00:00.000Z'
  };
}
