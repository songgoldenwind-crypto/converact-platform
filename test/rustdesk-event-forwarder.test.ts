import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskEventForwarderConfigFromEnv,
  forwardRustDeskEvents,
  writeRustDeskEventTemplate
} from '../scripts/rustdesk-event-forwarder.js';

test('rustdesk event forwarder config validates control-plane inputs', () => {
  const config = createRustDeskEventForwarderConfigFromEnv({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
    CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: 'rdgw_123',
    CONVERACT_RUSTDESK_EVENT_TYPE: 'remote.rustdesk.control_action.performed',
    CONVERACT_RUSTDESK_EVENT_ACTOR_IDENTITY: 'rustdesk-edge-agent',
    CONVERACT_RUSTDESK_EVENT_TARGET: '123456789',
    CONVERACT_RUSTDESK_EVENT_IDEMPOTENCY_KEY: 'control-action-1',
    CONVERACT_RUSTDESK_EVENT_METADATA_JSON: '{"operation_id":"operation-1","action":"mouse_click","permission":"control_mouse_keyboard","button":"left"}',
    CONVERACT_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE: '/var/tmp/opc-rustdesk-failed.jsonl',
    CONVERACT_RUSTDESK_EVENT_REPLAY_REMAINING_FILE: '/var/tmp/opc-rustdesk-remaining.jsonl'
  });

  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiToken, 'rustdesk-token');
  assert.equal(config.defaultExternalId, 'rdgw_123');
  assert.equal(config.defaultActorIdentity, 'rustdesk-edge-agent');
  assert.equal(config.replayDeadLetterFile, '/var/tmp/opc-rustdesk-failed.jsonl');
  assert.equal(config.replayRemainingFile, '/var/tmp/opc-rustdesk-remaining.jsonl');
  assert.deepEqual(config.inlineEvent, {
    external_id: 'rdgw_123',
    event_type: 'remote.rustdesk.control_action.performed',
    actor_identity: 'rustdesk-edge-agent',
    target: '123456789',
    idempotency_key: 'control-action-1',
    metadata: {
      operation_id: 'operation-1',
      action: 'mouse_click',
      permission: 'control_mouse_keyboard',
      button: 'left'
    }
  });

  assert.throws(
    () => createRustDeskEventForwarderConfigFromEnv({}),
    /CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL or CONVERACT_REMOTE_GATEWAY_BASE_URL is required/
  );
  assert.throws(
    () =>
      createRustDeskEventForwarderConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_RUSTDESK_EVENT_TYPE: 'remote.rustdesk.recording.started'
      }),
    /CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID is required/
  );
  assert.throws(
    () =>
      createRustDeskEventForwarderConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: 'rdgw_123',
        CONVERACT_RUSTDESK_EVENT_TYPE: 'remote.rustdesk.custom',
        CONVERACT_RUSTDESK_EVENT_METADATA_JSON: '[]'
      }),
    /CONVERACT_RUSTDESK_EVENT_METADATA_JSON must be a JSON object/
  );
  assert.throws(
    () =>
      createRustDeskEventForwarderConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: 'rdgw_123',
        CONVERACT_RUSTDESK_EVENT_RETRY_ATTEMPTS: 'many'
      }),
    /CONVERACT_RUSTDESK_EVENT_RETRY_ATTEMPTS must be a non-negative integer/
  );
  assert.throws(
    () =>
      createRustDeskEventForwarderConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: 'rdgw_123',
        CONVERACT_RUSTDESK_EVENT_RETRY_DELAY_MS: '-1'
      }),
    /CONVERACT_RUSTDESK_EVENT_RETRY_DELAY_MS must be a non-negative integer/
  );
  assert.throws(
    () =>
      createRustDeskEventForwarderConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'ftp://opc.example.com',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: 'rdgw_123'
      }),
    /CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL must use http\(s\)/
  );
  assert.throws(
    () =>
      createRustDeskEventForwarderConfigFromEnv({
        CONVERACT_REMOTE_GATEWAY_BASE_URL: 'rustdesk://opc.example.com',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: 'rdgw_123'
      }),
    /CONVERACT_REMOTE_GATEWAY_BASE_URL must use http\(s\)/
  );
});

