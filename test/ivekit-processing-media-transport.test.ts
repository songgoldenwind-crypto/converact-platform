import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import {
  ProcessingMediaTransport
} from '../src/agent-runtime/ivekit/media-control/processing.js';
import type {
  MediaTransportCommand
} from '../src/agent-runtime/ivekit/media-control/transport.js';

describe('processing MediaTransportPort', () => {
  it('sends the complete fenced command with bounded internal credentials', async () => {
    await withServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/commands');
      assert.equal(request.headers.authorization, 'Bearer processing-token');
      assert.equal(
        request.headers['x-ivekit-client-identity'],
        'media-control-sidecar'
      );
      assert.equal(request.headers['accept-encoding'], 'identity');
      const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
      assert.equal(payload.protocol_version, 'ivekit.processing-control.v1');
      assert.equal(payload.admission_reservation_id, 'admission-a');
      assert.equal(payload.media_reservation_id, 'media-a');
      assert.equal(payload.command_hash, HASH_B);
      json(response, 200, {
        state: 'succeeded',
        command_id: 'command-a',
        transport_session_id: 'processing:media-a',
        effective_sdp: 'v=0\r\n',
        session_state: 'prepared',
        applied_at: '2026-07-28T00:00:00.000Z'
      });
    }, async (endpoint) => {
      const transport = processing(endpoint);
      const outcome = await transport.execute(command());
      assert.deepEqual(outcome, {
        state: 'succeeded',
        command_id: 'command-a',
        transport_session_id: 'processing:media-a',
        effective_sdp: 'v=0\r\n',
        session_state: 'prepared',
        applied_at: '2026-07-28T00:00:00.000Z'
      });
    });
  });

  it('returns unknown when an applied command response exceeds the hard limit', async () => {
    await withServer(async (_request, response) => {
      json(response, 200, {
        state: 'succeeded',
        command_id: 'command-a',
        transport_session_id: 'processing:media-a',
        effective_sdp: 'x'.repeat(8_192),
        session_state: 'prepared',
        applied_at: '2026-07-28T00:00:00.000Z'
      });
    }, async (endpoint) => {
      const transport = processing(endpoint, { max_response_bytes: 1_024 });
      const outcome = await transport.execute(command());
      assert.deepEqual(outcome, {
        state: 'unknown',
        command_id: 'command-a',
        error_code: 'processing_response_too_large',
        retryable: true
      });
    });
  });

  it('preserves an explicit unknown outcome from the processing worker', async () => {
    await withServer(async (_request, response) => {
      json(response, 200, {
        state: 'unknown',
        command_id: 'command-a',
        error_code: 'processing_worker_control_timeout',
        retryable: true
      });
    }, async (endpoint) => {
      const outcome = await processing(endpoint).execute(command());
      assert.deepEqual(outcome, {
        state: 'unknown',
        command_id: 'command-a',
        error_code: 'processing_worker_control_timeout',
        retryable: true
      });
    });
  });

  it('does not follow redirects because the original command may already be applied', async () => {
    let redirected = 0;
    await withServer(async (request, response) => {
      if (request.url === '/redirected') {
        redirected += 1;
        json(response, 200, {});
        return;
      }
      response.writeHead(307, { location: '/redirected' });
      response.end();
    }, async (endpoint) => {
      const transport = processing(endpoint);
      const outcome = await transport.execute(command());
      assert.equal(outcome.state, 'unknown');
      assert.equal(outcome.error_code, 'processing_transport_redirected');
      assert.equal(redirected, 0);
    });
  });

  it('reconciles command outcomes and restores processing sessions', async () => {
    await withServer(async (request, response) => {
      if (request.url === '/v1/reconcile') {
        const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
        assert.deepEqual(payload, {
          protocol_version: 'ivekit.processing-control.v1',
          command_id: 'command-a',
          media_reservation_id: 'media-a',
          owner_epoch: '1',
          command_hash: HASH_B
        });
        json(response, 200, {
          found: true,
          outcome: {
            state: 'succeeded',
            command_id: 'command-a',
            transport_session_id: 'processing:media-a',
            effective_sdp: 'v=0\r\n',
            session_state: 'committed',
            applied_at: '2026-07-28T00:00:01.000Z'
          }
        });
        return;
      }
      if (request.url === '/v1/sessions/media-a') {
        json(response, 200, {
          media_reservation_id: 'media-a',
          call_id: 'call-a',
          owner_epoch: '1',
          last_sequence: 2,
          state: 'committed',
          transport_session_id: 'processing:media-a',
          effective_sdp: 'v=0\r\n',
          expires_at: '2026-07-28T00:05:00.000Z',
          updated_at: '2026-07-28T00:00:01.000Z'
        });
        return;
      }
      json(response, 404, { error: 'not_found' });
    }, async (endpoint) => {
      const transport = processing(endpoint);
      const reconciled = await transport.queryCommand({
        command_id: 'command-a',
        media_reservation_id: 'media-a',
        owner_epoch: '1',
        command_hash: HASH_B
      });
      assert.equal(reconciled.found, true);
      assert(reconciled.found);
      assert.equal(reconciled.outcome.state, 'succeeded');
      assert(
        reconciled.outcome.state === 'succeeded'
      );
      assert.equal(reconciled.outcome.transport_session_id, 'processing:media-a');

      const session = await transport.querySession({
        media_reservation_id: 'media-a',
        call_id: 'call-a'
      });
      assert.equal(session?.state, 'committed');
      assert.equal(session?.from_tag, null);
      assert.equal(session?.to_tag, null);
    });
  });

  it('scans bounded orphan candidates and releases them with the returned fence', async () => {
    let deleteCommands = 0;
    await withServer(async (request, response) => {
      if (request.method === 'GET' &&
          request.url === '/v1/sessions?after=cursor-a&limit=2') {
        json(response, 200, {
          items: [{
            tenant_id: 'tenant-a',
            call_id: 'call-a',
            leg_id: 'leg-a',
            cell_id: 'cell-a',
            owner_node_id: 'node-a',
            owner_epoch: '7',
            admission_reservation_id: 'admission-a',
            media_reservation_id: 'media-a',
            transport_session_id: 'processing:media-a',
            last_sequence: 11,
            expires_at: '2026-07-28T00:05:00.000Z',
            state: 'committed'
          }],
          next_cursor: 'media-a',
          inspected: 2
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/commands') {
        deleteCommands += 1;
        const payload = JSON.parse(
          await requestBody(request)
        ) as Record<string, unknown>;
        assert.equal(payload.action, 'delete');
        assert.equal(payload.tenant_id, 'tenant-a');
        assert.equal(payload.owner_epoch, '7');
        assert.equal(payload.admission_reservation_id, 'admission-a');
        assert.equal(payload.media_reservation_id, 'media-a');
        assert.equal(payload.transport_session_id, 'processing:media-a');
        assert.equal(payload.command_sequence, 12);
        assert.deepEqual(payload.payload, {
          reason: 'orphaned_owner_and_session'
        });
        assert.match(String(payload.payload_hash), /^[a-f0-9]{64}$/);
        assert.match(String(payload.command_hash), /^[a-f0-9]{64}$/);
        json(response, 200, {
          state: 'succeeded',
          command_id: payload.command_id,
          transport_session_id: 'processing:media-a',
          effective_sdp: '',
          session_state: 'closed',
          applied_at: '2026-07-28T00:00:02.000Z'
        });
        return;
      }
      json(response, 404, { error: 'not_found' });
    }, async (endpoint) => {
      const transport = processing(endpoint);
      const page = await transport.scanOrphanCandidates({
        after: 'cursor-a',
        limit: 2
      });
      assert.deepEqual(page, {
        items: [{
          tenant_id: 'tenant-a',
          call_id: 'call-a',
          leg_id: 'leg-a',
          cell_id: 'cell-a',
          owner_node_id: 'node-a',
          owner_epoch: '7',
          media_reservation_id: 'media-a',
          transport_session_id: 'processing:media-a',
          expires_at: '2026-07-28T00:05:00.000Z',
          state: 'committed'
        }],
        next_cursor: 'media-a'
      });
      await transport.releaseSession(
        'processing:media-a',
        'orphaned_owner_and_session'
      );
      await transport.releaseSession(
        'processing:media-a',
        'orphaned_owner_and_session'
      );
      assert.equal(deleteCommands, 1);
    });
  });
});

