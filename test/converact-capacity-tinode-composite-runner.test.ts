import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  executeTinodeCompositeRunnerInput,
  type TinodeCompositeRunnerInput
} from '../scripts/capacity/generators/tinode-composite-runner.js';
import type {
  TinodeCompositeShardInput,
  TinodeCompositeShardResult
} from '../scripts/capacity/generators/tinode-composite.js';

test('Tinode composite runner loads a private bundle and preserves one shared topology', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tinode-composite-runner-'));
  const bundlePath = join(directory, 'credentials.json');
  writeFileSync(bundlePath, JSON.stringify({
    schema_version: '1.0.0',
    api_key: 'private-api-key',
    connections: [
      {
        ordinal: 0,
        auth: { scheme: 'token', secret: 'private-customer-token' },
        topics: ['grpLoad0']
      },
      {
        ordinal: 1,
        auth: { scheme: 'token', secret: 'private-agent-token' },
        topics: ['grpLoad0']
      }
    ],
    interactions: [
      {
        ordinal: 0,
        topic: 'grpLoad0',
        publisher_connection_ordinal: 0,
        subscriber_connection_ordinal: 1
      }
    ]
  }));
  chmodSync(bundlePath, 0o600);

  let captured: TinodeCompositeShardInput | null = null;
  try {
    const output = await executeTinodeCompositeRunnerInput(
      runnerInput(bundlePath),
      {
        run: async (input) => {
          captured = input;
          assert.deepEqual(await input.connection_for_ordinal(0), {
            auth: { scheme: 'token', secret: 'private-customer-token' },
            topics: ['grpLoad0']
          });
          assert.deepEqual(await input.interaction_for_ordinal(0), {
            topic: 'grpLoad0',
            publisher_connection_ordinal: 0,
            subscriber_connection_ordinal: 1
          });
          return passingResult();
        }
      }
    );

    assert.ok(captured);
    assert.equal(captured.connection_ordinal_end_exclusive, 2);
    assert.equal(captured.interaction_ordinal_end_exclusive, 1);
    assert.equal(output.capacity_claim, 'none');
    assert.equal(output.observation_scope, 'client_only');
    assert.equal(output.connection_expected_count, 2);
    assert.equal(output.interaction_expected_count, 1);
    assert.match(output.credential_bundle_sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(output).includes('private-customer-token'), false);
    assert.equal(JSON.stringify(output).includes('private-agent-token'), false);
    assert.equal(JSON.stringify(output).includes('private-api-key'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Tinode composite runner preserves global shard ordinal ranges', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tinode-composite-runner-range-'));
  const bundlePath = join(directory, 'credentials.json');
  writeFileSync(bundlePath, JSON.stringify({
    schema_version: '1.0.0',
    api_key: 'private-api-key',
    connections: [{
      ordinal: 3000,
      auth: { scheme: 'token', secret: 'private-customer-token' },
      topics: ['grpLoad2000']
    }, {
      ordinal: 3001,
      auth: { scheme: 'token', secret: 'private-agent-token' },
      topics: ['grpLoad2000']
    }],
    interactions: [{
      ordinal: 2000,
      topic: 'grpLoad2000',
      publisher_connection_ordinal: 3000,
      subscriber_connection_ordinal: 3001
    }]
  }));
  chmodSync(bundlePath, 0o600);

  try {
    const input = {
      ...runnerInput(bundlePath),
      connection_ordinal_start: 3000,
      connection_ordinal_end_exclusive: 3002,
      interaction_ordinal_start: 2000,
      interaction_ordinal_end_exclusive: 2001
    };
    let captured: TinodeCompositeShardInput | null = null;
    await executeTinodeCompositeRunnerInput(input, {
      run: async (value) => {
        captured = value;
        assert.equal((await value.connection_for_ordinal(3000)).topics[0], 'grpLoad2000');
        assert.equal(
          (await value.interaction_for_ordinal(2000)).publisher_connection_ordinal,
          3000
        );
        return {
          ...passingResult(),
          connection_attempted_count: 2,
          connection_accepted_count: 2,
          connection_active_peak_count: 2,
          connection_closed_count: 2,
          interaction_attempted_count: 1,
          interaction_active_count: 1
        };
      }
    });

    assert.equal(captured?.connection_ordinal_start, 3000);
    assert.equal(captured?.interaction_ordinal_start, 2000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runnerInput(credentialBundlePath: string): TinodeCompositeRunnerInput {
  return {
    schema_version: '1.0.0',
    endpoint: 'wss://tinode.example.test/v0/channels',
    credential_bundle_path: credentialBundlePath,
    run_id: 'tinode-composite-run-001',
    shard_id: 'composite/tinode/0-2',
    worker_id: 'tinode-worker-1',
    lease_epoch: '1',
    messages_per_interaction: 1,
    message_body_bytes: 128,
    receipts_enabled: true,
    maximum_reconnects: 1,
    reconnect_delay_ms: 10,
    request_timeout_ms: 1_000,
    send_to_ack_p95_limit_ms: 200,
    send_to_ack_p99_limit_ms: 500,
    send_to_delivery_p95_limit_ms: 250,
    send_to_delivery_p99_limit_ms: 750,
    delivery_settle_ms: 5,
    connection_hold_ms: 0,
    connection_ramp_per_second: 100,
    interaction_start_rate_per_second: 100,
    concurrency: 10
  };
}

function passingResult(): TinodeCompositeShardResult {
  return {
    protocol: 'tinode_websocket',
    evidence_level: 'controlled',
    status: 'controlled_pass',
    run_id: 'tinode-composite-run-001',
    shard_id: 'composite/tinode/0-2',
    worker_id: 'tinode-worker-1',
    lease_epoch: '1',
    connection_attempted_count: 2,
    connection_accepted_count: 2,
    connection_active_peak_count: 2,
    connection_closed_count: 2,
    connection_start_window_ms: 10,
    connection_rate_conformant: true,
    connection_max_starts_per_second: 2,
    connection_open_sample_count: 2,
    connection_open_p50_ms: 1,
    connection_open_p95_ms: 1,
    connection_open_p99_ms: 1,
    interaction_attempted_count: 1,
    interaction_active_count: 1,
    interaction_start_window_ms: 0,
    interaction_rate_conformant: true,
    interaction_max_starts_per_second: 1,
    socket_attempt_count: 2,
    reconnect_count: 0,
    published_message_count: 1,
    message_send_window_ms: 1,
    published_messages_per_second: 1_000,
    receipt_note_count: 2,
    send_to_ack_sample_count: 1,
    send_to_ack_p50_ms: 1,
    send_to_ack_p95_ms: 1,
    send_to_ack_p99_ms: 1,
    delivered_message_count: 1,
    send_to_delivery_sample_count: 1,
    send_to_delivery_p50_ms: 2,
    send_to_delivery_p95_ms: 2,
    send_to_delivery_p99_ms: 2,
    durable_message_loss_count: 0,
    duplicate_message_count: 0,
    out_of_order_message_count: 0,
    quality_gate_passed: true,
    quality_reasons: [],
    error_count: 0,
    errors: [],
    elapsed_ms: 10,
    journal_sha256: 'a'.repeat(64)
  };
}
