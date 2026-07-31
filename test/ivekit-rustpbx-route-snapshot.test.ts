import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  PostgresRustPbxRouteSnapshotRepository,
  createRustPbxRouteSnapshotProjector,
  verifyRustPbxRouteSnapshotEnvelope
} from '../src/ivekit-rustpbx-route-snapshot.js';

const FORWARD_HMAC = 'a'.repeat(64);
const REJECT_HMAC = 'b'.repeat(64);
const SIGNING_KEY = Buffer.alloc(32, 7).toString('base64');

test('RustPBX route snapshot patch imports the HMAC constructor trait', () => {
  const patch = readFileSync(
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-route-snapshot.patch',
    'utf8'
  );

  assert.match(patch, /use hmac::\{Hmac, KeyInit, Mac\};/);
});

test('RustPBX route snapshot patch covers display-name SIP To headers', () => {
  const patch = readFileSync(
    'infra/ivekit/rustpbx/patches/rustpbx-ivekit-route-snapshot.patch',
    'utf8'
  );

  assert.match(
    patch,
    /snapshot_result\(r#""iveKit RTP Route" <sip:\+8613800138000@pbx\.invalid>"#\)/
  );
  assert.match(patch, /\.split_once\('<'\)/);
  assert.match(patch, /rest\.split_once\('>'\)/);
});

test('route snapshot projector signs a canonical HMAC-only snapshot and advances sequence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-route-snapshot-'));
  const output = join(directory, 'routes.json');
  let routeLoads = 0;
  const repository = {
    loadProfileRevision: async () => ({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      adapter: 'rustpbx' as const,
      status: 'enabled' as const,
      source_revision: 11
    }),
    listRoutes: async () => {
      routeLoads += 1;
      return [
        {
          address_hmac: REJECT_HMAC,
          rules: { action: 'reject', code: 486, reason: 'busy' },
          capabilities: { json_rpc_routing: true }
        },
        {
          address_hmac: FORWARD_HMAC,
          rules: {
            action: 'forward_sip',
            targets: ['sip:1001@10.0.0.8'],
            record: true
          },
          capabilities: { json_rpc_routing: true, recording: true }
        }
      ];
    }
  };
  const projector = createRustPbxRouteSnapshotProjector({
    repository,
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    output_path: output,
    signing_key: SIGNING_KEY,
    ttl_ms: 15_000
  });
  const now = new Date('2026-07-16T08:00:00.000Z');

  const first = await projector.runOnce(now);
  const unchanged = await projector.runOnce(new Date(now.getTime() + 1_000));
  const renewed = await projector.runOnce(new Date(now.getTime() + 8_000));
  const raw = await readFile(output, 'utf8');
  const verified = verifyRustPbxRouteSnapshotEnvelope(raw, {
    signing_key: SIGNING_KEY,
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    now: new Date(now.getTime() + 8_000)
  });

  assert.equal(first.published, true);
  assert.equal(unchanged.published, false);
  assert.equal(renewed.published, true);
  assert.equal(unchanged.body.sequence, first.body.sequence);
  assert.ok(renewed.body.sequence > first.body.sequence);
  assert.equal(verified.sequence, renewed.body.sequence);
  assert.equal(verified.source_revision, 11);
  assert.equal(routeLoads, 1);
  assert.match(raw, /^ivekit-route-snapshot-v1\.[A-Za-z0-9_-]{43}\n\{/);
  assert.deepEqual(verified.routes[FORWARD_HMAC], {
    action: 'forward',
    headers: {},
    max_ring_time: 30,
    record: true,
    strategy: 'sequential',
    targets: ['sip:1001@10.0.0.8'],
    timeout: 30
  });
  assert.deepEqual(verified.routes[REJECT_HMAC], {
    action: 'reject',
    reason: 'busy',
    status: 486
  });
  assert.doesNotMatch(raw, /\+861|e164_ciphertext|e164_redacted/);
  assert.ok(raw.indexOf(FORWARD_HMAC) < raw.indexOf(REJECT_HMAC));
  assert.deepEqual(await readdir(directory), ['routes.json']);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('PostgreSQL route projection uses bounded profile and batch route queries', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pg: PgQueryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/FROM ivekit_voice_deployment_profiles/i.test(text)) {
        return {
          rows: [{
            tenant_id: 'tenant-a',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            status: 'enabled',
            source_revision: '7'
          }],
          rowCount: 1
        } as never;
      }
      return {
        rows: [{
          address_hmac: FORWARD_HMAC,
          rules: { action: 'reject', code: 404 },
          capabilities: {}
        }],
        rowCount: 1
      } as never;
    }
  };

  const repository = new PostgresRustPbxRouteSnapshotRepository(pg);
  assert.ok(await repository.loadProfileRevision('tenant-a', 'profile-a'));
  assert.equal((await repository.listRoutes('tenant-a', 'profile-a')).length, 1);

  assert.equal(calls.length, 4);
  const dataCalls = calls.filter((call) => /FROM ivekit_voice_/i.test(call.text));
  assert.deepEqual(dataCalls.map((call) => call.values), [
    ['tenant-a', 'profile-a'],
    ['tenant-a', 'profile-a']
  ]);
  assert.match(dataCalls[0]!.text, /ivekit_voice_route_snapshot_revisions/i);
  assert.match(dataCalls[1]!.text, /ivekit_voice_dids[\s\S]+ivekit_voice_route_versions/i);
  assert.doesNotMatch(dataCalls[1]!.text, /e164_ciphertext|e164_redacted/i);
  assert.match(dataCalls[1]!.text, /LIMIT 100001/i);
});

test('route snapshot verification rejects wrong identity and tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-route-snapshot-'));
  const output = join(directory, 'routes.json');
  const projector = createRustPbxRouteSnapshotProjector({
    repository: {
      loadProfileRevision: async () => ({
        tenant_id: 'tenant-a',
        profile_id: 'profile-a',
        adapter: 'rustpbx' as const,
        status: 'degraded' as const,
        source_revision: 1
      }),
      listRoutes: async () => []
    },
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    output_path: output,
    signing_key: SIGNING_KEY,
    ttl_ms: 15_000
  });
  const now = new Date('2026-07-16T08:00:00.000Z');
  await projector.runOnce(now);
  const raw = await readFile(output, 'utf8');

  assert.throws(() => verifyRustPbxRouteSnapshotEnvelope(raw, {
    signing_key: SIGNING_KEY,
    tenant_id: 'tenant-b',
    profile_id: 'profile-a',
    now
  }), /identity/i);
  assert.throws(() => verifyRustPbxRouteSnapshotEnvelope(
    raw.replace('"sequence":', '"sequence":9'),
    {
      signing_key: SIGNING_KEY,
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      now
    }
  ), /signature|envelope/i);
});

test('route snapshot revision migration bumps every routing authority table', () => {
  const sql = readFileSync('src/migrations/079_ivekit_voice_route_snapshot_revision.sql', 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_route_snapshot_revisions/i);
  assert.match(sql, /PRIMARY KEY \(tenant_id, profile_id\)/i);
  assert.match(sql, /revision BIGINT NOT NULL DEFAULT 1/i);
  for (const table of [
    'ivekit_voice_deployment_profiles',
    'ivekit_voice_capability_snapshots',
    'ivekit_voice_sip_trunks',
    'ivekit_voice_routes',
    'ivekit_voice_route_versions',
    'ivekit_voice_dids'
  ]) {
    assert.match(sql, new RegExp(`ON ${table}`, 'i'));
  }
  assert.match(sql, /revision = ivekit_voice_route_snapshot_revisions\.revision \+ 1/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
});
