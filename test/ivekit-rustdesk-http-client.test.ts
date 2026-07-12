import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIveKitRustDeskHttpClient,
  IveKitRustDeskHttpError,
  projectRustDeskClientDistributionProfile
} from '../src/agent-runtime/ivekit/index.js';

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

test('iveKit RustDesk HTTP client calls the reusable facade lifecycle', async () => {
  const calls: FetchCall[] = [];
  const responses = [
    { id_server: 'rustdesk-id.example.com' },
    {
      id: 'rdesk_1',
      rustdesk_id: '123456789',
      display_name: 'LED controller'
    },
    { id: 'rdesk_1', rustdesk_id: '123456789' },
    [{ id: 'rdesk_1', rustdesk_id: '123456789' }],
    { id: 'rdesk_1', runtime_status: 'online' },
    {
      id: 'tool_1',
      provider: 'rustdesk',
      external_id: 'rdgw_1',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1'
    },
    { external_id: 'rdgw_1', status: 'active' },
    { event: { id: 'evt_1', event_type: 'remote.rustdesk.control_action.performed' } },
    { events: [{ id: 'evt_1', event_type: 'remote.rustdesk.control_action.performed' }] },
    { id: 'rdesk_1', status: 'inactive' },
    null,
    {
      required: true,
      status: 'pending',
      command: {
        id: 'rdcmd_1',
        external_id: 'rdgw_1',
        status: 'pending',
        requested_reason: 'gateway_ended'
      }
    }
  ];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const headers = headersToRecord(init.headers);
    calls.push({
      url: String(input),
      method: init.method || 'GET',
      headers,
      body: init.body ? JSON.parse(String(init.body)) : null
    });
    const body = responses.shift();
    return jsonResponse(body === null ? 204 : 200, body);
  };
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com/',
    apiKey: 'opc-api-key',
    tenantId: 'tenant_led',
    userId: 'agent_led',
    fetch: fetchImpl
  });

  await client.getClientConfig();
  await client.registerDevice({
    business_ref: { type: 'service_order', id: 'SO-1' },
    rustdesk_id: '123456789',
    display_name: 'LED controller',
    metadata: { rack: 'A-01' }
  });
  await client.getDevice('rdesk_1');
  await client.listDevicesByBusinessRef({
    business_ref: { type: 'service_order', id: 'SO-1' },
    limit: 25
  });
  await client.heartbeatDevice('rdesk_1', {
    actor_identity: 'edge-led-1',
    runtime_status: 'online',
    metadata: { ip: '10.0.0.8' }
  });
  await client.startGatewaySession({
    remote_session_id: 'remote_1',
    device_id: 'rdesk_1',
    actor_identity: 'agent_led',
    permissions: ['view_screen', 'control_mouse_keyboard'],
    metadata: { source: 'led' }
  });
  await client.getGatewayLaunchPlan('rdgw_1');
  await client.recordGatewayEvent('rdgw_1', {
    event_type: 'remote.rustdesk.control_action.performed',
    actor_identity: 'agent_led',
    metadata: {
      operation_id: 'op_1',
      action: 'mouse.click',
      permission: 'control_mouse_keyboard'
    }
  });
  await client.listGatewayAuditEvents('rdgw_1', {
    since: '2026-07-06T00:00:00.000Z'
  });
  await client.deactivateDevice('rdesk_1');
  await client.endGatewaySession('rdgw_1', {
    actor_identity: 'agent_led'
  });
  const disconnectState = await client.getGatewayDisconnectState('rdgw_1');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`),
    [
      'GET /api/ivekit/rustdesk/client-config',
      'POST /api/ivekit/rustdesk/devices',
      'GET /api/ivekit/rustdesk/devices/rdesk_1',
      'GET /api/ivekit/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-1&limit=25',
      'POST /api/ivekit/rustdesk/devices/rdesk_1/heartbeat',
      'POST /api/ivekit/rustdesk/gateway-sessions',
      'GET /api/ivekit/rustdesk/gateway-sessions/rdgw_1/launch',
      'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_1/events',
      'GET /api/ivekit/rustdesk/gateway-sessions/rdgw_1/audit?since=2026-07-06T00%3A00%3A00.000Z',
      'POST /api/ivekit/rustdesk/devices/rdesk_1/deactivate',
      'DELETE /api/ivekit/rustdesk/gateway-sessions/rdgw_1',
      'GET /api/ivekit/rustdesk/gateway-sessions/rdgw_1/disconnect'
    ]
  );
  for (const call of calls) {
    assert.equal(call.headers['x-api-key'], 'opc-api-key');
    assert.equal(call.headers['x-tenant-id'], 'tenant_led');
    assert.equal(call.headers['x-user-id'], 'agent_led');
  }
  assert.deepEqual(calls[1].body, {
    business_ref: { type: 'service_order', id: 'SO-1' },
    rustdesk_id: '123456789',
    display_name: 'LED controller',
    metadata: { rack: 'A-01' }
  });
  assert.deepEqual(calls[10].body, { actor_identity: 'agent_led' });
  assert.equal(disconnectState.status, 'pending');
  assert.equal(disconnectState.command?.id, 'rdcmd_1');
  assert.equal(JSON.stringify(disconnectState).includes('claim_token'), false);
});

test('iveKit RustDesk HTTP client rejects bad configuration before calling fetch', async () => {
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'file:///tmp/opc', apiKey: 'k', tenantId: 't' }),
    /baseUrl must use http\(s\)/
  );
  for (const baseUrl of [
    'https://url-user:url-password@opc.example.com',
    'https://opc.example.com?token=query-secret',
    'https://opc.example.com#fragment-secret'
  ]) {
    assert.throws(
      () => createIveKitRustDeskHttpClient({ baseUrl, apiKey: 'k', tenantId: 't' }),
      (error) => {
        assert.match(String(error), /baseUrl must not include credentials, query, or fragment/);
        assert.doesNotMatch(String(error), /url-user|url-password|query-secret|fragment-secret/);
        return true;
      }
    );
  }
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'https://opc.example.com/ivekit/', apiKey: 'k', tenantId: 't' }),
    /baseUrl must not include a path/
  );
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'https://opc.example.com', apiKey: '', tenantId: 't' }),
    /exactly one of apiKey or accessToken is required/
  );
  assert.throws(
    () => createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      apiKey: 'server-key',
      accessToken: 'user-token',
      tenantId: 't'
    }),
    /exactly one of apiKey or accessToken is required/
  );
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'https://opc.example.com', apiKey: 'k', tenantId: '' }),
    /tenantId is required/
  );
});

test('iveKit RustDesk HTTP client keeps Bearer identity authoritative', async () => {
  let headers: Record<string, string> = {};
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-user-token',
    tenantId: 'tenant_led',
    userId: 'spoofed-user-id',
    fetch: async (_input, init = {}) => {
      headers = headersToRecord(init.headers);
      return jsonResponse(200, { id_server: 'rustdesk-id.example.com' });
    }
  });

  await client.getClientConfig();
  assert.equal(headers.authorization, 'Bearer short-lived-user-token');
  assert.equal(headers['x-tenant-id'], 'tenant_led');
  assert.equal(headers['x-user-id'], undefined);
  assert.equal(headers['x-api-key'], undefined);
});

test('iveKit RustDesk HTTP client exposes status, method, path, and upstream error', async () => {
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    apiKey: 'opc-api-key',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(403, { error: 'active consent required' })
  });

  await assert.rejects(
    () =>
      client.startGatewaySession({
        remote_session_id: 'remote_1',
        device_id: 'rdesk_1',
        actor_identity: 'agent_led',
        permissions: ['view_screen']
      }),
    (error) => {
      assert.equal(error instanceof IveKitRustDeskHttpError, true);
      const httpError = error as IveKitRustDeskHttpError;
      assert.equal(httpError.status, 403);
      assert.equal(httpError.method, 'POST');
      assert.equal(httpError.path, '/api/ivekit/rustdesk/gateway-sessions');
      assert.match(httpError.message, /active consent required/);
      return true;
    }
  );
});

test('iveKit RustDesk HTTP client applies the configured request timeout', async () => {
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    apiKey: 'opc-api-key',
    tenantId: 'tenant_led',
    timeoutMs: 100,
    fetch: async (_input, init = {}) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });

  await assert.rejects(
    () => client.getClientConfig(),
    (error) => {
      assert.equal(error instanceof IveKitRustDeskHttpError, true);
      const timeout = error as IveKitRustDeskHttpError;
      assert.equal(timeout.status, 0);
      assert.equal(timeout.method, 'GET');
      assert.equal(timeout.path, '/api/ivekit/rustdesk/client-config');
      assert.match(timeout.message, /timed out after 100ms/);
      return true;
    }
  );
});

test('iveKit RustDesk HTTP client requests and projects a pinned client distribution profile', async () => {
  const calls: string[] = [];
  const now = Date.now();
  const responseProfile = {
    ...expectedClientDistributionProfile(),
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 840_000).toISOString()
  };
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async (input) => {
      calls.push(String(input));
      return jsonResponse(200, unsafeClientDistributionProfile(responseProfile));
    }
  });

  const profile = await client.getClientProfile({
    platform: 'windows',
    architecture: 'x86_64',
    client_version: '1.4.7',
    expected_server_version: '1.1.15',
    expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
  });

  assert.equal(calls.length, 1);
  assert.equal(
    new URL(calls[0]).search,
    '?platform=windows&architecture=x86_64&client_version=1.4.7&expected_server_version=1.1.15&expected_server_key_fingerprint=sha256%3Ac57cc3b55d39f9a6'
  );
  assert.deepEqual(profile, responseProfile);
  assert.doesNotMatch(
    JSON.stringify(profile),
    /api_key|bearer|private_key|edge_secret|unattended_password|launch_token|installer_credential|drop-me/
  );
});

test('iveKit RustDesk client profile projection rejects drift, expiry, and malformed responses', async () => {
  const base = expectedClientDistributionProfile();
  const expected = {
    platform: 'windows' as const,
    architecture: 'x86_64' as const,
    client_version: '1.4.7',
    expected_server_version: '1.1.15',
    expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
  };
  const invalid: Array<[string, unknown, RegExp]> = [
    ['platform drift', { ...base, platform: 'linux' }, /platform/],
    ['unsupported tuple', { ...base, architecture: 'aarch64' }, /tuple/],
    ['client drift', { ...base, client_version: { exact: '1.4.8', allowed: ['1.4.8'] } }, /client_version/],
    ['floating allowed version', { ...base, client_version: { exact: '1.4.7', allowed: ['^1.4.7'] } }, /client_version/],
    ['server drift', { ...base, server_version: '1.1.14' }, /server_version/],
    ['key drift', { ...base, server_key_fingerprint: 'sha256:0000000000000000' }, /fingerprint/],
    ['expired', { ...base, expires_at: '2020-01-01T00:00:00.000Z' }, /expired/],
    ['bad timestamp', { ...base, issued_at: 'today' }, /issued_at/],
    ['unsafe URL', {
      ...base,
      install_source: { ...base.install_source, url: 'https://user:password@downloads.example.com/1.4.7/rustdesk.exe' }
    }, /install_source.url/],
    ['bad checksum', {
      ...base,
      install_source: { ...base.install_source, sha256: 'not-a-checksum' }
    }, /install_source.sha256/],
    ['unsafe API server', {
      ...base,
      manual_fields: { ...base.manual_fields, api_server: 'https://user:password@rustdesk-api.example.com' }
    }, /manual_fields.api_server/],
    ['unattended claim', {
      ...base,
      unattended_policy: { mode: 'unattended_allowed', state: 'configured' }
    }, /unattended_policy/]
  ];

  for (const [name, value, pattern] of invalid) {
    await assert.rejects(
      async () => projectRustDeskClientDistributionProfile(value, expected, new Date('2026-07-12T12:05:00.000Z')),
      pattern,
      name
    );
  }
});

test('iveKit RustDesk client profile binds the returned public key to both fingerprints', async () => {
  const profile = {
    ...expectedClientDistributionProfile(),
    manual_fields: {
      ...expectedClientDistributionProfile().manual_fields,
      key: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
    },
    server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
  };

  await assert.rejects(
    async () => projectRustDeskClientDistributionProfile(profile, {
      platform: 'windows',
      architecture: 'x86_64',
      client_version: '1.4.7',
      expected_server_version: '1.1.15',
      expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
    }, new Date('2026-07-12T12:05:00.000Z')),
    /public key fingerprint/
  );
});

for (const [name, key] of [
  ['malformed base64', 'not-base64'],
  ['multiline base64', 'AQEBAQEBAQEBAQEBAQEB\nAQEBAQEBAQEBAQEBAQEBAQE='],
  ['noncanonical base64', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'],
  ['decoded private-key length', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=='],
  ['PEM private key', '-----BEGIN PRIVATE KEY-----\nAQEBAQ==\n-----END PRIVATE KEY-----']
] as const) {
  test(`iveKit RustDesk profile projection rejects ${name} public key`, async () => {
    const profile = {
      ...expectedClientDistributionProfile(),
      manual_fields: { ...expectedClientDistributionProfile().manual_fields, key },
      server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
    };
    await assert.rejects(
      async () => projectRustDeskClientDistributionProfile(profile, {
        platform: 'windows',
        architecture: 'x86_64',
        client_version: '1.4.7',
        expected_server_version: '1.1.15',
        expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
      }, new Date('2026-07-12T12:05:00.000Z')),
      /manual_fields.key/
    );
  });
}

test('iveKit RustDesk HTTP client rejects missing profile pins before fetch', async () => {
  let calls = 0;
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => {
      calls += 1;
      return jsonResponse(200, expectedClientDistributionProfile());
    }
  });
  const base = {
    platform: 'windows' as const,
    architecture: 'x86_64' as const,
    client_version: '1.4.7'
  };

  for (const input of [
    { ...base, expected_server_version: '', expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6' },
    { ...base, expected_server_version: '1.1.15', expected_server_key_fingerprint: '' }
  ]) {
    await assert.rejects(() => client.getClientProfile(input), /expected_server_(?:version|key_fingerprint) is required/);
  }
  assert.equal(calls, 0);
});

for (const [name, filename, urlFilename] of [
  ['version mismatch', 'rustdesk-1.4.8-windows-x86_64.exe', 'rustdesk-1.4.8-windows-x86_64.exe'],
  ['platform mismatch', 'rustdesk-1.4.7-linux-x86_64.exe', 'rustdesk-1.4.7-linux-x86_64.exe'],
  ['architecture mismatch', 'rustdesk-1.4.7-windows-aarch64.exe', 'rustdesk-1.4.7-windows-aarch64.exe'],
  ['extension mismatch', 'rustdesk-1.4.7-windows-x86_64.dmg', 'rustdesk-1.4.7-windows-x86_64.dmg'],
  ['URL basename mismatch', 'rustdesk-1.4.7-windows-x86_64.exe', 'other-1.4.7-windows-x86_64.exe']
] as const) {
  test(`iveKit RustDesk profile projection rejects artifact ${name}`, async () => {
    const profile = {
      ...expectedClientDistributionProfile(),
      manual_fields: {
        ...expectedClientDistributionProfile().manual_fields,
        key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
      },
      server_key_fingerprint: 'sha256:c57cc3b55d39f9a6',
      install_source: {
        state: 'configured',
        filename,
        url: `https://downloads.example.com/releases/1.4.7/${urlFilename}`,
        sha256: 'a'.repeat(64)
      }
    };
    await assert.rejects(
      async () => projectRustDeskClientDistributionProfile(profile, {
        platform: 'windows',
        architecture: 'x86_64',
        client_version: '1.4.7',
        expected_server_version: '1.1.15',
        expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
      }, new Date('2026-07-12T12:05:00.000Z')),
      /install_source/
    );
  });
}

