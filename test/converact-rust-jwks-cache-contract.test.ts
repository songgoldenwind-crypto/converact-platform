import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setImmediate as settle } from 'node:timers/promises';
import { test } from 'node:test';
import {
  _clearJwksCache,
  _injectJwksForTest,
  resolveAuthContext
} from '../src/middleware/auth.js';

type Availability = 'ready' | 'unavailable' | 'clock_regressed';

interface ExpectedDecision {
  availability: Availability;
  refresh_started: boolean;
}

interface Step {
  name: string;
  at_ms: number;
  key: 'known' | 'unknown';
  expected: ExpectedDecision;
  target_expected?: ExpectedDecision;
}

interface Sequence {
  name: string;
  seed_at_ms: number;
  fetch_mode: 'reject' | 'pending';
  steps: Step[];
}

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-jwks-cache-v1.json', import.meta.url),
  'utf8'
)) as {
  contract_version: number;
  source: string;
  source_sha256: string;
  known_key_id: string;
  unknown_key_id: string;
  sequences: Sequence[];
};

const rs256Fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-rs256-v1.json', import.meta.url),
  'utf8'
)) as {
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
  tokens: { valid: string };
};

test('active TypeScript JWKS cache replays the Rust lifecycle corpus', async () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(
    fixture.source,
    'src/middleware/auth.ts#jwksCache+fetchJwks+queueJwksRefresh+jwksCacheAgeMs'
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('../src/middleware/auth.ts', import.meta.url)))
      .digest('hex'),
    fixture.source_sha256
  );
  assert.equal(rs256Fixture.public_jwk.kid, fixture.known_key_id);

  const restoreEnvironment = installFixtureEnvironment();
  const originalFetch = globalThis.fetch;
  const originalNow = performance.now.bind(performance);
  let monotonicNow = 0;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => monotonicNow
  });
  try {
    const targetDivergences: string[] = [];
    for (const sequence of fixture.sequences) {
      _clearJwksCache();
      monotonicNow = sequence.seed_at_ms;
      _injectJwksForTest(rs256Fixture.policy.expected_issuer, [rs256Fixture.public_jwk]);
      let requests = 0;
      let rejectPending: ((reason?: unknown) => void) | undefined;
      globalThis.fetch = (() => {
        requests += 1;
        if (sequence.fetch_mode === 'pending') {
          return new Promise<Response>((_resolve, reject) => {
            rejectPending = reject;
          });
        }
        return Promise.reject(new Error('fixture_refresh_failed'));
      }) as typeof fetch;

      for (const step of sequence.steps) {
        if (step.target_expected !== undefined) targetDivergences.push(step.name);
        monotonicNow = step.at_ms;
        const before = requests;
        let availability: Availability = 'unavailable';
        try {
          availability = resolveAuthContext({
            authorization: `Bearer ${tokenFor(step.key)}`
          }).authenticated ? 'ready' : 'unavailable';
        } catch {
          availability = 'unavailable';
        }
        await settle();
        assert.deepEqual(
          { availability, refresh_started: requests > before },
          step.expected,
          `${sequence.name}/${step.name}`
        );
      }
      rejectPending?.(new Error('fixture_pending_refresh_released'));
      await settle();
    }
    assert.deepEqual(targetDivergences, ['clock_regression_fails_closed']);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: originalNow
    });
    _clearJwksCache();
    restoreEnvironment();
  }
});

function tokenFor(key: 'known' | 'unknown'): string {
  if (key === 'known') return rs256Fixture.tokens.valid;
  const [headerRaw, payloadRaw, signatureRaw] = rs256Fixture.tokens.valid.split('.');
  assert.ok(headerRaw && payloadRaw && signatureRaw);
  const header = JSON.parse(Buffer.from(headerRaw, 'base64url').toString('utf8')) as Record<string, unknown>;
  header.kid = fixture.unknown_key_id;
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payloadRaw}.${signatureRaw}`;
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
  delete process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_AUTH_ISSUER = rs256Fixture.policy.expected_issuer;
  process.env.CONVERACT_AUTH_AUDIENCE = rs256Fixture.policy.expected_audience;
  process.env.CONVERACT_AUTH_POLICY_VERSION = String(rs256Fixture.policy.current_policy_version);
  process.env.CONVERACT_AUTH_REVOCATION_EPOCH = String(rs256Fixture.policy.current_revocation_epoch);
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