test('rustdesk event forwarder replay config does not require a default external id', () => {
  const config = createRustDeskEventForwarderConfigFromEnv({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
    CONVERACT_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE: '/var/tmp/opc-rustdesk-failed.jsonl',
    CONVERACT_RUSTDESK_EVENT_REPLAY_REMAINING_FILE: '/var/tmp/opc-rustdesk-remaining.jsonl'
  });

  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiToken, 'rustdesk-token');
  assert.equal(config.defaultExternalId, '');
  assert.equal(config.replayDeadLetterFile, '/var/tmp/opc-rustdesk-failed.jsonl');
  assert.equal(config.replayRemainingFile, '/var/tmp/opc-rustdesk-remaining.jsonl');
  assert.equal(config.inlineEvent, undefined);
});

test('rustdesk event forwarder validate-only config does not require network credentials', () => {
  const config = createRustDeskEventForwarderConfigFromEnv({
    CONVERACT_RUSTDESK_EVENT_VALIDATE_ONLY: '1',
    CONVERACT_RUSTDESK_EVENT_FILE: '/var/tmp/opc-rustdesk-events.jsonl'
  });

  assert.equal(config.validateOnly, true);
  assert.equal(config.baseUrl, '');
  assert.equal(config.apiToken, '');
  assert.equal(config.defaultExternalId, '');
  assert.equal(config.eventFile, '/var/tmp/opc-rustdesk-events.jsonl');
});

test('rustdesk event forwarder template config does not require network credentials', () => {
  const config = createRustDeskEventForwarderConfigFromEnv({
    CONVERACT_RUSTDESK_EVENT_TEMPLATE_FILE: '/var/tmp/opc-rustdesk-events-template.jsonl'
  });

  assert.equal(config.templateFile, '/var/tmp/opc-rustdesk-events-template.jsonl');
  assert.equal(config.baseUrl, '');
  assert.equal(config.apiToken, '');
});

test('rustdesk event forwarder posts an inline operation event', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown>; authorization: string }> = [];
  const result = await forwardRustDeskEvents(
    {
      baseUrl: 'https://opc.example.com',
      apiToken: 'rustdesk-token',
      defaultExternalId: 'rdgw_inline_1',
      defaultActorIdentity: 'rustdesk-edge-agent',
      inlineEvent: {
        external_id: 'rdgw_inline_1',
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'rustdesk-edge-agent',
        target: '123456789',
        idempotency_key: 'recording-started-1',
        metadata: { recording_id: 'egress-1', evidence_type: 'screen_recording' },
        occurred_at: '2026-07-04T12:00:00.000Z'
      }
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({
        method: init.method || 'GET',
        path: url.pathname,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
        authorization: String((init.headers as Record<string, string>)?.authorization || '')
      });
      return jsonResponse(201, {
        event: {
          event_type: 'remote.rustdesk.recording.started',
          metadata: {
            recording_id: 'egress-1',
            evidence_type: 'screen_recording',
            idempotency_key: 'recording-started-1'
          }
        }
      });
    }
  );

  assert.deepEqual(result, {
    forwarded: 1,
    events: ['remote.rustdesk.recording.started']
  });
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/api/opc/rustdesk/sessions/rdgw_inline_1/events');
  assert.equal(calls[0]?.authorization, 'Bearer rustdesk-token');
  assert.deepEqual(calls[0]?.body, {
    event_type: 'remote.rustdesk.recording.started',
    actor_identity: 'rustdesk-edge-agent',
    target: '123456789',
    idempotency_key: 'recording-started-1',
    metadata: { recording_id: 'egress-1', evidence_type: 'screen_recording' },
    occurred_at: '2026-07-04T12:00:00.000Z'
  });
});

test('rustdesk event forwarder retries transient failures before posting succeeds', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await forwardRustDeskEvents(
    {
      baseUrl: 'https://opc.example.com',
      apiToken: 'rustdesk-token',
      defaultExternalId: 'rdgw_retry_1',
      defaultActorIdentity: 'rustdesk-edge-agent',
      retryAttempts: 2,
      retryDelayMs: 25,
      inlineEvent: {
        event_type: 'remote.rustdesk.recording.started',
        metadata: { recording_id: 'egress-retry-1', evidence_type: 'screen_recording' }
      }
    },
    async () => {
      attempts += 1;
      return attempts < 3
        ? jsonResponse(503, { error: 'temporarily unavailable' })
        : jsonResponse(201, { event: { event_type: 'remote.rustdesk.recording.started' } });
    },
    async (delayMs) => {
      delays.push(delayMs);
    }
  );

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 25]);
  assert.deepEqual(result, {
    forwarded: 1,
    events: ['remote.rustdesk.recording.started']
  });
});

