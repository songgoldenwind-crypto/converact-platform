import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import {
  EnvVoiceSecretResolver,
  RustPbxManagementClient,
  VoiceError,
  type RustPbxManagementPaths
} from '../src/agent-runtime/ivekit/voice/index.js';

const paths: RustPbxManagementPaths = {
  management_health: '/api/pending-reloads',
  ami_health: '/ami/v1/health',
  ami_dialogs: '/ami/v1/dialogs',
  ami_sipflow: '/ami/v1/sipflow/flow/{id}',
  trunk_collection: '/api/sip-trunk',
  trunk_item: '/api/sip-trunk/{id}',
  trunk_test: '/api/diagnostics/trunks/options',
  trunk_reload: '/ami/v1/reload/trunks',
  extension_collection: '/api/extensions',
  extension_item: '/api/extensions/{id}',
  route_evaluate: '/api/diagnostics/routes/evaluate',
  route_reload: '/ami/v1/reload/routes',
  recording_lookup: '/api/call-records/{id}/metadata'
};

test('RustPBX management client maps bounded authenticated endpoints', async () => {
  const requests: Array<{ method: string; url: string; authorization: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestJson(request);
    requests.push({
      method: request.method || '',
      url: request.url || '',
      authorization: String(request.headers.authorization || ''),
      body
    });
    const url = request.url || '';
    if (url === '/api/pending-reloads') return json(response, 200, { targets: [] });
    if (url === '/ami/v1/health') return json(response, 200, {
      status: 'running', version: 'rustpbx-test-1'
    });
    if (url === '/ami/v1/dialogs') return json(response, 200, [
      { id: 'call/a', state: 'active', provider_call_id: 'provider-call-from-dialog' },
      { call_id: 'talking-call', state: 'talking', source: 'active_call_registry' },
      {
        call_id: 'terminated-call',
        state: 'terminated-call-local-remote(Terminated UacBye)',
        source: 'sip_dialog_layer'
      }
    ]);
    if (url.includes('/sipflow/flow/')) return json(response, 200, { flow: [{ event: 'invite' }] });
    if (url.includes('/call-records/')) return json(response, 200, { state: 'available', object_ref: 's3://recording-a' });
    if (url === '/api/diagnostics/trunks/options') return json(response, 200, { success: true });
    if (url === '/api/sip-trunk' && request.method === 'POST') {
      return json(response, 200, { items: [] });
    }
    if (url === '/api/extensions' && request.method === 'POST') {
      return json(response, 200, { items: [] });
    }
    if (url === '/api/sip-trunk' && request.method === 'PUT') return json(response, 200, { status: 'ok', id: 41 });
    if (url === '/api/extensions' && request.method === 'PUT') return json(response, 200, { status: 'ok', id: 42 });
    return json(response, 200, { status: 'ok', accepted: true });
  });
  const baseUrl = await listen(server);
  try {
    const client = managementClient(baseUrl);
    const preflight = await client.preflight();
    assert.equal(preflight.provider_version, 'rustpbx-test-1');
    assert.equal(preflight.capabilities.management_http, true);
    assert.equal(preflight.capabilities.postgres_backend, true);

    const trunkInput = {
      resource_id: 'trunk-a',
      desired_state: {
        provider_name: 'ivekit-trunk-a', name: 'Carrier A', direction: 'both', transport: 'tls',
        codecs: ['PCMU'], max_channels: 10, credential_secret_ref: 'env://TRUNK_AUTH', sip_server: 'sip.carrier.test',
        auth_username: 'carrier-user', status: 'active'
      }
    };
    assert.equal((await client.applyTrunk(trunkInput)).provider_ref, '41');
    assert.equal((await client.applyTrunk({ ...trunkInput, provider_ref: '41' })).provider_ref, '41');
    assert.equal((await client.testTrunk({ resource_id: 'trunk-a', desired_state: trunkInput.desired_state })).ready, true);
    assert.equal((await client.applyDid({
      resource_id: 'did-a', desired_state: { e164: '+8613800138000' }
    })).provider_ref, 'ivekit-http-router:did:did-a');
    const extensionInput = {
      resource_id: 'extension-a',
      desired_state: {
        extension: '1001', display_name: 'Agent A', credential_secret_ref: 'env://EXTENSION_AUTH',
        status: 'active', identity: 'agent-a', permissions: {}, webrtc_enabled: true
      }
    };
    assert.equal((await client.applyExtension(extensionInput)).provider_ref, '42');
    assert.equal((await client.applyExtension({ ...extensionInput, provider_ref: '42' })).provider_ref, '42');
    assert.deepEqual(await client.applyRoute({
      resource_id: 'route-a', desired_state: { version: 3, rules: { action: 'forward_sip' } }
    }), {
      provider_ref: 'ivekit-http-router:route:route-a', provider_revision: '3',
      safe_diagnostics: { authority: 'ivekit_http_router' }
    });
    assert.deepEqual(await client.lookupDialog({ provider_call_id: 'call/a' }), {
      state: 'succeeded', provider_state: 'active',
      provider_call_id: 'provider-call-from-dialog',
      safe_diagnostics: { state: 'active', provider_call_id: 'provider-call-from-dialog' }
    });
    assert.deepEqual(await client.lookupDialog({ provider_call_id: 'talking-call' }), {
      state: 'succeeded', provider_state: 'talking', provider_call_id: 'talking-call',
      safe_diagnostics: { state: 'talking', provider_call_id: 'talking-call' }
    });
    assert.deepEqual(await client.lookupDialog({ provider_call_id: 'terminated-call' }), {
      state: 'succeeded',
      provider_state: 'terminated-call-local-remote(Terminated UacBye)',
      provider_call_id: 'terminated-call',
      safe_diagnostics: {
        state: 'terminated-call-local-remote(Terminated UacBye)',
        provider_call_id: 'terminated-call'
      }
    });
    assert.equal((await client.lookupRecording({ provider_recording_id: 'recording/a' })).state, 'available');
    assert.deepEqual((await client.getSipFlow('call/a')).items, [{ event: 'invite' }]);
    assert.equal((await client.evaluateRoute({ call_id: 'call-a' })).accepted, true);
    await client.reloadRoutes();

    assert.equal(requests.every((request) => request.authorization === 'Bearer management-secret-value'), true);
    assert.equal(requests.some((request) => request.url === '/ami/v1/health'), true);
    assert.equal(requests.some((request) => request.url === '/api/sip-trunk'), true);
    assert.equal(requests.some((request) => request.url === '/api/sip-trunk/41'), true);
    assert.equal(requests.some((request) => request.url === '/ami/v1/dialogs'), true);
    assert.equal(requests.some((request) => isRecord(request.body)
      && request.body.auth_password === 'trunk-password'), true);
    assert.equal(requests.some((request) => isRecord(request.body)
      && request.body.sip_password === 'extension-password'), true);
    assert.equal(requests.some((request) => request.method === 'PUT'), true);
    assert.equal(requests.some((request) => request.method === 'PATCH'), true);
    assert.equal(requests.some((request) => request.method === 'POST'), true);
  } finally {
    await close(server);
  }
});

