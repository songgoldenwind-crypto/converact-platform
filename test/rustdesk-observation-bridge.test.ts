import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  RustDeskObservationBridge,
  createRustDeskObservationBridgeConfigFromEnv
} from '../scripts/rustdesk-observation-bridge.js';

const DEVICE_TOKEN = 'device-bound-observation-token-material-123456789';

test('observation bridge ingests atomic JSON and forwards a device-token batch exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-observation-bridge-'));
  const inputDirectory = join(root, 'inbox');
  const spoolDirectory = join(root, 'spool');
  const tokenFile = join(root, 'edge-token');
  writeFileSync(tokenFile, `${DEVICE_TOKEN}\n`, { mode: 0o600 });
  const config = createRustDeskObservationBridgeConfigFromEnv({
    CONVERACT_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
    CONVERACT_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
    CONVERACT_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: inputDirectory,
    CONVERACT_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR: spoolDirectory,
    CONVERACT_RUSTDESK_EDGE_OBSERVATION_BATCH_SIZE: '20'
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const bridge = await RustDeskObservationBridge.open(config, async (input, init) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      accepted: body.observations.length,
      events: body.observations
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  writeFileSync(join(inputDirectory, 'observation-1.json'), JSON.stringify(observation()), 'utf8');

  const result = await bridge.pollOnce('rdesk-device-1');
  assert.deepEqual(result, { ingested: 1, forwarded: 1, deadLettered: 0 });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://ivekit.example.com/api/ivekit/rustdesk/devices/rdesk-device-1/observations'
  );
  assert.equal((requests[0].init?.headers as Record<string, string>)['x-rustdesk-edge-token'], DEVICE_TOKEN);
  assert.equal(existsSync(join(inputDirectory, 'observation-1.json')), false);
  const records = await bridge.listRecords();
  assert.equal(records[0].state, 'forwarded');
  await bridge.close();
});

test('observation bridge recovers transient forwarding and quarantines invalid input without content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-observation-recovery-'));
  const tokenFile = join(root, 'edge-token');
  writeFileSync(tokenFile, `${DEVICE_TOKEN}\n`, { mode: 0o600 });
  let now = new Date('2026-07-15T06:00:00.000Z');
  const config = {
    ...createRustDeskObservationBridgeConfigFromEnv({
      CONVERACT_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
      CONVERACT_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
      CONVERACT_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: join(root, 'inbox'),
      CONVERACT_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR: join(root, 'spool'),
      CONVERACT_RUSTDESK_EDGE_OBSERVATION_RETRY_DELAY_MS: '1000'
    }),
    now: () => now
  };
  let attempts = 0;
  const bridge = await RustDeskObservationBridge.open(config, async () => {
    attempts += 1;
    if (attempts === 1) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({ accepted: 1, events: [{}] }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  });
  writeFileSync(join(config.inputDirectory, 'valid.json'), JSON.stringify(observation()), 'utf8');
  writeFileSync(join(config.inputDirectory, 'invalid.json'), JSON.stringify({
    ...observation(),
    clipboard_content: 'must not survive quarantine'
  }), 'utf8');

  const first = await bridge.pollOnce('rdesk-device-1');
  assert.equal(first.ingested, 1);
  assert.equal(first.forwarded, 0);
  const quarantineFiles = readdirSync(join(config.inputDirectory, 'quarantine'));
  assert.equal(quarantineFiles.length, 1);
  const quarantine = readFileSync(join(config.inputDirectory, 'quarantine', quarantineFiles[0]), 'utf8');
  assert.doesNotMatch(quarantine, /must not survive quarantine/);
  assert.match(quarantine, /invalid_schema/);

  now = new Date('2026-07-15T06:00:02.000Z');
  const second = await bridge.pollOnce('rdesk-device-1');
  assert.equal(second.forwarded, 1);
  assert.equal(attempts, 2);
  await bridge.close();
});

test('observation bridge binds placement-enabled operations to the current server owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-observation-owner-'));
  const tokenFile = join(root, 'edge-token');
  writeFileSync(tokenFile, `${DEVICE_TOKEN}\n`, { mode: 0o600 });
  const config = {
    ...createRustDeskObservationBridgeConfigFromEnv({
      CONVERACT_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
      CONVERACT_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
      CONVERACT_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: join(root, 'inbox'),
      CONVERACT_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR: join(root, 'spool')
    }),
    placementEnabled: true
  };
  const posted: Array<Record<string, unknown>> = [];
  const bridge = await RustDeskObservationBridge.open(config, async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.endsWith('/evidence-context')) {
      return new Response(JSON.stringify({
        schema_version: 1,
        device_id: 'rdesk-device-1',
        rustdesk_id: '246813579',
        generated_at: '2026-07-15T06:00:00.000Z',
        expires_at: '2099-07-15T06:00:00.000Z',
        sessions: [{
          external_id: 'gateway-observation-1',
          interaction_id: 'remote-session-observation-1',
          reservation_id: 'reservation-observation-1',
          owner_epoch: '81'
        }],
        bindings: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(String(init?.body)) as { observations: Array<Record<string, unknown>> };
    posted.push(...body.observations);
    return new Response(JSON.stringify({ accepted: body.observations.length, events: [] }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  });
  writeFileSync(join(config.inputDirectory, 'owner.json'), JSON.stringify(observation()), 'utf8');

  try {
    assert.equal((await bridge.pollOnce('rdesk-device-1')).forwarded, 1);
    assert.deepEqual({
      interaction_id: posted[0].interaction_id,
      reservation_id: posted[0].reservation_id,
      owner_epoch: posted[0].owner_epoch
    }, {
      interaction_id: 'remote-session-observation-1',
      reservation_id: 'reservation-observation-1',
      owner_epoch: '81'
    });
  } finally {
    await bridge.close();
  }
});

function observation() {
  return {
    external_id: 'gateway-observation-1',
    operation_id: 'screen-view-1',
    operation: 'view_screen',
    status: 'observed_succeeded',
    observer: 'native_client',
    source_adapter: 'rustdesk_log',
    observed_at: '2026-07-15T06:00:00.000Z',
    evidence_refs: [{
      type: 'native_log',
      ref: 'evidence://rustdesk/screen-view-1',
      sha256: `sha256:${'d'.repeat(64)}`
    }]
  };
}
