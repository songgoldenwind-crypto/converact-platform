import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  _clearJwksCache,
  _injectJwksForTest,
  resolveAuthContext,
  signAccessToken
} from '../src/middleware/auth.js';

test('dev mode: X-API-Key matching CONVERACT_API_KEY returns system context', () => {
  const original = process.env.CONVERACT_AUTH_DISABLED;
  const originalKey = process.env.CONVERACT_API_KEY;
  try {
    process.env.CONVERACT_AUTH_DISABLED = '1';
    process.env.CONVERACT_API_KEY = 'test-secret-key';

    const ctx = resolveAuthContext({
      'x-api-key': 'test-secret-key',
      'x-tenant-id': 'tenant_abc'
    });

    assert.equal(ctx.role, 'system');
    assert.equal(ctx.userId, 'system');
    assert.equal(ctx.tenantId, 'tenant_abc');
    assert.equal(ctx.authenticated, true);
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = original;
    process.env.CONVERACT_API_KEY = originalKey;
  }
});

test('dev mode: X-API-Key with no CONVERACT_API_KEY env does not grant system role', () => {
  const original = process.env.CONVERACT_AUTH_DISABLED;
  const originalKey = process.env.CONVERACT_API_KEY;
  try {
    process.env.CONVERACT_AUTH_DISABLED = '1';
    delete process.env.CONVERACT_API_KEY;

    const ctx = resolveAuthContext({
      'x-api-key': 'some-key',
      'x-tenant-id': 'tenant_abc',
      'x-user-id': 'user_1'
    });

    assert.notEqual(ctx.role, 'system');
    assert.equal(ctx.tenantId, 'tenant_abc');
    assert.equal(ctx.userId, 'user_1');
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = original;
    process.env.CONVERACT_API_KEY = originalKey;
  }
});

test('dev mode: X-Tenant-Id + X-User-Id returns custom context', () => {
  const original = process.env.CONVERACT_AUTH_DISABLED;
  try {
    process.env.CONVERACT_AUTH_DISABLED = '1';

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
    process.env.CONVERACT_AUTH_DISABLED = original;
  }
});

test('dev mode: invalid role fails closed', () => {
  const original = process.env.CONVERACT_AUTH_DISABLED;
  try {
    process.env.CONVERACT_AUTH_DISABLED = '1';

    assert.throws(
      () => resolveAuthContext({
        'x-tenant-id': 'tenant_xyz',
        'x-user-id': 'user_42',
        'x-role': 'superadmin'
      }),
      (error: any) => error.status === 401 && /role/i.test(error.message)
    );
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = original;
  }
});

test('dev mode: tenant-only header returns viewer context', () => {
  const original = process.env.CONVERACT_AUTH_DISABLED;
  try {
    process.env.CONVERACT_AUTH_DISABLED = '1';

    const ctx = resolveAuthContext({
      'x-tenant-id': 'tenant_xyz'
    });

    assert.equal(ctx.tenantId, 'tenant_xyz');
    assert.equal(ctx.userId, 'anonymous');
    assert.equal(ctx.role, 'viewer');
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = original;
  }
});

test('dev mode: empty headers return empty context', () => {
  const original = process.env.CONVERACT_AUTH_DISABLED;
  try {
    process.env.CONVERACT_AUTH_DISABLED = '1';

    const ctx = resolveAuthContext({});

    assert.equal(ctx.tenantId, '');
    assert.equal(ctx.userId, '');
    assert.equal(ctx.role, 'viewer');
    assert.equal(ctx.authenticated, false);
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = original;
  }
});

test('auth required: missing Authorization header throws 401', () => {
  const origDisabled = process.env.CONVERACT_AUTH_DISABLED;
  const origIssuer = process.env.CONVERACT_AUTH_ISSUER;
  try {
    delete process.env.CONVERACT_AUTH_DISABLED;
    process.env.CONVERACT_AUTH_ISSUER = 'https://auth.example.com';

    assert.throws(
      () => resolveAuthContext({}),
      (err: any) => {
        assert.equal(err.status, 401);
        assert.match(err.message, /Authorization/);
        return true;
      }
    );
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = origDisabled;
    process.env.CONVERACT_AUTH_ISSUER = origIssuer;
  }
});

test('production never implicitly trusts development identity headers', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(
      () => resolveAuthContext({
        'x-tenant-id': 'attacker-tenant',
        'x-user-id': 'attacker-user',
        'x-role': 'owner'
      }),
      (error: any) => error.status === 401
    );
  } finally {
    restore();
  }
});

test('non-production never implicitly trusts development identity headers without explicit AUTH_DISABLED=1', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.NODE_ENV = 'test';
    assert.throws(
      () => resolveAuthContext({
        'x-tenant-id': 'attacker-tenant',
        'x-user-id': 'attacker-user',
        'x-role': 'owner'
      }),
      (error: any) => error.status === 401
    );
  } finally {
    restore();
  }
});