test('RustPBX management client classifies HTTP failures without leaking secrets', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/reset')) {
      request.socket.destroy();
      return;
    }
    const status = Number(new URL(request.url || '/', 'http://localhost').searchParams.get('status') || 200);
    if (status !== 200) return json(response, status, { error: 'management-secret-value must not escape' });
    return json(response, 200, { provider_ref: 'ok' });
  });
  const baseUrl = await listen(server);
  try {
    for (const [status, code, retryable] of [
      [401, 'provider_auth_failed', false],
      [403, 'provider_auth_failed', false],
      [404, 'capability_unavailable', false],
      [408, 'provider_unavailable', true],
      [429, 'provider_unavailable', true],
      [503, 'provider_unavailable', true]
    ] as const) {
      const client = managementClient(baseUrl, {
        ...paths,
        trunk_collection: `/failure?status=${status}`
      });
      await assert.rejects(
        () => client.applyTrunk(validTrunkInput()),
        (error: unknown) => error instanceof VoiceError
          && error.code === code
          && error.retryable === retryable
          && !JSON.stringify(error).includes('management-secret-value')
      );
    }
    await assert.rejects(
      () => managementClient(baseUrl, { ...paths, trunk_collection: '/reset' })
        .applyTrunk(validTrunkInput()),
      (error: unknown) => error instanceof VoiceError
        && error.code === 'provider_unavailable'
        && error.retryable
    );
  } finally {
    await close(server);
  }
});

