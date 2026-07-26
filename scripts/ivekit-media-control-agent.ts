import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MediaControlAgent
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import {
  createMediaControlHttpServer,
  type MediaControlServerTlsOptions
} from '../src/agent-runtime/ivekit/media-control/http.js';
import {
  MediaControlEventBroker
} from '../src/agent-runtime/ivekit/media-control/events.js';
import {
  MediaCommandJournal
} from '../src/agent-runtime/ivekit/media-control/journal.js';
import {
  RtpengineMediaTransport
} from '../src/agent-runtime/ivekit/media-control/rtpengine.js';
import {
  RtpengineNgClient
} from '../src/agent-runtime/ivekit/media-control/rtpengine-ng.js';
import {
  InMemoryMediaTransport
} from '../src/agent-runtime/ivekit/media-control/simulator.js';
import type {
  MediaTransportPort
} from '../src/agent-runtime/ivekit/media-control/transport.js';
import {
  HttpComponentNodeAdmissionClient,
  type ComponentNodeAdmissionClientTlsOptions
} from '../src/agent-runtime/ivekit/placement/component-node-admission-http.js';

const production = booleanEnv('IVEKIT_MEDIA_CONTROL_PRODUCTION', true);
const requireMtls = booleanEnv(
  'IVEKIT_MEDIA_CONTROL_REQUIRE_MTLS',
  production
);
const transportMode = stringEnv(
  'IVEKIT_MEDIA_CONTROL_TRANSPORT',
  production ? 'rtpengine' : 'simulator'
);
if (transportMode !== 'simulator' && transportMode !== 'rtpengine') {
  throw new Error('IVEKIT media control transport is unsupported');
}
if (production && !requireMtls) {
  throw new Error('IVEKIT media control production mTLS cannot be disabled');
}
if (production && transportMode === 'simulator') {
  throw new Error('IVEKIT media control simulator is not production eligible');
}
const events = new MediaControlEventBroker({
  maxBindings: integerEnv(
    'IVEKIT_MEDIA_CONTROL_EVENT_MAX_BINDINGS',
    100_000,
    1,
    10_000_000
  ),
  maxRetainedEventsPerOwner: integerEnv(
    'IVEKIT_MEDIA_CONTROL_EVENT_REPLAY_CAPACITY',
    4_096,
    1,
    1_000_000
  ),
  maxSubscriptionsPerOwner: integerEnv(
    'IVEKIT_MEDIA_CONTROL_EVENT_MAX_SUBSCRIBERS_PER_OWNER',
    2,
    1,
    16
  )
});
const transportRuntime = await openTransportRuntime(transportMode, events);

const serviceToken = secret(
  'IVEKIT_MEDIA_CONTROL_TOKEN',
  'IVEKIT_MEDIA_CONTROL_TOKEN_FILE'
);
const admissionToken = secret(
  'IVEKIT_MEDIA_CONTROL_ADMISSION_TOKEN',
  'IVEKIT_MEDIA_CONTROL_ADMISSION_TOKEN_FILE'
);
const admissionRequireMtls = booleanEnv(
  'IVEKIT_MEDIA_CONTROL_ADMISSION_REQUIRE_MTLS',
  production
);
if (production && !admissionRequireMtls) {
  throw new Error('IVEKIT media control admission mTLS cannot be disabled');
}
const admission = new HttpComponentNodeAdmissionClient({
  endpoint: requiredEnv('IVEKIT_MEDIA_CONTROL_ADMISSION_ENDPOINT'),
  service_token: admissionToken,
  production: admissionRequireMtls,
  tls: admissionRequireMtls ? admissionTlsOptions() : undefined,
  timeout_ms: integerEnv(
    'IVEKIT_MEDIA_CONTROL_ADMISSION_TIMEOUT_MS',
    2_000,
    100,
    30_000
  )
});
const admissionHealthIntervalMs = integerEnv(
  'IVEKIT_MEDIA_CONTROL_ADMISSION_HEALTH_INTERVAL_MS',
  1_000,
  100,
  60_000
);
let admissionReadyUntil = 0;
async function refreshAdmissionReadiness(): Promise<void> {
  try {
    const state = await admission.readState();
    const ready = state.lease_fresh &&
      !state.recovery_pending &&
      (state.state === 'accepting' || state.state === 'degraded');
    admissionReadyUntil = ready
      ? Date.now() + admissionHealthIntervalMs * 3
      : 0;
  } catch {
    admissionReadyUntil = 0;
  }
}
await refreshAdmissionReadiness();
const admissionHealthTimer = setInterval(() => {
  void refreshAdmissionReadiness();
}, admissionHealthIntervalMs);
admissionHealthTimer.unref();

