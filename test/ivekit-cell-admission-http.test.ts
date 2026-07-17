import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CellAdmissionController,
  HttpCellAdmissionClient,
  createCellAdmissionHttpServer,
  createCellAdmissionStandbyHttpServer
} from '../src/agent-runtime/ivekit/placement/index.js';
import { listenOnRandomPort } from './test-helpers.js';

const token = 'capacity-service-token-1234567890';

test('Cell admission standby is live but never ready or routable', async (t) => {
  const server = createCellAdmissionStandbyHttpServer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-b'
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;

  const live = await fetch(`${endpoint}/livez`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), {
    status: 'alive',
    role: 'standby',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-b'
  });

  const ready = await fetch(`${endpoint}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json() as any).role, 'standby');

  const admission = await fetch(`${endpoint}/v1/reservations`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify(reservationRequest())
  });
  assert.equal(admission.status, 503);
  assert.deepEqual(await admission.json(), {
    error: {
      code: 'cell_admission_standby',
      retryable: true
    }
  });
});

test('Cell admission HTTP requires service authentication and exact Cell fencing', async (t) => {
  const controller = fixture();
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;
  const request = reservationRequest();

  const unauthenticated = await fetch(`${endpoint}/v1/reservations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
  assert.equal(unauthenticated.status, 401);

  const stale = await fetch(`${endpoint}/v1/reservations`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify({ ...request, cell_lease_epoch: 2 })
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: {
      code: 'stale_cell_lease_epoch',
      retryable: true
    }
  });
  assert.equal(controller.snapshot().reservations.length, 0);
});

test('Cell admission HTTP reserves idempotently and exposes lifecycle operations', async (t) => {
  const controller = fixture();
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new HttpCellAdmissionClient({
    endpoint,
    service_token: token,
    timeout_ms: 1_000
  });

  const first = await client.reserve(reservationRequest());
  const replay = await client.reserve({
    ...reservationRequest(),
    request_id: 'request-retry'
  });
  assert.equal(replay.reservation_id, first.reservation_id);
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].reserved, 1);

  const active = await client.activate(first.reservation_id);
  assert.equal(active.state, 'active');
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].used, 1);

  const closed = await client.close(first.reservation_id);
  assert.equal(closed.state, 'closed');
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].used, 0);
});

test('Cell admission HTTP persists every acknowledged reservation transition', async (t) => {
  const controller = fixture();
  const persisted: string[] = [];
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    persistence: {
      async persist(checkpoint) {
        persisted.push(`${checkpoint.reservation_id}:${checkpoint.state}`);
      }
    }
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const client = new HttpCellAdmissionClient({
    endpoint: `http://127.0.0.1:${port}`,
    service_token: token,
    timeout_ms: 1_000
  });

  const reserved = await client.reserve(reservationRequest());
  await client.activate(reserved.reservation_id);
  await client.close(reserved.reservation_id);

  assert.deepEqual(persisted, [
    `${reserved.reservation_id}:reserved`,
    `${reserved.reservation_id}:active`,
    `${reserved.reservation_id}:closed`
  ]);
});

test('Cell admission HTTP serializes concurrent lifecycle persistence per reservation', async (t) => {
  const controller = fixture();
  const persisted: string[] = [];
  let releaseActive!: () => void;
  const activeBarrier = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let activeStarted!: () => void;
  const activeObserved = new Promise<void>((resolve) => {
    activeStarted = resolve;
  });
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    persistence: {
      async persist(checkpoint) {
        persisted.push(checkpoint.state);
        if (checkpoint.state === 'active') {
          activeStarted();
          await activeBarrier;
        }
      }
    }
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const client = new HttpCellAdmissionClient({
    endpoint: `http://127.0.0.1:${port}`,
    service_token: token,
    timeout_ms: 1_000
  });
  const reservation = await client.reserve(reservationRequest());

  const activating = client.activate(reservation.reservation_id);
  await activeObserved;
  const closing = client.close(reservation.reservation_id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(persisted, ['reserved', 'active']);
  releaseActive();

  assert.equal((await activating).state, 'active');
  assert.equal((await closing).state, 'closed');
  assert.deepEqual(persisted, ['reserved', 'active', 'closed']);
});

test('Cell admission HTTP drains and fails closed when its durable ledger is unavailable', async (t) => {
  const controller = fixture();
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    persistence: {
      async persist() {
        throw new Error('controlled ledger outage');
      }
    }
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const response = await fetch(`http://127.0.0.1:${port}/v1/reservations`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify(reservationRequest())
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'admission_persistence_failed',
      retryable: true
    }
  });
  assert.equal(controller.snapshot().state, 'draining');
});

test('Cell admission isolates a failed component node without draining the whole Cell', async (t) => {
  const controller = fixture();
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    persistence: {
      async persist() {}
    },
    node_sync: {
      async applyCheckpoint() {
        const error = Object.assign(new Error('controlled node outage'), {
          code: 'component_node_checkpoint_failed',
          node_id: 'rustpbx-a',
          status: 503,
          retryable: true
        });
        throw error;
      }
    }
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const response = await fetch(`http://127.0.0.1:${port}/v1/reservations`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify(reservationRequest())
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'component_node_checkpoint_failed',
      retryable: true
    }
  });
  assert.equal(controller.snapshot().state, 'accepting');
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');
});

