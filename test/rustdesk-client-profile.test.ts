import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createRustDeskClientDistributionProfile,
  RUSTDESK_CLIENT_VERSION,
  RUSTDESK_SERVER_VERSION,
  SUPPORTED_RUSTDESK_CLIENT_TARGETS
} from '../src/agent-runtime/collaboration/rustdesk-client-profile.js';
import { createIveKitHttpServer } from '../src/agent-runtime/ivekit/index.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { listenOnRandomPort } from './test-helpers.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const SHA256 = 'a'.repeat(64);

test('RustDesk client profiles support only the pinned V1 desktop matrix', () => {
  const env = profileEnv();

  assert.equal(RUSTDESK_CLIENT_VERSION, '1.4.7');
  assert.equal(RUSTDESK_SERVER_VERSION, '1.1.15');
  assert.deepEqual(SUPPORTED_RUSTDESK_CLIENT_TARGETS, [
    { platform: 'windows', architecture: 'x86_64' },
    { platform: 'macos', architecture: 'x86_64' },
    { platform: 'macos', architecture: 'aarch64' },
    { platform: 'linux', architecture: 'x86_64' },
    { platform: 'linux', architecture: 'aarch64' }
  ]);

  for (const target of SUPPORTED_RUSTDESK_CLIENT_TARGETS) {
    const profile = createRustDeskClientDistributionProfile(
      { ...target, client_version: '1.4.7' },
      { env, now: () => NOW }
    );
    assert.equal(profile.platform, target.platform);
    assert.equal(profile.architecture, target.architecture);
    assert.deepEqual(profile.client_version, { exact: '1.4.7', allowed: ['1.4.7'] });
    assert.equal(profile.server_version, '1.1.15');
    assert.equal(profile.issued_at, '2026-07-12T12:00:00.000Z');
    assert.equal(profile.expires_at, '2026-07-12T12:15:00.000Z');
    assert.equal(profile.protocol_handler.supported, true);
    assert.equal(profile.protocol_handler.user_initiated_only, true);
    assert.deepEqual(profile.unattended_policy, { mode: 'attended_only', state: 'not_configured' });
    assert.deepEqual(profile.install_source, { state: 'not_configured' });
  }

  for (const input of [
    { platform: 'windows', architecture: 'aarch64', client_version: '1.4.7' },
    { platform: 'android', architecture: 'aarch64', client_version: '1.4.7' },
    { platform: 'linux', architecture: 'armv7', client_version: '1.4.7' },
    { platform: 'linux', architecture: 'x86_64', client_version: '1.4' },
    { platform: 'linux', architecture: 'x86_64', client_version: '^1.4.7' },
    { platform: 'linux', architecture: 'x86_64', client_version: '1.4.8' }
  ]) {
    assert.throws(
      () => createRustDeskClientDistributionProfile(input, { env, now: () => NOW }),
      /unsupported RustDesk client|client_version must equal 1\.4\.7/
    );
  }
});

test('RustDesk client profiles use only validated explicit artifact metadata', () => {
  const manifest = artifactManifest([
    artifact('windows', 'x86_64', 'rustdesk-1.4.7-x86_64.exe')
  ]);
  const profile = createRustDeskClientDistributionProfile(
    { platform: 'windows', architecture: 'x86_64', client_version: '1.4.7' },
    { env: profileEnv(manifest), now: () => NOW }
  );

  assert.deepEqual(profile.install_source, {
    state: 'configured',
    url: 'https://downloads.example.com/releases/1.4.7/rustdesk-1.4.7-x86_64.exe',
    filename: 'rustdesk-1.4.7-x86_64.exe',
    sha256: SHA256
  });
  assert.deepEqual(profile.manual_fields, {
    id_server: 'rustdesk-id.example.com',
    relay_server: 'rustdesk-relay.example.com',
    api_server: 'https://rustdesk-api.example.com',
    key: 'rustdesk-public-key'
  });
  assert.match(profile.server_key_fingerprint, /^sha256:[a-f0-9]{16}$/);
  assert.doesNotMatch(
    JSON.stringify(profile),
    /api.?key|bearer|private.?key|edge.?secret|unattended.?password|launch.?token|installer.?credential/i
  );
  assert.throws(
    () => createRustDeskClientDistributionProfile(
      { platform: 'windows', architecture: 'x86_64', client_version: '1.4.7' },
      {
        env: {
          ...profileEnv(manifest),
          OPC_RUSTDESK_API_SERVER: 'https://user:password@rustdesk-api.example.com'
        },
        now: () => NOW
      }
    ),
    /API server must not include credentials, query, or fragment/
  );
});

