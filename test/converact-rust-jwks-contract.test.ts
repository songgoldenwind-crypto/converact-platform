import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { _clearJwksCache, warmJwksCache } from '../src/middleware/auth.js';

type Decision = 'allowed' | 'denied';

interface Vector {
  name: string;
  recipe?: 'empty_keys' | 'too_many_keys' | 'duplicate_key' | 'invalid_root' | 'missing_keys';
  key_overrides?: Record<string, unknown>;
  key_remove?: string[];
  expected: Decision;
  target_expected?: Decision;
}

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-jwks-v1.json', import.meta.url),
  'utf8'
)) as {
  contract_version: number;
  source: string;
  source_sha256: string;
  base_key: Record<string, unknown>;
  cases: Vector[];
};

test('active TypeScript JWKS decoder replays the Rust migration corpus', async () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(fixture.source, 'src/middleware/auth.ts#decodeJwks');
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
      const document = documentFor(vector);
      globalThis.fetch = (async () => new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch;
      _clearJwksCache();
      let allowed = true;
      try {
        await warmJwksCache('https://identity.example.test');
      } catch {
        allowed = false;
      }
      assert.equal(allowed, vector.expected === 'allowed', vector.name);
    }
    assert.deepEqual(targetDivergences, [
      'encryption_key_operation',
      'weak_2041_bit_modulus',
      'noncanonical_modulus_encoding',
      'zero_exponent',
      'even_modulus',
      'even_exponent',
      'oversized_exponent'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    _clearJwksCache();
  }
});

function documentFor(vector: Vector): unknown {
  if (vector.recipe === 'invalid_root') return [];
  if (vector.recipe === 'missing_keys') return {};
  if (vector.recipe === 'empty_keys') return { keys: [] };
  const key = { ...fixture.base_key, ...vector.key_overrides };
  for (const field of vector.key_remove ?? []) delete key[field];
  if (vector.recipe === 'duplicate_key') return { keys: [key, { ...key }] };
  if (vector.recipe === 'too_many_keys') {
    return {
      keys: Array.from({ length: 65 }, (_, index) => ({
        ...key,
        kid: `identity-rs256-${index}`
      }))
    };
  }
  return { keys: [key] };
}