test('iveKit RustDesk profile projection rejects inexact release paths and contradictory identity tokens', async () => {
  const expectedFilename = 'rustdesk-1.4.7-windows-x86_64.exe';
  const invalidSources = [
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
  const expected = {
    platform: 'windows' as const,
    architecture: 'x86_64' as const,
    client_version: '1.4.7',
    expected_server_version: '1.1.15',
    expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
  };

  for (const { name, filename, url } of invalidSources) {
    const base = expectedClientDistributionProfile();
    await assert.rejects(
      () => projectRustDeskClientDistributionProfile({
        ...base,
        install_source: { ...base.install_source, filename, url }
      }, expected, new Date('2026-07-12T12:05:00.000Z')),
      /install_source/,
      name
    );
  }

  const base = expectedClientDistributionProfile();
  const githubUrl = `https://github.com/rustdesk/rustdesk/releases/download/1.4.7/${expectedFilename}`;
  const githubProfile = await projectRustDeskClientDistributionProfile({
    ...base,
    install_source: { ...base.install_source, url: githubUrl }
  }, expected, new Date('2026-07-12T12:05:00.000Z'));
  assert.equal(githubProfile.install_source.state, 'configured');
  if (githubProfile.install_source.state === 'configured') {
    assert.equal(githubProfile.install_source.url, githubUrl);
  }
});

test('iveKit RustDesk profile projection rejects noncanonical installer filenames', async () => {
  const safe = 'rustdesk-1.4.7-windows-x86_64.exe';
  const baseUrl = 'https://downloads.example.com/releases/1.4.7/';
  const invalidSources = [
    ['raw URL newline', safe, `${baseUrl}rustdesk-1.4.7-windows-x86_\n64.exe`],
    ['encoded newline', 'rustdesk-1.4.7-windows-x86_64\n.exe', `${baseUrl}rustdesk-1.4.7-windows-x86_64%0A.exe`],
    ['encoded control', 'rustdesk-1.4.7-windows-x86_64\u0000.exe', `${baseUrl}rustdesk-1.4.7-windows-x86_64%00.exe`],
    ['whitespace', 'rustdesk 1.4.7-windows-x86_64.exe', `${baseUrl}rustdesk%201.4.7-windows-x86_64.exe`],
    ['literal percent escape', 'rustdesk-%0A-1.4.7-windows-x86_64.exe', `${baseUrl}rustdesk-%250A-1.4.7-windows-x86_64.exe`],
    ['encoded canonical basename', safe, `${baseUrl}rustdesk-1.4.7-windows-%7886_64.exe`],
    ['Unicode confusable', 'rustdеsk-1.4.7-windows-x86_64.exe', `${baseUrl}rustdеsk-1.4.7-windows-x86_64.exe`],
    ['disallowed ASCII', 'rustdesk@1.4.7-windows-x86_64.exe', `${baseUrl}rustdesk@1.4.7-windows-x86_64.exe`],
    ['overlong filename', `${'a'.repeat(230)}-rustdesk-1.4.7-windows-x86_64.exe`, `${baseUrl}${'a'.repeat(230)}-rustdesk-1.4.7-windows-x86_64.exe`],
    ['malformed percent encoding', safe, `${baseUrl}rustdesk-1.4.7-windows-x86_64%ZZ.exe`]
  ] as const;
  const expected = {
    platform: 'windows' as const,
    architecture: 'x86_64' as const,
    client_version: '1.4.7',
    expected_server_version: '1.1.15',
    expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
  };

  for (const [name, filename, url] of invalidSources) {
    const profile = expectedClientDistributionProfile();
    await assert.rejects(
      () => projectRustDeskClientDistributionProfile({
        ...profile,
        install_source: { ...profile.install_source, filename, url }
      }, expected, new Date('2026-07-12T12:05:00.000Z')),
      /install_source/,
      name
    );
  }
});

test('iveKit RustDesk profile projection rejects lifetime below 60 seconds', async () => {
  const profile = {
    ...expectedClientDistributionProfile(),
    issued_at: '2026-07-12T12:00:00.000Z',
    expires_at: '2026-07-12T12:00:00.005Z'
  };

  await assert.rejects(
    () => projectRustDeskClientDistributionProfile(profile, {
      platform: 'windows',
      architecture: 'x86_64',
      client_version: '1.4.7',
      expected_server_version: '1.1.15',
      expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
    }, new Date('2026-07-12T12:00:00.000Z')),
    /profile lifetime/
  );
});

for (const [name, timestamps] of [
  ['impossible calendar date', { issued_at: '2026-02-30T12:00:00.000Z' }],
  ['timezone offset', { issued_at: '2026-07-12T20:00:00.000+08:00' }],
  ['missing millisecond precision', { issued_at: '2026-07-12T12:00:00Z' }],
  ['issued more than 60 seconds in the future', {
    issued_at: '2026-07-12T12:06:01.000Z',
    expires_at: '2026-07-12T12:21:01.000Z'
  }],
  ['lifetime above configured maximum', {
    issued_at: '2026-07-12T12:00:00.000Z',
    expires_at: '2026-07-12T13:00:00.001Z'
  }]
] as const) {
  test(`iveKit RustDesk profile projection rejects ${name}`, async () => {
    const profile = {
      ...expectedClientDistributionProfile(),
      ...timestamps,
      manual_fields: {
        ...expectedClientDistributionProfile().manual_fields,
        key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
      },
      server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
    };
    await assert.rejects(
      async () => projectRustDeskClientDistributionProfile(profile, {
        platform: 'windows',
        architecture: 'x86_64',
        client_version: '1.4.7',
        expected_server_version: '1.1.15',
        expected_server_key_fingerprint: 'sha256:c57cc3b55d39f9a6'
      }, new Date('2026-07-12T12:05:00.000Z')),
      /invalid RustDesk client distribution profile: (?:issued_at|expires_at|profile lifetime)/
    );
  });
}

test('iveKit RustDesk HTTP client projects complete terminal profiles from every device response path', async () => {
  const device = (id: string) => ({
    id,
    rustdesk_id: '123456789',
    terminal_profile: unsafeTerminalProfile(id)
  });
  const responses = [
    device('registered'),
    device('fetched'),
    [device('listed')],
    device('heartbeat'),
    device('deactivated')
  ];
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, responses.shift())
  });

  const devices = [
    await client.registerDevice({
      business_ref: { type: 'service_order', id: 'SO-1' },
      rustdesk_id: '123456789',
      display_name: 'LED controller'
    }),
    await client.getDevice('rdesk_1'),
    ...(await client.listDevicesByBusinessRef({
      business_ref: { type: 'service_order', id: 'SO-1' }
    })),
    await client.heartbeatDevice('rdesk_1', { actor_identity: 'edge-led-1' }),
    await client.deactivateDevice('rdesk_1')
  ];

  assert.equal(devices.length, 5);
  for (const projected of devices) {
    assert.deepEqual(projected.terminal_profile, expectedTerminalProfile(projected.id));
  assert.doesNotMatch(
      JSON.stringify(projected),
      /api_key|private_key|profile-token|nested-token|clipboard_text|terminal clipboard secret|metadata-token|reference-token|top-level-credential|arbitrary|drop-me/
    );
  }
});

