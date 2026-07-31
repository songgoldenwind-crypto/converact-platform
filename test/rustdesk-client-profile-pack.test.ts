import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildRustDeskClientProfilePack,
  createRustDeskClientProfilePackConfigFromEnv,
  renderRustDeskClientProfilePack,
  writeRustDeskClientProfilePack
} from '../scripts/rustdesk-client-profile-pack.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const FINGERPRINT = 'sha256:c57cc3b55d39f9a6';
const PUBLIC_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

test('RustDesk client profile pack creates a ready five-target handoff manifest', async () => {
  const calls: unknown[] = [];
  const pack = await buildRustDeskClientProfilePack(
    packConfig(),
    {
      async getClientProfile(input) {
        calls.push(input);
        return profileFor(input.platform, input.architecture);
      }
    },
    () => NOW
  );

  assert.equal(calls.length, 5);
  assert.equal(pack.ready, true);
  assert.equal(pack.client_version, '1.4.9');
  assert.equal(pack.server_version, '1.1.16');
  assert.equal(pack.generated_at, NOW.toISOString());
  assert.equal(pack.expires_at, '2026-07-12T12:15:00.000Z');
  assert.equal(pack.server_key_fingerprint, FINGERPRINT);
  assert.equal(pack.targets.length, 5);
  assert.deepEqual(pack.missing_targets, []);
  assert.deepEqual(pack.unattended_policy, { mode: 'attended_only', state: 'not_configured' });
  assert.equal(pack.operator_instructions.length >= 4, true);
  for (const target of pack.targets) {
    assert.equal(target.install_source.state, 'configured');
    if (target.install_source.state === 'configured') {
      assert.match(target.install_source.url, /^https:\/\//);
      assert.match(target.install_source.sha256, /^[a-f0-9]{64}$/);
    }
  }

  const rendered = renderRustDeskClientProfilePack(pack);
  assert.deepEqual(JSON.parse(rendered), pack);
  assert.doesNotMatch(
    rendered,
    /profile-pack-api-secret|bearer-secret|private-key-secret|edge-secret|unattended-secret|signed-launch-secret|protocol-launch-secret|installer-secret/
  );
});

test('RustDesk client profile pack validates each slow response with a fresh clock', async () => {
  const responseTimes = [0, 20_000, 40_000, 65_000, 80_000].map((offset) => new Date(NOW.getTime() + offset));
  let current = NOW;
  let calls = 0;
  let clockReads = 0;
  const pack = await buildRustDeskClientProfilePack(
    packConfig(),
    {
      async getClientProfile(input) {
        current = responseTimes[calls];
        calls += 1;
        return profileFor(input.platform, input.architecture, false, current);
      }
    },
    () => {
      clockReads += 1;
      return current;
    }
  );

  assert.equal(pack.ready, true);
  assert.equal(calls, 5);
  assert.equal(clockReads, 7);
});

test('RustDesk client profile pack marks missing artifacts not ready without inventing metadata', async () => {
  const pack = await buildRustDeskClientProfilePack(
    packConfig(),
    {
      async getClientProfile(input) {
        return profileFor(
          input.platform,
          input.architecture,
          input.platform === 'linux' && input.architecture === 'aarch64'
        );
      }
    },
    () => NOW
  );

  assert.equal(pack.ready, false);
  assert.deepEqual(pack.missing_targets, ['linux/aarch64']);
  const missing = pack.targets.find((target) => target.platform === 'linux' && target.architecture === 'aarch64');
  assert.deepEqual(missing?.install_source, { state: 'not_configured' });
  assert.doesNotMatch(JSON.stringify(missing), /sha256|https:\/\//);
});

test('RustDesk client profile pack rejects profiles that expire during aggregation', async () => {
  const responseTimes = [0, 20_000, 40_000, 65_000, 80_000].map((offset) => new Date(NOW.getTime() + offset));
  let current = NOW;
  let calls = 0;
  let clockReads = 0;

  await assert.rejects(
    () => buildRustDeskClientProfilePack(
      packConfig(),
      {
        async getClientProfile(input) {
          current = responseTimes[calls];
          const profile = profileFor(input.platform, input.architecture, false, current);
          if (calls === 0) {
            profile.expires_at = new Date(current.getTime() + 70_000).toISOString();
          }
          calls += 1;
          return profile;
        }
      },
      () => {
        clockReads += 1;
        return current;
      }
    ),
    /expired/
  );
  assert.equal(calls, 5);
  assert.equal(clockReads, 7);
});

test('RustDesk client profile pack cannot become ready with encoded or control filenames', async () => {
  const unsafeSources = [
    (filename: string, url: string) => ({
      filename: filename.replace(/(\.[^.]+)$/, '\n$1'),
      url: url.replace(/(\.[^.]+)$/, '%0A$1')
    }),
    (filename: string, url: string) => ({
      filename: filename.replace(/(\.[^.]+)$/, '\u0000$1'),
      url: url.replace(/(\.[^.]+)$/, '%00$1')
    }),
    (filename: string, url: string) => ({
      filename,
      url: url.replace('rustdesk', '%72ustdesk')
    })
  ];

  for (const unsafeSource of unsafeSources) {
    await assert.rejects(
      () => buildRustDeskClientProfilePack(
        packConfig(),
        {
          async getClientProfile(input) {
            const profile = profileFor(input.platform, input.architecture);
            if (profile.install_source.state !== 'configured') return profile;
            return {
              ...profile,
              install_source: {
                ...profile.install_source,
                ...unsafeSource(profile.install_source.filename, profile.install_source.url)
              }
            };
          }
        },
        () => NOW
      ),
      /install_source/
    );
  }
});

test('RustDesk client profile pack rejects drift, expiry, and unsafe fake-client responses', async () => {
  await assert.rejects(
    () => buildRustDeskClientProfilePack(
      packConfig(),
      {
        async getClientProfile(input) {
          const profile = profileFor(input.platform, input.architecture);
          return input.platform === 'macos' && input.architecture === 'aarch64'
            ? { ...profile, server_key_fingerprint: 'sha256:0000000000000000' }
            : profile;
        }
      },
      () => NOW
    ),
    /fingerprint/
  );

  await assert.rejects(
    () => buildRustDeskClientProfilePack(
      packConfig(),
      {
        async getClientProfile(input) {
          return { ...profileFor(input.platform, input.architecture), expires_at: '2020-01-01T00:00:00.000Z' };
        }
      },
      () => NOW
    ),
    /expired/
  );

  await assert.rejects(
    () => buildRustDeskClientProfilePack(
      packConfig(),
      {
        async getClientProfile(input) {
          return {
            ...profileFor(input.platform, input.architecture),
            install_source: {
              state: 'configured',
              url: 'https://downloads.example.com/releases/latest/rustdesk.bin',
              filename: 'rustdesk.bin',
              sha256: 'a'.repeat(64)
            }
          };
        }
      },
      () => NOW
    ),
    /install_source/
  );
});

test('RustDesk client profile pack config validates trusted origin and expected drift values', () => {
  const config = createRustDeskClientProfilePackConfigFromEnv({
    CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_FILE: '/tmp/rustdesk-client-profile-pack.json',
    CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_BASE_URL: 'https://opc.example.com/',
    CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_API_KEY: 'profile-pack-api-secret',
    CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID: 'tenant_led',
    CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION: '1.1.16',
    CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT: FINGERPRINT
  });
  assert.equal(config.outputFile, '/tmp/rustdesk-client-profile-pack.json');
  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiKey, 'profile-pack-api-secret');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.expectedServerVersion, '1.1.16');
  assert.equal(config.expectedServerKeyFingerprint, FINGERPRINT);

  for (const baseUrl of [
    'file:///tmp/opc',
    'https://user:password@opc.example.com',
    'https://opc.example.com/path',
    'https://opc.example.com?token=secret',
    'https://opc.example.com#secret'
  ]) {
    assert.throws(
      () => createRustDeskClientProfilePackConfigFromEnv({
        CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_BASE_URL: baseUrl,
        CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_API_KEY: 'profile-pack-api-secret',
        CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID: 'tenant_led',
        CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION: '1.1.16',
        CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT: FINGERPRINT
      }),
      /base URL/
    );
  }

  assert.throws(
    () => createRustDeskClientProfilePackConfigFromEnv({
      CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_BASE_URL: 'https://opc.example.com',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_API_KEY: 'profile-pack-api-secret',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID: 'tenant_led',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION: 'latest',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT: FINGERPRINT
    }),
    /expected server version must equal 1\.1\.16/
  );

  assert.throws(
    () => createRustDeskClientProfilePackConfigFromEnv({
      CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_BASE_URL: 'https://opc.example.com',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_API_KEY: 'profile-pack-api-secret',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID: 'tenant_led',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION: '1.1.16',
      CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT: `sha256:${'a'.repeat(64)}`
    }),
    /expected fingerprint is invalid/
  );
});

