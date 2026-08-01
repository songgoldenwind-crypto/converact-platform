import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  generateTinodeApiCredential,
  normalizeTinodeStaircaseConfig,
  parseDockerStatsSample,
  parseTinodeLiveSessions
} from '../scripts/capacity/tinode-staircase.js';

test('generates a Tinode API key that matches the supplied salt and sequence', () => {
  const salt = Buffer.alloc(32, 0x2a);
  const credential = generateTinodeApiCredential({
    salt,
    sequence: 7,
    is_root: false
  });

  assert.equal(credential.api_key_salt, salt.toString('base64'));
  const decoded = Buffer.from(credential.api_key, 'base64url');
  assert.equal(decoded.length, 24);
  assert.equal(decoded[0], 1);
  assert.equal(decoded.readUInt32LE(1), 0);
  assert.equal(decoded.readUInt16LE(5), 7);
  assert.equal(decoded[7], 0);
  assert.deepEqual(
    decoded.subarray(8),
    createHmac('md5', salt).update(decoded.subarray(0, 8)).digest()
  );
});

test('normalizes the strict Tinode staircase contract', () => {
  const config = normalizeTinodeStaircaseConfig({
    output_file: '/tmp/tinode-staircase/evidence.json',
    tinode_image: 'ivekit/tinode:v0.25.3-ivekit.3-22a7c18e-amd64',
    postgres_image:
      'postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20'
  });

  assert.deepEqual(config.points, [100, 250, 500, 1_000]);
  assert.equal(config.connection_ramp_per_second, 100);
  assert.equal(config.interaction_start_rate_per_second, 33);
  assert.equal(config.messages_per_interaction, 2);
  assert.equal(config.message_body_bytes, 256);
  assert.equal(config.connection_hold_ms, 10_000);
  assert.equal(config.sample_interval_ms, 500);
  assert.equal(config.tinode_port, 18_061);

  assert.throws(
    () => normalizeTinodeStaircaseConfig({
      output_file: '/tmp/evidence.json',
      tinode_image: config.tinode_image,
      postgres_image: config.postgres_image,
      points: [250, 100]
    }),
    /strictly increasing/
  );
});

test('parses Docker resource samples without losing byte precision', () => {
  assert.deepEqual(
    parseDockerStatsSample({
      CPUPerc: '27.56%',
      MemUsage: '25.37MiB / 7.77GiB',
      PIDs: '10',
      NetIO: '1.5MB / 900kB',
      BlockIO: '12.5kB / 3MB'
    }),
    {
      cpu_percent: 27.56,
      memory_bytes: 26_602_373.12,
      pids: 10,
      network_rx_bytes: 1_500_000,
      network_tx_bytes: 900_000,
      block_read_bytes: 12_500,
      block_write_bytes: 3_000_000
    }
  );
});

test('reads Tinode LiveSessions from expvar and rejects malformed counters', () => {
  assert.equal(parseTinodeLiveSessions('{"LiveSessions":250,"Version":"test"}'), 250);
  assert.throws(
    () => parseTinodeLiveSessions('{"LiveSessions":-1}'),
    /LiveSessions/
  );
  assert.throws(
    () => parseTinodeLiveSessions('{"Version":"test"}'),
    /LiveSessions/
  );
});

test('strict Tinode server staircase evidence stays source-bound and secret-free', () => {
  const evidencePath =
    'docs/evidence/wave3-tinode-composite-strict-staircase-2026-07-23.json';
  const raw = readFileSync(evidencePath, 'utf8');
  const evidence = JSON.parse(raw) as any;

  assert.equal(evidence.status, 'controlled_pass');
  assert.equal(evidence.capacity_claim, 'none');
  assert.deepEqual(
    evidence.points.map((point: any) => point.connections),
    [100, 250, 500, 1_000]
  );
  for (const point of evidence.points) {
    assert.equal(point.status, 'controlled_pass');
    assert.equal(point.sampling_error_count, 0);
    assert.equal(point.sensitive_inputs_removed, true);
    assert.equal(point.reconciliation.exact_match, true);
    assert.equal(point.reconciliation.sut_live_sessions_max, point.connections);
    assert.equal(point.client.connection_rate_conformant, true);
    assert.equal(point.client.interaction_rate_conformant, true);
    assert.equal(point.client.durable_message_loss_count, 0);
    assert.equal(point.client.duplicate_message_count, 0);
    assert.equal(point.client.out_of_order_message_count, 0);
    assert.equal(point.client.error_count, 0);
  }
  assert.equal(evidence.controls.credential_bundle_removed_after_run, true);
  assert.equal(evidence.controls.led_state_preserved, true);
  assert.equal(evidence.controls.test_resources_remaining, 0);

  const evidenceCommit = spawnSync(
    'git',
    ['log', '-n', '1', '--format=%H', '--', evidencePath],
    { encoding: 'utf8' }
  ).stdout.trim();
  assert.match(evidenceCommit, /^[a-f0-9]{40}$/);
  for (const [path, expected] of Object.entries(evidence.source.sha256)) {
    const archived = spawnSync(
      'git',
      ['show', `${evidenceCommit}:${path}`],
      { encoding: null }
    );
    assert.equal(archived.status, 0, `${path} is missing from the archived evidence commit`);
    const actual = createHash('sha256').update(archived.stdout).digest('hex');
    assert.equal(actual, expected, `${path} drifted from the server evidence`);
  }
  assert.doesNotMatch(
    raw,
    /"(api_key|api_key_salt|postgres_password|auth_token_key|uid_encryption_key)"|POSTGRES_DSN|credentials\.json|postgres\.env|tinode\.env/i
  );
});
