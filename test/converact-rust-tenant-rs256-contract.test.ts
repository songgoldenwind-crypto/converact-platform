import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  _clearJwksCache,
  _injectJwksForTest,
  resolveAuthContext
} from '../src/middleware/auth.js';

type Decision = 'allowed' | 'denied';

interface Vector {
  name: string;
  token_ref?: string;
  recipe?:
    | 'header_override'
    | 'header_remove_key'
    | 'invalid_signature'
    | 'signature_padding'
    | 'short_signature';
  header_overrides?: Record<string, unknown>;
  expected: Decision;
  target_expected?: Decision;
}

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-rs256-v1.json', import.meta.url),
  'utf8'
)) as {
  contract_version: number;
  source: string;
  source_sha256: string;
  public_jwk: {
    kty: string;
    kid: string;
    n: string;
    e: string;
    use: string;
    alg: string;
  };
  policy: {
    expected_issuer: string;
    expected_audience: string;
    current_policy_version: number;
    current_revocation_epoch: number;
  };
  tokens: Record<string, string>;
  cases: Vector[];
};

test('active TypeScript RS256 verifier replays the Rust migration corpus', () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(
    fixture.source,
    'src/middleware/auth.ts#verifyJwt+validatePlatformJwtPayload'
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('../src/middleware/auth.ts', import.meta.url)))
      .digest('hex'),
    fixture.source_sha256
  );

  const restore = installFixtureEnvironment();
  try {
    _injectJwksForTest(fixture.policy.expected_issuer, [fixture.public_jwk]);
    const intentionalTargetDivergences: string[] = [];
    for (const vector of fixture.cases) {
      if (vector.target_expected !== undefined) intentionalTargetDivergences.push(vector.name);
      let allowed = false;
      try {
        const identity = resolveAuthContext({ authorization: `Bearer ${tokenFor(vector)}` });
        allowed = identity.authenticated;
        if (vector.expected === 'allowed') {
          assert.equal(identity.tenantId, 'tenant-rs', vector.name);
          assert.equal(identity.userId, 'user-rs', vector.name);
          assert.equal(identity.role, 'operator', vector.name);
        }
      } catch {
        allowed = false;
      }
      assert.equal(allowed, vector.expected === 'allowed', vector.name);
    }
    assert.deepEqual(intentionalTargetDivergences, [
      'rs256_cannot_claim_mtls',
      'duplicate_tenant_claim'
    ]);
  } finally {
    restore();
    _clearJwksCache();
  }
});

function tokenFor(vector: Vector): string {
  if (vector.token_ref !== undefined) {
    const token = fixture.tokens[vector.token_ref];
    assert.ok(token, `missing frozen token ${vector.token_ref}`);
    return token;
  }
  const valid = fixture.tokens.valid;
  assert.ok(valid, 'missing frozen valid token');
  const [headerRaw, payloadRaw, signatureRaw] = valid.split('.');
  assert.ok(headerRaw && payloadRaw && signatureRaw, 'malformed frozen valid token');
  if (vector.recipe === 'header_override' || vector.recipe === 'header_remove_key') {
    const header = JSON.parse(Buffer.from(headerRaw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (vector.recipe === 'header_remove_key') delete header.kid;
    else Object.assign(header, vector.header_overrides);
    return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payloadRaw}.${signatureRaw}`;
  }
  if (vector.recipe === 'invalid_signature') {
    const replacement = signatureRaw.startsWith('A') ? 'B' : 'A';
    return `${headerRaw}.${payloadRaw}.${replacement}${signatureRaw.slice(1)}`;
  }
  if (vector.recipe === 'signature_padding') return `${valid}=`;
  if (vector.recipe === 'short_signature') {
    return `${headerRaw}.${payloadRaw}.${Buffer.alloc(255).toString('base64url')}`;
  }
  throw new Error(`unknown vector recipe: ${vector.name}`);
}

function installFixtureEnvironment(): () => void {
  const keys = [
    'NODE_ENV',
    'CONVERACT_AUTH_DISABLED',
    'CONVERACT_JWT_SECRET',
    'CONVERACT_AUTH_ISSUER',
    'CONVERACT_AUTH_AUDIENCE',
    'CONVERACT_AUTH_POLICY_VERSION',
    'CONVERACT_AUTH_REVOCATION_EPOCH'
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  delete process.env.CONVERACT_AUTH_DISABLED;
  process.env.CONVERACT_JWT_SECRET = 'test-only-wrong-algorithm-key';
  process.env.CONVERACT_AUTH_ISSUER = fixture.policy.expected_issuer;
  process.env.CONVERACT_AUTH_AUDIENCE = fixture.policy.expected_audience;
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