test('HS256 auth rejects a signed token with no expiry or platform identity contract', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.NODE_ENV = 'production';
    process.env.CONVERACT_JWT_SECRET = 'strict-auth-test-secret-at-least-32-bytes';
    const token = signHs256Raw({
      sub: 'user-1',
      tid: 'tenant-1',
      role: 'owner',
      iat: Math.floor(Date.now() / 1000)
    }, process.env.CONVERACT_JWT_SECRET);

    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${token}` }),
      (error: any) => error.status === 401 && /claim|expiry|identity/i.test(error.message)
    );
  } finally {
    restore();
  }
});

test('locally issued HS256 token carries and enforces the complete platform identity contract', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.NODE_ENV = 'production';
    process.env.CONVERACT_JWT_SECRET = 'strict-auth-test-secret-at-least-32-bytes';
    process.env.CONVERACT_AUTH_TOKEN_ISSUER = 'https://identity.example.test';
    process.env.CONVERACT_AUTH_AUDIENCE = 'converact-core';
    process.env.CONVERACT_AUTH_KEY_ID = 'identity-key-v7';
    process.env.CONVERACT_AUTH_POLICY_VERSION = '12';
    process.env.CONVERACT_AUTH_REVOCATION_EPOCH = '4';

    const token = signAccessToken({ sub: 'user-1', tid: 'tenant-1', role: 'operator' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const claim of [
      'tenant_id', 'identity_id', 'identity_kind', 'session_id', 'token_id', 'issuer', 'audience',
      'key_id', 'issued_at', 'not_before', 'expires_at', 'policy_version', 'revocation_epoch',
      'role', 'capabilities', 'purpose', 'credential_strength', 'iss', 'aud', 'iat', 'nbf', 'exp'
    ]) {
      assert.notEqual(payload[claim], undefined, claim);
    }
    assert.equal(resolveAuthContext({ authorization: `Bearer ${token}` }).tenantId, 'tenant-1');

    delete payload.session_id;
    const incomplete = signHs256Raw(payload, process.env.CONVERACT_JWT_SECRET, 'identity-key-v7');
    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${incomplete}` }),
      (error: any) => error.status === 401 && /identity/i.test(error.message)
    );
  } finally {
    restore();
  }
});

test('HS256 auth rejects stale policy and revocation epochs', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.CONVERACT_JWT_SECRET = 'strict-auth-test-secret-at-least-32-bytes';
    process.env.CONVERACT_AUTH_POLICY_VERSION = '12';
    process.env.CONVERACT_AUTH_REVOCATION_EPOCH = '4';
    const token = signAccessToken({ sub: 'user-1', tid: 'tenant-1', role: 'operator' });

    process.env.CONVERACT_AUTH_POLICY_VERSION = '13';
    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${token}` }),
      (error: any) => error.status === 401 && /stale_policy/.test(error.message)
    );
    process.env.CONVERACT_AUTH_POLICY_VERSION = '12';
    process.env.CONVERACT_AUTH_REVOCATION_EPOCH = '5';
    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${token}` }),
      (error: any) => error.status === 401 && /stale_revocation/.test(error.message)
    );
  } finally {
    restore();
  }
});

test('production rejects explicit AUTH_DISABLED development mode', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.NODE_ENV = 'production';
    process.env.CONVERACT_AUTH_DISABLED = '1';
    assert.throws(
      () => resolveAuthContext({
        'x-tenant-id': 'attacker-tenant',
        'x-user-id': 'attacker-user'
      }),
      (error: any) => error.status === 401
    );
  } finally {
    restore();
  }
});

test('production does not let a shared API key choose an arbitrary tenant', () => {
  const restore = isolateAuthEnvironment();
  try {
    process.env.NODE_ENV = 'production';
    process.env.CONVERACT_API_KEY = 'shared-api-key';
    assert.throws(
      () => resolveAuthContext({
        'x-api-key': 'shared-api-key',
        'x-tenant-id': 'attacker-selected-tenant'
      }),
      (error: any) => error.status === 401
    );
  } finally {
    restore();
  }
});

test('auth required: non-Bearer token throws 401', () => {
  const origDisabled = process.env.CONVERACT_AUTH_DISABLED;
  const origIssuer = process.env.CONVERACT_AUTH_ISSUER;
  try {
    delete process.env.CONVERACT_AUTH_DISABLED;
    process.env.CONVERACT_AUTH_ISSUER = 'https://auth.example.com';

    assert.throws(
      () => resolveAuthContext({ authorization: 'Basic dXNlcjpwYXNz' }),
      (err: any) => {
        assert.equal(err.status, 401);
        return true;
      }
    );
  } finally {
    process.env.CONVERACT_AUTH_DISABLED = origDisabled;
    process.env.CONVERACT_AUTH_ISSUER = origIssuer;
  }
});