test('rustdesk event forwarder does not retry non-transient control-plane failures', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: 'https://opc.example.com',
          apiToken: 'rustdesk-token',
          defaultExternalId: 'rdgw_auth_1',
          defaultActorIdentity: 'rustdesk-edge-agent',
          retryAttempts: 3,
          retryDelayMs: 0,
          inlineEvent: {
            event_type: 'remote.rustdesk.recording.started',
            metadata: { recording_id: 'egress-auth-1', evidence_type: 'screen_recording' }
          }
        },
        async () => {
          attempts += 1;
          return jsonResponse(401, { error: 'invalid token' });
        }
      ),
    /RustDesk event forward failed: remote.rustdesk.recording.started 401 invalid token/
  );
  assert.equal(attempts, 1);
});

test('rustdesk event forwarder writes failed events to a dead letter file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-dead-letter-'));
  const deadLetterFile = join(dir, 'failed-events.jsonl');
  let attempts = 0;

  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: 'https://opc.example.com',
          apiToken: 'rustdesk-token',
          defaultExternalId: 'rdgw_dead_letter_1',
          defaultActorIdentity: 'rustdesk-edge-agent',
          retryAttempts: 1,
          retryDelayMs: 0,
          deadLetterFile,
          inlineEvent: {
            event_type: 'remote.rustdesk.recording.started',
            target: '123456789',
            metadata: { recording_id: 'egress-dead-letter-1', evidence_type: 'screen_recording' }
          }
        },
        async () => {
          attempts += 1;
          return jsonResponse(503, { error: 'temporarily unavailable' });
        },
        async () => {}
      ),
    /RustDesk event forward failed: remote.rustdesk.recording.started 503 temporarily unavailable/
  );

  assert.equal(attempts, 2);
  const rows = readFileSync(deadLetterFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
    error: string;
    attempts: number;
    event: Record<string, unknown>;
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.error, 'RustDesk event forward failed: remote.rustdesk.recording.started 503 temporarily unavailable');
  assert.equal(rows[0]?.attempts, 2);
  assert.match(String(rows[0]?.event.failed_at || ''), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rows[0]?.event, {
    external_id: 'rdgw_dead_letter_1',
    event_type: 'remote.rustdesk.recording.started',
    actor_identity: 'rustdesk-edge-agent',
    target: '123456789',
    idempotency_key: 'rustdesk-event:recording:egress-dead-letter-1',
    metadata: { recording_id: 'egress-dead-letter-1', evidence_type: 'screen_recording' },
    failed_at: rows[0]?.event.failed_at
  });
});

test('rustdesk event forwarder replays dead letter events and writes remaining failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-dead-letter-replay-'));
  const replayFile = join(dir, 'failed-events.jsonl');
  const remainingFile = join(dir, 'remaining-events.jsonl');
  writeFileSync(replayFile, [
    JSON.stringify({
      error: 'previous outage',
      attempts: 2,
      event: {
        external_id: 'rdgw_replay_ok',
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'recording-agent',
        idempotency_key: 'recording-replay-ok',
        metadata: { recording_id: 'egress-replay-ok', evidence_type: 'screen_recording' },
        failed_at: '2026-07-04T01:00:00.000Z'
      }
    }),
    JSON.stringify({
      error: 'previous outage',
      attempts: 2,
      event: {
        external_id: 'rdgw_replay_fail',
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'file-agent',
        target: '123456789',
        idempotency_key: 'file-replay-fail',
        metadata: { transfer_id: 'transfer-replay-fail', direction: 'download' },
        failed_at: '2026-07-04T01:01:00.000Z'
      }
    })
  ].join('\n'));
  const calls: string[] = [];

  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: 'https://opc.example.com',
          apiToken: 'rustdesk-token',
          defaultExternalId: 'unused-default',
          defaultActorIdentity: 'rustdesk-event-forwarder',
          retryAttempts: 0,
          retryDelayMs: 0,
          replayDeadLetterFile: replayFile,
          replayRemainingFile: remainingFile
        },
        async (input) => {
          const path = new URL(String(input)).pathname;
          calls.push(path);
          return path.includes('rdgw_replay_ok')
            ? jsonResponse(201, { event: { event_type: 'remote.rustdesk.recording.started' } })
            : jsonResponse(503, { error: 'still down' });
        }
      ),
    /RustDesk dead-letter replay failed: 1 of 2 events/
  );

  assert.deepEqual(calls, [
    '/api/opc/rustdesk/sessions/rdgw_replay_ok/events',
    '/api/opc/rustdesk/sessions/rdgw_replay_fail/events'
  ]);
  const remainingRows = readFileSync(remainingFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
    error: string;
    attempts: number;
    event: Record<string, unknown>;
  });
  assert.equal(remainingRows.length, 1);
  assert.equal(remainingRows[0]?.error, 'RustDesk event forward failed: remote.rustdesk.file_transfer.started 503 still down');
  assert.equal(remainingRows[0]?.attempts, 3);
  assert.match(String(remainingRows[0]?.event.failed_at || ''), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(remainingRows[0]?.event, {
    external_id: 'rdgw_replay_fail',
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'file-agent',
    target: '123456789',
    idempotency_key: 'file-replay-fail',
    metadata: { transfer_id: 'transfer-replay-fail', direction: 'download' },
    failed_at: remainingRows[0]?.event.failed_at
  });
});