test('iveKit RustDesk HTTP client rejects invalid terminal profile fields', async () => {
  const base = expectedTerminalProfile('rdesk_1');
  const invalidProfiles: Array<[string, unknown]> = [
    ['missing device_id', { ...base, device_id: undefined }],
    ['blank rustdesk_id', { ...base, rustdesk_id: '' }],
    ['invalid platform', { ...base, platform: 'android' }],
    ['invalid architecture', { ...base, architecture: 'riscv64' }],
    ['missing client_version', { ...base, client_version: undefined }],
    ['invalid client product', { ...base, client_version: { ...base.client_version, product: 'other' } }],
    ['blank client version', { ...base, client_version: { ...base.client_version, version: '' } }],
    ['invalid client channel', { ...base, client_version: { ...base.client_version, channel: 'nightly' } }],
    ['invalid client source', { ...base, client_version: { ...base.client_version, source: 'edge' } }],
    ['invalid client timestamp', { ...base, client_version: { ...base.client_version, reported_at: 'yesterday' } }],
    ['missing configured', { ...base, configured: undefined }],
    ...(['id_server_configured', 'relay_server_configured', 'api_server_configured', 'public_key_configured'] as const)
      .map((field) => [`invalid configured.${field}`, {
        ...base,
        configured: { ...base.configured, [field]: 'true' }
      }] as [string, unknown]),
    ['missing fingerprint', { ...base, configured: { ...base.configured, server_key_fingerprint: undefined } }],
    ['missing available', { ...base, available: undefined }],
    ['invalid available source', { ...base, available: { ...base.available, source: 'configured' } }],
    ['invalid available timestamp', { ...base, available: { ...base.available, reported_at: 'not-a-time' } }],
    ...([
      'view_screen',
      'control_mouse_keyboard',
      'multi_display',
      'transfer_file',
      'clipboard',
      'record_screen',
      'session_disconnect'
    ] as const).map((field) => [`invalid available.${field}`, {
      ...base,
      available: { ...base.available, [field]: 'configured' }
    }] as [string, unknown]),
    ['missing granted', { ...base, granted: undefined }],
    ...(['requested', 'consented', 'granted'] as const).flatMap((field) => [
      [`non-array granted.${field}`, { ...base, granted: { ...base.granted, [field]: 'view_screen' } }],
      [`invalid scope in granted.${field}`, { ...base, granted: { ...base.granted, [field]: ['multi_display'] } }]
    ] as Array<[string, unknown]>),
    ['non-array observed', { ...base, observed: {} }],
    ['invalid updated_at', { ...base, updated_at: 'tomorrow' }]
  ];

  for (const [name, terminal_profile] of invalidProfiles) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, { id: 'rdesk_1', terminal_profile })
    });
    await assert.rejects(
      () => client.getDevice('rdesk_1'),
      (error) => {
        assert.match(String(error), /invalid RustDesk terminal profile/, name);
        return true;
      },
      name
    );
  }
});