test('RustDesk client profile pack rejects missing trusted pins before client calls', async () => {
  let calls = 0;
  const client = {
    async getClientProfile() {
      calls += 1;
      return profileFor('windows', 'x86_64');
    }
  };
  for (const config of [
    { ...packConfig(), expectedServerVersion: '' },
    { ...packConfig(), expectedServerKeyFingerprint: '' }
  ]) {
    await assert.rejects(
      () => buildRustDeskClientProfilePack(config as ReturnType<typeof packConfig>, client, () => NOW),
      /expected server (?:version|key fingerprint) is required/
    );
  }
  assert.equal(calls, 0);
});

test('RustDesk client profile pack writes a secret-free JSON artifact and exposes local tooling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-client-profile-pack-'));
  const outputFile = join(dir, 'profile-pack.json');
  const config = { ...packConfig(), outputFile };
  const result = await writeRustDeskClientProfilePack(
    config,
    { async getClientProfile(input) { return profileFor(input.platform, input.architecture); } },
    () => NOW
  );

  assert.deepEqual(result, { outputFile, ready: true, targets: 5, missingTargets: 0 });
  const written = readFileSync(outputFile, 'utf8');
  assert.equal((JSON.parse(written) as { ready: boolean }).ready, true);
  assert.doesNotMatch(written, /profile-pack-api-secret/);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:client-profile-pack'], 'tsx scripts/rustdesk-client-profile-pack.ts');
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const name of [
    'CONVERACT_RUSTDESK_CLIENT_ARTIFACTS_JSON',
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_FILE',
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_BASE_URL',
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_API_KEY',
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_PACK_TENANT_ID',
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_SERVER_VERSION',
    'CONVERACT_RUSTDESK_CLIENT_PROFILE_EXPECTED_FINGERPRINT'
  ]) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  }
});

