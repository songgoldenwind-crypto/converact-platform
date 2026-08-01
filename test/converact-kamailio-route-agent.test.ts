import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ComponentNodeStateSnapshot } from '../src/agent-runtime/converact/placement/component-node-admission.js';
import { ComponentNodeAdmissionController } from '../src/agent-runtime/converact/placement/component-node-admission.js';
import { createComponentNodeAdmissionHttpServer } from '../src/agent-runtime/converact/placement/component-node-admission-http.js';
import {
  HttpKamailioCoreMetricsClient,
  HttpKamailioJsonRpcClient,
  KamailioRouteAgent,
  createKamailioRouteAgentHttpServer,
  loadKamailioRouteAgentRuntimeConfig,
  startKamailioRouteAgent
} from '../src/agent-runtime/converact/voice/kamailio-route-agent.js';
import { KamailioRouteSnapshotCodec } from '../src/agent-runtime/converact/voice/kamailio-route-snapshot.js';
import { listenOnRandomPort } from './test-helpers.js';

const KEY = Buffer.alloc(32, 8);
const TOKEN = 'component-node-route-agent-token-123456';
const T0 = new Date('2026-07-21T08:00:00.000Z');

test('route agent bounds parallel polls and atomically publishes monotonic snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-agent-'));
  let active = 0;
  let maximumActive = 0;
  let reloads = 0;
  const nodes = Array.from({ length: 4 }, (_, index) => routeNode(index, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(5);
    active -= 1;
    return componentState(index);
  }));
  const agent = routeAgent(directory, nodes, {
    max_parallel_polls: 2,
    rpc: { reload: async () => { reloads += 1; } }
  });

  const first = await agent.runOnce(T0);
  assert.deepEqual(first, {
    mode: 'published',
    published: true,
    reloaded: true,
    sequence: 1
  });
  assert.equal(maximumActive, 2);
  assert.equal(reloads, 1);
  const wire = await readFile(join(directory, 'route.snapshot'), 'utf8');
  assert.equal(codec().verify(wire, verification(0, new Date(T0.getTime() + 1))).body.sequence, 1);
  const dispatcher = await readFile(join(directory, 'dispatcher.list'), 'utf8');
  assert.match(dispatcher, /^100 sip:rustpbx-a-0\.internal/m);
  assert.equal((await stat(join(directory, 'route.snapshot'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'dispatcher.list'))).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(directory)).sort(), ['dispatcher.list', 'route.snapshot']);
  assert.equal(agent.status(new Date(T0.getTime() + 1_000)).ready, true);

  const unchanged = await agent.runOnce(new Date(T0.getTime() + 1_000));
  assert.equal(unchanged.mode, 'unchanged');
  assert.equal(unchanged.published, false);
  assert.equal(reloads, 1);

  const renewed = await agent.runOnce(new Date(T0.getTime() + 6_000));
  assert.equal(renewed.sequence, 2);
  assert.equal(renewed.published, true);
  assert.equal(reloads, 2);
});

test('route agent retains last-known-good until TTL then fails closed without deleting pin sets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-stale-'));
  let available = true;
  let reloads = 0;
  const agent = routeAgent(directory, [routeNode(0, async () => {
    if (!available) throw new Error('component endpoint unavailable');
    return componentState(0);
  })], { rpc: { reload: async () => { reloads += 1; } } });

  await agent.runOnce(T0);
  const acceptedWire = await readFile(join(directory, 'route.snapshot'), 'utf8');
  available = false;
  const retained = await agent.runOnce(new Date(T0.getTime() + 2_000));
  assert.equal(retained.mode, 'last_known_good');
  assert.equal(reloads, 1);
  assert.equal(await readFile(join(directory, 'route.snapshot'), 'utf8'), acceptedWire);
  assert.match(await readFile(join(directory, 'dispatcher.list'), 'utf8'), /^100 /m);

  const stale = await agent.runOnce(new Date(T0.getTime() + 10_000));
  assert.equal(stale.mode, 'fail_closed');
  assert.equal(stale.published, false);
  assert.equal(stale.reloaded, true);
  assert.equal(reloads, 2);
  const failClosed = await readFile(join(directory, 'dispatcher.list'), 'utf8');
  assert.doesNotMatch(failClosed, /^100 /m);
  assert.match(failClosed, /^10000 /m);
  assert.equal(await readFile(join(directory, 'route.snapshot'), 'utf8'), acceptedWire);
  assert.equal(agent.status(new Date(T0.getTime() + 10_001)).ready, false);

  available = true;
  const recovered = await agent.runOnce(new Date(T0.getTime() + 12_000));
  assert.equal(recovered.mode, 'published');
  assert.equal(recovered.sequence, 2);
  assert.match(await readFile(join(directory, 'dispatcher.list'), 'utf8'), /^100 /m);
});