test('iveKit RustDesk terminal profile enforces requested, consented, and granted subsets', async () => {
  const base = expectedTerminalProfile('rdesk_1');
  for (const granted of [
    {
      requested: ['view_screen'],
      consented: ['view_screen', 'transfer_file'],
      granted: ['view_screen']
    },
    {
      requested: ['view_screen'],
      consented: ['view_screen'],
      granted: ['view_screen', 'clipboard']
    }
  ]) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, {
        id: 'rdesk_1',
        rustdesk_id: '123456789',
        terminal_profile: { ...base, granted }
      })
    });

    await assert.rejects(() => client.getDevice('rdesk_1'), /invalid RustDesk terminal profile: granted/);
  }
});

test('iveKit RustDesk terminal profile is bound to the enclosing device identifiers', async () => {
  for (const terminal_profile of [
    { ...expectedTerminalProfile('different-device'), rustdesk_id: '123456789' },
    { ...expectedTerminalProfile('rdesk_1'), rustdesk_id: '987654321' }
  ]) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, {
        id: 'rdesk_1',
        rustdesk_id: '123456789',
        terminal_profile
      })
    });

    await assert.rejects(() => client.getDevice('rdesk_1'), /invalid RustDesk terminal profile: device binding/);
  }
});

test('iveKit RustDesk HTTP client fails closed on invalid terminal evidence', async () => {
  const terminalProfile = expectedTerminalProfile('rdesk_1');
  terminalProfile.observed = [{
    operation_id: 'terminal-operation-1',
    operation: 'view_screen',
    status: 'observed_succeeded',
    observer: 'none',
    observed_at: '2026-07-12T12:00:00.000Z',
    evidence_refs: [{ type: 'qa_report', ref: 'evidence://run-1/view-1', sha256: 'a'.repeat(64) }],
    metadata: { token: 'must-not-leak' }
  }] as never;
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, {
      id: 'rdesk_1',
      terminal_profile: terminalProfile
    })
  });

  await assert.rejects(
    () => client.getDevice('rdesk_1'),
    (error) => {
      assert.match(String(error), /invalid RustDesk operation evidence/);
      assert.doesNotMatch(String(error), /must-not-leak/);
      return true;
    }
  );
});

