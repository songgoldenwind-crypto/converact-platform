import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isValidRustDeskLaunchToken,
  rustDeskLaunchPlan,
  rustDeskRuntimeMetadata,
  rustDeskLaunchUrl
} from '../src/agent-runtime/collaboration/rustdesk-launch-plan.js';
import type { RustDeskGatewaySession } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';

test('RustDesk launch URL rejects base URLs without HTTP protocols', () => {
  const previousBaseUrl = process.env.OPC_RUSTDESK_LAUNCH_BASE_URL;
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'ftp://opc.example.com';

  try {
    assert.throws(
      () => rustDeskLaunchUrl('rustdesk-session-launch-base-contract-1'),
      /RustDesk launch base URL must use http\(s\)/
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousBaseUrl);
  }
});

test('RustDesk launch URL rejects missing signing secrets', () => {
  const previousEnv = {
    baseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    remoteGatewayToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    serverKey: process.env.OPC_RUSTDESK_SERVER_KEY
  };
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';
  delete process.env.OPC_RUSTDESK_LAUNCH_SECRET;
  delete process.env.OPC_RUSTDESK_API_TOKEN;
  delete process.env.OPC_REMOTE_GATEWAY_API_TOKEN;
  delete process.env.OPC_RUSTDESK_SERVER_KEY;

  try {
    assert.throws(
      () => rustDeskLaunchUrl('rustdesk-session-missing-launch-secret-1'),
      /RustDesk launch secret is not configured/
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.baseUrl);
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousEnv.launchSecret);
    restoreOptionalEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreOptionalEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.remoteGatewayToken);
    restoreOptionalEnv('OPC_RUSTDESK_SERVER_KEY', previousEnv.serverKey);
  }
});

test('RustDesk launch URL accepts HTTP base URLs and keeps the signed launch page path', () => {
  const previousBaseUrl = process.env.OPC_RUSTDESK_LAUNCH_BASE_URL;
  const previousSecret = process.env.OPC_RUSTDESK_LAUNCH_SECRET;
  const previousTtl = process.env.OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS;
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com///';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS = '60000';

  try {
    const externalId = 'rustdesk-session-launch-base-contract-2';
    const launchUrl = new URL(rustDeskLaunchUrl(externalId));
    const token = launchUrl.searchParams.get('token') || '';
    const expiresAt = launchUrl.searchParams.get('expires_at') || '';

    assert.equal(launchUrl.protocol, 'https:');
    assert.equal(launchUrl.origin, 'https://opc.example.com');
    assert.equal(launchUrl.pathname, '/remote/rustdesk/launch');
    assert.equal(launchUrl.searchParams.get('session_id'), externalId);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.match(expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(new Date(expiresAt).getTime() > Date.now(), true);
    assert.equal(isValidRustDeskLaunchToken(externalId, token, expiresAt), true);
    assert.equal(isValidRustDeskLaunchToken(externalId, token, '2000-01-01T00:00:00.000Z'), false);
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousBaseUrl);
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousSecret);
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS', previousTtl);
  }
});

test('RustDesk launch URL rejects invalid token TTL configuration', () => {
  const previousBaseUrl = process.env.OPC_RUSTDESK_LAUNCH_BASE_URL;
  const previousSecret = process.env.OPC_RUSTDESK_LAUNCH_SECRET;
  const previousTtl = process.env.OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS;
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS = '0';

  try {
    assert.throws(
      () => rustDeskLaunchUrl('rustdesk-session-invalid-ttl-1'),
      /RustDesk launch token ttl must be a positive integer/
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousBaseUrl);
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousSecret);
    restoreOptionalEnv('OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS', previousTtl);
  }
});

test('RustDesk launch plan rejects protocol URL templates without the rustdesk scheme', () => {
  const previousTemplate = process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE;
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'https://opc.example.com/connect/{rustdesk_id}';

  try {
    assert.throws(
      () => rustDeskLaunchPlan(rustDeskSession()),
      /RustDesk protocol URL template must produce a rustdesk:\/\/ URL/
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousTemplate);
  }
});

