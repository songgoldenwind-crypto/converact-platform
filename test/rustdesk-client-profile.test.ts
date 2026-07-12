import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskClientDistributionProfile,
  RUSTDESK_CLIENT_VERSION,
  RUSTDESK_SERVER_VERSION,
  SUPPORTED_RUSTDESK_CLIENT_TARGETS
} from '../src/agent-runtime/collaboration/rustdesk-client-profile.js';
import {
  rustDeskClientConfig,
  rustDeskPublicKey
} from '../src/agent-runtime/collaboration/rustdesk-client-config.js';
import { createIveKitHttpServer } from '../src/agent-runtime/ivekit/index.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { listenOnRandomPort } from './test-helpers.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const SHA256 = 'a'.repeat(64);
const PUBLIC_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const PRIVATE_LENGTH_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';

test('RustDesk public key loader accepts only canonical 32-byte Ed25519 public keys', () => {
  assert.deepEqual(rustDeskPublicKey({ OPC_RUSTDESK_PUBLIC_KEY: PUBLIC_KEY }), {
    value: PUBLIC_KEY,
    source: 'env',
    file_path: ''
  });

  for (const invalid of [
    'rustdesk-public-key',
    ` ${PUBLIC_KEY}`,
    `${PUBLIC_KEY}\n`,
    `${PUBLIC_KEY.slice(0, 20)}\n${PUBLIC_KEY.slice(20)}`,
    PUBLIC_KEY.slice(0, -1),
    PRIVATE_LENGTH_KEY,
    `-----BEGIN PRIVATE KEY-----\n${PRIVATE_LENGTH_KEY}\n-----END PRIVATE KEY-----`,
    `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----`
  ]) {
    const loaded = rustDeskPublicKey({ OPC_RUSTDESK_PUBLIC_KEY: invalid });
    assert.equal(loaded.value, '', invalid);
    assert.match(loaded.error || '', /canonical.*base64.*32 bytes/i, invalid);
    const config = rustDeskClientConfig({ OPC_RUSTDESK_PUBLIC_KEY: invalid });
    assert.equal(config.public_key, '', invalid);
    assert.equal(config.manual_fields.key, '', invalid);
    assert.doesNotMatch(JSON.stringify(config), new RegExp(escapeRegExp(invalid)));
  }

  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-invalid-public-key-'));
  const file = join(dir, 'id_ed25519.pub');
  writeFileSync(file, PRIVATE_LENGTH_KEY, 'utf8');
  const loadedFile = rustDeskPublicKey({ OPC_RUSTDESK_PUBLIC_KEY_FILE: file });
  assert.equal(loadedFile.value, '');
  assert.match(loadedFile.error || '', /canonical.*base64.*32 bytes/i);
});

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
      pinnedInput(target),
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
      () => createRustDeskClientDistributionProfile(pinnedInput(input), { env, now: () => NOW }),
      /unsupported RustDesk client|client_version must equal 1\.4\.7/
    );
  }
});

test('RustDesk client profiles use only validated explicit artifact metadata', () => {
  const manifest = artifactManifest([
    artifact('windows', 'x86_64', 'rustdesk-1.4.7-windows-x86_64.exe')
  ]);
  const profile = createRustDeskClientDistributionProfile(
    pinnedInput({ platform: 'windows', architecture: 'x86_64' }),
    { env: profileEnv(manifest), now: () => NOW }
  );

  assert.deepEqual(profile.install_source, {
    state: 'configured',
    url: 'https://downloads.example.com/releases/1.4.7/rustdesk-1.4.7-windows-x86_64.exe',
    filename: 'rustdesk-1.4.7-windows-x86_64.exe',
    sha256: SHA256
  });
  assert.deepEqual(profile.manual_fields, {
    id_server: 'rustdesk-id.example.com',
    relay_server: 'rustdesk-relay.example.com',
    api_server: 'https://rustdesk-api.example.com',
    key: PUBLIC_KEY
  });
  assert.match(profile.server_key_fingerprint, /^sha256:[a-f0-9]{16}$/);
  assert.doesNotMatch(
    JSON.stringify(profile),
    /api.?key|bearer|private.?key|edge.?secret|unattended.?password|launch.?token|installer.?credential/i
  );
  assert.throws(
    () => createRustDeskClientDistributionProfile(
      pinnedInput({ platform: 'windows', architecture: 'x86_64' }),
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
  const valid = artifact('windows', 'x86_64', 'rustdesk-1.4.7-windows-x86_64.exe');
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
        pinnedInput({ platform: 'windows', architecture: 'x86_64' }),
        { env: profileEnv(value), now: () => NOW }
      ),
      /artifact manifest|artifact/,
      name
    );
  }
});

