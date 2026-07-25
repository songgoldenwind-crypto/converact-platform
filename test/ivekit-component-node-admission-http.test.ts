import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ComponentNodeAdmissionController,
  HttpComponentNodeAdmissionClient,
  createComponentNodeAdmissionHttpServer
} from '../src/agent-runtime/ivekit/placement/index.js';
import { listenOnRandomPort } from './test-helpers.js';

const token = 'component-node-service-token-1234567890';

test('component node production boundary completes a mutual-TLS handshake', async (t) => {
  const certificates = testCertificates();
  t.after(async () => {
    rmSync(certificates.directory, { recursive: true, force: true });
  });
  const server = createComponentNodeAdmissionHttpServer({
    controller: fixture(),
    service_token: token,
    production: true,
    tls: {
      key: certificates.serverKey,
      cert: certificates.serverCert,
      ca: certificates.ca
    },
    now: () => new Date('2026-07-16T08:00:00.000Z')
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const client = new HttpComponentNodeAdmissionClient({
    endpoint: `https://127.0.0.1:${port}`,
    service_token: token,
    production: true,
    tls: {
      key: certificates.clientKey,
      cert: certificates.clientCert,
      ca: certificates.ca
    }
  });

  assert.equal((await client.readState()).node_id, 'livekit-a');
  assert.throws(
    () => createComponentNodeAdmissionHttpServer({
      controller: fixture(),
      service_token: token,
      production: true
    }),
    /production mTLS is required/
  );
  assert.throws(
    () => new HttpComponentNodeAdmissionClient({
      endpoint: `https://127.0.0.1:${port}`,
      service_token: token,
      production: true
    }),
    /production mTLS is required/
  );
});

test('component node HTTP fences readiness, authentication and target identity', async (t) => {
  const controller = fixture();
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: token,
    now: () => new Date('2026-07-16T08:00:00.000Z')
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${endpoint}/livez`)).status, 200);
  assert.equal((await fetch(`${endpoint}/readyz`)).status, 503);
  assert.equal((await fetch(`${endpoint}/v1/state`)).status, 401);

  const mismatch = await fetch(`${endpoint}/v1/lease`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(lease({ node_id: 'livekit-other' }))
  });
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), {
    error: {
      code: 'component_node_identity_mismatch',
      retryable: false
    }
  });
});

test('component node HTTP client applies lease, reservation and authorization', async (t) => {
  const controller = fixture();
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: token,
    now: () => new Date('2026-07-16T08:00:01.000Z')
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new HttpComponentNodeAdmissionClient({
    endpoint,
    service_token: token,
    timeout_ms: 1_000
  });

  await client.applyLease(lease({ state: 'draining', recovery_complete: false }));
  await client.applyLease(lease());
  const state = await client.readState();
  assert.equal(state.component, 'livekit');
  assert.equal(state.node_id, 'livekit-a');
  assert.equal(state.lease_fresh, true);
  assert.equal(state.dimensions['video.participants']?.safe_capacity, 100);
  const stored = await client.applyReservation(reservation());
  assert.equal(stored.state, 'reserved');
  const authorization = await client.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901889',
    operation: 'open'
  });
  assert.equal(authorization.allowed, true);
  assert.equal(authorization.node_id, 'livekit-a');
  const batch = await client.authorizeBatch([
    {
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'open'
    },
    {
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901888',
      operation: 'open'
    }
  ]);
  assert.equal(batch[0]?.authorization?.allowed, true);
  assert.equal(batch[1]?.error?.code, 'stale_owner_epoch');
  assert.equal((await fetch(`${endpoint}/readyz`)).status, 200);
});

test('component node HTTP client authenticates state reads and rejects malformed or oversized state', async () => {
  let request: { url: string; init?: RequestInit } | null = null;
  const validClient = new HttpComponentNodeAdmissionClient({
    endpoint: 'https://rustpbx-a.internal:3210',
    service_token: token,
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return Response.json({ data: componentState() });
    }
  });
  const state = await validClient.readState();
  assert.equal(state.node_id, 'rustpbx-a');
  assert.equal(request?.url, 'https://rustpbx-a.internal:3210/v1/state');
  assert.equal(request?.init?.method, 'GET');
  assert.equal((request?.init?.headers as Record<string, string>).authorization, `Bearer ${token}`);
  assert.equal(request?.init?.body, undefined);

  const malformedClient = new HttpComponentNodeAdmissionClient({
    endpoint: 'https://rustpbx-a.internal:3210',
    service_token: token,
    fetch: async () => Response.json({ data: { ...componentState(), unexpected: true } })
  });
  await assert.rejects(
    () => malformedClient.readState(),
    (error: any) => error?.code === 'component_node_response_invalid'
  );

  const oversizedClient = new HttpComponentNodeAdmissionClient({
    endpoint: 'https://rustpbx-a.internal:3210',
    service_token: token,
    fetch: async () => new Response('x'.repeat(131_073), { status: 200 })
  });
  await assert.rejects(
    () => oversizedClient.readState(),
    (error: any) => error?.code === 'component_node_response_too_large'
  );

  let pulls = 0;
  const streamingClient = new HttpComponentNodeAdmissionClient({
    endpoint: 'https://rustpbx-a.internal:3210',
    service_token: token,
    fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 10) {
          controller.enqueue(new Uint8Array(65_536));
        } else {
          controller.close();
        }
      }
    }), { status: 200 })
  });
  await assert.rejects(
    () => streamingClient.readState(),
    (error: any) => error?.code === 'component_node_response_too_large'
  );
  assert.ok(pulls <= 4, `response stream was not cancelled after the bound: ${pulls}`);
});

test('component node HTTP metrics are bounded and contain no tenant or interaction IDs', async (t) => {
  const controller = fixture();
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  controller.applyLease(lease(), new Date('2026-07-16T08:00:00.000Z'));
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: token,
    now: () => new Date('2026-07-16T08:00:02.000Z')
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;

  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /ivekit_component_node_lease_fresh 1/);
  assert.match(body, /ivekit_component_node_reservations\{state="reserved"\} 1/);
  assert.match(body, /ivekit_component_node_capacity_reserved\{dimension="video\.participants"\} 1/);
  assert.doesNotMatch(body, /tenant-a|room-a|reservation-a/);
  assert.ok(Buffer.byteLength(body) < 65_536);
});

test('component node HTTP supports drain and bounds request bodies', async (t) => {
  const controller = fixture();
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: token,
    max_body_bytes: 256,
    now: () => new Date('2026-07-16T08:00:01.000Z')
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new HttpComponentNodeAdmissionClient({
    endpoint,
    service_token: token,
    timeout_ms: 1_000
  });
  await client.applyLease(lease({ state: 'draining', recovery_complete: false }));
  await client.applyLease(lease());
  await client.drain();
  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:01.000Z')).state, 'draining');

  const oversized = await fetch(`${endpoint}/v1/lease`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...lease(), padding: 'x'.repeat(512) })
  });
  assert.equal(oversized.status, 413);
});

test('component node HTTP runs the local capacity gate only for new reservations', async (t) => {
  const controller = fixture();
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  controller.applyLease(lease(), new Date('2026-07-16T08:00:00.000Z'));
  let gates = 0;
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: token,
    now: () => new Date('2026-07-16T08:00:01.000Z'),
    before_new_reservation(checkpoint) {
      gates += 1;
      assert.equal(checkpoint.reservation_id, 'reservation-a');
    },
    additional_metrics: () => 'ivekit_local_capacity_gate 1\n'
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const client = new HttpComponentNodeAdmissionClient({
    endpoint: `http://127.0.0.1:${port}`,
    service_token: token,
    timeout_ms: 1_000
  });
  await client.applyReservation(reservation());
  await client.applyReservation(reservation());
  assert.equal(gates, 1);
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text());
  assert.match(metrics, /ivekit_local_capacity_gate 1/);
});

