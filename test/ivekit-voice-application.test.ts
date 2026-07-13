import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startIveKitApplication } from '../src/agent-runtime/ivekit/application.js';
import {
  dispatchIveKitVoiceCallCommand,
  iveKitVoiceWorkerConfig,
  startIveKitVoiceProviderEventWorker,
  type IveKitVoiceWorkerConfig
} from '../src/agent-runtime/ivekit/voice/runtime.js';
import { MemoryPg } from '../src/db-pg.js';
import type { PgQueryable } from '../src/db-pg.js';

const ADDRESS_KEY = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY = Buffer.alloc(32, 2).toString('base64');

test('Voice workers are disabled without requiring provider or address secrets', () => {
  assert.deepEqual(iveKitVoiceWorkerConfig({}), {
    enabled: false,
    command_interval_ms: 1_000,
    command_batch_size: 25,
    command_lease_ms: 30_000,
    command_max_attempts: 5,
    command_retry_delays_ms: [1_000, 5_000, 30_000],
    event_interval_ms: 1_000,
    event_batch_size: 25,
    event_lease_ms: 30_000,
    reconciliation_interval_ms: 5_000,
    reconciliation_max_age_ms: 900_000,
    provider_timeout_ms: 10_000,
    tenant_limit: 100
  } satisfies IveKitVoiceWorkerConfig);
});

test('Voice runtime dispatches LiveKit bridge commands to the specialized executor', async () => {
  const calls: string[] = [];
  const provider = async () => { calls.push('provider'); return { provider_command_id: 'provider', result: {} }; };
  const bridge = async () => { calls.push('bridge'); return { provider_command_id: 'bridge', result: {} }; };

  const bridgeResult = await dispatchIveKitVoiceCallCommand(
    { kind: 'livekit_bridge_create' } as never,
    provider,
    bridge
  );
  const providerResult = await dispatchIveKitVoiceCallCommand(
    { kind: 'answer' } as never,
    provider,
    bridge
  );

  assert.equal(bridgeResult.provider_command_id, 'bridge');
  assert.equal(providerResult.provider_command_id, 'provider');
  assert.deepEqual(calls, ['bridge', 'provider']);
});

test('Voice worker config validates keys, bounds, retry delays, and provider lease budget', () => {
  const valid = iveKitVoiceWorkerConfig({
    OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
    OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
    OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY,
    OPC_IVEKIT_VOICE_PROVIDER_TIMEOUT_MS: '20000',
    OPC_IVEKIT_VOICE_COMMAND_LEASE_MS: '25001',
    OPC_IVEKIT_VOICE_EVENT_LEASE_MS: '25001',
    OPC_IVEKIT_VOICE_COMMAND_RETRY_DELAYS_MS: '2000,10000,60000'
  });
  assert.equal(valid.enabled, true);
  assert.equal(valid.command_lease_ms, 25_001);
  assert.deepEqual(valid.command_retry_delays_ms, [2_000, 10_000, 60_000]);

  assert.throws(() => iveKitVoiceWorkerConfig({
    OPC_IVEKIT_VOICE_WORKERS_ENABLED: 'yes'
  }), /OPC_IVEKIT_VOICE_WORKERS_ENABLED/);
  assert.throws(() => iveKitVoiceWorkerConfig({
    OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
    OPC_IVEKIT_VOICE_ADDRESS_KEY: 'not-a-key',
    OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY
  }), /OPC_IVEKIT_VOICE_ADDRESS_KEY/);
  assert.throws(() => iveKitVoiceWorkerConfig({
    OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
    OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
    OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY,
    OPC_IVEKIT_VOICE_COMMAND_RETRY_DELAYS_MS: '1000,-1'
  }), /OPC_IVEKIT_VOICE_COMMAND_RETRY_DELAYS_MS/);
  assert.throws(() => iveKitVoiceWorkerConfig({
    OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
    OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
    OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY,
    OPC_IVEKIT_VOICE_PROVIDER_TIMEOUT_MS: '30000',
    OPC_IVEKIT_VOICE_COMMAND_LEASE_MS: '30000'
  }), /COMMAND_LEASE_MS.*provider timeout/i);
});