test('rustdesk event forwarder counts local validation failures as replay attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-dead-letter-invalid-'));
  const replayFile = join(dir, 'failed-events.jsonl');
  const remainingFile = join(dir, 'remaining-events.jsonl');
  writeFileSync(replayFile, JSON.stringify({
    error: 'previous validation failure',
    attempts: 4,
    event: {
      external_id: 'rdgw_replay_invalid',
      event_type: 'remote.rustdesk.recording.started',
      actor_identity: 'recording-agent',
      idempotency_key: 'recording-replay-invalid',
      metadata: { recording_id: 'egress-replay-invalid' },
      failed_at: '2026-07-04T02:00:00.000Z'
    }
  }));
  let called = false;

  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: 'https://opc.example.com',
          apiToken: 'rustdesk-token',
          defaultExternalId: 'unused-default',
          defaultActorIdentity: 'rustdesk-event-forwarder',
          replayDeadLetterFile: replayFile,
          replayRemainingFile: remainingFile
        },
        async () => {
          called = true;
          return jsonResponse(201, {});
        }
      ),
    /RustDesk dead-letter replay failed: 1 of 1 events/
  );

  assert.equal(called, false);
  const remainingRow = JSON.parse(readFileSync(remainingFile, 'utf8').trim()) as {
    error: string;
    attempts: number;
    event: Record<string, unknown>;
  };
  assert.equal(remainingRow.error, 'RustDesk recording event metadata.evidence_type is required');
  assert.equal(remainingRow.attempts, 5);
  assert.deepEqual(remainingRow.event, {
    external_id: 'rdgw_replay_invalid',
    event_type: 'remote.rustdesk.recording.started',
    actor_identity: 'recording-agent',
    idempotency_key: 'recording-replay-invalid',
    metadata: { recording_id: 'egress-replay-invalid' },
    failed_at: remainingRow.event.failed_at
  });
});

test('rustdesk event forwarder rejects known operation events with incomplete metadata before posting', async () => {
  let called = false;
  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: 'https://opc.example.com',
          apiToken: 'rustdesk-token',
          defaultExternalId: 'rdgw_inline_1',
          defaultActorIdentity: 'rustdesk-edge-agent',
          inlineEvent: {
            event_type: 'remote.rustdesk.control_action.performed',
            metadata: {
              action: 'mouse_click',
              permission: 'control_mouse_keyboard'
            }
          }
        },
        async () => {
          called = true;
          return jsonResponse(201, {});
        }
      ),
    /RustDesk control action event metadata.operation_id is required/
  );
  assert.equal(called, false);
});