test('iveKit RustDesk HTTP client projects operation evidence onto browser-safe keys', async () => {
  const observed = {
    operation_id: 'operation-1',
    operation: 'clipboard',
    status: 'observed_succeeded',
    observer: 'qa',
    observed_at: '2026-07-12T12:00:00.000Z',
    evidence_refs: [{
      type: 'qa_report',
      ref: 'evidence://run-1/clipboard-1',
      sha256: 'a'.repeat(64),
      token: 'evidence-ref-token'
    }],
    metadata: {
      operation_id: 'operation-1',
      external_id: 'rdgw_1',
      direction: 'agent_to_device',
      byte_count: 24,
      checksum_sha256: 'b'.repeat(64),
      status_detail: 'operator_verified',
      clipboard_text: 'sensitive clipboard text',
      token: 'metadata-token',
      arbitrary: 'drop-me'
    },
    credential: 'top-level-credential'
  };
  const disconnectObserved = {
    ...observed,
    operation_id: 'disconnect-1',
    operation: 'session_disconnect',
    metadata: {
      external_id: 'rdgw_1',
      reason: 'operator_verified',
      token: 'disconnect-token'
    }
  };
  const responses = [
    {
      id: 'tool_1',
      operation_evidence: [observed],
      disconnect_state: {
        required: true,
        status: 'succeeded',
        command: { id: 'rdcmd_1', status: 'succeeded' },
        observation_status: 'observed_disconnected',
        observed: disconnectObserved
      }
    },
    { external_id: 'rdgw_1', operation_evidence: [observed] },
    {
      required: true,
      status: 'succeeded',
      command: { id: 'rdcmd_1', status: 'succeeded' },
      observation_status: 'observed_disconnected',
      observed: disconnectObserved
    }
  ];
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, responses.shift())
  });

  const session = await client.startGatewaySession({
    remote_session_id: 'remote_1',
    device_id: 'rdesk_1',
    actor_identity: 'agent_led',
    permissions: ['view_screen']
  });
  const launch = await client.getGatewayLaunchPlan('rdgw_1');
  const disconnect = await client.getGatewayDisconnectState('rdgw_1');

  for (const value of [session, launch, disconnect]) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /clipboard_text|sensitive clipboard text|metadata-token|disconnect-token|evidence-ref-token|top-level-credential|arbitrary|drop-me/);
  }
  assert.deepEqual(session.operation_evidence?.[0].metadata, {
    external_id: 'rdgw_1',
    direction: 'agent_to_device',
    byte_count: 24,
    checksum_sha256: 'b'.repeat(64),
    status_detail: 'operator_verified'
  });
  assert.deepEqual(session.operation_evidence?.[0].evidence_refs[0], {
    type: 'qa_report',
    ref: 'evidence://run-1/clipboard-1',
    sha256: 'a'.repeat(64)
  });
  assert.deepEqual(session.disconnect_state?.observed?.metadata, {
    external_id: 'rdgw_1',
    reason: 'operator_verified'
  });
});

