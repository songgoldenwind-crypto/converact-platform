import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { _clearJwksCache, warmJwksCache } from '../src/middleware/auth.js';

interface Vector {
  name: string;
  status: number;
  content_type?: string;
  content_length?: string;
  body: BodyKind;
  expected: 'allowed' | 'denied';
  target_expected?: 'allowed' | 'denied';
}

type BodyKind =
  | 'valid_jwks'
  | 'valid_jwks_exact_limit'
  | 'valid_jwks_over_limit'
  | 'invalid_utf8'
  | 'malformed_json'
  | 'empty';

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-jwks-response-v1.json', import.meta.url),
  'utf8'
)) as {
  contract_version: number;
  source: string;
  source_sha256: string;
  max_response_bytes: number;
  cases: Vector[];
};

const publicJwk = (JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-rs256-v1.json', import.meta.url),
  'utf8'
)) as { public_jwk: Record<string, unknown> }).public_jwk;

test('active TypeScript JWKS response path replays the Rust migration corpus', async () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(fixture.max_response_bytes, 131_072);
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('../src/middleware/auth.ts', import.meta.url)))
      .digest('hex'),
    fixture.source_sha256
  );

  const originalFetch = globalThis.fetch;
  const divergences: string[] = [];
  try {
    for (const vector of fixture.cases) {
      _clearJwksCache();
      const body = responseBody(vector.body, fixture.max_response_bytes);
      const headers = new Headers();
      if (vector.content_type !== undefined) headers.set('content-type', vector.content_type);
      if (vector.content_length !== undefined) {
        headers.set(
          'content-length',
          vector.content_length === 'actual' ? String(body.byteLength) : vector.content_length
        );
      }
      globalThis.fetch = (async () => new Response(body, {
        status: vector.status,
        headers
      })) as typeof fetch;

      let allowed = true;
      try {
        await warmJwksCache('https://auth.example.test');
      } catch {
        allowed = false;
      }
      assert.equal(allowed, vector.expected === 'allowed', vector.name);
      if (vector.target_expected !== undefined) divergences.push(vector.name);
    }
    assert.deepEqual(divergences, [
      'missing_content_type_is_rejected',
      'text_plain_is_rejected',
      'non_200_success_is_rejected',
      'declared_length_mismatch_is_rejected'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    _clearJwksCache();
  }
});

function responseBody(kind: BodyKind, limit: number): Uint8Array {
  const valid = JSON.stringify({ keys: [publicJwk] });
  switch (kind) {
    case 'valid_jwks':
      return Buffer.from(valid);
    case 'valid_jwks_exact_limit': {
      const seed = JSON.stringify({ keys: [publicJwk], padding: '' });
      assert.ok(seed.length <= limit);
      const body = JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(limit - seed.length) });
      assert.equal(Buffer.byteLength(body), limit);
      return Buffer.from(body);
    }
    case 'valid_jwks_over_limit': {
      const exact = responseBody('valid_jwks_exact_limit', limit);
      return Buffer.concat([exact, Buffer.from(' ')]);
    }
    case 'invalid_utf8':
      return Uint8Array.of(0xff);
    case 'malformed_json':
      return Buffer.from('{');
    case 'empty':
      return new Uint8Array();
  }
}
