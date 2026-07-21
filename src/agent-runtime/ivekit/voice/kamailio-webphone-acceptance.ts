import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import WebSocket from 'ws';

export interface KamailioWebPhoneRegisterProbeInput {
  endpoint: string;
  token: string;
  origin: string;
  identity: string;
  realm: string;
  register_expires_seconds: number;
  refresh_delay_ms: number;
  timeout_ms: number;
  allow_insecure_ws?: boolean;
}

export interface KamailioWebPhoneRegisterProbeResult {
  status: 'passed';
  register_status: 200;
  refresh_status: 200;
  unregister_status: 200;
  refresh_delay_ms: number;
}

export async function runKamailioWebPhoneRegisterProbe(
  input: KamailioWebPhoneRegisterProbeInput
): Promise<KamailioWebPhoneRegisterProbeResult> {
  const config = validateInput(input);
  const endpoint = new URL(config.endpoint);
  endpoint.searchParams.set('token', config.token);
  const socket = new WebSocket(endpoint, 'sip', {
    origin: config.origin,
    handshakeTimeout: config.timeout_ms
  });
  const callId = `${randomUUID()}@webphone.invalid`;
  const fromTag = randomUUID().replaceAll('-', '');

  try {
    await waitForOpen(socket, config.timeout_ms);
    await register(socket, config, callId, fromTag, 1, config.register_expires_seconds);
    await delay(config.refresh_delay_ms);
    await register(socket, config, callId, fromTag, 2, config.register_expires_seconds);
    await register(socket, config, callId, fromTag, 3, 0);
    return {
      status: 'passed',
      register_status: 200,
      refresh_status: 200,
      unregister_status: 200,
      refresh_delay_ms: config.refresh_delay_ms
    };
  } finally {
    closeSocket(socket);
  }
}

async function register(
  socket: WebSocket,
  config: KamailioWebPhoneRegisterProbeInput,
  callId: string,
  fromTag: string,
  cseq: number,
  expires: number
): Promise<void> {
  const response = waitForResponse(socket, callId, cseq, config.timeout_ms);
  socket.send(buildRegister(config, callId, fromTag, cseq, expires));
  const status = await response;
  if (status !== 200) throw new Error(`WebPhone REGISTER ${cseq} returned SIP ${status}`);
}

function buildRegister(
  config: KamailioWebPhoneRegisterProbeInput,
  callId: string,
  fromTag: string,
  cseq: number,
  expires: number
): string {
  const branch = `z9hG4bK-${randomUUID().replaceAll('-', '')}`;
  const aor = `sip:${config.identity}@${config.realm}`;
  return [
    `REGISTER sip:${config.realm} SIP/2.0`,
    `Via: SIP/2.0/WSS webphone.invalid;branch=${branch};rport`,
    `From: <${aor}>;tag=${fromTag}`,
    `To: <${aor}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: <sip:${config.identity}@webphone.invalid;transport=ws;ob>;expires=${expires}`,
    'Max-Forwards: 16',
    'Supported: path, outbound',
    `Expires: ${expires}`,
    'User-Agent: ivekit-kamailio-webphone-acceptance',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n');
}

function waitForResponse(
  socket: WebSocket,
  callId: string,
  cseq: number,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`WebPhone REGISTER ${cseq} timed out`)), timeoutMs);
    const onMessage = (bytes: WebSocket.RawData) => {
      const message = bytes.toString();
      if (!new RegExp(`^Call-ID:\\s*${escapeRegExp(callId)}\\s*$`, 'im').test(message) ||
          !new RegExp(`^CSeq:\\s*${cseq}\\s+REGISTER\\s*$`, 'im').test(message)) return;
      const match = /^SIP\/2\.0\s+([1-6][0-9]{2})\b/m.exec(message);
      if (!match) return finish(new Error('WebPhone received a malformed SIP response'));
      const status = Number(match[1]);
      if (status < 200) return;
      finish(undefined, status);
    };
    const onClose = () => finish(new Error('WebPhone WSS closed before REGISTER completed'));
    const onError = () => finish(new Error('WebPhone WSS failed before REGISTER completed'));
    const finish = (error?: Error, status?: number) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(status!);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebPhone WSS handshake timed out')), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error('WebPhone WSS handshake failed'));
    const onClose = () => finish(new Error('WebPhone WSS closed during handshake'));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function validateInput(input: KamailioWebPhoneRegisterProbeInput): KamailioWebPhoneRegisterProbeInput {
  const endpoint = new URL(input.endpoint);
  const insecureLoopback = endpoint.protocol === 'ws:' &&
    ['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname) && input.allow_insecure_ws === true;
  if (endpoint.protocol !== 'wss:' && !insecureLoopback) {
    throw new Error('WebPhone acceptance requires a secure WSS endpoint');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/ws') {
    throw new Error('WebPhone acceptance endpoint must be an uncredentialed /ws URL');
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token) ||
      input.token.length > 4_096) {
    throw new Error('WebPhone acceptance token is invalid');
  }
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.origin !== input.origin || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('WebPhone acceptance Origin must be an exact HTTPS origin');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(input.identity)) {
    throw new Error('WebPhone acceptance identity is invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(input.realm)) {
    throw new Error('WebPhone acceptance realm is invalid');
  }
  boundedInteger(input.register_expires_seconds, 30, 300, 'register expiry');
  boundedInteger(input.refresh_delay_ms, 0, 3_600_000, 'refresh delay');
  boundedInteger(input.timeout_ms, 100, 60_000, 'timeout');
  return { ...input, endpoint: endpoint.toString().replace(/\/$/, '') };
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`WebPhone acceptance ${name} is invalid`);
  }
  return value;
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, 'probe complete');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function runKamailioWebPhoneAcceptanceFromEnv(): Promise<void> {
  const tokenFile = requiredAbsoluteEnv('OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_TOKEN_FILE');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (Buffer.byteLength(token) > 4_096) throw new Error('WebPhone acceptance token file is too large');
  const result = await runKamailioWebPhoneRegisterProbe({
    endpoint: requiredEnv('OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_ENDPOINT'),
    token,
    origin: requiredEnv('OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_ORIGIN'),
    identity: requiredEnv('OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_IDENTITY'),
    realm: requiredEnv('OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_REALM'),
    register_expires_seconds: envInteger(
      'OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_REGISTER_EXPIRES_SECONDS',
      240
    ),
    refresh_delay_ms: envInteger(
      'OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_REFRESH_DELAY_MS',
      0
    ),
    timeout_ms: envInteger('OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_TIMEOUT_MS', 10_000)
  });
  const output = process.env.OPC_IVEKIT_KAMAILIO_WEBPHONE_ACCEPTANCE_OUTPUT;
  if (output) {
    if (!isAbsolute(output)) throw new Error('WebPhone acceptance output must be absolute');
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAbsoluteEnv(name: string): string {
  const value = requiredEnv(name);
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

function envInteger(name: string, fallback: number): number {
  const value = String(process.env[name] || '').trim();
  return value ? Number(value) : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKamailioWebPhoneAcceptanceFromEnv().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