test('rustdesk event forwarder rejects non-object event metadata before posting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-events-invalid-metadata-'));
  const filePath = join(dir, 'events.jsonl');
  writeFileSync(filePath, JSON.stringify({
    event_type: 'remote.rustdesk.custom',
    metadata: ['not-an-object']
  }));
  let called = false;

  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: 'https://opc.example.com',
          apiToken: 'rustdesk-token',
          defaultExternalId: 'rdgw_invalid_metadata',
          defaultActorIdentity: 'rustdesk-edge-agent',
          eventFile: filePath
        },
        async () => {
          called = true;
          return jsonResponse(201, {});
        }
      ),
    /RustDesk event metadata must be a JSON object/
  );
  assert.equal(called, false);
});

test('rustdesk event forwarder reports malformed event jsonl line numbers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-events-malformed-'));
  const filePath = join(dir, 'events.jsonl');
  writeFileSync(filePath, [
    JSON.stringify({
      event_type: 'remote.rustdesk.recording.started',
      metadata: { recording_id: 'recording-ok', evidence_type: 'screen_recording' }
    }),
    '{bad-json'
  ].join('\n'));

  await assert.rejects(
    () =>
      forwardRustDeskEvents({
        baseUrl: 'https://opc.example.com',
        apiToken: 'rustdesk-token',
        defaultExternalId: 'rdgw_malformed',
        defaultActorIdentity: 'rustdesk-edge-agent',
        eventFile: filePath
      }),
    new RegExp(`CONVERACT_RUSTDESK_EVENT_FILE invalid JSON at ${escapeRegExp(filePath)}:2`)
  );
});

test('rustdesk event forwarder reports malformed replay jsonl line numbers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-replay-malformed-'));
  const replayFile = join(dir, 'failed-events.jsonl');
  writeFileSync(replayFile, [
    JSON.stringify({
      attempts: 1,
      event: {
        external_id: 'rdgw_replay_ok',
        event_type: 'remote.rustdesk.recording.started',
        metadata: { recording_id: 'recording-ok', evidence_type: 'screen_recording' }
      }
    }),
    '{bad-json'
  ].join('\n'));

  await assert.rejects(
    () =>
      forwardRustDeskEvents({
        baseUrl: 'https://opc.example.com',
        apiToken: 'rustdesk-token',
        defaultExternalId: '',
        defaultActorIdentity: 'rustdesk-edge-agent',
        replayDeadLetterFile: replayFile
      }),
    new RegExp(`CONVERACT_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE invalid JSON at ${escapeRegExp(replayFile)}:2`)
  );
});

test('rustdesk event forwarder reports invalid replay attempts line numbers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-replay-attempts-'));
  const replayFile = join(dir, 'failed-events.jsonl');
  writeFileSync(replayFile, JSON.stringify({
    attempts: 'many',
    event: {
      external_id: 'rdgw_replay_attempts',
      event_type: 'remote.rustdesk.recording.started',
      metadata: { recording_id: 'recording-attempts', evidence_type: 'screen_recording' }
    }
  }));

  await assert.rejects(
    () =>
      forwardRustDeskEvents({
        baseUrl: 'https://opc.example.com',
        apiToken: 'rustdesk-token',
        defaultExternalId: '',
        defaultActorIdentity: 'rustdesk-edge-agent',
        replayDeadLetterFile: replayFile
      }),
    new RegExp(`CONVERACT_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE attempts must be a non-negative integer at ${escapeRegExp(replayFile)}:1`)
  );
});