test('RustDesk launch plan accepts rustdesk protocol URL templates', () => {
  const previousTemplate = process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE;
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdesk_id}?session={external_id}';

  try {
    const plan = rustDeskLaunchPlan(rustDeskSession());

    assert.equal(
      plan.actions.protocol_url,
      'rustdesk://connect/123456789?session=rustdesk-session-protocol-contract-1'
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousTemplate);
  }
});

test('RustDesk launch plan binds the protocol URL to the exact native session', () => {
  const previousTemplate = process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE;
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdesk_id}?session={external_id}';

  try {
    const plan = rustDeskLaunchPlan({
      ...rustDeskSession(),
      metadata: {
        rustdesk_id: '123456789',
        ivekit_native_session_id: '9223372036854775807'
      }
    });
    const protocolUrl = new URL(plan.actions.protocol_url);

    assert.equal(protocolUrl.searchParams.get('session'), 'rustdesk-session-protocol-contract-1');
    assert.equal(protocolUrl.searchParams.get('ivekit_session_id'), '9223372036854775807');
    assert.equal(plan.metadata.ivekit_native_session_id, undefined);
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousTemplate);
  }
});

test('RustDesk launch plan clears the launch URL after the session ends', () => {
  const plan = rustDeskLaunchPlan({
    ...rustDeskSession(),
    status: 'ended',
    ended_at: '2026-07-04T00:10:00.000Z',
    ended_by: 'engineer_42'
  });

  assert.equal(plan.launch_url, '');
  assert.equal(plan.actions.can_launch, false);
  assert.equal(plan.actions.open_url, '');
  assert.equal(plan.actions.protocol_url, '');
});

test('RustDesk launch plan rejects secret-bearing metadata and preserves safe metadata', () => {
  assert.throws(
    () => rustDeskLaunchPlan({
      ...rustDeskSession(),
      metadata: {
        source: 'ivekit',
        nested: [{ credential_ref: 'secret://rustdesk/launch' }]
      }
    }),
    /RustDesk gateway metadata contains sensitive material/
  );

  const plan = rustDeskLaunchPlan({
    ...rustDeskSession(),
    metadata: { source: 'ivekit', site: 'showroom-7', rustdesk_id: '123456789' }
  });
  assert.equal(plan.metadata.source, 'ivekit');
  assert.equal(plan.metadata.site, 'showroom-7');
});

test('RustDesk launch plan rejects unsupported protocol URL template placeholders', () => {
  const previousTemplate = process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE;
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdeskid}?session={external_id}';

  try {
    assert.throws(
      () => rustDeskLaunchPlan(rustDeskSession()),
      /RustDesk protocol URL template contains unsupported placeholder: rustdeskid/
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousTemplate);
  }
});

test('RustDesk runtime metadata rejects API servers without HTTP protocols', () => {
  const previousApiServer = process.env.OPC_RUSTDESK_API_SERVER;
  process.env.OPC_RUSTDESK_API_SERVER = 'ftp://rustdesk-api.example.com';

  try {
    assert.throws(
      () => rustDeskRuntimeMetadata({}, { type: 'device', id: '123456789' }),
      /RustDesk API server must use http\(s\)/
    );
  } finally {
    restoreOptionalEnv('OPC_RUSTDESK_API_SERVER', previousApiServer);
  }
});

function rustDeskSession(): RustDeskGatewaySession {
  return {
    external_id: 'rustdesk-session-protocol-contract-1',
    tenant_id: 'tenant_led',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-session-protocol-contract-1&token=launch-token',
    status: 'active',
    metadata: { rustdesk_id: '123456789' },
    created_at: '2026-07-04T00:00:00.000Z',
    ended_at: null,
    ended_by: ''
  };
}

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
