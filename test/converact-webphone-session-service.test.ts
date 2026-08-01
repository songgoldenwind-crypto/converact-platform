import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createConfiguredWebPhoneExtensionSessionService,
  PostgresWebPhoneExtensionSessionService,
  runWebPhoneSessionCleanupOnce,
  webPhoneSessionCleanupConfig,
  type WebPhoneExtensionSessionConfig
} from '../src/agent-runtime/converact/voice/webphone-session-service.js';
import type { PgQueryable } from '../src/db-pg.js';
import type { VoiceExtension } from '../src/agent-runtime/converact/voice/types.js';

const NOW = new Date('2026-07-19T08:00:00.000Z');
const JWT_SECRET = 'webphone-jwt-secret-value-that-is-at-least-32-bytes';

test('WebPhone session service issues a RustPBX-verifiable WSS plan without persisting credentials', async () => {
  const pg = new SessionPg();
  const service = new PostgresWebPhoneExtensionSessionService(pg, config(), {
    now: () => NOW,
    id: () => 'webphone-session-a'
  });

  const plan = await service.create({
    tenant_id: 'tenant-a', extension: extension(), actor: 'agent-a', idempotency_key: 'request-a'
  });

  assert.equal(plan.session_id, 'webphone-session-a');
  assert.equal(plan.extension_id, 'extension-a');
  assert.equal(plan.transport, 'wss');
  assert.equal(plan.address_of_record, 'sip:1001@voice.example.com');
  assert.equal(plan.authorization_username, '1001');
  assert.equal(plan.register_expires_seconds, 240);
  assert.equal(plan.expires_at, '2026-07-19T08:05:00.000Z');
  assert.deepEqual(plan.capabilities, {
    incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
    audio_input: true, audio_output: true
  });

  const websocket = new URL(plan.websocket_url);
  assert.equal(websocket.origin + websocket.pathname, 'wss://voice.example.com/ws');
  const token = websocket.searchParams.get('token');
  assert.ok(token);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), {
    alg: 'HS256', typ: 'JWT'
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), {
    aud: 'rustpbx-webphone', exp: 1784448300, extension_id: 'extension-a',
    iat: 1784448000, iss: 'converact', jti: 'webphone-session-a',
    profile_id: 'profile-a', scope: 'sip:webphone', sub: '1001', tenant_id: 'tenant-a'
  });
  assert.equal(
    signature,
    createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  );
  assert.match(plan.authorization_password, /^[A-Za-z0-9_-]{43}$/);

  const persisted = JSON.stringify(pg.rows);
  const sqlParameters = JSON.stringify(pg.calls.map((call) => call.params));
  for (const secret of [JWT_SECRET, token, plan.authorization_password]) {
    assert.equal(persisted.includes(secret), false);
    assert.equal(sqlParameters.includes(secret), false);
  }
});

test('WebPhone session service replays one byte-identical plan across service instances', async () => {
  const pg = new SessionPg();
  const first = new PostgresWebPhoneExtensionSessionService(pg, config(), {
    now: () => NOW, id: () => 'webphone-session-a'
  });
  const second = new PostgresWebPhoneExtensionSessionService(pg, config(), {
    now: () => new Date('2026-07-19T08:00:30.000Z'), id: () => 'must-not-win'
  });
  const input = {
    tenant_id: 'tenant-a', extension: extension(), actor: 'agent-a', idempotency_key: 'request-a'
  };

  const created = await first.create(input);
  const replayed = await second.create(input);

  assert.deepEqual(replayed, created);
  assert.equal(pg.rows.length, 1);
});

test('WebPhone session idempotency rejects changed or expired requests', async () => {
  const pg = new SessionPg();
  let now = NOW;
  const service = new PostgresWebPhoneExtensionSessionService(pg, config(), {
    now: () => now, id: () => 'webphone-session-a'
  });
  const input = {
    tenant_id: 'tenant-a', extension: extension(), actor: 'agent-a', idempotency_key: 'request-a'
  };
  await service.create(input);

  await assert.rejects(
    () => service.create({ ...input, extension: { ...input.extension, revision: 2 } }),
    (error: unknown) => (error as { code?: string }).code === 'idempotency_conflict'
  );
  now = new Date('2026-07-19T08:05:01.000Z');
  await assert.rejects(
    () => service.create(input),
    (error: unknown) => (error as { code?: string }).code === 'idempotency_conflict'
  );
});

test('configured WebPhone session service fails closed on unsafe runtime settings', () => {
  assert.equal(createConfiguredWebPhoneExtensionSessionService(new SessionPg(), {}), undefined);
  assert.throws(
    () => createConfiguredWebPhoneExtensionSessionService(new SessionPg(), env({
      CONVERACT_FABRIC_WEBPHONE_WSS_URL: 'ws://voice.example.com/ws'
    })),
    /WSS/i
  );
  assert.throws(
    () => createConfiguredWebPhoneExtensionSessionService(new SessionPg(), env({
      CONVERACT_FABRIC_WEBPHONE_JWT_SECRET: 'short'
    })),
    /JWT_SECRET/i
  );
  assert.throws(
    () => createConfiguredWebPhoneExtensionSessionService(new SessionPg(), env({
      CONVERACT_FABRIC_WEBPHONE_REGISTER_EXPIRES_SECONDS: '300'
    })),
    /REGISTER_EXPIRES_SECONDS/i
  );
  assert.throws(
    () => createConfiguredWebPhoneExtensionSessionService(new SessionPg(), env({
      CONVERACT_FABRIC_WEBPHONE_ICE_SERVERS_JSON: '[{"urls":"https://ice.example.com"}]'
    })),
    /ICE/i
  );
});