test('route agent retries a pending RPC reload without allocating another sequence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-rpc-'));
  let attempts = 0;
  let polls = 0;
  const agent = routeAgent(directory, [routeNode(0, async () => {
    polls += 1;
    return componentState(0);
  })], {
    rpc: {
      reload: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Kamailio restarting');
      }
    }
  });

  await assert.rejects(() => agent.runOnce(T0), /Kamailio restarting/);
  assert.equal(agent.status(new Date(T0.getTime() + 1)).ready, false);
  const pendingWire = await readFile(join(directory, 'route.snapshot'), 'utf8');
  const retried = await agent.runOnce(new Date(T0.getTime() + 500));
  assert.equal(retried.mode, 'reload_retry');
  assert.equal(retried.sequence, 1);
  assert.equal(polls, 1);
  assert.equal(attempts, 2);
  assert.equal(await readFile(join(directory, 'route.snapshot'), 'utf8'), pendingWire);
});

test('route agent restores sequence from an expired signed snapshot without accepting it as ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-restore-'));
  const oldBody = {
    schema_version: '1.0.0' as const,
    sequence: 77,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    generated_at: '2026-07-21T07:59:40.000Z',
    expires_at: '2026-07-21T07:59:50.000Z',
    edge_replica_count: 2,
    pools: [{
      pool_id: 100,
      profile_id: 'cell-10k-v1',
      nodes: [{
        node_id: 'rustpbx-a-0',
        sip_uri: 'sip:rustpbx-a-0.internal:5060;transport=udp',
        pin_set_id: 10_000,
        state: 'accepting' as const,
        safe_capacity: 2_500,
        used: 800,
        reserved: 100,
        routing_weight: 100,
        priority: 10
      }]
    }]
  };
  const agent = routeAgent(directory, [routeNode(0, async () => componentState(0))]);
  const restored = agent.restore(codec().encode(oldBody), T0);
  assert.equal(restored.fresh, false);
  assert.equal(restored.sequence, 77);
  assert.equal(agent.status(T0).ready, false);

  const result = await agent.runOnce(T0);
  assert.equal(result.sequence, 78);
});

test('Kamailio JSON-RPC client is loopback-only, authenticated and retry-bounded', async () => {
  let calls = 0;
  const waits: number[] = [];
  const client = new HttpKamailioJsonRpcClient({
    endpoint: 'http://127.0.0.1:5060/RPC',
    bearer_token: 'kamailio-loopback-rpc-token-123456',
    max_attempts: 3,
    retry_delay_ms: 10,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    fetch: async (_input, init) => {
      calls += 1;
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer kamailio-loopback-rpc-token-123456');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        jsonrpc: '2.0',
        method: 'dispatcher.reload',
        id: calls
      });
      return calls === 1
        ? Response.json({ error: 'restarting' }, { status: 503 })
        : Response.json({ jsonrpc: '2.0', result: 'OK', id: calls });
    }
  });
  await client.reload();
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10]);

  assert.throws(() => new HttpKamailioJsonRpcClient({
    endpoint: 'http://kamailio.internal:5060/RPC',
    bearer_token: 'kamailio-loopback-rpc-token-123456'
  }), /loopback/i);
});

test('Kamailio JSON-RPC client applies HEP sample threshold before mode and revision', async () => {
  const requests: Array<{ method: string; params: unknown[]; id: number }> = [];
  const client = new HttpKamailioJsonRpcClient({
    endpoint: 'http://127.0.0.1:5060/RPC',
    bearer_token: 'kamailio-loopback-rpc-token-123456',
    max_attempts: 1,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
        id: number;
      };
      requests.push(body);
      return Response.json({ jsonrpc: '2.0', result: 'OK', id: body.id });
    }
  });

  await client.applyHepControl({
    mode: 'sampled',
    sample_buckets: 102,
    revision: 7
  });
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    {
      method: 'htable.seti',
      params: ['ivekit_hep_control', 'sample_buckets', 102]
    },
    {
      method: 'htable.seti',
      params: ['ivekit_hep_control', 'mode', 1]
    },
    {
      method: 'htable.seti',
      params: ['ivekit_hep_control', 'revision', 7]
    }
  ]);
});