function packConfig() {
  return {
    title: 'RustDesk desktop client distribution',
    baseUrl: 'https://opc.example.com',
    apiKey: 'profile-pack-api-secret',
    tenantId: 'tenant_led',
    expectedServerVersion: '1.1.16' as const,
    expectedServerKeyFingerprint: FINGERPRINT
  };
}

function profileFor(platform: string, architecture: string, missing = false, issuedAt = NOW) {
  const extension = platform === 'windows' ? 'exe' : platform === 'macos' ? 'dmg' : 'deb';
  const filename = `rustdesk-1.4.9-${architecture}.${extension}`;
  return {
    platform,
    architecture,
    client_version: { exact: '1.4.9', allowed: ['1.4.9'] },
    server_version: '1.1.16',
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 900_000).toISOString(),
    manual_fields: {
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      api_server: 'https://rustdesk-api.example.com',
      key: PUBLIC_KEY
    },
    server_key_fingerprint: FINGERPRINT,
    protocol_handler: { supported: true, user_initiated_only: true },
    install_source: missing ? { state: 'not_configured' } : {
      state: 'configured',
      url: `https://downloads.example.com/releases/1.4.9/${filename}`,
      filename,
      sha256: 'a'.repeat(64)
    },
    unattended_policy: { mode: 'attended_only', state: 'not_configured' },
    api_key: 'profile-pack-api-secret',
    bearer_token: 'bearer-secret',
    private_key: 'private-key-secret',
    edge_secret: 'edge-secret',
    unattended_password: 'unattended-secret',
    signed_launch_url: 'signed-launch-secret',
    protocol_launch_token: 'protocol-launch-secret',
    installer_credential: 'installer-secret'
  };
}