test('rustdesk event forwarder derives idempotency keys for known operation events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-events-derived-keys-'));
  const filePath = join(dir, 'events.jsonl');
  writeFileSync(filePath, [
    JSON.stringify({
      event_type: 'remote.rustdesk.control_action.performed',
      metadata: {
        operation_id: 'operation-derived-1',
        action: 'mouse_click',
        permission: 'control_mouse_keyboard'
      }
    }),
    JSON.stringify({
      event_type: 'remote.rustdesk.file_transfer.started',
      metadata: { transfer_id: 'transfer-derived-1' }
    }),
    JSON.stringify({
      event_type: 'remote.rustdesk.file_transfer.completed',
      metadata: { transfer_id: 'transfer-derived-1', status: 'completed' }
    }),
    JSON.stringify({
      event_type: 'remote.rustdesk.recording.started',
      metadata: { recording_id: 'recording-derived-1', evidence_type: 'screen_recording' }
    }),
    JSON.stringify({
      event_type: 'remote.rustdesk.recording.stopped',
      metadata: { recording_id: 'recording-derived-1', evidence_type: 'screen_recording' }
    }),
    JSON.stringify({
      event_type: 'remote.rustdesk.clipboard.synced',
      metadata: { clipboard_id: 'clipboard-derived-1', direction: 'agent_to_device' }
    })
  ].join('\n'));
  const bodies: Record<string, unknown>[] = [];

  await forwardRustDeskEvents(
    {
      baseUrl: 'https://opc.example.com',
      apiToken: 'rustdesk-token',
      defaultExternalId: 'rdgw_derived_keys',
      defaultActorIdentity: 'rustdesk-edge-agent',
      eventFile: filePath
    },
    async (_input, init = {}) => {
      bodies.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>);
      return jsonResponse(201, { event: { event_type: bodies.at(-1)?.event_type } });
    }
  );

  assert.deepEqual(bodies.map((body) => body.idempotency_key), [
    'rustdesk-event:control-action:operation-derived-1',
    'rustdesk-event:file-transfer:transfer-derived-1',
    'rustdesk-event:file-transfer:transfer-derived-1',
    'rustdesk-event:recording:recording-derived-1',
    'rustdesk-event:recording:recording-derived-1',
    'rustdesk-event:clipboard:clipboard-derived-1'
  ]);
});

test('rustdesk event forwarder validate-only validates jsonl events without posting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-events-validate-only-'));
  const filePath = join(dir, 'events.jsonl');
  writeFileSync(filePath, [
    JSON.stringify({
      external_id: 'rdgw_validate_1',
      event_type: 'remote.rustdesk.control_action.performed',
      metadata: {
        operation_id: 'operation-validate-1',
        action: 'mouse_click',
        permission: 'control_mouse_keyboard'
      }
    }),
    JSON.stringify({
      external_id: 'rdgw_validate_1',
      event_type: 'remote.rustdesk.file_transfer.completed',
      metadata: { transfer_id: 'transfer-validate-1', direction: 'download' }
    })
  ].join('\n'));
  let called = false;

  const result = await forwardRustDeskEvents(
    {
      baseUrl: '',
      apiToken: '',
      defaultExternalId: '',
      defaultActorIdentity: 'rustdesk-event-forwarder',
      validateOnly: true,
      eventFile: filePath
    },
    async () => {
      called = true;
      return jsonResponse(201, {});
    }
  );

  assert.equal(called, false);
  assert.deepEqual(result, {
    forwarded: 0,
    validated: 2,
    mode: 'validate-only',
    events: [
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.completed'
    ]
  });
});

test('rustdesk event forwarder validate-only rejects invalid replay events before posting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-replay-validate-only-'));
  const replayFile = join(dir, 'failed-events.jsonl');
  writeFileSync(replayFile, JSON.stringify({
    attempts: 2,
    event: {
      external_id: 'rdgw_validate_invalid',
      event_type: 'remote.rustdesk.clipboard.synced',
      metadata: { clipboard_id: 'clipboard-invalid', direction: 'bad-direction' }
    }
  }));
  let called = false;

  await assert.rejects(
    () =>
      forwardRustDeskEvents(
        {
          baseUrl: '',
          apiToken: '',
          defaultExternalId: '',
          defaultActorIdentity: 'rustdesk-event-forwarder',
          validateOnly: true,
          replayDeadLetterFile: replayFile
        },
        async () => {
          called = true;
          return jsonResponse(201, {});
        }
      ),
    /RustDesk clipboard event metadata.direction must be one of agent_to_device, device_to_agent/
  );
  assert.equal(called, false);
});