test('RustPBX management client enforces timeout, response bytes, and JSON shape', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/slow')) {
      setTimeout(() => json(response, 200, { provider_ref: 'late' }), 100);
      return;
    }
    if (request.url?.startsWith('/large')) return json(response, 200, { value: 'x'.repeat(2048) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{not-json');
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      () => managementClient(baseUrl, { ...paths, trunk_collection: '/slow' }, { timeout_ms: 20 })
        .applyTrunk(validTrunkInput()),
      hasVoiceCode('provider_timeout')
    );
    await assert.rejects(
      () => managementClient(baseUrl, { ...paths, trunk_collection: '/large' }, { max_response_bytes: 128 })
        .applyTrunk(validTrunkInput()),
      hasVoiceCode('provider_response_too_large')
    );
    await assert.rejects(
      () => managementClient(baseUrl, { ...paths, trunk_collection: '/malformed' })
        .applyTrunk(validTrunkInput()),
      hasVoiceCode('protocol_mismatch')
    );
  } finally {
    await close(server);
  }
});

test('RustPBX management client validates URL security and configured paths', () => {
  const secretResolver = resolver();
  assert.throws(
    () => new RustPbxManagementClient({
      base_url: 'ftp://pbx.internal', profile_id: 'profile-a', config_hash: 'a'.repeat(64),
      service_token_ref: 'env://RUSTPBX_MANAGEMENT_TOKEN', secret_resolver: secretResolver, paths
    }),
    hasVoiceCode('validation_failed')
  );
  assert.throws(
    () => new RustPbxManagementClient({
      base_url: 'http://pbx.public.example', profile_id: 'profile-a', config_hash: 'a'.repeat(64),
      service_token_ref: 'env://RUSTPBX_MANAGEMENT_TOKEN', secret_resolver: secretResolver,
      paths, production: true
    }),
    hasVoiceCode('validation_failed')
  );
  assert.doesNotThrow(() => new RustPbxManagementClient({
    base_url: 'http://rustpbx:8080', profile_id: 'profile-a', config_hash: 'a'.repeat(64),
    service_token_ref: 'env://RUSTPBX_MANAGEMENT_TOKEN', secret_resolver: secretResolver,
    paths, production: true, internal_service: true
  }));
  for (const invalidPath of ['https://attacker.test/path', '../admin', '/safe/../admin', '/path?token=secret']) {
    assert.throws(
      () => new RustPbxManagementClient({
        base_url: 'https://pbx.internal', profile_id: 'profile-a', config_hash: 'a'.repeat(64),
        service_token_ref: 'env://RUSTPBX_MANAGEMENT_TOKEN', secret_resolver: secretResolver,
        paths: { ...paths, trunk_collection: invalidPath }
      }),
      hasVoiceCode('validation_failed')
    );
  }
});

function managementClient(
  baseUrl: string,
  configuredPaths: RustPbxManagementPaths = paths,
  overrides: { timeout_ms?: number; max_response_bytes?: number } = {}
): RustPbxManagementClient {
  return new RustPbxManagementClient({
    base_url: baseUrl,
    profile_id: 'profile-a',
    config_hash: 'a'.repeat(64),
    service_token_ref: 'env://RUSTPBX_MANAGEMENT_TOKEN',
    secret_resolver: resolver(),
    paths: configuredPaths,
    internal_service: true,
    ...overrides
  });
}

function resolver(): EnvVoiceSecretResolver {
  return new EnvVoiceSecretResolver({
    env: {
      RUSTPBX_MANAGEMENT_TOKEN: 'management-secret-value',
      TRUNK_AUTH: 'trunk-password',
      EXTENSION_AUTH: 'extension-password'
    },
    allowlist: {
      rustpbx_management: ['RUSTPBX_MANAGEMENT_TOKEN'],
      rustpbx_resource_credential: ['TRUNK_AUTH', 'EXTENSION_AUTH']
    }
  });
}

function validTrunkInput() {
  return {
    resource_id: 'trunk-a',
    desired_state: {
      provider_name: 'ivekit-trunk-a', name: 'Carrier A', direction: 'both', transport: 'udp',
      codecs: ['PCMU'], max_channels: 10, credential_secret_ref: 'env://TRUNK_AUTH',
      sip_server: 'sip.carrier.test', status: 'active'
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