test('iveKit RustDesk HTTP client fails closed on invalid evidence and disconnect provenance', async () => {
  const invalidPayloads = [
    {
      id: 'tool_1',
      operation_evidence: [{
        operation_id: 'operation-1',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'none',
        observed_at: '2026-07-12T12:00:00.000Z',
        evidence_refs: [{ type: 'qa_report', ref: 'evidence://run-1/view-1', sha256: 'a'.repeat(64) }],
        metadata: { token: 'must-not-leak' }
      }]
    },
    {
      external_id: 'rdgw_1',
      operation_evidence: [{
        operation_id: 'operation-2',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'qa',
        observed_at: '2026-07-12T12:00:00.000Z',
        evidence_refs: [{ type: '', ref: '', sha256: 'bad' }],
        metadata: {}
      }]
    },
    {
      required: true,
      status: 'succeeded',
      command: { id: 'rdcmd_1', status: 'failed' },
      observation_status: 'observed_disconnected',
      observed: {
        operation_id: 'operation-3',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'qa',
        observed_at: '2026-07-12T12:00:00.000Z',
        evidence_refs: [{ type: 'qa_report', ref: 'evidence://run-1/disconnect-1', sha256: 'a'.repeat(64) }],
        metadata: {}
      }
    }
  ];
  const clientFor = (payload: unknown) => createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, payload)
  });

  await assert.rejects(
    () => clientFor(invalidPayloads[0]).startGatewaySession({
      remote_session_id: 'remote_1',
      device_id: 'rdesk_1',
      actor_identity: 'agent_led',
      permissions: ['view_screen']
    }),
    (error) => {
      assert.match(String(error), /invalid RustDesk operation evidence/);
      assert.doesNotMatch(String(error), /must-not-leak/);
      return true;
    }
  );
  await assert.rejects(
    () => clientFor(invalidPayloads[1]).getGatewayLaunchPlan('rdgw_1'),
    /invalid RustDesk operation evidence/
  );
  await assert.rejects(
    () => clientFor(invalidPayloads[2]).getGatewayDisconnectState('rdgw_1'),
    /invalid RustDesk disconnect state/
  );
});

