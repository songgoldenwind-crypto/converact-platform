import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pgTenantContextStorage,
  resolvePgTenantContextForRequest,
  runWithPgTenantContext,
  withPgRequestContext
} from '../src/db-pg-tenant.js';
import type { PgQueryable } from '../src/db-pg.js';

test('resolvePgTenantContextForRequest does not grant auth routes a generic RLS bypass', () => {
  assert.deepEqual(resolvePgTenantContextForRequest('/api/auth/register', {}), {});
  assert.deepEqual(resolvePgTenantContextForRequest('/api/auth/login', {}), {});
});

test('resolvePgTenantContextForRequest reads tenant from API key auth', () => {
  const prevKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'test-tenant-ctx-key';
  try {
    const ctx = resolvePgTenantContextForRequest('/api/call-center/queues', {
      'X-API-Key': 'test-tenant-ctx-key',
      'X-Tenant-Id': 'tenant_demo'
    });
    assert.equal(ctx.tenantId, 'tenant_demo');
    assert.equal(ctx.bypassRls, undefined);
  } finally {
    if (prevKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = prevKey;
  }
});

test('resolvePgTenantContextForRequest reads tenant from authenticated Media Core requests', () => {
  const previousToken = process.env.OPC_MEDIA_API_TOKEN;
  process.env.OPC_MEDIA_API_TOKEN = 'media-tenant-context-token';
  try {
    const postContext = resolvePgTenantContextForRequest(
      '/api/media/livekit/recordings/start',
      { authorization: 'Bearer media-tenant-context-token' },
      { body: { tenant_id: 'tenant_media_post' } }
    );
    assert.deepEqual(postContext, { tenantId: 'tenant_media_post' });

    const getContext = resolvePgTenantContextForRequest(
      '/api/media/livekit/recordings',
      { authorization: 'Bearer media-tenant-context-token' },
      { url: new URL('http://localhost/api/media/livekit/recordings?tenant_id=tenant_media_get') }
    );
    assert.deepEqual(getContext, { tenantId: 'tenant_media_get' });

    const invalid = resolvePgTenantContextForRequest(
      '/api/media/livekit/recordings',
      { authorization: 'Bearer wrong-token' },
      { url: new URL('http://localhost/api/media/livekit/recordings?tenant_id=tenant_spoofed') }
    );
    assert.deepEqual(invalid, {});
  } finally {
    if (previousToken === undefined) delete process.env.OPC_MEDIA_API_TOKEN;
    else process.env.OPC_MEDIA_API_TOKEN = previousToken;
  }
});

test('runWithPgTenantContext propagates to nested calls', () => {
  runWithPgTenantContext({ tenantId: 'tenant_a' }, () => {
    const store = pgTenantContextStorage.getStore();
    assert.equal(store?.tenantId, 'tenant_a');
  });
  assert.equal(pgTenantContextStorage.getStore(), undefined);
});

test('runWithPgTenantContext propagates bypassRls flag to nested reads', () => {
  runWithPgTenantContext({ bypassRls: true }, () => {
    const store = pgTenantContextStorage.getStore();
    assert.equal(store?.bypassRls, true);
  });
  assert.equal(pgTenantContextStorage.getStore(), undefined);
});

test('sequential tenant contexts do not bleed into each other', () => {
  runWithPgTenantContext({ tenantId: 'tenant_a' }, () => {
    assert.equal(pgTenantContextStorage.getStore()?.tenantId, 'tenant_a');
  });
  runWithPgTenantContext({ tenantId: 'tenant_b' }, () => {
    assert.equal(pgTenantContextStorage.getStore()?.tenantId, 'tenant_b');
    assert.notEqual(pgTenantContextStorage.getStore()?.tenantId, 'tenant_a');
  });
  assert.equal(pgTenantContextStorage.getStore(), undefined);
});

test('HTTP request tenant context sets PostgreSQL tenant GUC before route queries', async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const pg = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    }
  } as PgQueryable;

  const result = await withPgRequestContext(pg, { tenantId: 'tenant_request' }, async (scopedPg) => {
    await scopedPg.query('SELECT * FROM collaboration_sessions');
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.match(queries[0].text, /set_config\('app\.current_tenant'/);
  assert.deepEqual(queries[0].params, ['tenant_request']);
  assert.equal(queries[1].text, 'SELECT * FROM collaboration_sessions');
});

test('HTTP request rejects generic PostgreSQL bypass for a non-privileged role', async () => {
  const queries: string[] = [];
  const pg = {
    query: async (text: string) => {
      queries.push(text);
      return {
        rows: text.includes('opc_rls_bypass') ? [{ allowed: false }] : [],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: []
      };
    }
  } as PgQueryable;

  await assert.rejects(
    () => withPgRequestContext(pg, { bypassRls: true }, (scopedPg) => scopedPg.query('SELECT 1')),
    /RLS bypass is not permitted/
  );

  assert.match(queries[0], /set_config\('app\.bypass_rls'/);
  assert.match(queries[1], /opc_rls_bypass/);
  assert.equal(queries.includes('SELECT 1'), false);
});

// Gate invariant: bypassRls may only ever be set for the two auth-bootstrap
// paths. Any business path — regardless of headers — must NOT resolve to a
// bypass context. This is the deterministic core of A-11's escape-surface
// gate; the RLS-enforcement half lives in db-rls-integration.test.ts and
// requires a real Postgres.
const BUSINESS_PATHS = [
  '/api/call-center/queues',
  '/api/compliance/dnc',
  '/api/billing/subscriptions',
  '/api/voice-agent-specs',
  '/api/ivr/flows',
  '/api/call-center/sessions/nonexistent/turns'
];

for (const path of BUSINESS_PATHS) {
  test(`bypassRls is never set for business path ${path}`, () => {
    const ctx = resolvePgTenantContextForRequest(path, {});
    assert.equal(ctx.bypassRls, undefined, `${path} must not resolve to bypass`);
  });
}

test('auth routes use fixed security-definer operations instead of request-wide bypass', () => {
  assert.deepEqual(resolvePgTenantContextForRequest('/api/auth/register', {}), {});
  assert.deepEqual(resolvePgTenantContextForRequest('/api/auth/login', {}), {});
});

test('bypass resolves do not leak across sequential unrelated path resolutions', () => {
  // Resolve a bypass path, then a business path: the business path must not
  // inherit bypass from the earlier call (no module-global state leak).
  resolvePgTenantContextForRequest('/api/auth/register', {});
  const ctx = resolvePgTenantContextForRequest('/api/call-center/queues', {});
  assert.equal(ctx.bypassRls, undefined);
});