test('iveKit application starts Voice workers only when enabled and stops them in reverse order', async () => {
  const events: string[] = [];
  const worker = (name: string) => {
    events.push(`start:${name}`);
    return { async stop() { events.push(`stop:${name}`); } };
  };
  const existing = {
    startTinode: () => worker('tinode'),
    startTinodeInbound: () => worker('tinode-inbound'),
    startAttachment: () => worker('attachment'),
    startQuality: () => worker('quality'),
    startTranslation: () => worker('translation'),
    startMediaTimeout: () => worker('media-timeout'),
    startEventRetention: () => worker('event-retention')
  };
  const voice = {
    startVoiceCommand: () => worker('voice-command'),
    startVoiceEvent: () => worker('voice-event'),
    startVoiceReconciliation: () => worker('voice-reconciliation')
  };

  const disabled = startIveKitApplication({
    pg: new MemoryPg(), env: {}, adapters: { ...existing, ...voice }
  });
  await disabled.stop();
  assert.equal(events.some((event) => event.includes('voice-')), false);

  events.length = 0;
  const enabled = startIveKitApplication({
    pg: new MemoryPg(),
    env: {
      OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
      OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
      OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY
    },
    adapters: { ...existing, ...voice }
  });
  await enabled.stop();
  await enabled.stop();
  assert.deepEqual(events, [
    'start:tinode', 'start:tinode-inbound', 'start:attachment', 'start:quality',
    'start:translation', 'start:media-timeout', 'start:event-retention',
    'start:voice-command', 'start:voice-event', 'start:voice-reconciliation',
    'stop:voice-reconciliation', 'stop:voice-event', 'stop:voice-command',
    'stop:event-retention', 'stop:media-timeout', 'stop:translation', 'stop:quality',
    'stop:attachment', 'stop:tinode-inbound', 'stop:tinode'
  ]);
});

test('iveKit application waits for every Voice stop and aggregates failures', async () => {
  const stopped: string[] = [];
  const handle = { async stop() {} };
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    env: {
      OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
      OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
      OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY
    },
    adapters: {
      startTinode: () => handle,
      startTinodeInbound: () => handle,
      startAttachment: () => handle,
      startQuality: () => handle,
      startTranslation: () => handle,
      startMediaTimeout: () => handle,
      startEventRetention: () => handle,
      startVoiceCommand: () => ({
        async stop() { stopped.push('command'); throw new Error('command stop failed'); }
      }),
      startVoiceEvent: () => ({
        async stop() { await Promise.resolve(); stopped.push('event'); }
      }),
      startVoiceReconciliation: () => ({
        async stop() { stopped.push('reconciliation'); throw new Error('reconciliation stop failed'); }
      })
    }
  });

  await assert.rejects(
    () => application.stop(),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2
  );
  assert.deepEqual(stopped, ['reconciliation', 'event', 'command']);
});

test('production Voice scheduler stop waits for an active tenant-discovery batch', async () => {
  const queryStarted = deferred<void>();
  const queryGate = deferred<{ rows: Array<{ tenant_id: string }> }>();
  const queries: unknown[][] = [];
  const pg = {
    async query(_text: string, values?: unknown[]) {
      queries.push(values || []);
      queryStarted.resolve();
      return {
        ...(await queryGate.promise),
        rowCount: 0, command: '', oid: 0, fields: []
      };
    }
  } as unknown as PgQueryable;
  const worker = startIveKitVoiceProviderEventWorker({
    pg,
    env: {
      OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
      OPC_IVEKIT_VOICE_ADDRESS_KEY: ADDRESS_KEY,
      OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: HMAC_KEY
    }
  });
  await queryStarted.promise;

  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  queryGate.resolve({ rows: [] });
  await stopping;

  assert.equal(stopped, true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.[0], 'voice_provider_event');
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
