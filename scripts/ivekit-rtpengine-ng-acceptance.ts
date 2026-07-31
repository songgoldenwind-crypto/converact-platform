import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { RtpengineNgClient } from '../src/agent-runtime/converact/media-control/rtpengine-ng.js';

const host = String(process.env.IVEKIT_RTPENGINE_NG_HOST || '').trim();
const port = boundedInteger(
  process.env.IVEKIT_RTPENGINE_NG_PORT,
  1,
  65_535,
  'IVEKIT_RTPENGINE_NG_PORT'
);
const requestCount = boundedInteger(
  process.env.IVEKIT_RTPENGINE_NG_REQUESTS || '32',
  1,
  10_000,
  'IVEKIT_RTPENGINE_NG_REQUESTS'
);
if (!host) throw new Error('IVEKIT_RTPENGINE_NG_HOST is required');

const client = new RtpengineNgClient({
  host,
  port,
  maxConnections: Math.min(4, requestCount),
  maxInFlight: requestCount,
  requestTimeoutMs: 5_000,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 64 * 1024,
  maxQueuedBytes: 1024 * 1024
});
const startedAt = new Date();
const started = performance.now();

try {
  const responses = await Promise.all(
    Array.from({ length: requestCount }, (_, index) => {
      const commandId = `acceptance-ping-${index}`;
      return client.request(
        { command: 'ping' },
        {
          command_id: commandId,
          command_hash: createHash('sha256').update(commandId).digest('hex')
        }
      );
    })
  );
  for (const response of responses) {
    assert.ok(Buffer.isBuffer(response.result));
    assert.equal(response.result.toString('ascii'), 'pong');
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: 'ivekit.rtpengine-ng-acceptance.v1',
    host,
    port,
    requests: requestCount,
    succeeded: responses.length,
    failed: 0,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString()
  })}\n`);
} finally {
  await client.close();
}

function boundedInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  name: string
): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
