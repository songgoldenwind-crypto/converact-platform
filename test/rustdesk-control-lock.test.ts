import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RustDeskControlLockStore } from '../src/agent-runtime/collaboration/rustdesk-control-lock-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg } from '../src/db-pg.js';

test('RustDesk control ownership migration defines leases confirmations and immutable events', () => {
  const migrationUrl = new URL('../src/migrations/040_rustdesk_control_ownership.sql', import.meta.url);
  assert.equal(existsSync(migrationUrl), true, 'RustDesk control ownership migration must exist');

  const migration = readFileSync(migrationUrl, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_control_locks \(/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, external_id\)/);
  assert.match(migration, /owner_identity TEXT NOT NULL/);
  assert.match(migration, /lease_expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(migration, /version INTEGER NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations \(/);
  assert.match(migration, /operation TEXT NOT NULL/);
  assert.match(migration, /consumed_at TIMESTAMPTZ/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_control_events \(/);
  assert.match(migration, /event_type TEXT NOT NULL/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/g);
  assert.doesNotMatch(migration, /password|credential_ref|credential-ref/i);
});

test('full schema includes RustDesk control ownership tables without early RLS helpers', () => {
  const schema = readFileSync(new URL('../src/migrations/005_full_schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_control_locks \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_control_events \(/);
  assert.doesNotMatch(
    schema,
    /ALTER TABLE rustdesk_control_locks ENABLE ROW LEVEL SECURITY;[\s\S]*opc_current_tenant\(\)/
  );
});

async function fixture(name: string) {
  const pg = new MemoryPg();
  const tenantId = `tenant_control_${name}`;
  const sessions = new RustDeskGatewaySessionStore(pg);
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: { type: 'device', id: `device-${name}` },
    permissions: ['view_screen', 'control_mouse_keyboard', 'transfer_file', 'clipboard'],
    actor_identity: 'agent-a',
    launch_url: `https://opc.example.test/rustdesk/${name}`
  });
  return { pg, sessions, session, tenantId, locks: new RustDeskControlLockStore(pg) };
}

test('RustDesk control lock allows one owner and rejects stale heartbeat or challenge replay', async () => {
  const { locks, session, tenantId } = await fixture('exclusive');
  const now = '2026-07-12T03:00:00.000Z';
  const firstConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard', now
  });
  const acquired = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: firstConfirmation.id, lease_ms: 30_000, now
  });
  assert.equal(acquired.status, 'owned');
  assert.equal(acquired.owner_identity, 'agent-a');

  await assert.rejects(() => locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: firstConfirmation.id, now
  }), /fresh secondary confirmation required/);
  await assert.rejects(() => locks.heartbeat({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    version: acquired.version - 1, now: '2026-07-12T03:00:01.000Z'
  }), /stale control ownership version/);

  const otherConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-b',
    operation: 'control_mouse_keyboard', now
  });
  await assert.rejects(() => locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-b',
    confirmation_id: otherConfirmation.id, now
  }), /already owned/);
});

test('RustDesk control lock expires and transfers atomically with fresh confirmation', async () => {
  const { locks, session, tenantId } = await fixture('transfer');
  const now = '2026-07-12T04:00:00.000Z';
  const acquireConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard', now
  });
  const acquired = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: acquireConfirmation.id, lease_ms: 5_000, now
  });
  const transferConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_transfer', now
  });
  const transferred = await locks.transfer({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    to_identity: 'agent-b', confirmation_id: transferConfirmation.id, version: acquired.version,
    lease_ms: 5_000, now: '2026-07-12T04:00:01.000Z'
  });
  assert.equal(transferred.owner_identity, 'agent-b');
  assert.equal(transferred.version, acquired.version + 1);

  const expired = await locks.getOwnership({
    tenant_id: tenantId, external_id: session.external_id, now: '2026-07-12T04:00:07.000Z'
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.owner_identity, null);
});

test('RustDesk terminal gateway session rejects confirmations and lock changes', async () => {
  const { locks, sessions, session, tenantId } = await fixture('terminal');
  await sessions.endSession({ external_id: session.external_id, actor_identity: 'agent-a' });
  await assert.rejects(() => locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard'
  }), /gateway session is terminal/);
});
