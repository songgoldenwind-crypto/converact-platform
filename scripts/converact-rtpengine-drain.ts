import { resolveConveractEnv } from '../src/config/converact-env.js';
import { createHash, randomUUID } from 'node:crypto';

import {
  RtpengineNgClient
} from '../src/agent-runtime/converact/media-control/rtpengine-ng.js';

const endpoint = parseEndpoint(
  requiredEnv('CONVERACT_FABRIC_RTPENGINE_NG_ENDPOINT')
);
const client = new RtpengineNgClient({
  host: endpoint.host,
  port: endpoint.port,
  maxConnections: 1,
  maxInFlight: 1,
  maxRequestBytes: 4_096,
  maxResponseBytes: 4_096,
  maxQueuedBytes: 4_096,
  requestTimeoutMs: integerEnv(
    'CONVERACT_FABRIC_RTPENGINE_REQUEST_TIMEOUT_MS',
    2_000,
    1,
    30_000
  )
});

try {
  const command = 'ivekit drain';
  const commandId = `prestop-${randomUUID()}`;
  const response = await client.request(
    { command },
    {
      command_id: commandId,
      command_hash: createHash('sha256')
        .update(command, 'utf8')
        .digest('hex')
    }
  );
  const result = Buffer.isBuffer(response.result)
    ? response.result.toString('utf8')
    : String(response.result ?? '');
  if (result !== 'ok') throw new Error('RTPengine drain rejected');
} finally {
  await client.close();
}

function parseEndpoint(value: string): {
  host: string;
  port: number;
} {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('CONVERACT_FABRIC_RTPENGINE_NG_ENDPOINT is invalid');
  }
  if (endpoint.protocol !== 'tcp:' ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.pathname !== '' && endpoint.pathname !== '/') ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.hostname ||
      !endpoint.port) {
    throw new Error('CONVERACT_FABRIC_RTPENGINE_NG_ENDPOINT is invalid');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CONVERACT_FABRIC_RTPENGINE_NG_ENDPOINT is invalid');
  }
  return { host: endpoint.hostname, port };
}

function requiredEnv(name: string): string {
  const value = resolveConveractEnv(process.env, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = resolveConveractEnv(process.env, name)?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
