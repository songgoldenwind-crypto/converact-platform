import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  inspectIveKitVoice,
  type IveKitVoicePreflightReport
} from '../src/agent-runtime/converact/voice/preflight.js';
import { voiceProfileConfigHash } from '../src/agent-runtime/converact/voice/deployment-profile-service.js';
import type { VoiceDeploymentProfile } from '../src/agent-runtime/converact/voice/types.js';
import type { PgQueryable } from '../src/db-pg.js';

const ADDRESS_KEY = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY = Buffer.alloc(32, 2).toString('base64');

test('Voice preflight keeps disabled workers configuration-safe without address keys or profiles', async () => {
  const report = await inspectIveKitVoice({
    pg: preflightPg({ profiles: [] }),
    env: { DATABASE_URL: 'postgresql://must-not-escape' }
  });

  assert.equal(report.ready, true);
  assert.equal(report.workers.enabled, false);
  assert.deepEqual(report.address_keys, { configured: false, valid: false });
  assert.deepEqual(report.profiles, []);
  assert.deepEqual(report.issues, []);
  assertSecretSafe(report, ['postgresql://must-not-escape']);
});

test('Voice preflight reports ready PostgreSQL runtime profile and fresh capability state safely', async () => {
  const profile = rustPbxProfile();
  const report = await inspectIveKitVoice({
    pg: preflightPg({
      profiles: [{
        ...profile,
        capability_status: 'ready',
        capability_checked_at: '2026-07-13T11:59:30.000Z',
        capability_config_hash: voiceProfileConfigHash(profile)
      }]
    }),
    env: voiceEnv(),
    now: () => new Date('2026-07-13T12:00:00.000Z')
  });

  assert.equal(report.ready, true);
  assert.equal(report.database.migration_present, true);
  assert.equal(report.database.runtime_role_safe, true);
  assert.equal(report.address_keys.valid, true);
  assert.deepEqual(report.profiles, [{
    adapter: 'rustpbx',
    status: 'enabled',
    endpoint: { scheme: 'https:', origin: 'https://pbx.internal', path: '/management' },
    rwi_endpoint: { scheme: 'wss:', origin: 'wss://pbx.internal', path: '/rwi/v1' },
    secret_refs: { total: 2, configured: 2, ready: true },
    capability: { status: 'ready', age: 'fresh', config_hash_matches: true }
  }]);
  assertSecretSafe(report, [
    'profile-secret-id', 'RUSTPBX_MANAGEMENT_TOKEN', 'RUSTPBX_RWI_TOKEN',
    'management-secret-value', 'rwi-secret-value'
  ]);
});

test('Voice preflight returns stable issue codes for unsafe role stale capabilities and invalid worker config', async () => {
  const profile = rustPbxProfile();
  const report = await inspectIveKitVoice({
    pg: preflightPg({
      runtime_role_safe: false,
      profiles: [{
        ...profile,
        base_url: 'http://public.example.com/management',
        capability_status: 'ready',
        capability_checked_at: '2026-07-01T00:00:00.000Z',
        capability_config_hash: 'b'.repeat(64)
      }]
    }),
    env: {
      ...voiceEnv(),
      NODE_ENV: 'production',
      OPC_IVEKIT_VOICE_COMMAND_LEASE_MS: '10000'
    },
    now: () => new Date('2026-07-13T12:00:00.000Z')
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.issues.sort(), [
    'capability_config_drift',
    'capability_snapshot_stale',
    'profile_endpoint_insecure',
    'runtime_role_unsafe',
    'worker_config_invalid'
  ]);
  assert.equal(JSON.stringify(report).includes('must exceed the provider'), false);

  const missingMigration = await inspectIveKitVoice({
    pg: preflightPg({ migration_present: false, profiles: [] }),
    env: { DATABASE_URL: 'postgresql://must-not-escape' }
  });
  assert.equal(missingMigration.ready, false);
  assert.equal(missingMigration.issues.includes('migration_missing'), true);
});

function preflightPg(input: {
  migration_present?: boolean;
  runtime_role_safe?: boolean;
  profiles: Array<Record<string, unknown>>;
}): PgQueryable {
  return {
    async query(text: string) {
      if (text.includes('to_regclass')) {
        return result([{
          migration_present: input.migration_present ?? true,
          runtime_role_safe: input.runtime_role_safe ?? true
        }]);
      }
      if (text.includes('ivekit_voice_deployment_profiles')) return result(input.profiles);
      throw new Error('unexpected query');
    }
  } as unknown as PgQueryable;
}

function result(rows: Array<Record<string, unknown>>) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

function voiceEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://database-secret-value',
    OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
    OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
    OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY,
    RUSTPBX_MANAGEMENT_TOKEN: 'management-secret-value',
    RUSTPBX_RWI_TOKEN: 'rwi-secret-value'
  };
}

function rustPbxProfile(): VoiceDeploymentProfile {
  return {
    id: 'profile-secret-id', tenant_id: 'tenant-secret-id', name: 'RustPBX', adapter: 'rustpbx',
    status: 'enabled', base_url: 'https://pbx.internal/management', desired_version: '0.9.0',
    config: { rwi_url: 'wss://pbx.internal/rwi/v1', internal_service: false },
    secret_refs: {
      management_service_token: 'env://RUSTPBX_MANAGEMENT_TOKEN',
      rwi_token: 'env://RUSTPBX_RWI_TOKEN'
    },
    revision: 1, created_by: 'admin', updated_by: 'admin',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function assertSecretSafe(report: IveKitVoicePreflightReport, secrets: string[]): void {
  const serialized = JSON.stringify(report);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, secret);
}