test('Cell admission drain preserves active owners and rejects new placement', async (t) => {
  const controller = fixture();
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new HttpCellAdmissionClient({
    endpoint,
    service_token: token,
    timeout_ms: 1_000
  });
  const reservation = await client.reserve(reservationRequest());
  await fetch(
    `${endpoint}/v1/reservations/${encodeURIComponent(reservation.reservation_id)}/activate`,
    { method: 'POST', headers: authenticatedHeaders(), body: '{}' }
  );

  const drain = await fetch(`${endpoint}/v1/drain`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: '{}'
  });
  assert.equal(drain.status, 200);
  assert.equal(controller.snapshot().state, 'draining');
  assert.equal(controller.snapshot().reservations[0]?.state, 'active');
  const readiness = await fetch(`${endpoint}/readyz`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json() as any).state, 'draining');

  await assert.rejects(
    () => client.reserve({
      ...reservationRequest(),
      request_id: 'request-b',
      idempotency_key: 'idem-b',
      interaction_id: 'call-b'
    }),
    (error: any) => error?.code === 'cell_draining' && error?.retryable === true
  );
});

test('Cell admission state endpoint cannot reactivate after lease loss', async (t) => {
  let leaseHealthy = true;
  const controller = fixture();
  controller.startDrain(new Date('2026-07-16T08:00:00.000Z'));
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    can_accept: () => leaseHealthy
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;

  const recovered = await fetch(`${endpoint}/v1/state`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify({ state: 'accepting' })
  });
  assert.equal(recovered.status, 200);
  assert.equal(controller.snapshot().state, 'accepting');

  controller.startDrain(new Date('2026-07-16T08:00:01.000Z'));
  leaseHealthy = false;
  const fenced = await fetch(`${endpoint}/v1/state`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify({ state: 'accepting' })
  });
  assert.equal(fenced.status, 409);
  assert.deepEqual(await fenced.json(), {
    error: { code: 'cell_lease_lost', retryable: true }
  });
  assert.equal(controller.snapshot().state, 'draining');
});

test('Cell admission capacity endpoint fences lease and exposes freshness', async (t) => {
  const controller = fixture();
  const server = createCellAdmissionHttpServer({
    controller,
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    now: () => new Date('2026-07-16T08:00:01.000Z')
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const endpoint = `http://127.0.0.1:${port}`;
  const observation = capacityObservation();

  const staleLease = await fetch(`${endpoint}/v1/capacity`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify({ ...observation, cell_lease_epoch: 2 })
  });
  assert.equal(staleLease.status, 409);

  const accepted = await fetch(`${endpoint}/v1/capacity`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify(observation)
  });
  assert.equal(accepted.status, 200);
  const payload = await accepted.json() as any;
  assert.equal(payload.data.capacity_sequence, 1);
  assert.equal(payload.data.capacity_expires_at, '2026-07-16T08:00:05.000Z');
});

test('Cell admission HTTP bounds JSON request bodies', async (t) => {
  const server = createCellAdmissionHttpServer({
    controller: fixture(),
    service_token: token,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    max_body_bytes: 128
  });
  const port = await listenOrSkip(t, server);
  if (port === null) return;
  const response = await fetch(`http://127.0.0.1:${port}/v1/reservations`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify({
      ...reservationRequest(),
      padding: 'x'.repeat(512)
    })
  });
  assert.equal(response.status, 413);
});

function fixture(): CellAdmissionController {
  let id = 0;
  return new CellAdmissionController({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    reservation_ttl_ms: 10_000,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'count',
        safe_capacity: 100,
        used: 0,
        reserved: 0
      }
    },
    nodes: [{
      node_id: 'rustpbx-a',
      endpoint: 'https://rustpbx-a.internal',
      state: 'accepting',
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['sip_voice'],
      dimensions: {
        'voice.weighted_calls': {
          unit: 'count',
          safe_capacity: 100,
          used: 0,
          reserved: 0
        }
      }
    }],
    id_factory: () => `reservation-${++id}`
  });
}

function reservationRequest() {
  return {
    request_id: 'request-a',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'voice-queue-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice' as const,
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 },
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    snapshot_version: 1,
    cell_lease_epoch: 3
  };
}

function capacityObservation() {
  return {
    schema_version: '1.0.0',
    sequence: 1,
    observed_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:05.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'count',
        safe_capacity: 100,
        used: 12
      }
    },
    nodes: [{
      node_id: 'rustpbx-a',
      state: 'accepting',
      dimensions: {
        'voice.weighted_calls': {
          unit: 'count',
          safe_capacity: 100,
          used: 12
        }
      }
    }]
  };
}

function authenticatedHeaders(): Record<string, string> {
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