test('Kamailio JSON-RPC client leaves revision uncommitted after a partial HEP write', async () => {
  const methods: string[] = [];
  let failModeWrite = true;
  const client = new HttpKamailioJsonRpcClient({
    endpoint: 'http://127.0.0.1:5060/RPC',
    bearer_token: 'kamailio-loopback-rpc-token-123456',
    max_attempts: 1,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      methods.push(body.method);
      if (body.method === 'htable.seti' && methods.length === 2 && failModeWrite) {
        failModeWrite = false;
        return Response.json({ error: 'write failed' }, { status: 503 });
      }
      return Response.json({ jsonrpc: '2.0', result: 'OK', id: body.id });
    }
  });

  await assert.rejects(
    () => client.applyHepControl({ mode: 'sampled', sample_buckets: 102, revision: 7 }),
    /HTTP 503/
  );
  assert.deepEqual(methods, ['htable.seti', 'htable.seti']);

  await client.applyHepControl({ mode: 'sampled', sample_buckets: 102, revision: 7 });
  assert.deepEqual(methods, [
    'htable.seti',
    'htable.seti',
    'htable.seti',
    'htable.seti',
    'htable.seti'
  ]);
});

test('Kamailio JSON-RPC client reads the committed HEP revision', async () => {
  const client = new HttpKamailioJsonRpcClient({
    endpoint: 'http://127.0.0.1:5060/RPC',
    bearer_token: 'kamailio-loopback-rpc-token-123456',
    max_attempts: 1,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
        id: number;
      };
      assert.equal(body.method, 'htable.get');
      assert.deepEqual(body.params, ['ivekit_hep_control', 'revision']);
      return Response.json({
        jsonrpc: '2.0',
        result: { item: { key: 'revision', value: 37, type: 'int' } },
        id: body.id
      });
    }
  });

  assert.equal(
    await (client as unknown as { readHepControlRevision(): Promise<number> })
      .readHepControlRevision(),
    37
  );
});

test('Kamailio JSON-RPC client rejects non-numeric HEP revisions', async () => {
  const client = new HttpKamailioJsonRpcClient({
    endpoint: 'http://127.0.0.1:5060/RPC',
    bearer_token: 'kamailio-loopback-rpc-token-123456',
    max_attempts: 1,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({
        jsonrpc: '2.0',
        result: { item: { key: 'revision', value: null, type: 'int' } },
        id: body.id
      });
    }
  });

  await assert.rejects(
    () => (client as unknown as { readHepControlRevision(): Promise<number> })
      .readHepControlRevision(),
    /revision response is invalid/i
  );
});

test('route agent health and metrics expose freshness without node or tenant cardinality', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-http-'));
  const agent = routeAgent(directory, [routeNode(0, async () => componentState(0))]);
  await agent.runOnce(T0);
  const server = createKamailioRouteAgentHttpServer({
    agent,
    now: () => new Date(T0.getTime() + 1_000)
  });
  const port = await listenOnRandomPort(server);
  t.after(() => closeServer(server));

  assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text());
  assert.match(metrics, /ivekit_kamailio_snapshot_valid 1/);
  assert.match(metrics, /ivekit_kamailio_snapshot_sequence 1/);
  assert.match(metrics, /ivekit_kamailio_new_call_nodes 1/);
  assert.match(metrics, /ivekit_kamailio_route_nodes\{state="accepting"\} 1/);
  assert.doesNotMatch(metrics, /rustpbx-a-0|tenant/);
  assert.ok(Buffer.byteLength(metrics) < 32_768);
});

test('route agent metrics merge bounded Kamailio loopback metrics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-core-metrics-'));
  const agent = routeAgent(directory, [routeNode(0, async () => componentState(0))]);
  await agent.runOnce(T0);
  const server = createKamailioRouteAgentHttpServer({
    agent,
    now: () => new Date(T0.getTime() + 1_000),
    read_core_metrics: async () => '# TYPE kamailio_core_ivekit_pin_failures counter\nkamailio_core_ivekit_pin_failures 2\n'
  });
  const port = await listenOnRandomPort(server);
  t.after(() => closeServer(server));

  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text());
  assert.match(metrics, /ivekit_kamailio_core_metrics_up 1/);
  assert.match(metrics, /kamailio_core_ivekit_pin_failures 2/);
});

