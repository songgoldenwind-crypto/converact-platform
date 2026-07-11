import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildRustDeskClientConfigPack,
  createRustDeskClientConfigPackConfigFromEnv,
  renderRustDeskClientConfigPack,
  writeRustDeskClientConfigPack,
  type RustDeskClientConfigPackClient
} from '../scripts/rustdesk-client-config-pack.js';

test('RustDesk client config pack config maps focused env and fallbacks', () => {
  const config = createRustDeskClientConfigPackConfigFromEnv({
    OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md',
    OPC_RUSTDESK_CLIENT_CONFIG_PACK_TITLE: 'LED client setup',
    OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com/',
    OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
    OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_CLIENT_CONFIG_USER_ID: 'agent_1',
    OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rdgw_1',
    OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '123456789'
  });

  assert.equal(config.outputFile, '/tmp/rustdesk-client-config-pack.md');
  assert.equal(config.title, 'LED client setup');
  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiKey, 'secret-token');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.userId, 'agent_1');
  assert.equal(config.externalId, 'rdgw_1');
  assert.equal(config.targetRustDeskId, '123456789');

  const fallback = createRustDeskClientConfigPackConfigFromEnv({
    OPC_BASE_URL: 'https://opc-fallback.example.com',
    OPC_API_KEY: 'fallback-secret',
    OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_fallback'
  });
  assert.equal(fallback.baseUrl, 'https://opc-fallback.example.com');
  assert.equal(fallback.apiKey, 'fallback-secret');
  assert.equal(fallback.tenantId, 'tenant_fallback');
});

test('RustDesk client config pack rejects base URL credentials, query, and fragment without persisting secrets', () => {
  const invalidBaseUrls = [
    'https://url-user:url-password@opc.example.com/api',
    'https://opc.example.com/api?token=query-secret',
    'https://opc.example.com/api#fragment-secret'
  ];

  for (const baseUrl of invalidBaseUrls) {
    assert.throws(
      () => createRustDeskClientConfigPackConfigFromEnv({
        OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: baseUrl,
        OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'api-secret',
        OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led'
      }),
      (error) => {
        assert.match(String(error), /base URL must not include credentials, query, or fragment/);
        assert.doesNotMatch(String(error), /url-user|url-password|query-secret|fragment-secret/);
        return true;
      }
    );
  }

  const pathConfig = createRustDeskClientConfigPackConfigFromEnv({
    OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com/ivekit/',
    OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'api-secret',
    OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led'
  });
  assert.equal(pathConfig.baseUrl, 'https://opc.example.com/ivekit');
});