test('RustDesk client artifact manifest rejects unsafe metadata and duplicate targets', () => {
  const valid = artifact('windows', 'x86_64', 'rustdesk-1.4.7-x86_64.exe');
  const invalidManifests: Array<[string, unknown]> = [
    ['malformed JSON', '{'],
    ['wrong client version', artifactManifest([valid], { client_version: '1.4.8' })],
    ['wrong server version', artifactManifest([valid], { server_version: '1.1.14' })],
    ['unsupported tuple', artifactManifest([{ ...valid, architecture: 'aarch64' }])],
    ['duplicate tuple', artifactManifest([valid, { ...valid, filename: 'duplicate.exe' }])],
    ['non-HTTPS URL', artifactManifest([{ ...valid, url: 'http://downloads.example.com/releases/1.4.7/rustdesk.exe' }])],
    ['URL userinfo', artifactManifest([{ ...valid, url: 'https://user:password@downloads.example.com/releases/1.4.7/rustdesk.exe' }])],
    ['URL query', artifactManifest([{ ...valid, url: `${valid.url}?token=secret` }])],
    ['URL fragment', artifactManifest([{ ...valid, url: `${valid.url}#secret` }])],
    ['wrong release URL', artifactManifest([{ ...valid, url: 'https://downloads.example.com/releases/latest/rustdesk-1.4.7-x86_64.exe' }])],
    ['unsafe filename', artifactManifest([{ ...valid, filename: '../rustdesk.exe' }])],
    ['URL filename mismatch', artifactManifest([{ ...valid, filename: 'other.exe' }])],
    ['bad checksum', artifactManifest([{ ...valid, sha256: 'abc' }])]
  ];

  for (const [name, value] of invalidManifests) {
    assert.throws(
      () => createRustDeskClientDistributionProfile(
        { platform: 'windows', architecture: 'x86_64', client_version: '1.4.7' },
        { env: profileEnv(value), now: () => NOW }
      ),
      /artifact manifest|artifact/,
      name
    );
  }
});

test('RustDesk client profile rejects configured server and key drift', () => {
  const env = profileEnv();
  const profile = createRustDeskClientDistributionProfile(
    { platform: 'linux', architecture: 'x86_64', client_version: '1.4.7' },
    { env, now: () => NOW }
  );

  assert.throws(
    () => createRustDeskClientDistributionProfile(
      {
        platform: 'linux',
        architecture: 'x86_64',
        client_version: '1.4.7',
        expected_server_version: '1.1.14'
      },
      { env, now: () => NOW }
    ),
    /server version drift/
  );
  assert.throws(
    () => createRustDeskClientDistributionProfile(
      {
        platform: 'linux',
        architecture: 'x86_64',
        client_version: '1.4.7',
        expected_server_key_fingerprint: 'sha256:0000000000000000'
      },
      { env, now: () => NOW }
    ),
    /server key fingerprint drift/
  );
  assert.throws(
    () => createRustDeskClientDistributionProfile(
      { platform: 'linux', architecture: 'x86_64', client_version: '1.4.7' },
      { env: { ...env, RUSTDESK_SERVER_IMAGE_TAG: 'latest' }, now: () => NOW }
    ),
    /server version must equal 1\.1\.15/
  );
  assert.match(profile.server_key_fingerprint, /^sha256:/);
});

