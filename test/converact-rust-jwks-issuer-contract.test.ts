import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { _clearJwksCache, warmJwksCache } from '../src/middleware/auth.js';

interface Vector {
  name: string;
  issuer: string;
  target_policy: 'https_only' | 'explicit_loopback_http';
  expected: 'allowed' | 'denied';
  expected_jwks_url?: string;
  target_expected?: 'allowed' | 'denied';
  target_jwks_url?: string;
}

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-jwks-issuer-v1.json', import.meta.url),
  'utf8'
)) as {
  contract_version: number;
  source: string;
  source_sha256: string;
  cases: Vector[];
};

const jwksFixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-rs256-v1.json', import.meta.url),
  'utf8'
)) as { public_jwk: Record<string, unknown> };

test('active TypeScript issuer URL builder replays the Rust migration corpus', async () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(fixture.source, 'src/middleware/auth.ts#jwksUrl');
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('../src/middleware/auth.ts', import.meta.url)))
      .digest('hex'),
    fixture.source_sha256
  );

  const originalFetch = globalThis.fetch;
  const targetDivergences: string[] = [];
  try {
    for (const vector of fixture.cases) {
      if (vector.target_expected !== undefined) targetDivergences.push(vector.name);
      _clearJwksCache();
      let fetchedUrl: string | undefined;
      globalThis.fetch = (async (input) => {
        fetchedUrl = String(input);
        return new Response(JSON.stringify({ keys: [jwksFixture.public_jwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }) as typeof fetch;
      let allowed = true;
      try {
        await warmJwksCache(vector.issuer);
      } catch {
        allowed = false;
      }
      assert.equal(allowed, vector.expected === 'allowed', vector.name);
      if (vector.expected === 'allowed') {
        assert.equal(fetchedUrl, vector.expected_jwks_url, vector.name);
      } else {
        assert.equal(fetchedUrl, undefined, `${vector.name} must reject before fetch`);
      }
    }
    assert.deepEqual(targetDivergences, [
      'query_and_fragment_are_not_authority',
      'credentials_are_not_authority',
      'empty_userinfo_is_not_authority',
      'leading_whitespace_is_rejected',
      'embedded_ascii_whitespace_is_rejected',
      'trailing_dot_host_is_rejected',
      'zero_port_is_rejected',
      'loopback_http_requires_explicit_policy',
      'ipv6_loopback_supported_when_explicit'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    _clearJwksCache();
  }
});