test('iveKit RustDesk HTTP client enforces non-contradictory disconnect observations', async () => {
  const observed = (status: 'observed_succeeded' | 'observed_failed') => ({
    operation_id: `disconnect-${status}`,
    operation: 'session_disconnect',
    status,
    observer: 'qa',
    observed_at: '2026-07-12T12:00:00.000Z',
    evidence_refs: [{ type: 'qa_report', ref: `evidence://run-1/${status}`, sha256: 'a'.repeat(64) }],
    metadata: {}
  });
  const notObserved = {
    operation_id: 'disconnect-not-observed',
    operation: 'session_disconnect',
    status: 'not_observed',
    observer: 'none',
    observed_at: null,
    evidence_refs: [],
    metadata: {}
  };
  const state = (observation_status: string, evidence: unknown) => ({
    required: true,
    status: 'succeeded',
    command: { id: 'rdcmd_1', status: 'succeeded' },
    observation_status,
    observed: evidence
  });

  for (const payload of [
    state('observed_disconnected', observed('observed_succeeded')),
    state('observed_connected', observed('observed_failed')),
    state('not_observed', notObserved)
  ]) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, payload)
    });
    await client.getGatewayDisconnectState('rdgw_1');
  }

  for (const payload of [
    state('observed_disconnected', observed('observed_failed')),
    state('observed_connected', observed('observed_succeeded')),
    state('not_observed', observed('observed_succeeded'))
  ]) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, payload)
    });
    await assert.rejects(
      () => client.getGatewayDisconnectState('rdgw_1'),
      /invalid RustDesk disconnect state/
    );
  }
});

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'content-type': 'application/json' }
  });
}