test('route agent metrics isolate Kamailio loopback scrape failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-core-down-'));
  const agent = routeAgent(directory, [routeNode(0, async () => componentState(0))]);
  await agent.runOnce(T0);
  const server = createKamailioRouteAgentHttpServer({
    agent,
    now: () => new Date(T0.getTime() + 1_000),
    read_core_metrics: async () => { throw new Error('Kamailio restarting'); }
  });
  const port = await listenOnRandomPort(server);
  t.after(() => closeServer(server));

  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  const metrics = await response.text();
  assert.equal(response.status, 200);
  assert.match(metrics, /ivekit_kamailio_snapshot_valid 1/);
  assert.match(metrics, /ivekit_kamailio_core_metrics_up 0/);
});

test('Kamailio core metrics client is loopback-only and response-bounded', async () => {
  assert.throws(() => new HttpKamailioCoreMetricsClient({
    endpoint: 'http://kamailio.internal:5065/metrics'
  }), /loopback/i);
  const client = new HttpKamailioCoreMetricsClient({
    endpoint: 'http://127.0.0.1:5065/metrics',
    fetch: async () => new Response('x'.repeat(1_048_577), { status: 200 })
  });
  await assert.rejects(() => client.read(), /too large/i);
});

test('route agent runtime config loads topology and secrets only from bounded files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-config-'));
  const currentKeyFile = join(directory, 'current-key');
  const nodeTokenFile = join(directory, 'node-token');
  const rpcTokenFile = join(directory, 'rpc-token');
  const topologyFile = join(directory, 'topology.json');
  await writeFile(currentKeyFile, `${KEY.toString('base64')}\n`, { mode: 0o600 });
  await writeFile(nodeTokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(rpcTokenFile, 'kamailio-loopback-rpc-token-123456\n', { mode: 0o600 });
  await writeFile(topologyFile, JSON.stringify({
    pools: [{
      pool_id: 100,
      profile_id: 'cell-10k-v1',
      capacity_dimension: 'voice.weighted_calls',
      nodes: [{
        node_id: 'rustpbx-a-0',
        component_endpoint: 'http://rustpbx-a-0.internal:3210',
        service_token_file: nodeTokenFile,
        sip_uri: 'sip:rustpbx-a-0.internal:5060;transport=udp',
        pin_set_id: 10_000,
        priority: 10,
        safe_capacity_fallback: 2_500
      }]
    }]
  }), { mode: 0o600 });
  const env = runtimeEnv(directory, {
    CONVERACT_FABRIC_KAMAILIO_TOPOLOGY_FILE: topologyFile,
    CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY_FILE: currentKeyFile,
    CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE: rpcTokenFile,
    CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED: 'true',
    CONVERACT_FABRIC_KAMAILIO_HOMER_METRICS_ENDPOINT: 'http://homer.observability:9090/metrics',
    CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_SAMPLE_PERCENT: '12.5',
    CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_PROCESSING_GAP_SAMPLE_PER_SECOND: '300'
  });

  const config = await loadKamailioRouteAgentRuntimeConfig(env);
  assert.equal(config.pools[0]?.nodes[0]?.service_token, TOKEN);
  assert.equal(config.current_key.key, KEY.toString('base64'));
  assert.equal(config.rpc.bearer_token, 'kamailio-loopback-rpc-token-123456');
  assert.equal(config.hep_high_water?.metrics_endpoint, 'http://homer.observability:9090/metrics');
  assert.equal(config.hep_high_water?.policy.sample_percent, 12.5);
  assert.equal(config.hep_high_water?.policy.processing_gap_sample_per_second, 300);

  await assert.rejects(
    () => loadKamailioRouteAgentRuntimeConfig({
      ...env,
      CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY: KEY.toString('base64')
    }),
    /inline.*secret/i
  );
  await assert.rejects(
    () => loadKamailioRouteAgentRuntimeConfig({
      ...env,
      CONVERACT_FABRIC_KAMAILIO_HOMER_METRICS_ENDPOINT: 'http://user:secret@homer:9090/metrics'
    }),
    /endpoint/i
  );
});