const agent = new MediaControlAgent({
  authority: {
    async authorize(input) {
      const authorization = await admission.authorize({
        reservation_id: input.media_reservation_id,
        interaction_id: input.call_id,
        owner_epoch: input.owner_epoch,
        operation: input.operation
      });
      return {
        owner_epoch: authorization.owner_epoch,
        reservation_expires_at: authorization.reservation_expires_at,
        node_lease_expires_at: authorization.lease_expires_at
      };
    }
  },
  transport: transportRuntime.transport,
  max_reservations: integerEnv(
    'IVEKIT_MEDIA_CONTROL_MAX_RESERVATIONS',
    100_000,
    1,
    1_000_000
  ),
  max_terminal_reservations: integerEnv(
    'IVEKIT_MEDIA_CONTROL_MAX_TERMINAL_RESERVATIONS',
    100_000,
    1,
    1_000_000
  ),
  max_commands_per_reservation: integerEnv(
    'IVEKIT_MEDIA_CONTROL_MAX_COMMANDS_PER_RESERVATION',
    16,
    4,
    256
  ),
  terminal_retention_ms: integerEnv(
    'IVEKIT_MEDIA_CONTROL_TERMINAL_RETENTION_MS',
    300_000,
    1_000,
    86_400_000
  )
});

const tls = requireMtls ? tlsOptions() : undefined;
const server = createMediaControlHttpServer({
  agent,
  service_token: serviceToken,
  production: requireMtls,
  tls,
  events: events,
  ready: () => Date.now() < admissionReadyUntil,
  max_body_bytes: integerEnv(
    'IVEKIT_MEDIA_CONTROL_MAX_BODY_BYTES',
    262_144,
    1_024,
    1_048_576
  )
});
const host = stringEnv('IVEKIT_MEDIA_CONTROL_HOST', '127.0.0.1');
const port = integerEnv('IVEKIT_MEDIA_CONTROL_PORT', 3_211, 1, 65_535);
const sweepIntervalMs = integerEnv(
  'IVEKIT_MEDIA_CONTROL_SWEEP_INTERVAL_MS',
  1_000,
  100,
  60_000
);
const sweepTimer = setInterval(() => {
  void agent.sweep(new Date()).catch((error) => {
    process.stderr.write(
      `ivekit media control sweep failed: ${safeError(error)}\n`
    );
  });
}, sweepIntervalMs);
sweepTimer.unref();