for (const [name, filename, urlFilename] of [
  ['version mismatch', 'rustdesk-1.4.8-windows-x86_64.exe', 'rustdesk-1.4.8-windows-x86_64.exe'],
  ['platform mismatch', 'rustdesk-1.4.7-linux-x86_64.exe', 'rustdesk-1.4.7-linux-x86_64.exe'],
  ['architecture mismatch', 'rustdesk-1.4.7-windows-aarch64.exe', 'rustdesk-1.4.7-windows-aarch64.exe'],
  ['extension mismatch', 'rustdesk-1.4.7-windows-x86_64.dmg', 'rustdesk-1.4.7-windows-x86_64.dmg'],
  ['URL basename mismatch', 'rustdesk-1.4.7-windows-x86_64.exe', 'other-1.4.7-windows-x86_64.exe']
] as const) {
  test(`RustDesk artifact manifest rejects ${name}`, () => {
    const value = artifactManifest([{
      platform: 'windows',
      architecture: 'x86_64',
      filename,
      url: `https://downloads.example.com/releases/1.4.7/${urlFilename}`,
      sha256: SHA256
    }]);
    assert.throws(
      () => createRustDeskClientDistributionProfile(
        {
          platform: 'windows',
          architecture: 'x86_64',
          client_version: '1.4.7',
          expected_server_version: '1.1.15',
          expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
        },
        { env: { ...profileEnv(value), OPC_RUSTDESK_PUBLIC_KEY: PUBLIC_KEY }, now: () => NOW }
      ),
      /artifact/
    );
  });
}

test('RustDesk artifact manifest rejects inexact release paths and contradictory identity tokens', () => {
  const expectedFilename = 'rustdesk-1.4.7-windows-x86_64.exe';
  const invalidArtifacts = [
    {
      name: 'wrong release directory with correct basename',
      filename: expectedFilename,
      url: `https://downloads.example.com/releases/latest/${expectedFilename}`
    },
    {
      name: 'wrong release version with correct basename',
      filename: expectedFilename,
      url: `https://downloads.example.com/releases/1.4.8/${expectedFilename}`
    },
    {
      name: 'conflicting semantic version in filename',
      filename: 'rustdesk-1.4.7-1.4.8-windows-x86_64.exe',
      url: 'https://downloads.example.com/releases/1.4.7/rustdesk-1.4.7-1.4.8-windows-x86_64.exe'
    },
    {
      name: 'conflicting semantic version in path',
      filename: expectedFilename,
      url: `https://downloads.example.com/archive-1.4.8/releases/1.4.7/${expectedFilename}`
    },
    {
      name: 'conflicting platform token',
      filename: 'rustdesk-1.4.7-windows-linux-x86_64.exe',
      url: 'https://downloads.example.com/releases/1.4.7/rustdesk-1.4.7-windows-linux-x86_64.exe'
    },
    {
      name: 'conflicting architecture token',
      filename: 'rustdesk-1.4.7-windows-x86_64-aarch64.exe',
      url: 'https://downloads.example.com/releases/1.4.7/rustdesk-1.4.7-windows-x86_64-aarch64.exe'
    }
  ];

  for (const { name, filename, url } of invalidArtifacts) {
    assert.throws(
      () => createRustDeskClientDistributionProfile(
        pinnedInput({ platform: 'windows', architecture: 'x86_64' }),
        {
          env: profileEnv(artifactManifest([{
            platform: 'windows',
            architecture: 'x86_64',
            filename,
            url,
            sha256: SHA256
          }])),
          now: () => NOW
        }
      ),
      /artifact/,
      name
    );
  }

  const githubUrl = `https://github.com/rustdesk/rustdesk/releases/download/1.4.7/${expectedFilename}`;
  const githubProfile = createRustDeskClientDistributionProfile(
    pinnedInput({ platform: 'windows', architecture: 'x86_64' }),
    {
      env: profileEnv(artifactManifest([{
        platform: 'windows',
        architecture: 'x86_64',
        filename: expectedFilename,
        url: githubUrl,
        sha256: SHA256
      }])),
      now: () => NOW
    }
  );
  assert.equal(githubProfile.install_source.state, 'configured');
  if (githubProfile.install_source.state === 'configured') {
    assert.equal(githubProfile.install_source.url, githubUrl);
  }
});

