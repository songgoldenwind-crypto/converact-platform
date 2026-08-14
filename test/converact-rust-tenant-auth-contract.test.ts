import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  evaluatePlatformAccess,
  type PlatformIdentityClaims
} from '../src/agent-runtime/converact/platform-foundation/identity.js';

interface AccessFixture {
  contract_version: number;
  source: string;
  base_claims: PlatformIdentityClaims;
  base_input: {
    resource_tenant_id: string;
    required_audience: string;
    required_capability: string;
    required_purpose: string;
    current_policy_version: number;
    current_revocation_epoch: number;
    wall_now: string;
  };
  timestamp_source: string;
  timestamp_vectors: Array<{ input: string; expected_epoch_ms: number | null }>;
  safe_integer_vectors: Array<{ input: string; expected: number | null }>;
  cases: Array<{
    name: string;
    claims_overrides: Record<string, unknown>;
    claims_utf16_overrides?: Record<string, number[]>;
    claims_remove?: string[];
    input_overrides: Record<string, unknown>;
    expected: { allowed: true } | { allowed: false; reason: string };
  }>;
}

test('Rust tenant auth vectors replay the active TypeScript access policy', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('../server-rs/tests/fixtures/platform-access-v1.json', import.meta.url),
    'utf8'
  )) as AccessFixture;
  assert.equal(fixture.contract_version, 1);
  assert.equal(
    fixture.source,
    'src/agent-runtime/converact/platform-foundation/identity.ts#evaluatePlatformAccess'
  );
  assert.equal(fixture.cases.length, 26);
  assert.equal(
    fixture.timestamp_source,
    'src/agent-runtime/converact/platform-foundation/identity.ts#canonicalTimestamp'
  );

  for (const vector of fixture.timestamp_vectors) {
    const parsed = Date.parse(vector.input);
    const actual = Number.isFinite(parsed) && new Date(parsed).toISOString() === vector.input
      ? parsed
      : null;
    assert.equal(actual, vector.expected_epoch_ms, vector.input);
  }

  for (const vector of fixture.safe_integer_vectors) {
    const value = JSON.parse(vector.input) as unknown;
    const actual = typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 0
      ? (Object.is(value, -0) ? 0 : value)
      : null;
    assert.equal(actual, vector.expected, vector.input);
  }

  for (const vector of fixture.cases) {
    const claims = { ...fixture.base_claims, ...vector.claims_overrides } as PlatformIdentityClaims;
    for (const [field, units] of Object.entries(vector.claims_utf16_overrides ?? {})) {
      (claims as unknown as Record<string, unknown>)[field] = String.fromCharCode(...units);
    }
    for (const field of vector.claims_remove ?? []) {
      delete (claims as unknown as Record<string, unknown>)[field];
    }
    const input = { ...fixture.base_input, ...vector.input_overrides };
    assert.deepEqual(evaluatePlatformAccess({
      claims,
      resource_tenant_id: String(input.resource_tenant_id),
      required_audience: String(input.required_audience),
      required_capability: String(input.required_capability),
      required_purpose: String(input.required_purpose),
      current_policy_version: Number(input.current_policy_version),
      current_revocation_epoch: Number(input.current_revocation_epoch),
      wall_now: new Date(input.wall_now)
    }), vector.expected, vector.name);
  }
});
