import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import {
  executeTinodeCapacityWorkerInput,
  type TinodeCapacityWorkerInput
} from '../scripts/capacity/generators/tinode-worker.js';
import {
  ExternalJsonCapacityShardDriver
} from '../scripts/capacity/generators/external-worker.js';
import type { CapacityStartShardCommand } from '../scripts/capacity/orchestrator/types.js';

test('Tinode capacity worker executes an interaction shard without exposing credentials', async () => {
  const fixture = await tinodeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-tinode-worker-'));
  const bundlePath = join(directory, 'credentials.json');
  await writeCredentialBundle(bundlePath, [
    credential('interaction', 'tinode_im', 0, 'interaction-secret', 'grpInteraction')
  ]);

  try {
    const result = await executeTinodeCapacityWorkerInput(workerInput(
      interactionCommand(),
      bundlePath,
      fixture.endpoint
    ));

    assert.equal(result.outcome, 'completed');
    assert.equal(result.error_code, '');
    assert.equal(result.evidence_kind, 'tinode_client_protocol');
    assert.equal(result.evidence.workload_domain, 'interaction');
    assert.equal(result.evidence.workload_id, 'tinode_im');
    assert.equal((result.evidence.client as any).status, 'controlled_pass');
    assert.equal((result.evidence.client as any).published_message_count, 2);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('interaction-secret'), false);
    assert.equal(serialized.includes('tinode-load-key'), false);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Tinode capacity worker holds all connection-shard sockets active and emits protocol activity', async () => {
  const fixture = await tinodeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-tinode-worker-'));
  const bundlePath = join(directory, 'credentials.json');
  await writeCredentialBundle(bundlePath, [
    credential('connection', 'tinode_websocket', 0, 'connection-secret-0', 'grpConnection0'),
    credential('connection', 'tinode_websocket', 1, 'connection-secret-1', 'grpConnection1')
  ]);

  try {
    const input = workerInput(connectionCommand(), bundlePath, fixture.endpoint);
    input.static_input.connection_hold_ms = 30;
    input.static_input.activity_interval_ms = 10;
    const result = await executeTinodeCapacityWorkerInput(input);

    assert.equal(result.outcome, 'completed');
    const client = result.evidence.client as any;
    assert.equal(client.status, 'controlled_pass');
    assert.equal(client.attempted_count, 2);
    assert.equal(client.accepted_count, 2);
    assert.equal(client.active_peak_count, 2);
    assert.equal(client.closed_count, 2);
    assert.ok(client.activity_note_count >= 2);
    assert.ok(fixture.typingNotes >= 2);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Tinode capacity worker executes covered IM interactions on the physical connection shard', async () => {
  const fixture = await tinodeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-tinode-worker-composite-'));
  const bundlePath = join(directory, 'credentials.json');
  await writeCompositeCredentialBundle(bundlePath);

  try {
    const command = compositeCommand();
    const input = workerInput(
      command,
      bundlePath,
      fixture.endpoint
    );
    input.static_input.composite_credential_bundles = [
      await compositeBundleBinding(command, bundlePath)
    ];
    const result = await executeTinodeCapacityWorkerInput(input);

    assert.equal(result.outcome, 'completed');
    assert.equal(result.evidence_kind, 'tinode_composite_protocol');
    const client = result.evidence.client as any;
    assert.equal(client.connection_attempted_count, 3);
    assert.equal(client.connection_accepted_count, 3);
    assert.equal(client.interaction_attempted_count, 2);
    assert.equal(client.interaction_active_count, 2);
    assert.equal(client.published_message_count, 4);
    assert.equal(client.delivered_message_count, 4);
    assert.equal(fixture.connectionCount, 3);
    assert.deepEqual(result.evidence.workload_evidence, [{
      workload_domain: 'connection',
      workload_id: 'tinode_websocket',
      expected_count: 3,
      attempted_count: 3,
      accepted_count: 3,
      active_peak_count: 3
    }, {
      workload_domain: 'interaction',
      workload_id: 'tinode_im',
      expected_count: 2,
      attempted_count: 2,
      accepted_count: 2,
      active_peak_count: 2
    }]);
    assert.equal(JSON.stringify(result).includes('composite-agent-secret'), false);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Tinode capacity worker selects exact bundles for two nonzero composite shards', async () => {
  const fixture = await tinodeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-tinode-worker-routed-'));
  const firstPath = join(directory, 'first.json');
  const secondPath = join(directory, 'second.json');
  await writeCompositeCredentialBundle(firstPath, {
    connection_start: 3000,
    interaction_start: 2000,
    label: 'First'
  });
  await writeCompositeCredentialBundle(secondPath, {
    connection_start: 4000,
    interaction_start: 2500,
    label: 'Second'
  });
  const firstCommand = compositeCommand(3000, 2000);
  const secondCommand = compositeCommand(4000, 2500);
  const bindings = [
    await compositeBundleBinding(firstCommand, firstPath),
    await compositeBundleBinding(secondCommand, secondPath)
  ];

  try {
    const tamperedInput = workerInput(firstCommand, firstPath, fixture.endpoint);
    tamperedInput.static_input.composite_credential_bundles = [{
      ...bindings[0],
      sha256: '0'.repeat(64)
    }];
    await assert.rejects(
      () => executeTinodeCapacityWorkerInput(tamperedInput),
      /checksum mismatch/
    );

    const firstInput = workerInput(firstCommand, firstPath, fixture.endpoint);
    firstInput.static_input.composite_credential_bundles = bindings;
    const first = await executeTinodeCapacityWorkerInput(firstInput);
    const secondInput = workerInput(secondCommand, firstPath, fixture.endpoint);
    secondInput.static_input.composite_credential_bundles = bindings;
    const second = await executeTinodeCapacityWorkerInput(secondInput);

    assert.equal(first.outcome, 'completed');
    assert.equal(second.outcome, 'completed');
    assert.notEqual(
      first.evidence.credential_bundle_sha256,
      second.evidence.credential_bundle_sha256
    );
    assert.equal((first.evidence.client as any).connection_attempted_count, 3);
    assert.equal((second.evidence.client as any).connection_attempted_count, 3);
    assert.equal(fixture.connectionCount, 6);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Tinode capacity worker rejects a credential bundle readable by group or other users', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-tinode-worker-'));
  const bundlePath = join(directory, 'credentials.json');
  await writeCredentialBundle(bundlePath, [
    credential('interaction', 'tinode_im', 0, 'must-not-leak', 'grpPrivate')
  ]);
  await chmod(bundlePath, 0o644);

  try {
    await assert.rejects(
      () => executeTinodeCapacityWorkerInput(workerInput(
        interactionCommand(),
        bundlePath,
        'ws://127.0.0.1:9/v0/channels'
      )),
      /credential bundle permissions/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic capacity worker launches the SHA-pinned Tinode executable end to end', async () => {
  const fixture = await tinodeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-tinode-executable-'));
  const bundlePath = join(directory, 'credentials.json');
  await writeCredentialBundle(bundlePath, [
    credential('interaction', 'tinode_im', 0, 'external-secret', 'grpExternal')
  ]);
  const executable = resolve('scripts/ivekit-capacity-tinode-worker.ts');
  const binarySha256 = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  const staticInput = workerInput(
    interactionCommand(),
    bundlePath,
    fixture.endpoint
  ).static_input;

  try {
    const driver = new ExternalJsonCapacityShardDriver({
      spec: {
        schema_version: '1.0.0',
        executable,
        binary_version: 'tinode-worker-test',
        binary_sha256: binarySha256,
        result_directory: directory,
        timeout_ms: 10_000,
        static_input: staticInput
      }
    });
    const result = await driver.execute(interactionCommand(), {
      signal: new AbortController().signal
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(result.evidence_kind, 'tinode_client_protocol');
    assert.equal((result.evidence.client as any).status, 'controlled_pass');
    assert.equal(JSON.stringify(result).includes('external-secret'), false);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function workerInput(
  command: CapacityStartShardCommand,
  credentialBundlePath: string,
  endpoint: string
): TinodeCapacityWorkerInput {
  return {
    schema_version: '1.0.0',
    command,
    static_input: {
      endpoint,
      credential_bundle_path: credentialBundlePath,
      messages_per_interaction: 2,
      message_body_bytes: 32,
      presence_enabled: true,
      typing_enabled: true,
      receipts_enabled: true,
      maximum_reconnects: 1,
      reconnect_delay_ms: 5,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 200,
      send_to_ack_p99_limit_ms: 500,
      send_to_delivery_p95_limit_ms: 250,
      send_to_delivery_p99_limit_ms: 750,
      delivery_settle_ms: 5,
      offline_recovery_message_count: 0,
      offline_recovery_p99_limit_ms: 1_000,
      concurrency: 2,
      connection_hold_ms: 20,
      activity_interval_ms: 10,
      connection_ramp_per_second: 100,
      interaction_start_rate_per_second: 50
    },
    result_path: '/tmp/tinode-capacity-result.json'
  };
}

function interactionCommand(): CapacityStartShardCommand {
  return command({
    shard_id: 'interaction/tinode_im/0-1',
    workload_domain: 'interaction',
    workload_id: 'tinode_im',
    workload_kind: 'tinode_im',
    ordinal_start: 0,
    ordinal_end_exclusive: 1,
    expected_count: 1
  });
}

function connectionCommand(): CapacityStartShardCommand {
  return command({
    shard_id: 'connection/tinode_websocket/0-2',
    workload_domain: 'connection',
    workload_id: 'tinode_websocket',
    workload_kind: 'tinode_websocket',
    ordinal_start: 0,
    ordinal_end_exclusive: 2,
    expected_count: 2
  });
}

function compositeCommand(
  connectionStart = 0,
  interactionStart = 0
): CapacityStartShardCommand {
  const value = connectionCommand();
  value.assignment.ordinal_start = connectionStart;
  value.assignment.ordinal_end_exclusive = connectionStart + 3;
  value.assignment.expected_count = 3;
  value.assignment.covered_workloads = [{
    workload_domain: 'interaction',
    workload_id: 'tinode_im',
    workload_kind: 'tinode_im',
    ordinal_start: interactionStart,
    ordinal_end_exclusive: interactionStart + 2,
    expected_count: 2
  }];
  value.shard_id = `connection/tinode_websocket/${connectionStart}-${connectionStart + 3}`;
  return value;
}

function command(
  assignment: Omit<
    CapacityStartShardCommand['assignment'],
    'required_protocols' | 'seed'
  > & { shard_id: string }
): CapacityStartShardCommand {
  const { shard_id, ...commandAssignment } = assignment;
  return {
    schema_version: '1.0.0',
    command_id: 'command-tinode-worker',
    command_type: 'start_shard',
    run_id: 'run-tinode-worker',
    phase_id: 'steady',
    shard_id,
    worker_id: 'tinode-worker-0',
    fleet_id: 'tinode',
    lease_epoch: '1',
    lease_expires_at: '2026-07-23T12:01:00.000Z',
    issued_at: '2026-07-23T12:00:00.000Z',
    assignment: {
      ...commandAssignment,
      required_protocols: ['tinode_websocket'],
      seed: 'a'.repeat(64)
    }
  };
}

function credential(
  workloadDomain: 'interaction' | 'connection',
  workloadId: 'tinode_im' | 'tinode_websocket',
  ordinal: number,
  secret: string,
  topic: string
) {
  return {
    workload_domain: workloadDomain,
    workload_id: workloadId,
    ordinal,
    auth: { scheme: 'token', secret },
    topic
  };
}

async function writeCredentialBundle(path: string, credentials: unknown[]): Promise<void> {
  await writeFile(path, JSON.stringify({
    schema_version: '1.0.0',
    api_key: 'tinode-load-key',
    credentials
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeCompositeCredentialBundle(
  path: string,
  options: {
    connection_start?: number;
    interaction_start?: number;
    label?: string;
  } = {}
): Promise<void> {
  const connectionStart = options.connection_start ?? 0;
  const interactionStart = options.interaction_start ?? 0;
  const label = options.label ?? 'Composite';
  await writeFile(path, JSON.stringify({
    schema_version: '1.0.0',
    api_key: 'tinode-load-key',
    connections: [{
      ordinal: connectionStart,
      auth: { scheme: 'token', secret: 'composite-customer-0-secret' },
      topics: [`grp${label}0`]
    }, {
      ordinal: connectionStart + 1,
      auth: { scheme: 'token', secret: 'composite-agent-secret' },
      topics: [`grp${label}0`, `grp${label}1`]
    }, {
      ordinal: connectionStart + 2,
      auth: { scheme: 'token', secret: 'composite-customer-1-secret' },
      topics: [`grp${label}1`]
    }],
    interactions: [{
      ordinal: interactionStart,
      topic: `grp${label}0`,
      publisher_connection_ordinal: connectionStart,
      subscriber_connection_ordinal: connectionStart + 1
    }, {
      ordinal: interactionStart + 1,
      topic: `grp${label}1`,
      publisher_connection_ordinal: connectionStart + 2,
      subscriber_connection_ordinal: connectionStart + 1
    }]
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function compositeBundleBinding(
  command: CapacityStartShardCommand,
  path: string
) {
  return {
    run_id: command.run_id,
    phase_id: command.phase_id,
    shard_id: command.shard_id,
    path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex')
  };
}

async function tinodeFixture(): Promise<{
  endpoint: string;
  readonly typingNotes: number;
  readonly connectionCount: number;
  close(): Promise<void>;
}> {
  const http = createServer();
  const server = new WebSocketServer({ server: http, path: '/v0/channels' });
  let typingNotes = 0;
  let connectionCount = 0;
  let sequence = 0;
  const subscriptions = new Map<WebSocket, Set<string>>();
  server.on('connection', (socket, request) => {
    connectionCount += 1;
    subscriptions.set(socket, new Set());
    socket.on('close', () => subscriptions.delete(socket));
    const url = new URL(request.url || '/', 'ws://localhost');
    assert.equal(url.searchParams.get('apikey'), 'tinode-load-key');
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      if (kind === 'note') {
        if (body.what === 'kp') typingNotes += 1;
        return;
      }
      if (kind === 'sub') subscriptions.get(socket)!.add(body.topic);
      socket.send(JSON.stringify({
        ctrl: {
          id: body.id,
          code: 200,
          text: 'ok',
          topic: body.topic || '',
          params: kind === 'pub' ? { seq: ++sequence } : {}
        }
      }));
      if (kind === 'pub') {
        const data = JSON.stringify({
          data: {
            topic: body.topic,
            seq: sequence,
            head: body.head,
            content: body.content
          }
        });
        for (const [subscriber, topics] of subscriptions) {
          if (topics.has(body.topic) && subscriber.readyState === WebSocket.OPEN) {
            subscriber.send(data);
          }
        }
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `ws://127.0.0.1:${address.port}/v0/channels`,
    get typingNotes() { return typingNotes; },
    get connectionCount() { return connectionCount; },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}