test('RustDesk client profile rejects configured server and key drift', () => {
  const env = profileEnv();
  const profile = createRustDeskClientDistributionProfile(
    pinnedInput({ platform: 'linux', architecture: 'x86_64' }),
    { env, now: () => NOW }
  );

  assert.throws(
    () => createRustDeskClientDistributionProfile(
      {
        platform: 'linux',
        architecture: 'x86_64',
        client_version: '1.4.7',
        expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6',
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
        expected_server_version: '1.1.15',
        expected_server_key_fingerprint: 'sha256:0000000000000000'
      },
      { env, now: () => NOW }
    ),
    /server key fingerprint drift/
  );
  assert.throws(
    () => createRustDeskClientDistributionProfile(
      pinnedInput({ platform: 'linux', architecture: 'x86_64' }),
      { env: { ...env, RUSTDESK_SERVER_IMAGE_TAG: 'latest' }, now: () => NOW }
    ),
    /server version must equal 1\.1\.15/
  );
  assert.match(profile.server_key_fingerprint, /^sha256:/);
});

test('RustDesk client profile requires both trusted drift pins before construction', () => {
  const base = { platform: 'linux', architecture: 'x86_64', client_version: '1.4.7' };
  for (const input of [
    base,
    { ...base, expected_server_version: '', expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6' },
    { ...base, expected_server_version: '1.1.15', expected_server_key_fingerprint: '' }
  ]) {
    assert.throws(
      () => createRustDeskClientDistributionProfile(
        input as Parameters<typeof createRustDeskClientDistributionProfile>[0],
        { env: profileEnv(), now: () => NOW }
      ),
      /expected_server_(?:version|key_fingerprint) is required/
    );
  }
});

test('authenticated client-profile endpoint returns private no-store responses and tenant-aware Vary', async (t) => {
  const previous = saveProfileProcessEnv();
  Object.assign(process.env, profileEnv(artifactManifest([
    artifact('windows', 'x86_64', 'rustdesk-1.4.7-windows-x86_64.exe')
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
  const url = `http://127.0.0.1:${port}/api/ivekit/rustdesk/client-profile?platform=windows&architecture=x86_64&client_version=1.4.7&expected_server_version=1.1.15&expected_server_key_fingerprint=sha256%3Ac57cc3b55d39f9a6`;

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

  const driftedUrl = new URL(url);
  driftedUrl.searchParams.set('expected_server_key_fingerprint', 'sha256:0000000000000000');
  const drifted = await fetch(
    driftedUrl,
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
    OPC_RUSTDESK_PUBLIC_KEY: PUBLIC_KEY,
    RUSTDESK_SERVER_IMAGE_TAG: '1.1.15',
    ...(manifest === undefined ? {} : { OPC_RUSTDESK_CLIENT_ARTIFACTS_JSON: String(manifest) })
  };
}

function pinnedInput(input: { platform: unknown; architecture: unknown; client_version?: unknown }) {
  return {
    platform: input.platform,
    architecture: input.architecture,
    client_version: input.client_version || '1.4.7',
    expected_server_version: '1.1.15',
    expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