test('authenticated client-profile endpoint returns private no-store responses and tenant-aware Vary', async (t) => {
  const previous = saveProfileProcessEnv();
  Object.assign(process.env, profileEnv(artifactManifest([
    artifact('windows', 'x86_64', 'rustdesk-1.4.7-x86_64.exe')
  ])));
  process.env.OPC_API_KEY = 'profile-api-key';
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({ db, pg: new MemoryPg() });
  t.after(async () => {
    restoreProfileProcessEnv(previous);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });
  const port = await listenOnRandomPort(server);
  const url = `http://127.0.0.1:${port}/api/ivekit/rustdesk/client-profile?platform=windows&architecture=x86_64&client_version=1.4.7`;

  const unauthenticated = await fetch(url);
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(url, {
    headers: {
      'x-api-key': 'profile-api-key',
      'x-tenant-id': 'tenant_profile',
      'x-user-id': 'operator_profile'
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const vary = String(response.headers.get('vary') || '').toLowerCase();
  for (const header of ['authorization', 'x-api-key', 'x-tenant-id', 'origin']) {
    assert.match(vary, new RegExp(`(?:^|,\\s*)${header}(?:,|$)`));
  }
  const profile = await response.json() as Record<string, unknown>;
  assert.equal(profile.platform, 'windows');
  assert.equal((profile.install_source as Record<string, unknown>).state, 'configured');
  assert.doesNotMatch(JSON.stringify(profile), /profile-api-key|operator_profile|tenant_profile/);

  const unsupported = await fetch(
    url.replace('architecture=x86_64', 'architecture=aarch64'),
    { headers: { 'x-api-key': 'profile-api-key', 'x-tenant-id': 'tenant_profile' } }
  );
  assert.equal(unsupported.status, 400);

  const drifted = await fetch(
    `${url}&expected_server_key_fingerprint=sha256%3A0000000000000000`,
    { headers: { 'x-api-key': 'profile-api-key', 'x-tenant-id': 'tenant_profile' } }
  );
  assert.equal(drifted.status, 409);
});

test('RustDesk client profile deployment passes pinned version and manifest into every API service', () => {
  for (const path of [
    '../docker-compose.callcenter.yml',
    '../infra/docker-compose.production.yml',
    '../infra/ivekit/docker-compose.yml'
  ]) {
    const compose = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(compose, /RUSTDESK_SERVER_IMAGE_TAG:\s*\$\{RUSTDESK_SERVER_IMAGE_TAG/);
    assert.match(compose, /OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON:\s*\$\{OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON/);
    assert.match(compose, /OPC_RUSTDESK_CLIENT_PROFILE_TTL_MS:\s*\$\{OPC_RUSTDESK_CLIENT_PROFILE_TTL_MS/);
  }
  for (const path of ['../infra/env.example', '../infra/ivekit/env.example']) {
    const env = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(env, /^OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON=$/m);
    assert.match(env, /^OPC_RUSTDESK_CLIENT_PROFILE_TTL_MS=900000$/m);
  }
});

function artifact(platform: string, architecture: string, filename: string) {
  return {
    platform,
    architecture,
    url: `https://downloads.example.com/releases/1.4.7/${filename}`,
    filename,
    sha256: SHA256
  };
}

function artifactManifest(
  artifacts: unknown[],
  versions: { client_version?: string; server_version?: string } = {}
): string {
  return JSON.stringify({
    client_version: versions.client_version || '1.4.7',
    server_version: versions.server_version || '1.1.15',
    artifacts
  });
}

function profileEnv(manifest?: unknown): NodeJS.ProcessEnv {
  return {
    OPC_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    OPC_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    OPC_RUSTDESK_API_SERVER: 'https://rustdesk-api.example.com',
    OPC_RUSTDESK_PUBLIC_KEY: 'rustdesk-public-key',
    RUSTDESK_SERVER_IMAGE_TAG: '1.1.15',
    ...(manifest === undefined ? {} : { OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON: String(manifest) })
  };
}

const PROFILE_ENV_KEYS = [
  'OPC_API_KEY',
  'OPC_RUSTDESK_ID_SERVER',
  'OPC_RUSTDESK_RELAY_SERVER',
  'OPC_RUSTDESK_API_SERVER',
  'OPC_RUSTDESK_PUBLIC_KEY',
  'OPC_RUSTDESK_PUBLIC_KEY_FILE',
  'RUSTDESK_SERVER_IMAGE_TAG',
  'OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON'
] as const;

function saveProfileProcessEnv(): Record<string, string | undefined> {
  return Object.fromEntries(PROFILE_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreProfileProcessEnv(saved: Record<string, string | undefined>): void {
  for (const key of PROFILE_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