const HASH_A = '41'.repeat(32);
const HASH_B = '42'.repeat(32);

function command(): MediaTransportCommand {
  return {
    action: 'offer',
    command_id: 'command-a',
    tenant_id: 'tenant-a',
    call_id: 'call-a',
    leg_id: 'leg-a',
    cell_id: 'cell-a',
    owner_node_id: 'node-a',
    owner_epoch: '1',
    admission_reservation_id: 'admission-a',
    media_reservation_id: 'media-a',
    expires_at: '2026-07-28T00:05:00.000Z',
    command_sequence: 1,
    idempotency_key: 'idempotency-a',
    payload_hash: HASH_A,
    command_hash: HASH_B,
    payload: {
      offer_sdp: 'v=0\r\n',
      media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
      leg_a_codec: 'PCMU',
      leg_b_codec: 'OPUS',
      leg_a_payload_type: 0,
      leg_b_payload_type: 111,
      packetization_ms: 20
    }
  };
}

function processing(
  endpoint: string,
  overrides: { max_response_bytes?: number } = {}
): ProcessingMediaTransport {
  return new ProcessingMediaTransport({
    endpoint,
    bearer_token: 'processing-token',
    client_identity: 'media-control-sidecar',
    request_timeout_ms: 1_000,
    max_response_bytes: overrides.max_response_bytes ?? 16 * 1024
  });
}

async function withServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<void>,
  run: (endpoint: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}