test('WebPhone session migration is tenant-isolated and stores no bearer credential', () => {
  const migration = readFileSync(
    new URL('../src/migrations/094_ivekit_voice_extension_sessions.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS ivekit_voice_extension_sessions/);
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /GRANT SELECT, INSERT, DELETE/);
  assert.match(migration, /opc_ivekit_webphone_session_tenant_ids/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /LIMIT GREATEST\(1, LEAST\(COALESCE\(p_limit, 100\), 1000\)\)/);
  assert.doesNotMatch(migration, /\b(jwt|token|password|credential)\b/i);
});

test('WebPhone cleanup claims bounded expired rows inside tenant RLS transactions', async () => {
  const pg = new CleanupPg();
  const result = await runWebPhoneSessionCleanupOnce(pg, {
    tenant_limit: 10,
    batch_size: 25,
    now: new Date('2026-07-19T09:00:00.000Z')
  });

  assert.deepEqual(result, { tenants: 1, deleted: 2 });
  const lister = pg.calls.find((call) => /opc_ivekit_webphone_session_tenant_ids/i.test(call.text));
  assert.deepEqual(lister?.params, ['2026-07-19T09:00:00.000Z', 10]);
  const deletion = pg.calls.find((call) => /DELETE FROM ivekit_voice_extension_sessions/i.test(call.text));
  assert.match(deletion?.text || '', /FOR UPDATE SKIP LOCKED/i);
  assert.deepEqual(deletion?.params, ['tenant-a', '2026-07-19T09:00:00.000Z', 25]);
  assert.equal(pg.calls.some((call) => /set_config\('app\.current_tenant'/i.test(call.text)), true);
});

test('WebPhone cleanup configuration is enabled only with WebPhone and remains bounded', () => {
  assert.equal(webPhoneSessionCleanupConfig({}).enabled, false);
  assert.deepEqual(webPhoneSessionCleanupConfig({ CONVERACT_FABRIC_WEBPHONE_ENABLED: '1' }), {
    enabled: true, interval_ms: 60_000, tenant_limit: 100, batch_size: 500
  });
  assert.throws(
    () => webPhoneSessionCleanupConfig({
      CONVERACT_FABRIC_WEBPHONE_ENABLED: '1',
      CONVERACT_FABRIC_WEBPHONE_SESSION_CLEANUP_BATCH_SIZE: '5001'
    }),
    /CLEANUP_BATCH_SIZE/
  );
});

function config(): WebPhoneExtensionSessionConfig {
  return {
    websocket_url: 'wss://voice.example.com/ws', sip_realm: 'voice.example.com',
    jwt_secret: JWT_SECRET, jwt_issuer: 'converact', jwt_audience: 'rustpbx-webphone',
    ttl_seconds: 300, register_expires_seconds: 240,
    ice_servers: [{ urls: ['stun:stun.example.com:3478'] }]
  };
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CONVERACT_FABRIC_WEBPHONE_ENABLED: '1',
    CONVERACT_FABRIC_WEBPHONE_WSS_URL: 'wss://voice.example.com/ws',
    CONVERACT_FABRIC_WEBPHONE_SIP_REALM: 'voice.example.com',
    CONVERACT_FABRIC_WEBPHONE_JWT_SECRET: JWT_SECRET,
    CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER: 'converact',
    CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE: 'rustpbx-webphone',
    CONVERACT_FABRIC_WEBPHONE_TTL_SECONDS: '300',
    CONVERACT_FABRIC_WEBPHONE_REGISTER_EXPIRES_SECONDS: '240',
    CONVERACT_FABRIC_WEBPHONE_ICE_SERVERS_JSON: '[]',
    ...overrides
  };
}

function extension(): VoiceExtension {
  return {
    id: 'extension-a', tenant_id: 'tenant-a', profile_id: 'profile-a', identity: 'agent-a',
    extension: '1001', display_name: 'Agent A', credential_secret_ref: 'env://EXTENSION_AUTH',
    permissions: { incoming: true, outbound: true }, webrtc_enabled: true, status: 'active', revision: 1,
    created_at: '2026-07-19T07:00:00.000Z', updated_at: '2026-07-19T07:00:00.000Z'
  };
}

class SessionPg implements PgQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];
  readonly rows: Array<Record<string, unknown>> = [];

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    let rows: Record<string, unknown>[] = [];
    if (/INSERT INTO ivekit_voice_extension_sessions/i.test(text)) {
      const key = `${params[1]}\u0000${params[4]}`;
      const existing = this.rows.find((row) => `${row.tenant_id}\u0000${row.idempotency_key}` === key);
      if (!existing) {
        const row = {
          id: params[0], tenant_id: params[1], extension_id: params[2], actor: params[3],
          idempotency_key: params[4], request_hash: params[5], issued_at: params[6], expires_at: params[7]
        };
        this.rows.push(row);
        rows = [row];
      }
    } else if (/FROM ivekit_voice_extension_sessions/i.test(text)) {
      rows = this.rows.filter(
        (row) => row.tenant_id === params[0] && row.idempotency_key === params[1]
      );
    }
    return { rows: rows as R[], rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

class CleanupPg implements PgQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = /opc_ivekit_webphone_session_tenant_ids/i.test(text)
      ? [{ tenant_id: 'tenant-a' }]
      : /DELETE FROM ivekit_voice_extension_sessions/i.test(text)
        ? [{ id: 'session-a' }, { id: 'session-b' }]
        : [];
    return { rows: rows as R[], rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}