server.listen(port, host, () => {
  process.stdout.write(
    `ivekit media control agent listening on ${host}:${port} ` +
    `transport=${transportMode} production=${production} mtls=${requireMtls}\n`
  );
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(sweepTimer);
  clearInterval(admissionHealthTimer);
  process.stdout.write(`ivekit media control agent stopping on ${signal}\n`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await transportRuntime.drain().catch((error) => {
    process.stderr.write(
      `ivekit media control drain failed: ${safeError(error)}\n`
    );
  });
  await transportRuntime.close();
  clearTimeout(forced);
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

function tlsOptions(): MediaControlServerTlsOptions {
  return {
    key: readRequiredFile('IVEKIT_MEDIA_CONTROL_TLS_KEY_FILE'),
    cert: readRequiredFile('IVEKIT_MEDIA_CONTROL_TLS_CERT_FILE'),
    ca: readRequiredFile('IVEKIT_MEDIA_CONTROL_TLS_CA_FILE')
  };
}

function admissionTlsOptions(): ComponentNodeAdmissionClientTlsOptions {
  return {
    key: readRequiredFile(
      'IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_KEY_FILE'
    ),
    cert: readRequiredFile(
      'IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_CERT_FILE'
    ),
    ca: readRequiredFile(
      'IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_CA_FILE'
    ),
    servername:
      process.env.IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_SERVERNAME?.trim() ||
      undefined
  };
}

function secret(valueName: string, fileName: string): string {
  const value = process.env[valueName]?.trim();
  const file = process.env[fileName]?.trim();
  if (value && file) {
    throw new Error(`${valueName} and ${fileName} are mutually exclusive`);
  }
  const resolved = value || (file ? readFileSync(file, 'utf8').trim() : '');
  if (resolved.length < 24 || resolved.length > 512 || /[\0\r\n]/.test(resolved)) {
    throw new Error(`${valueName} is invalid`);
  }
  return resolved;
}

function readRequiredFile(name: string): Buffer {
  const path = requiredEnv(name);
  const value = readFileSync(path);
  if (value.length < 1) throw new Error(`${name} is empty`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function integerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]/g, ' ').slice(0, 256);
}

interface TransportRuntime {
  transport: MediaTransportPort;
  drain(): Promise<void>;
  close(): Promise<void>;
}

async function openTransportRuntime(
  mode: string,
  events: MediaControlEventBroker
): Promise<TransportRuntime> {
  if (mode === 'simulator') {
    return {
      transport: new InMemoryMediaTransport(),
      async drain() {},
      async close() {}
    };
  }
  if (mode !== 'rtpengine') {
    throw new Error('IVEKIT media control transport is unsupported');
  }

  const runtimeMode = requiredEnv('IVEKIT_RTPENGINE_RUNTIME_MODE');
  if (runtimeMode !== 'userspace' && runtimeMode !== 'kernel') {
    throw new Error(
      'IVEKIT_RTPENGINE_RUNTIME_MODE must be userspace or kernel'
    );
  }
  const endpoint = rtpengineEndpoint(
    requiredEnv('IVEKIT_RTPENGINE_NG_ENDPOINT')
  );
  const client = new RtpengineNgClient({
    host: endpoint.host,
    port: endpoint.port,
    maxConnections: integerEnv(
      'IVEKIT_RTPENGINE_MAX_CONNECTIONS',
      4,
      1,
      64
    ),
    maxInFlight: integerEnv(
      'IVEKIT_RTPENGINE_MAX_IN_FLIGHT',
      1_024,
      1,
      100_000
    ),
    maxRequestBytes: integerEnv(
      'IVEKIT_RTPENGINE_MAX_REQUEST_BYTES',
      1_048_576,
      64,
      67_108_864
    ),
    maxResponseBytes: integerEnv(
      'IVEKIT_RTPENGINE_MAX_RESPONSE_BYTES',
      1_048_576,
      64,
      67_108_864
    ),
    maxQueuedBytes: integerEnv(
      'IVEKIT_RTPENGINE_MAX_QUEUED_BYTES',
      4_194_304,
      64,
      67_108_864
    ),
    requestTimeoutMs: integerEnv(
      'IVEKIT_RTPENGINE_REQUEST_TIMEOUT_MS',
      2_000,
      1,
      300_000
    ),
    onDtmf: (event) => events.publishRtpengineDtmf(event)
  });
  const journal = await MediaCommandJournal.open({
    path: join(
      requiredEnv('IVEKIT_MEDIA_CONTROL_WAL_DIRECTORY'),
      'media-command.wal'
    ),
    maxRecords: integerEnv(
      'IVEKIT_MEDIA_CONTROL_WAL_MAX_RECORDS',
      1_000_000,
      1,
      10_000_000
    ),
    maxBytes: integerEnv(
      'IVEKIT_MEDIA_CONTROL_WAL_MAX_BYTES',
      268_435_456,
      512,
      17_179_869_184
    ),
    maxRecordBytes: integerEnv(
      'IVEKIT_MEDIA_CONTROL_WAL_MAX_RECORD_BYTES',
      2_097_152,
      256,
      67_108_864
    ),
    terminalRetentionMs: integerEnv(
      'IVEKIT_MEDIA_CONTROL_TERMINAL_RETENTION_MS',
      300_000,
      0,
      2_592_000_000
    )
  });

  try {
    await rtpengineControl(client, 'ivekit status');
    const transport = await RtpengineMediaTransport.open({
      client,
      journal,
      recoveryConcurrency: integerEnv(
        'IVEKIT_RTPENGINE_RECOVERY_CONCURRENCY',
        32,
        1,
        256
      ),
      maxSessions: integerEnv(
        'IVEKIT_RTPENGINE_MAX_SESSIONS',
        100_000,
        1,
        10_000_000
      ),
      maxCommands: integerEnv(
        'IVEKIT_RTPENGINE_MAX_COMMANDS',
        1_600_000,
        1,
        10_000_000
      ),
      terminalRetentionMs: integerEnv(
        'IVEKIT_MEDIA_CONTROL_TERMINAL_RETENTION_MS',
        300_000,
        0,
        2_592_000_000
      )
    });
    return {
      transport,
      async drain() {
        await rtpengineControl(client, 'ivekit drain');
      },
      async close() {
        await transport.close();
      }
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await journal.close().catch(() => undefined);
    throw error;
  }
}

function rtpengineEndpoint(value: string): {
  host: string;
  port: number;
} {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('IVEKIT_RTPENGINE_NG_ENDPOINT is invalid');
  }
  if (endpoint.protocol !== 'tcp:' ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.pathname !== '' && endpoint.pathname !== '/') ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.hostname ||
      !endpoint.port) {
    throw new Error('IVEKIT_RTPENGINE_NG_ENDPOINT is invalid');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('IVEKIT_RTPENGINE_NG_ENDPOINT is invalid');
  }
  return { host: endpoint.hostname, port };
}

async function rtpengineControl(
  client: RtpengineNgClient,
  command: 'ivekit status' | 'ivekit drain'
): Promise<void> {
  const commandId = `runtime-${randomUUID()}`;
  const response = await client.request(
    { command },
    {
      command_id: commandId,
      command_hash: createHash('sha256')
        .update(command, 'utf8')
        .digest('hex')
    }
  );
  const result = response.result;
  const value = Buffer.isBuffer(result)
    ? result.toString('utf8')
    : String(result ?? '');
  if (value !== 'ok') {
    throw new Error(`RTPengine ${command} rejected`);
  }
}