test('route agent runtime reaches ready against real component-node and JSON-RPC loopback servers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-kamailio-runtime-'));
  const controller = new ComponentNodeAdmissionController({
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a-0',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 2_500,
        used: 0,
        reserved: 0
      }
    }
  });
  controller.applyLease({
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a-0',
    cell_lease_epoch: 7,
    state: 'draining',
    recovery_complete: false,
    recovery_reset: true,
    observed_at: '2026-07-21T07:59:59.000Z',
    expires_at: '2026-07-21T08:00:20.000Z'
  }, T0);
  controller.applyLease({
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'rustpbx-a-0',
    cell_lease_epoch: 7,
    state: 'accepting',
    recovery_complete: true,
    recovery_reset: false,
    observed_at: '2026-07-21T08:00:00.000Z',
    expires_at: '2026-07-21T08:00:20.000Z'
  }, T0);
  const componentServer = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: TOKEN,
    now: () => T0
  });
  const componentPort = await listenOnRandomPort(componentServer);
  t.after(() => closeServer(componentServer));

  const rpcMethods: string[] = [];
  const rpcServer = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('kamailio_core_ivekit_dispatch_failures 0\n');
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer kamailio-loopback-rpc-token-123456');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id: number;
      method: string;
    };
    rpcMethods.push(requestBody.method);
    const result = requestBody.method === 'htable.get'
      ? { item: { key: 'revision', value: 0, type: 'int' } }
      : 'OK';
    const body = JSON.stringify({ jsonrpc: '2.0', result, id: requestBody.id });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  const rpcPort = await listenOnRandomPort(rpcServer);
  t.after(() => closeServer(rpcServer));

  const homerServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end([
      'homer_worker_queue_depth 0',
      'homer_worker_queue_capacity 80000',
      'process_cpu_seconds_total 10',
      'process_start_time_seconds 1784900000',
      'homer_hep_packets_received_total{protocol="udp"} 100',
      'homer_hep_packets_processed_total{protocol="udp"} 100',
      ''
    ].join('\n'));
  });
  const homerPort = await listenOnRandomPort(homerServer);
  t.after(() => closeServer(homerServer));

  const handle = await startKamailioRouteAgent({
    host: '127.0.0.1',
    port: 0,
    poll_interval_ms: 60_000,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    edge_replica_count: 2,
    ttl_ms: 10_000,
    degraded_weight_factor: 0.5,
    max_parallel_polls: 2,
    snapshot_path: join(directory, 'route.snapshot'),
    dispatcher_path: join(directory, 'dispatcher.list'),
    current_key: { key_id: 'route-key-1', key: KEY },
    pools: [{
      pool_id: 100,
      profile_id: 'cell-10k-v1',
      capacity_dimension: 'voice.weighted_calls',
      nodes: [{
        node_id: 'rustpbx-a-0',
        component_endpoint: `http://127.0.0.1:${componentPort}`,
        service_token: TOKEN,
        sip_uri: 'sip:rustpbx-a-0.internal:5060;transport=udp',
        pin_set_id: 10_000,
        priority: 10,
        safe_capacity_fallback: 2_500
      }]
    }],
    rpc: {
      endpoint: `http://127.0.0.1:${rpcPort}/RPC`,
      bearer_token: 'kamailio-loopback-rpc-token-123456',
      max_attempts: 1,
      retry_delay_ms: 0,
      timeout_ms: 1_000
    },
    hep_high_water: {
      poll_interval_ms: 60_000,
      metrics_endpoint: `http://127.0.0.1:${homerPort}/metrics`,
      metrics_timeout_ms: 1_000,
      policy: {
        sample_percent: 10,
        queue_sample_ratio: 0.5,
        queue_off_ratio: 0.8,
        queue_recover_ratio: 0.2,
        cpu_sample_cores: 0.7,
        cpu_off_cores: 1.5,
        cpu_recover_cores: 0.3,
        packets_sample_per_second: 5_000,
        packets_off_per_second: 10_000,
        packets_recover_per_second: 2_000,
        processing_gap_sample_per_second: 250,
        processing_gap_off_per_second: 1_000,
        processing_gap_recover_per_second: 25,
        failure_samples_to_off: 3,
        recovery_samples: 2
      }
    }
  }, {
    now: () => T0,
    log: () => undefined
  });
  t.after(() => handle.stop());

  const address = handle.server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status, 200);
  assert.deepEqual(rpcMethods, [
    'dispatcher.reload',
    'htable.get',
    'htable.seti',
    'htable.seti',
    'htable.seti'
  ]);
  const metrics = await fetch(`http://127.0.0.1:${address.port}/metrics`)
    .then((response) => response.text());
  assert.match(metrics, /ivekit_kamailio_hep_mode\{mode="off"\} 1/);
  assert.match(metrics, /ivekit_kamailio_hep_collector_up 1/);
  assert.match(await readFile(join(directory, 'dispatcher.list'), 'utf8'), /^100 /m);
});

