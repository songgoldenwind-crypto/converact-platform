import { readFileSync } from 'node:fs';

import {
  MediaControlAgent
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import {
  createMediaControlHttpServer,
  type MediaControlServerTlsOptions
} from '../src/agent-runtime/ivekit/media-control/http.js';
import {
  InMemoryMediaTransport
} from '../src/agent-runtime/ivekit/media-control/simulator.js';
import {
  HttpComponentNodeAdmissionClient
} from '../src/agent-runtime/ivekit/placement/component-node-admission-http.js';

const production = booleanEnv('IVEKIT_MEDIA_CONTROL_PRODUCTION', true);
const requireMtls = booleanEnv(
  'IVEKIT_MEDIA_CONTROL_REQUIRE_MTLS',
  production
);
const requireProductionTransport = booleanEnv(
  'IVEKIT_MEDIA_CONTROL_REQUIRE_PRODUCTION_TRANSPORT',
  production
);
const transportMode = stringEnv(
  'IVEKIT_MEDIA_CONTROL_TRANSPORT',
  'simulator'
);
if (transportMode !== 'simulator') {
  throw new Error('IVEKIT media control transport is unsupported');
}
if (production && !requireMtls) {
  throw new Error('IVEKIT media control production mTLS cannot be disabled');
}
if (requireProductionTransport) {
  throw new Error('IVEKIT media control simulator is not production eligible');
}

const serviceToken = secret(
  'IVEKIT_MEDIA_CONTROL_TOKEN',
  'IVEKIT_MEDIA_CONTROL_TOKEN_FILE'
);
const admissionToken = secret(
  'IVEKIT_MEDIA_CONTROL_ADMISSION_TOKEN',
  'IVEKIT_MEDIA_CONTROL_ADMISSION_TOKEN_FILE'
);
const admission = new HttpComponentNodeAdmissionClient({
  endpoint: requiredEnv('IVEKIT_MEDIA_CONTROL_ADMISSION_ENDPOINT'),
  service_token: admissionToken,
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
    await admission.readState();
    admissionReadyUntil = Date.now() + admissionHealthIntervalMs * 3;
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
      const authorization = await admission.authorize(input);
      return {
        owner_epoch: authorization.owner_epoch,
        reservation_expires_at: authorization.reservation_expires_at,
        node_lease_expires_at: authorization.lease_expires_at
      };
    }
  },
  transport: new InMemoryMediaTransport(),
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
    `transport=${transportMode} production=${production} ` +
    `mtls=${requireMtls} production_transport=${requireProductionTransport}\n`
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
