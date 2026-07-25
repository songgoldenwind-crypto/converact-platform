import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { provisionTinodeCompositeBundle } from '../scripts/capacity/generators/tinode-composite-provisioner.js';

test('Tinode composite provisioner creates identities, shared topics and extra agent devices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tinode-composite-provisioner-'));
  const outputPath = join(directory, 'credentials.json');
  const secondOutputPath = join(directory, 'credentials-second.json');
  const http = createServer();
  const server = new WebSocketServer({ server: http, path: '/v0/channels' });
  const accounts: Array<{ user: string; token: string }> = [];
  const usernames = new Set<string>();
  const basicLoginLengths: number[] = [];
  const grants: Array<{ topic: string; user: string; mode: string }> = [];
  let topicSequence = 0;

  server.on('connection', (socket, request) => {
    const url = new URL(request.url || '/', 'ws://localhost');
    assert.equal(url.searchParams.get('apikey'), 'tinode-provision-key');
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      const ctrl: Record<string, any> = {
        id: body.id,
        code: 200,
        text: 'ok',
        params: {}
      };
      if (kind === 'acc') {
        const [username] = Buffer.from(body.secret, 'base64').toString('utf8').split(':');
        basicLoginLengths.push(username.length);
        if (usernames.has(username)) {
          ctrl.code = 409;
          ctrl.text = 'duplicate username';
          socket.send(JSON.stringify({ ctrl }));
          return;
        }
        usernames.add(username);
        const account = {
          user: `usrProvision${accounts.length}`,
          token: `token-provision-${accounts.length}`
        };
        accounts.push(account);
        ctrl.params = account;
      } else if (kind === 'sub' && body.topic === 'new') {
        ctrl.topic = `grpProvision${topicSequence++}`;
      } else if (kind === 'set') {
        grants.push({
          topic: body.topic,
          user: body.sub.user,
          mode: body.sub.mode
        });
      }
      socket.send(JSON.stringify({ ctrl }));
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await provisionTinodeCompositeBundle({
      endpoint: `ws://127.0.0.1:${address.port}/v0/channels`,
      api_key: 'tinode-provision-key',
      output_path: outputPath,
      namespace: 'tinode-composite-step-5',
      connection_ordinal_start: 3000,
      interaction_ordinal_start: 2000,
      connection_count: 5,
      interaction_count: 3,
      agent_topic_capacity: 3,
      concurrency: 4,
      request_timeout_ms: 1_000
    });

    assert.deepEqual(result, {
      schema_version: '1.0.0',
      status: 'provisioned',
      connection_count: 5,
      interaction_count: 3,
      logical_identity_count: 4,
      topic_count: 3,
      output_path: outputPath,
      bundle_sha256: result.bundle_sha256
    });
    assert.match(result.bundle_sha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(accounts.length, 4);
    assert.ok(
      basicLoginLengths.every((length) => length <= 26),
      'Tinode PostgreSQL basic login must leave room for the basic: scheme prefix'
    );
    assert.equal(grants.length, 3);
    assert.ok(grants.every((grant) => grant.mode === 'JRP'));

    const bundle = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(bundle.connections.length, 5);
    assert.equal(bundle.interactions.length, 3);
    assert.deepEqual(bundle.connections[3].topics, [
      'grpProvision0',
      'grpProvision1',
      'grpProvision2'
    ]);
    assert.deepEqual(bundle.connections[4], {
      ordinal: 3004,
      auth: bundle.connections[3].auth,
      topics: bundle.connections[3].topics
    });
    assert.deepEqual(bundle.interactions[2], {
      ordinal: 2002,
      topic: 'grpProvision2',
      publisher_connection_ordinal: 3002,
      subscriber_connection_ordinal: 3003
    });

    await provisionTinodeCompositeBundle({
      endpoint: `ws://127.0.0.1:${address.port}/v0/channels`,
      api_key: 'tinode-provision-key',
      output_path: secondOutputPath,
      namespace: 'tinode-composite-step-5',
      connection_ordinal_start: 4000,
      interaction_ordinal_start: 2500,
      connection_count: 5,
      interaction_count: 3,
      agent_topic_capacity: 3,
      concurrency: 4,
      request_timeout_ms: 1_000
    });
    assert.equal(accounts.length, 8);
    assert.equal(usernames.size, 8);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
