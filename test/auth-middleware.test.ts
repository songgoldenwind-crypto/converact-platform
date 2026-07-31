import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { _clearJwksCache, _injectJwksForTest, resolveAuthContext } from '../src/middleware/auth.js';

test('dev mode: X-API-Key matching OPC_API_KEY returns system context', () => {
  const original = process.env.OPC_AUTH_DISABLED;
  const originalKey = process.env.OPC_API_KEY;
  try {
    process.env.OPC_AUTH_DISABLED = '1';
    process.env.OPC_API_KEY = 'test-secret-key';

    const ctx = resolveAuthContext({
      'x-api-key': 'test-secret-key',
      'x-tenant-id': 'tenant_abc'
    });

    assert.equal(ctx.role, 'system');
    assert.equal(ctx.userId, 'system');
    assert.equal(ctx.tenantId, 'tenant_abc');
    assert.equal(ctx.authenticated, true);
  } finally {
    process.env.OPC_AUTH_DISABLED = original;
    process.env.OPC_API_KEY = originalKey;
  }
});

test('dev mode: X-API-Key with no OPC_API_KEY env does not grant system role', () => {
  const original = process.env.OPC_AUTH_DISABLED;
  const originalKey = process.env.OPC_API_KEY;
  try {
    process.env.OPC_AUTH_DISABLED = '1';
    delete process.env.OPC_API_KEY;

    const ctx = resolveAuthContext({
      'x-api-key': 'some-key',
      'x-tenant-id': 'tenant_abc',
      'x-user-id': 'user_1'
    });

    assert.notEqual(ctx.role, 'system');
    assert.equal(ctx.tenantId, 'tenant_abc');
    assert.equal(ctx.userId, 'user_1');
  } finally {
    process.env.OPC_AUTH_DISABLED = original;
    process.env.OPC_API_KEY = originalKey;
  }
});

test('dev mode: X-Tenant-Id + X-User-Id returns custom context', () => {
  const original = process.env.OPC_AUTH_DISABLED;
  try {
    process.env.OPC_AUTH_DISABLED = '1';

    const ctx = resolveAuthContext({
      'x-tenant-id': 'tenant_xyz',
      'x-user-id': 'user_42',
      'x-role': 'admin'
    });

    assert.equal(ctx.tenantId, 'tenant_xyz');
    assert.equal(ctx.userId, 'user_42');
    assert.equal(ctx.role, 'admin');
    assert.equal(ctx.authenticated, false);
  } finally {
    process.env.OPC_AUTH_DISABLED = original;
  }
});

test('dev mode: invalid role falls back to operator', () => {
  const original = process.env.OPC_AUTH_DISABLED;
  try {
    process.env.OPC_AUTH_DISABLED = '1';

    const ctx = resolveAuthContext({
      'x-tenant-id': 'tenant_xyz',
      'x-user-id': 'user_42',
      'x-role': 'superadmin'
    });

    assert.equal(ctx.role, 'operator');
  } finally {
    process.env.OPC_AUTH_DISABLED = original;
  }
});

test('dev mode: tenant-only header returns viewer context', () => {
  const original = process.env.OPC_AUTH_DISABLED;
  try {
    process.env.OPC_AUTH_DISABLED = '1';

    const ctx = resolveAuthContext({
      'x-tenant-id': 'tenant_xyz'
    });

    assert.equal(ctx.tenantId, 'tenant_xyz');
    assert.equal(ctx.userId, 'anonymous');
    assert.equal(ctx.role, 'viewer');
  } finally {
    process.env.OPC_AUTH_DISABLED = original;
  }
});

test('dev mode: empty headers return empty context', () => {
  const original = process.env.OPC_AUTH_DISABLED;
  try {
    process.env.OPC_AUTH_DISABLED = '1';

    const ctx = resolveAuthContext({});

    assert.equal(ctx.tenantId, '');
    assert.equal(ctx.userId, '');
    assert.equal(ctx.role, 'viewer');
    assert.equal(ctx.authenticated, false);
  } finally {
    process.env.OPC_AUTH_DISABLED = original;
  }
});

test('auth required: missing Authorization header throws 401', () => {
  const origDisabled = process.env.OPC_AUTH_DISABLED;
  const origIssuer = process.env.OPC_AUTH_ISSUER;
  try {
    delete process.env.OPC_AUTH_DISABLED;
    process.env.OPC_AUTH_ISSUER = 'https://auth.example.com';

    assert.throws(
      () => resolveAuthContext({}),
      (err: any) => {
        assert.equal(err.status, 401);
        assert.match(err.message, /Authorization/);
        return true;
      }
    );
  } finally {
    process.env.OPC_AUTH_DISABLED = origDisabled;
    process.env.OPC_AUTH_ISSUER = origIssuer;
  }
});

test('auth required: non-Bearer token throws 401', () => {
  const origDisabled = process.env.OPC_AUTH_DISABLED;
  const origIssuer = process.env.OPC_AUTH_ISSUER;
  try {
    delete process.env.OPC_AUTH_DISABLED;
    process.env.OPC_AUTH_ISSUER = 'https://auth.example.com';

    assert.throws(
      () => resolveAuthContext({ authorization: 'Basic dXNlcjpwYXNz' }),
      (err: any) => {
        assert.equal(err.status, 401);
        return true;
      }
    );
  } finally {
    process.env.OPC_AUTH_DISABLED = origDisabled;
    process.env.OPC_AUTH_ISSUER = origIssuer;
  }
});

test('RS256 auth requires a signed tenant claim and never trusts X-Tenant-Id', () => {
  const originalDisabled = process.env.OPC_AUTH_DISABLED;
  const originalIssuer = process.env.OPC_AUTH_ISSUER;
  const originalSecret = process.env.OPC_JWT_SECRET;
  const issuer = 'https://auth.example.test';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  try {
    delete process.env.OPC_AUTH_DISABLED;
    delete process.env.OPC_JWT_SECRET;
    process.env.OPC_AUTH_ISSUER = issuer;
    _injectJwksForTest(issuer, [{
      kty: String(jwk.kty),
      kid: 'auth-test-key',
      n: String(jwk.n),
      e: String(jwk.e),
      use: 'sig',
      alg: 'RS256'
    }]);

    const withoutTenant = signRs256({ sub: 'user-1', iss: issuer, exp: futureEpoch() }, privateKey);
    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${withoutTenant}`, 'x-tenant-id': 'attacker-tenant' }),
      (error: any) => error.status === 403 && /signed tenant/i.test(error.message)
    );

    const signedTenant = signRs256({
      sub: 'user-1', tenant_id: 'signed-tenant', role: 'operator', iss: issuer, exp: futureEpoch()
    }, privateKey);
    const context = resolveAuthContext({
      authorization: `Bearer ${signedTenant}`,
      'x-tenant-id': 'attacker-tenant'
    });
    assert.equal(context.tenantId, 'signed-tenant');
    assert.equal(context.userId, 'user-1');
  } finally {
    _clearJwksCache();
    process.env.OPC_AUTH_DISABLED = originalDisabled;
    process.env.OPC_AUTH_ISSUER = originalIssuer;
    process.env.OPC_JWT_SECRET = originalSecret;
  }
});

function futureEpoch(): number {
  return Math.floor(Date.now() / 1000) + 60;
}

function signRs256(payload: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'auth-test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}
