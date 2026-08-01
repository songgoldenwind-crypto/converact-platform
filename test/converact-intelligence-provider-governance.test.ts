import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { IntelligenceProviderGovernanceStore } from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';

const migrationPath = 'src/migrations/059_ivekit_provider_governance.sql';

test('provider governance migration adds explicit routes and durable runtime state', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const column of [
    'ocr_profile_ids',
    'asr_profile_ids',
    'quality_profile_ids',
    'translation_profile_ids'
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE collaboration_intelligence_policies[\\s\\S]*ADD COLUMN IF NOT EXISTS ${column} TEXT\\[\\]`,
        'i'
      ),
      column
    );
  }

  for (const table of [
    'collaboration_intelligence_provider_runtime',
    'collaboration_intelligence_provider_leases'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'), table);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(
      sql,
      new RegExp(
        `CREATE POLICY tenant_isolation ON ${table}[\\s\\S]*tenant_id = opc_current_tenant\\(\\)`,
        'i'
      ),
      table
    );
  }

  assert.match(
    sql,
    /PRIMARY KEY \(tenant_id, capability, profile_id\)/i,
    'runtime identity must be tenant and capability scoped'
  );
  assert.match(sql, /circuit_state TEXT NOT NULL DEFAULT 'closed'/i);
  assert.match(sql, /CHECK \(circuit_state IN \('closed', 'open', 'half_open'\)\)/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /idx_collaboration_intelligence_provider_leases_active/i);
  assert.match(sql, /idx_collaboration_intelligence_provider_leases_history/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_intelligence_provider_runtime/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_intelligence_provider_leases/i);
  assert.doesNotMatch(sql, /api_key|access_key|secret_key|password|bearer_token|provider_token/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});

test('provider governance migration backfills each route from its legacy primary profile', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const prefix of ['ocr', 'asr', 'quality', 'translation']) {
    assert.match(
      sql,
      new RegExp(
        `UPDATE collaboration_intelligence_policies[\\s\\S]*${prefix}_profile_ids[\\s\\S]*${prefix}_profile_id`,
        'i'
      ),
      prefix
    );
  }
});

test('PostgreSQL governance decisions use database time instead of process clocks', () => {
  const source = readFileSync(
    'src/agent-runtime/collaboration/intelligence-provider-governance-store.ts',
    'utf8'
  );
  assert.match(source, /SELECT clock_timestamp\(\) AS now/i);
});

test('provider governance atomically enforces concurrency and rolling quota windows', async () => {
  let now = new Date('2026-07-15T00:00:00.000Z');
  const pg = new MemoryPg();
  const store = new IntelligenceProviderGovernanceStore(pg, { now: () => now });
  const profile = providerProfile({
    requests_per_minute: 2,
    requests_per_day: 10,
    max_concurrency: 1
  });

  const first = await store.reserve({
    tenant_id: 'tenant-governance', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(first.granted, true);
  const concurrent = await store.reserve({
    tenant_id: 'tenant-governance', capability: 'translation', profile, route_attempt: 1
  });
  assert.deepEqual(concurrent, {
    granted: false,
    profile_id: 'translation-primary',
    reason: 'concurrency_exhausted',
    retry_at: '2026-07-15T00:00:35.000Z'
  });

  if (!first.granted) throw new Error('first reservation must be granted');
  await store.complete({
    tenant_id: 'tenant-governance', lease_id: first.lease_id, outcome: 'success'
  });
  const second = await store.reserve({
    tenant_id: 'tenant-governance', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(second.granted, true);
  if (!second.granted) throw new Error('second reservation must be granted');
  await store.complete({
    tenant_id: 'tenant-governance', lease_id: second.lease_id, outcome: 'success'
  });

  const limited = await store.reserve({
    tenant_id: 'tenant-governance', capability: 'translation', profile, route_attempt: 1
  });
  assert.deepEqual(limited, {
    granted: false,
    profile_id: 'translation-primary',
    reason: 'minute_quota_exhausted',
    retry_at: '2026-07-15T00:01:00.000Z'
  });

  now = new Date('2026-07-15T00:01:00.001Z');
  const afterWindow = await store.reserve({
    tenant_id: 'tenant-governance', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(afterWindow.granted, true);
});

test('provider governance opens, probes, and closes a circuit using retryable outcomes only', async () => {
  let now = new Date('2026-07-15T01:00:00.000Z');
  const pg = new MemoryPg();
  const store = new IntelligenceProviderGovernanceStore(pg, { now: () => now });
  const profile = providerProfile({ failure_threshold: 2, open_cooldown_ms: 10_000 });

  const terminal = await requiredLease(store, profile, 'tenant-circuit');
  let state = await store.complete({
    tenant_id: 'tenant-circuit', lease_id: terminal, outcome: 'terminal_failure',
    error_code: 'provider_invalid_response'
  });
  assert.equal(state.consecutive_retryable_failures, 0);
  assert.equal(state.circuit_state, 'closed');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const leaseId = await requiredLease(store, profile, 'tenant-circuit');
    state = await store.complete({
      tenant_id: 'tenant-circuit', lease_id: leaseId, outcome: 'retryable_failure',
      error_code: 'provider_timeout'
    });
  }
  assert.equal(state.circuit_state, 'open');
  assert.deepEqual(state.circuit_transition, { from_state: 'closed', to_state: 'open' });
  assert.equal(state.opened_until, '2026-07-15T01:00:10.000Z');

  const open = await store.reserve({
    tenant_id: 'tenant-circuit', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(open.granted, false);
  if (open.granted) throw new Error('open circuit must reject reservations');
  assert.equal(open.reason, 'circuit_open');

  now = new Date('2026-07-15T01:00:10.001Z');
  const probe = await store.reserve({
    tenant_id: 'tenant-circuit', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(probe.granted, true);
  if (!probe.granted) throw new Error('half-open probe must be granted');
  assert.deepEqual(probe.circuit_transition, { from_state: 'open', to_state: 'half_open' });
  const competingProbe = await store.reserve({
    tenant_id: 'tenant-circuit', capability: 'translation', profile, route_attempt: 2
  });
  assert.equal(competingProbe.granted, false);
  if (competingProbe.granted) throw new Error('half-open circuit must allow one probe');
  assert.equal(competingProbe.reason, 'circuit_half_open_busy');

  state = await store.complete({
    tenant_id: 'tenant-circuit', lease_id: probe.lease_id, outcome: 'success'
  });
  assert.equal(state.circuit_state, 'closed');
  assert.deepEqual(state.circuit_transition, { from_state: 'half_open', to_state: 'closed' });
  assert.equal(state.consecutive_retryable_failures, 0);
  const runtime = await store.listRuntime('tenant-circuit');
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].profile_id, 'translation-primary');
  assert.doesNotMatch(JSON.stringify(runtime), /translation-worker|base_url|token|secret/i);
});

test('expired provider leases release concurrency without claiming success', async () => {
  let now = new Date('2026-07-15T02:00:00.000Z');
  const pg = new MemoryPg();
  const store = new IntelligenceProviderGovernanceStore(pg, { now: () => now });
  const profile = providerProfile({ max_concurrency: 1, reservation_ttl_ms: 6_000 });

  const abandoned = await requiredLease(store, profile, 'tenant-expiry');
  now = new Date('2026-07-15T02:00:06.001Z');
  const recovered = await store.reserve({
    tenant_id: 'tenant-expiry', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(recovered.granted, true);
  assert.notEqual(recovered.granted ? recovered.lease_id : '', abandoned);
});

test('new reservations automatically prune bounded completed lease history', async () => {
  let now = new Date('2026-07-15T02:00:00.000Z');
  const store = new IntelligenceProviderGovernanceStore(new MemoryPg(), {
    now: () => now,
    leaseRetentionMs: 60_000
  });
  const profile = providerProfile();
  const leaseId = await requiredLease(store, profile, 'tenant-retention');
  await store.complete({ tenant_id: 'tenant-retention', lease_id: leaseId, outcome: 'success' });
  now = new Date('2026-07-15T02:01:00.001Z');
  const next = await store.reserve({
    tenant_id: 'tenant-retention', capability: 'translation', profile, route_attempt: 1
  });
  assert.equal(next.granted, true);
  assert.equal(await store.pruneLeaseHistory({ tenant_id: 'tenant-retention', limit: 100 }), 0);
});

function providerProfile(overrides: Record<string, unknown> = {}) {
  return createIntelligenceProviderRegistry({
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([{
      id: 'translation-primary', capability: 'translation', mode: 'self_hosted',
      base_url: 'http://translation-worker:8080', timeout_ms: 1_000,
      reservation_ttl_ms: 35_000, ...overrides
    }])
  }).requireProfile('translation-primary', 'translation');
}

async function requiredLease(
  store: IntelligenceProviderGovernanceStore,
  profile: ReturnType<typeof providerProfile>,
  tenantId: string
): Promise<string> {
  const result = await store.reserve({
    tenant_id: tenantId, capability: 'translation', profile, route_attempt: 1
  });
  if (result.granted === false) throw new Error(`reservation denied: ${result.reason}`);
  return result.lease_id;
}
