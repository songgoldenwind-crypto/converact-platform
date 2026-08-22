import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { ConveractFabricAuditService } from '../src/agent-runtime/converact/operations/audit/service.js';
import type { ConveractFabricAuditRepository } from '../src/agent-runtime/converact/operations/audit/ports.js';
import type {
  ConveractFabricAuditAppendInput,
  ConveractFabricAuditListInput,
  ConveractFabricAuditRequest
} from '../src/agent-runtime/converact/operations/audit/types.js';

const fixtureUrl = new URL('../server-rs/tests/fixtures/audit-ip-hmac-v1.json', import.meta.url);

interface AuditIpHmacFixture {
  contract_version: number;
  current_sources: Array<{ path: string; sha256: string }>;
  key_base64: string;
  valid_cases: Array<{
    name: string;
    source_ip_present: boolean;
    source_ip: string | null;
    normalized_ip: string;
    expected_hmac: string;
  }>;
  accepted_keys: string[];
  rejected_keys: string[];
  invalid_source_ips: string[];
  target_scope: {
    pure_contract_only: boolean;
    database_writer: boolean;
    runtime_route: boolean;
    server_or_container_change: boolean;
  };
}

test('Rust audit IP HMAC compatibility fixture exists', () => {
  assert.equal(
    existsSync(fixtureUrl),
    true,
    'freeze the active TypeScript IP normalization and HMAC outputs first'
  );
});

test('Rust audit IP HMAC vectors replay the active TypeScript service', async () => {
  const fixture = readFixture();
  assert.equal(fixture.contract_version, 1);

  for (const source of fixture.current_sources) {
    const bytes = readFileSync(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.path);
  }

  for (const vector of fixture.valid_cases) {
    const repository = new CapturingAuditRepository();
    const service = serviceWith(repository, fixture.key_base64);
    const request: ConveractFabricAuditRequest = baseRequest(vector.name);
    if (vector.source_ip_present) request.source_ip = vector.source_ip as string;

    await service.append(request);
    assert.equal(repository.last_append?.source_ip_hmac, vector.expected_hmac, vector.name);
  }
});

test('Rust audit IP HMAC key acceptance matches active TypeScript', () => {
  const fixture = readFixture();
  for (const key of fixture.accepted_keys) {
    assert.doesNotThrow(() => serviceWith(new CapturingAuditRepository(), key), key);
  }
  for (const key of fixture.rejected_keys) {
    assert.throws(
      () => serviceWith(new CapturingAuditRepository(), key),
      isValidationFailure,
      JSON.stringify(key)
    );
  }
});

test('Rust audit IP rejection matches active TypeScript', async () => {
  const fixture = readFixture();
  for (const sourceIp of fixture.invalid_source_ips) {
    const service = serviceWith(new CapturingAuditRepository(), fixture.key_base64);
    await assert.rejects(
      service.append({ ...baseRequest(sourceIp), source_ip: sourceIp }),
      isValidationFailure,
      JSON.stringify(sourceIp)
    );
  }
});

test('Rust audit IP HMAC slice remains pure and default-disabled', () => {
  const fixture = readFixture();
  assert.deepEqual(fixture.target_scope, {
    pure_contract_only: true,
    database_writer: false,
    runtime_route: false,
    server_or_container_change: false
  });

  const manifest = readFileSync(new URL('../server-rs/crates/audit/Cargo.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(manifest, /tokio|postgres|axum|reqwest/);
});

function readFixture(): AuditIpHmacFixture {
  return JSON.parse(readFileSync(fixtureUrl, 'utf8')) as AuditIpHmacFixture;
}

function serviceWith(repository: ConveractFabricAuditRepository, key: string) {
  return new ConveractFabricAuditService({
    repository,
    ip_hmac_key: key,
    now: () => new Date('2026-07-15T08:00:00.000Z')
  });
}

function baseRequest(idempotencyKey: string): ConveractFabricAuditRequest {
  return {
    tenant_id: 'tenant-a',
    actor_id: 'admin-a',
    actor_role: 'admin',
    action: 'audit.test',
    resource_type: 'audit',
    resource_id: 'audit-a',
    business_ref: { type: 'audit', id: 'audit-a' },
    request_id: 'request-a',
    idempotency_key: idempotencyKey,
    result: 'succeeded',
    policy_decision: 'allow',
    metadata: { status: 'active' }
  };
}

function isValidationFailure(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error
      && (error as { code: string }).code === 'validation_failed'
  );
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