function expectedTerminalProfile(deviceId: string) {
  return {
    device_id: deviceId,
    rustdesk_id: '123456789',
    platform: 'linux' as const,
    architecture: 'x86_64' as const,
    client_version: {
      product: 'rustdesk' as const,
      version: '1.4.7',
      channel: 'stable' as const,
      source: 'terminal_heartbeat' as const,
      reported_at: '2026-07-12T11:59:00.000Z'
    },
    configured: {
      id_server_configured: true,
      relay_server_configured: true,
      api_server_configured: false,
      public_key_configured: true,
      server_key_fingerprint: 'sha256:abcdef1234567890'
    },
    available: {
      source: 'native_observer' as const,
      reported_at: '2026-07-12T12:00:00.000Z',
      view_screen: 'available' as const,
      control_mouse_keyboard: 'available' as const,
      multi_display: 'unknown' as const,
      transfer_file: 'available' as const,
      clipboard: 'available' as const,
      record_screen: 'unavailable' as const,
      session_disconnect: 'available' as const
    },
    granted: {
      requested: ['view_screen', 'control_mouse_keyboard', 'transfer_file'] as const,
      consented: ['view_screen', 'control_mouse_keyboard'] as const,
      granted: ['view_screen'] as const
    },
    observed: [{
      operation_id: 'terminal-operation-1',
      operation: 'view_screen' as const,
      status: 'observed_succeeded' as const,
      observer: 'qa' as const,
      observed_at: '2026-07-12T12:00:00.000Z',
      evidence_refs: [{
        type: 'qa_report',
        ref: 'evidence://run-1/terminal-1',
        sha256: 'a'.repeat(64)
      }] as [{ type: string; ref: string; sha256: string }],
      metadata: {
        external_id: 'rdgw_1',
        provider_operation_id: 'native-view-1'
      }
    }],
    updated_at: '2026-07-12T12:00:01.000Z'
  };
}

function unsafeTerminalProfile(deviceId: string) {
  const profile = expectedTerminalProfile(deviceId);
  return {
    ...profile,
    api_key: 'profile-api-key',
    private_key: 'profile-private-key',
    token: 'profile-token',
    arbitrary: 'drop-me',
    client_version: { ...profile.client_version, token: 'nested-token', arbitrary: true },
    configured: { ...profile.configured, private_key: 'nested-private-key', arbitrary: true },
    available: { ...profile.available, api_key: 'nested-api-key', arbitrary: true },
    granted: { ...profile.granted, token: 'nested-token', arbitrary: true },
    observed: [{
      ...profile.observed[0],
      credential: 'top-level-credential',
      evidence_refs: [{ ...profile.observed[0].evidence_refs[0], token: 'reference-token' }],
      metadata: {
        ...profile.observed[0].metadata,
        clipboard_text: 'terminal clipboard secret',
        token: 'metadata-token',
        arbitrary: 'drop-me'
      }
    }]
  };
}

function expectedClientDistributionProfile() {
  return {
    platform: 'windows' as const,
    architecture: 'x86_64' as const,
    client_version: {
      exact: '1.4.7',
      allowed: ['1.4.7'] as ['1.4.7']
    },
    server_version: '1.1.15',
    issued_at: '2026-07-12T12:00:00.000Z',
    expires_at: '2026-07-12T12:15:00.000Z',
    manual_fields: {
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      api_server: 'https://rustdesk-api.example.com',
      key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
    },
    server_key_fingerprint: 'sha256:c57cc3b55d39f9a6',
    protocol_handler: {
      supported: true,
      user_initiated_only: true
    },
    install_source: {
      state: 'configured' as const,
      url: 'https://downloads.example.com/releases/1.4.7/rustdesk-1.4.7-windows-x86_64.exe',
      filename: 'rustdesk-1.4.7-windows-x86_64.exe',
      sha256: 'a'.repeat(64)
    },
    unattended_policy: {
      mode: 'attended_only' as const,
      state: 'not_configured' as const
    }
  };
}

function unsafeClientDistributionProfile(profile = expectedClientDistributionProfile()) {
  return {
    ...profile,
    api_key: 'server-api-key',
    bearer_token: 'bearer-secret',
    private_key: 'private-key',
    edge_secret: 'edge-secret',
    unattended_password: 'password',
    launch_token: 'signed-launch-token',
    installer_credential: 'installer-secret',
    arbitrary: 'drop-me',
    client_version: { ...profile.client_version, token: 'drop-me' },
    manual_fields: { ...profile.manual_fields, private_key: 'drop-me' },
    protocol_handler: { ...profile.protocol_handler, launch_token: 'drop-me' },
    install_source: { ...profile.install_source, credential: 'drop-me' },
    unattended_policy: { ...profile.unattended_policy, password: 'drop-me' }
  };
}