function fixture(): ComponentNodeAdmissionController {
  return new ComponentNodeAdmissionController({
    component: 'livekit',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'livekit-a',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['livekit_av', 'livekit_screen'],
    dimensions: {
      'video.participants': {
        unit: 'participants',
        safe_capacity: 100,
        used: 0,
        reserved: 0
      }
    }
  });
}

function lease(overrides: Record<string, unknown> = {}) {
  return {
    component: 'livekit' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'livekit-a',
    cell_lease_epoch: 3,
    state: 'accepting' as const,
    recovery_complete: true,
    observed_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:10.000Z',
    ...overrides
  };
}

function reservation() {
  return {
    reservation_id: 'reservation-a',
    state: 'reserved' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    endpoint: 'https://livekit-a.internal',
    expires_at: '2026-07-16T08:00:10.000Z',
    required_capacity: { 'video.participants': 1 },
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:room-a',
    interaction_id: 'room-a',
    interaction_kind: 'livekit_av' as const,
    profile_id: 'cell-10k-v1',
    idempotency_key: 'idem-a',
    payload_hash: 'a'.repeat(64),
    created_at: '2026-07-16T08:00:00.000Z',
    updated_at: '2026-07-16T08:00:00.000Z'
  };
}

function componentState() {
  return {
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a',
    state: 'accepting',
    state_sequence: 12,
    drain_started_at: '',
    cell_lease_epoch: 3,
    lease_observed_at: '2026-07-16T08:00:00.000Z',
    lease_expires_at: '2026-07-16T08:00:10.000Z',
    lease_fresh: true,
    recovery_pending: false,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 2_500,
        used: 800,
        reserved: 50
      }
    },
    reservations: { reserved: 50, active: 800, expired: 0, closed: 0 }
  };
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

async function listenOrSkip(
  t: { after(fn: () => Promise<void>): void; skip(message?: string): void },
  server: import('node:http').Server
): Promise<number | null> {
  try {
    const port = await listenOnRandomPort(server);
    t.after(() => closeServer(server));
    return port;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`loopback listener unavailable in this environment (${code})`);
      return null;
    }
    throw error;
  }
}

function closeServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function testCertificates(): {
  directory: string;
  ca: Buffer;
  serverKey: Buffer;
  serverCert: Buffer;
  clientKey: Buffer;
  clientCert: Buffer;
} {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-component-mtls-'));
  const run = (...arguments_: string[]) => {
    execFileSync('openssl', arguments_, {
      cwd: directory,
      stdio: 'ignore'
    });
  };
  run(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1',
    '-subj', '/CN=ivekit-component-test-ca'
  );
  run(
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth'
  );
  run(
    'x509', '-req', '-in', 'server.csr',
    '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.crt', '-days', '1', '-copy_extensions', 'copy'
  );
  run(
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'client.key', '-out', 'client.csr',
    '-subj', '/CN=ivekit-component-client',
    '-addext', 'extendedKeyUsage=clientAuth'
  );
  run(
    'x509', '-req', '-in', 'client.csr',
    '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-out', 'client.crt', '-days', '1', '-copy_extensions', 'copy'
  );
  return {
    directory,
    ca: readFileSync(join(directory, 'ca.crt')),
    serverKey: readFileSync(join(directory, 'server.key')),
    serverCert: readFileSync(join(directory, 'server.crt')),
    clientKey: readFileSync(join(directory, 'client.key')),
    clientCert: readFileSync(join(directory, 'client.crt'))
  };
}