test('route agent entrypoint and environment contracts require file-backed secrets', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['converact:kamailio:route-agent'],
    'node --import tsx scripts/converact-kamailio-route-agent.ts'
  );
  assert.match(
    await readFile('scripts/converact-kamailio-route-agent.ts', 'utf8'),
    /loadKamailioRouteAgentRuntimeConfig[\s\S]*runKamailioRouteAgent/
  );
  for (const path of [
    'infra/env.example',
    'infra/converact/env.example',
    'services/converact-service/env.example'
  ]) {
    const env = await readFile(path, 'utf8');
    assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_TOPOLOGY_FILE=\/etc\/converact\/kamailio-topology\.json$/m);
    assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY_FILE=\/run\/secrets\//m);
    assert.match(env, /^CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE=\/run\/secrets\//m);
    assert.doesNotMatch(env, /^CONVERACT_FABRIC_KAMAILIO_(?:CURRENT_KEY|RPC_TOKEN)=/m);
  }
});

function routeAgent(
  directory: string,
  nodes: ReturnType<typeof routeNode>[],
  overrides: Partial<ConstructorParameters<typeof KamailioRouteAgent>[0]> = {}
): KamailioRouteAgent {
  return new KamailioRouteAgent({
    codec: codec(),
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    edge_replica_count: 2,
    ttl_ms: 10_000,
    degraded_weight_factor: 0.5,
    max_parallel_polls: 4,
    snapshot_path: join(directory, 'route.snapshot'),
    dispatcher_path: join(directory, 'dispatcher.list'),
    pools: [{
      pool_id: 100,
      profile_id: 'cell-10k-v1',
      capacity_dimension: 'voice.weighted_calls',
      nodes
    }],
    rpc: { reload: async () => undefined },
    ...overrides
  });
}

function routeNode(index: number, readState: () => Promise<ComponentNodeStateSnapshot>) {
  return {
    node_id: `rustpbx-a-${index}`,
    sip_uri: `sip:rustpbx-a-${index}.internal:5060;transport=udp`,
    pin_set_id: 10_000 + index,
    priority: 10,
    safe_capacity_fallback: 2_500,
    read_state: readState
  };
}

function componentState(index: number): ComponentNodeStateSnapshot {
  return {
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: `rustpbx-a-${index}`,
    state: 'accepting',
    state_sequence: 12,
    drain_started_at: '',
    cell_lease_epoch: 7,
    lease_observed_at: '2026-07-21T07:59:59.000Z',
    lease_expires_at: '2026-07-21T08:00:20.000Z',
    lease_fresh: true,
    recovery_pending: false,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 2_500,
        used: 800,
        reserved: 100
      }
    },
    reservations: { reserved: 100, active: 800, expired: 0, closed: 0 }
  };
}

function codec(): KamailioRouteSnapshotCodec {
  return new KamailioRouteSnapshotCodec({
    current: { key_id: 'route-key-1', key: KEY }
  });
}

function verification(lastSequence: number, now: Date) {
  return {
    now,
    expected_region_id: 'region-a',
    expected_zone_id: 'zone-a',
    expected_cell_id: 'cell-a',
    expected_cell_lease_epoch: 7,
    last_accepted_sequence: lastSequence
  };
}

function runtimeEnv(directory: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    CONVERACT_FABRIC_KAMAILIO_HOST: '127.0.0.1',
    CONVERACT_FABRIC_KAMAILIO_PORT: '3220',
    CONVERACT_FABRIC_KAMAILIO_REGION_ID: 'region-a',
    CONVERACT_FABRIC_KAMAILIO_ZONE_ID: 'zone-a',
    CONVERACT_FABRIC_KAMAILIO_CELL_ID: 'cell-a',
    CONVERACT_FABRIC_KAMAILIO_CELL_LEASE_EPOCH: '7',
    CONVERACT_FABRIC_KAMAILIO_EDGE_REPLICA_COUNT: '2',
    CONVERACT_FABRIC_KAMAILIO_TOPOLOGY_FILE: join(directory, 'topology.json'),
    CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY_ID: 'route-key-1',
    CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY_FILE: join(directory, 'current-key'),
    CONVERACT_FABRIC_KAMAILIO_SNAPSHOT_PATH: join(directory, 'route.snapshot'),
    CONVERACT_FABRIC_KAMAILIO_DISPATCHER_PATH: join(directory, 'dispatcher.list'),
    CONVERACT_FABRIC_KAMAILIO_RPC_ENDPOINT: 'http://127.0.0.1:5060/RPC',
    CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE: join(directory, 'rpc-token'),
    ...overrides
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