test('RS256 auth requires the complete signed platform identity and never trusts X-Tenant-Id', () => {
  const originalDisabled = process.env.CONVERACT_AUTH_DISABLED;
  const originalIssuer = process.env.CONVERACT_AUTH_ISSUER;
  const originalSecret = process.env.CONVERACT_JWT_SECRET;
  const issuer = 'https://auth.example.test';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  try {
    delete process.env.CONVERACT_AUTH_DISABLED;
    process.env.CONVERACT_JWT_SECRET = 'coexisting-local-token-secret-at-least-32-bytes';
    process.env.CONVERACT_AUTH_ISSUER = issuer;
    _injectJwksForTest(issuer, [{
      kty: String(jwk.kty),
      kid: 'auth-test-key',
      n: String(jwk.n),
      e: String(jwk.e),
      use: 'sig',
      alg: 'RS256'
    }]);

    process.env.CONVERACT_AUTH_AUDIENCE = 'converact-core';
    process.env.CONVERACT_AUTH_POLICY_VERSION = '12';
    process.env.CONVERACT_AUTH_REVOCATION_EPOCH = '4';

    const withoutTenant = signRs256({
      ...strictRs256Claims(issuer),
      tenant_id: undefined
    }, privateKey);
    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${withoutTenant}`, 'x-tenant-id': 'attacker-tenant' }),
      (error: any) => error.status === 401 || error.status === 403
    );

    const signedTenant = signRs256(strictRs256Claims(issuer), privateKey);
    const context = resolveAuthContext({
      authorization: `Bearer ${signedTenant}`,
      'x-tenant-id': 'attacker-tenant'
    });
    assert.equal(context.tenantId, 'signed-tenant');
    assert.equal(context.userId, 'user-1');
  } finally {
    _clearJwksCache();
    process.env.CONVERACT_AUTH_DISABLED = originalDisabled;
    process.env.CONVERACT_AUTH_ISSUER = originalIssuer;
    process.env.CONVERACT_JWT_SECRET = originalSecret;
  }
});

test('RS256 auth rejects otherwise signed identity without exp', () => {
  const restore = isolateAuthEnvironment();
  const issuer = 'https://auth.example.test';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  try {
    process.env.NODE_ENV = 'production';
    process.env.CONVERACT_AUTH_ISSUER = issuer;
    process.env.CONVERACT_AUTH_AUDIENCE = 'converact-core';
    process.env.CONVERACT_AUTH_POLICY_VERSION = '12';
    process.env.CONVERACT_AUTH_REVOCATION_EPOCH = '4';
    _injectJwksForTest(issuer, [{
      kty: String(jwk.kty), kid: 'auth-test-key', n: String(jwk.n), e: String(jwk.e), use: 'sig', alg: 'RS256'
    }]);
    const { exp: _exp, ...withoutExpiry } = strictRs256Claims(issuer);
    const token = signRs256(withoutExpiry, privateKey);
    assert.throws(
      () => resolveAuthContext({ authorization: `Bearer ${token}` }),
      (error: any) => error.status === 401 && /claim|expiry|identity/i.test(error.message)
    );
  } finally {
    _clearJwksCache();
    restore();
  }
});

function futureEpoch(): number {
  return Math.floor(Date.now() / 1000) + 60;
}

function strictRs256Claims(issuer: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-1',
    tenant_id: 'signed-tenant',
    identity_id: 'user-1',
    identity_kind: 'human',
    session_id: 'session-1',
    token_id: 'token-1',
    iss: issuer,
    issuer,
    aud: ['converact-core'],
    audience: ['converact-core'],
    key_id: 'auth-test-key',
    iat: now,
    nbf: now,
    exp: futureEpoch(),
    issued_at: new Date(now * 1000).toISOString(),
    not_before: new Date(now * 1000).toISOString(),
    expires_at: new Date(futureEpoch() * 1000).toISOString(),
    policy_version: 12,
    revocation_epoch: 4,
    role: 'operator',
    capabilities: ['platform.api'],
    purpose: ['product_operation'],
    credential_strength: 'signed_token'
  };
}

function signHs256Raw(payload: Record<string, unknown>, secret: string, kid?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...(kid ? { kid } : {}) })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function signRs256(payload: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'auth-test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function isolateAuthEnvironment(): () => void {
  const keys = [
    'NODE_ENV',
    'CONVERACT_AUTH_DISABLED', 'OPC_AUTH_DISABLED',
    'CONVERACT_AUTH_ISSUER', 'OPC_AUTH_ISSUER',
    'CONVERACT_AUTH_TOKEN_ISSUER', 'OPC_AUTH_TOKEN_ISSUER',
    'CONVERACT_AUTH_AUDIENCE', 'OPC_AUTH_AUDIENCE',
    'CONVERACT_AUTH_KEY_ID', 'OPC_AUTH_KEY_ID',
    'CONVERACT_AUTH_POLICY_VERSION', 'OPC_AUTH_POLICY_VERSION',
    'CONVERACT_AUTH_REVOCATION_EPOCH', 'OPC_AUTH_REVOCATION_EPOCH',
    'CONVERACT_JWT_SECRET', 'OPC_JWT_SECRET',
    'CONVERACT_API_KEY', 'OPC_API_KEY'
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