test('RustDesk client config pack renders launch availability without persisting signed or executable URLs', async () => {
  const pack = await buildRustDeskClientConfigPack(
    createRustDeskClientConfigPackConfigFromEnv({
      OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com',
      OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
      OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rdgw_1',
      OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '123456789'
    }),
    fakeClient()
  );

  assert.equal(pack.ready, true);
  assert.equal(pack.manual_fields.id_server, 'rustdesk-id.example.com');
  assert.equal(pack.manual_fields.relay_server, 'rustdesk-relay.example.com');
  assert.equal(pack.manual_fields.key, 'public-key-value');
  assert.equal(pack.launch?.external_id, 'rdgw_1');
  assert.equal(pack.launch?.target_rustdesk_id, '123456789');
  assert.equal(pack.launch?.launch_available, true);
  assert.equal(pack.launch?.protocol_available, true);
  assert.equal(pack.launch?.launch_url, '');
  assert.equal(pack.launch?.protocol_url, '');

  const markdown = renderRustDeskClientConfigPack(pack);
  assert.match(markdown, /^# RustDesk Client Config Pack/m);
  assert.match(markdown, /ID server/);
  assert.match(markdown, /rustdesk-id\.example\.com/);
  assert.match(markdown, /Relay server/);
  assert.match(markdown, /public-key-value/);
  assert.match(markdown, /sha256:abcdef1234567890/);
  assert.match(markdown, /launch available at generation: `yes`/);
  assert.match(markdown, /protocol launch available at generation: `yes`/);
  assert.doesNotMatch(markdown, /\/remote\/rustdesk\/launch|rustdesk:\/\/connect|token=|expires_at=|session_id=|\?session=/);
  assert.match(markdown, /does not prove real screen view/);
  assert.equal(markdown.includes('secret-token'), false);
  assert.doesNotMatch(JSON.stringify(pack), /signed-launch-token|\/remote\/rustdesk\/launch|rustdesk:\/\/connect|token=|expires_at=|session_id=|\?session=/);
});

test('RustDesk client config pack requires literal can_launch true for generation-time availability', async () => {
  const pack = await buildRustDeskClientConfigPack(
    createRustDeskClientConfigPackConfigFromEnv({
      OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com',
      OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
      OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rdgw_1'
    }),
    fakeClient({}, { can_launch: 'true' })
  );

  assert.equal(pack.launch?.launch_available, false);
  assert.equal(pack.launch?.protocol_available, false);
});

test('RustDesk client config pack rejects configured target drift from the launch plan', async () => {
  await assert.rejects(
    () => buildRustDeskClientConfigPack(
      createRustDeskClientConfigPackConfigFromEnv({
        OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com',
        OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
        OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rdgw_1',
        OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '987654321'
      }),
      fakeClient()
    ),
    /configured target RustDesk ID does not match launch plan target/
  );

  await assert.rejects(
    () => buildRustDeskClientConfigPack(
      createRustDeskClientConfigPackConfigFromEnv({
        OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com',
        OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
        OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rdgw_1',
        OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '123456789'
      }),
      fakeClient({}, {}, { id: '987654321', type: 'device' })
    ),
    /configured target RustDesk ID does not match launch plan target/
  );
});

test('RustDesk client config pack fails fast when manual client fields are unusable', async () => {
  await assert.rejects(
    () => buildRustDeskClientConfigPack(
      createRustDeskClientConfigPackConfigFromEnv({
        OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com',
        OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
        OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led'
      }),
      fakeClient({
        id_server: '',
        public_key_configured: false,
        manual_fields: { id_server: '', relay_server: '', key: '' }
      })
    ),
    /RustDesk client config id_server is required/
  );
});

test('RustDesk client config pack writes markdown and exposes package and env wiring', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-client-config-pack-'));
  const outputFile = join(dir, 'client-config-pack.md');
  const result = await writeRustDeskClientConfigPack(
    createRustDeskClientConfigPackConfigFromEnv({
      OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE: outputFile,
      OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL: 'https://opc.example.com',
      OPC_RUSTDESK_CLIENT_CONFIG_API_KEY: 'secret-token',
      OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: 'rdgw_1',
      OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '123456789'
    }),
    fakeClient()
  );

  assert.equal(result.outputFile, outputFile);
  assert.equal(result.ready, true);
  assert.equal(result.manualFields, 4);
  const written = readFileSync(outputFile, 'utf8');
  assert.match(written, /RustDesk Client Config Pack/);
  assert.match(written, /launch available at generation: `yes`/);
  assert.doesNotMatch(written, /signed-launch-token|\/remote\/rustdesk\/launch|rustdesk:\/\/connect|token=|expires_at=|session_id=|\?session=/);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:client-config-pack'], 'tsx scripts/rustdesk-client-config-pack.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE=',
    'OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL=',
    'OPC_RUSTDESK_CLIENT_CONFIG_API_KEY=',
    'OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID=',
    'OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID=',
    'OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});

function fakeClient(
  overrides: Record<string, unknown> = {},
  actionOverrides: Record<string, unknown> = {},
  target: Record<string, unknown> = { id: '123456789', type: 'device' }
): RustDeskClientConfigPackClient {
  return {
    async getClientConfig() {
      return {
        provider: 'rustdesk',
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        api_server: 'https://rustdesk-api.example.com',
        public_key: 'public-key-value',
        public_key_source: 'env',
        public_key_file: '',
        public_key_configured: true,
        server_key_fingerprint: 'sha256:abcdef1234567890',
        manual_fields: {
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          api_server: 'https://rustdesk-api.example.com',
          key: 'public-key-value'
        },
        ...overrides
      };
    },
    async getGatewayLaunchPlan() {
      return {
        provider: 'rustdesk',
        external_id: 'rdgw_1',
        status: 'active',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1&expires_at=1780000000000&token=signed-launch-token',
        target,
        permissions: ['view_screen', 'control_mouse_keyboard'],
        runtime: {
          rustdesk_id: '123456789',
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          api_server: 'https://rustdesk-api.example.com',
          server_key_fingerprint: 'sha256:abcdef1234567890',
          public_key_configured: 'true',
          public_key_source: 'env'
        },
        actions: {
          can_launch: true,
          open_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1&expires_at=1780000000000&token=signed-launch-token',
          protocol_url: 'rustdesk://connect/123456789?session=rdgw_1',
          ...actionOverrides
        },
        client_config: {
          public_key_configured: true,
          public_key_source: 'env',
          manual_fields: {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            api_server: 'https://rustdesk-api.example.com',
            key: 'public-key-value'
          }
        },
        metadata: {},
        created_at: '2026-07-08T10:00:00.000Z',
        ended_at: null
      } as never;
    }
  };
}