test('rustdesk event forwarder writes a reusable operation event jsonl template', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-event-template-'));
  const templateFile = join(dir, 'events-template.jsonl');

  const result = writeRustDeskEventTemplate({
    baseUrl: '',
    apiToken: '',
    defaultExternalId: 'rdgw_template_1',
    defaultActorIdentity: 'rustdesk-event-template',
    templateFile,
    templateTarget: '123456789',
    templateOccurredAt: '2026-07-06T00:00:00.000Z'
  });

  const rows = readFileSync(templateFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
    external_id: string;
    event_type: string;
    actor_identity: string;
    target: string;
    metadata: Record<string, unknown>;
    occurred_at: string;
  });
  assert.deepEqual(result, {
    forwarded: 0,
    generated: 6,
    mode: 'template',
    events: [
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.file_transfer.completed',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.recording.stopped',
      'remote.rustdesk.clipboard.synced'
    ]
  });
  assert.deepEqual(rows.map((row) => row.event_type), result.events);
  assert.equal(rows.every((row) => row.external_id === 'rdgw_template_1'), true);
  assert.equal(rows.every((row) => row.actor_identity === 'rustdesk-event-template'), true);
  assert.equal(rows.every((row) => row.target === '123456789'), true);
  assert.equal(rows.every((row) => row.occurred_at === '2026-07-06T00:00:00.000Z'), true);
  assert.equal(rows[0]?.metadata.operation_id, 'operation-example-1');
  assert.equal(rows[1]?.metadata.transfer_id, 'transfer-example-1');
  assert.equal(rows[3]?.metadata.recording_id, 'recording-example-1');
  assert.equal(rows[5]?.metadata.clipboard_id, 'clipboard-example-1');

  const validation = await forwardRustDeskEvents({
    baseUrl: '',
    apiToken: '',
    defaultExternalId: '',
    defaultActorIdentity: 'rustdesk-event-forwarder',
    validateOnly: true,
    eventFile: templateFile
  });
  assert.equal(validation.validated, 6);
});

test('rustdesk event forwarder posts every event from a jsonl file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-events-'));
  const filePath = join(dir, 'events.jsonl');
  writeFileSync(filePath, [
    JSON.stringify({
      event_type: 'remote.rustdesk.control_action.performed',
      target: '123456789',
      idempotency_key: 'control-1',
      metadata: {
        operation_id: 'operation-jsonl-1',
        action: 'mouse_click',
        permission: 'control_mouse_keyboard'
      }
    }),
    JSON.stringify({
      external_id: 'rdgw_jsonl_2',
      event_type: 'remote.rustdesk.file_transfer.started',
      actor_identity: 'file-agent',
      target: '123456789',
      idempotency_key: 'file-1',
      metadata: { transfer_id: 'transfer-1', direction: 'upload' }
    })
  ].join('\n'));
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];

  const result = await forwardRustDeskEvents(
    {
      baseUrl: 'https://opc.example.com',
      apiToken: 'rustdesk-token',
      defaultExternalId: 'rdgw_jsonl_1',
      defaultActorIdentity: 'rustdesk-edge-agent',
      eventFile: filePath
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      });
      return jsonResponse(201, { event: { event_type: calls.at(-1)?.body.event_type } });
    }
  );

  assert.deepEqual(result, {
    forwarded: 2,
    events: [
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.started'
    ]
  });
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/opc/rustdesk/sessions/rdgw_jsonl_1/events',
    '/api/opc/rustdesk/sessions/rdgw_jsonl_2/events'
  ]);
  assert.equal(calls[0]?.body.actor_identity, 'rustdesk-edge-agent');
  assert.equal(calls[1]?.body.actor_identity, 'file-agent');
});

test('rustdesk event forwarder is wired into scripts and env examples', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:event-forwarder'], 'tsx scripts/rustdesk-event-forwarder.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of [
    'CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID=',
    'CONVERACT_RUSTDESK_EVENT_TYPE=',
    'CONVERACT_RUSTDESK_EVENT_ACTOR_IDENTITY=',
    'CONVERACT_RUSTDESK_EVENT_TARGET=',
    'CONVERACT_RUSTDESK_EVENT_IDEMPOTENCY_KEY=',
    'CONVERACT_RUSTDESK_EVENT_METADATA_JSON=',
    'CONVERACT_RUSTDESK_EVENT_FILE=',
    'CONVERACT_RUSTDESK_EVENT_VALIDATE_ONLY=',
    'CONVERACT_RUSTDESK_EVENT_TEMPLATE_FILE=',
    'CONVERACT_RUSTDESK_EVENT_TEMPLATE_TARGET=',
    'CONVERACT_RUSTDESK_EVENT_TEMPLATE_OCCURRED_AT=',
    'CONVERACT_RUSTDESK_EVENT_RETRY_ATTEMPTS=',
    'CONVERACT_RUSTDESK_EVENT_RETRY_DELAY_MS=',
    'CONVERACT_RUSTDESK_EVENT_DEAD_LETTER_FILE=',
    'CONVERACT_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE=',
    'CONVERACT_RUSTDESK_EVENT_REPLAY_REMAINING_FILE='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
