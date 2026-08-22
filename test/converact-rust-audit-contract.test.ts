import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { ConveractFabricAuditService } from '../src/agent-runtime/converact/operations/audit/service.js';
import { PostgresConveractFabricAuditStore } from '../src/agent-runtime/converact/operations/audit/postgres-store.js';
import type { ConveractFabricAuditRepository } from '../src/agent-runtime/converact/operations/audit/ports.js';
import type {
  ConveractFabricAuditAppendInput,
  ConveractFabricAuditListInput
} from '../src/agent-runtime/converact/operations/audit/types.js';

const fixtureUrl = new URL('../server-rs/tests/fixtures/audit-record-v1.json', import.meta.url);

interface AuditFixture {
  contract_version: number;
  baseline_commit: string;
  current_sources: Array<{ path: string; sha256: string }>;
  base_append: ConveractFabricAuditAppendInput;
  hash_cases: Array<{
    name: string;
    overrides: Partial<ConveractFabricAuditAppendInput>;
    previous_hash: string;
    expected_hash: string;
  }>;
  target_scope: {
    pure_contract_only: boolean;
    database_writer: boolean;
    runtime_route: boolean;
    server_or_container_change: boolean;
  };
}

test('Rust audit compatibility fixture exists', () => {
  assert.equal(
    existsSync(fixtureUrl),
    true,
    'write the exact-source audit fixture before implementing the Rust contract'
  );
});

test('Rust audit vectors replay the active TypeScript hash-chain contract', async () => {
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as AuditFixture;
  assert.equal(fixture.contract_version, 1);
  assert.equal(fixture.hash_cases.length >= 4, true);

  for (const source of fixture.current_sources) {
    const bytes = readFileSync(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.path);
  }

  for (const vector of fixture.hash_cases) {
    const input = { ...structuredClone(fixture.base_append), ...structuredClone(vector.overrides) };
    const pg = new RecordingPg((sql, params) => {
      if (/SELECT event_hash FROM ivekit_audit_events/i.test(sql)) {
        return vector.previous_hash === '0'.repeat(64)
          ? []
          : [{ event_hash: vector.previous_hash }];
      }
      if (/INSERT INTO ivekit_audit_events/i.test(sql)) {
        return [eventRow(input, {
          id: String(params[0]),
          previous_hash: String(params[16]),
          event_hash: String(params[17]),
          metadata: String(params[14]),
          occurred_at: String(params[15]),
          retention_until: params[18],
          legal_hold: params[19]
        })];
      }
      return [];
    });
    const result = await new PostgresConveractFabricAuditStore(pg, { id: () => 'audit-a' })
      .append(input);
    assert.equal(result.event.previous_hash, vector.previous_hash, vector.name);
    assert.equal(result.event.event_hash, vector.expected_hash, vector.name);
  }
});

test('Rust audit slice remains pure and default-disabled', () => {
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as AuditFixture;
  assert.deepEqual(fixture.target_scope, {
    pure_contract_only: true,
    database_writer: false,
    runtime_route: false,
    server_or_container_change: false
  });

  const workspace = readFileSync(new URL('../server-rs/Cargo.toml', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../server-rs/crates/audit/Cargo.toml', import.meta.url), 'utf8');
  assert.match(workspace, /"crates\/audit"/);
  assert.match(manifest, /name = "converact-audit"/);
  assert.doesNotMatch(manifest, /tokio|postgres|axum|reqwest/);
});

test('Rust edge vectors are witnessed by the active TypeScript normalizer', async () => {
  const repository = new CapturingAuditRepository();
  const service = new ConveractFabricAuditService({
    repository,
    ip_hmac_key: Buffer.alloc(32, 4).toString('base64'),
    now: () => new Date('2026-07-15T08:00:00.000Z')
  });
  const request = {
    tenant_id: 'tenant-a',
    actor_id: '\u0085actor\u0085',
    actor_role: 'admin' as const,
    action: 'audit.test',
    resource_type: 'audit',
    resource_id: 'audit-a',
    business_ref: { type: 'audit', id: 'audit-a' },
    request_id: 'request-a',
    idempotency_key: 'audit-edge-a',
    result: 'succeeded' as const,
    policy_decision: 'allow' as const,
    metadata: { status: 'active' }
  };

  await service.append(request);
  assert.equal(repository.last_append?.actor_id, '\u0085actor\u0085');

  await assert.rejects(
    service.append({
      ...request,
      idempotency_key: 'audit-edge-b',
      metadata: { subject: '+12\u00a0345\u00a06789' }
    }),
    (error: unknown) => Boolean(
      error && typeof error === 'object' && 'code' in error
      && (error as { code: string }).code === 'validation_failed'
    )
  );
});

class RecordingPg implements PgQueryable {
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[]) {}

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

class CapturingAuditRepository implements ConveractFabricAuditRepository {
  last_append?: ConveractFabricAuditAppendInput;

  async append(input: ConveractFabricAuditAppendInput) {
    this.last_append = input;
    return {
      event: {
        ...input,
        id: 'audit-a',
        previous_hash: '0'.repeat(64),
        event_hash: 'a'.repeat(64),
        created_at: '2026-07-15T08:00:00.000Z'
      },
      created: true
    };
  }

  async list(_input: ConveractFabricAuditListInput) {
    return { items: [], next_cursor: null };
  }
}

function eventRow(
  input: ConveractFabricAuditAppendInput,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: 'audit-a',
    ...input,
    previous_hash: '0'.repeat(64),
    event_hash: 'a'.repeat(64),
    created_at: '2026-07-15T08:00:00.000Z',
    ...overrides
  };
}
