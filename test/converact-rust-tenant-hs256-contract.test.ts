import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveAuthContext } from '../src/middleware/auth.js';

interface Vector {
  name: string;
  recipe?: 'frozen' | 'invalid_signature' | 'signature_padding';
  header_overrides?: Record<string, unknown>;
  payload_overrides?: Record<string, unknown>;
  payload_remove?: string[];
  expected: 'allowed' | 'denied';
  target_expected?: 'allowed' | 'denied';
}

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-hs256-v1.json', import.meta.url),
  'utf8'
)) as {
  contract_version: number;
  source: string;
  source_sha256: string;
  test_key_utf8: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  policy: {
    expected_issuer: string;
    expected_audience: string;
    expected_key_id: string;
    current_policy_version: number;
    current_revocation_epoch: number;
  };
  frozen_valid_token: string;
  cases: Vector[];
};

test('active TypeScript HS256 verifier replays the Rust migration corpus', () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(
    fixture.source,
    'src/middleware/auth.ts#verifyHs256Jwt+validatePlatformJwtPayload'
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('../src/middleware/auth.ts', import.meta.url)))
      .digest('hex'),
    fixture.source_sha256
  );
  const restore = installFixtureEnvironment();
  try {
    const intentionalTargetDivergences: string[] = [];
    for (const vector of fixture.cases) {
      if (vector.target_expected !== undefined) intentionalTargetDivergences.push(vector.name);
      const token = tokenFor(vector);
      let allowed = false;
      try {
        const identity = resolveAuthContext({ authorization: `Bearer ${token}` });
        allowed = identity.authenticated;
        if (vector.expected === 'allowed') {
          assert.equal(identity.tenantId, 'tenant-1', vector.name);
          assert.equal(identity.userId, 'user-1', vector.name);
          assert.equal(identity.role, 'operator', vector.name);
        }
      } catch {
        allowed = false;
      }
      assert.equal(allowed, vector.expected === 'allowed', vector.name);
    }
    assert.deepEqual(intentionalTargetDivergences, ['hs256_cannot_claim_mtls']);
  } finally {
    restore();
  }
});

function tokenFor(vector: Vector): string {
  if (vector.recipe === 'frozen') return fixture.frozen_valid_token;
  if (vector.recipe === 'invalid_signature') {
    return `${fixture.frozen_valid_token.slice(0, -1)}A`;
  }
  if (vector.recipe === 'signature_padding') return `${fixture.frozen_valid_token}=`;
  const header = { ...fixture.header, ...vector.header_overrides };
  const payload = { ...fixture.payload, ...vector.payload_overrides };
  for (const field of vector.payload_remove ?? []) delete payload[field];
  const headerPart = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = createHmac('sha256', fixture.test_key_utf8)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

function installFixtureEnvironment(): () => void {
  const keys = [
    'NODE_ENV',
    'CONVERACT_AUTH_DISABLED',
    'CONVERACT_JWT_SECRET',
    'CONVERACT_AUTH_TOKEN_ISSUER',
    'CONVERACT_AUTH_AUDIENCE',
    'CONVERACT_AUTH_KEY_ID',
    'CONVERACT_AUTH_POLICY_VERSION',
    'CONVERACT_AUTH_REVOCATION_EPOCH'
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  delete process.env.CONVERACT_AUTH_DISABLED;
  process.env.CONVERACT_JWT_SECRET = fixture.test_key_utf8;
  process.env.CONVERACT_AUTH_TOKEN_ISSUER = fixture.policy.expected_issuer;
  process.env.CONVERACT_AUTH_AUDIENCE = fixture.policy.expected_audience;
  process.env.CONVERACT_AUTH_KEY_ID = fixture.policy.expected_key_id;
  process.env.CONVERACT_AUTH_POLICY_VERSION = String(fixture.policy.current_policy_version);
  process.env.CONVERACT_AUTH_REVOCATION_EPOCH = String(fixture.policy.current_revocation_epoch);
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
