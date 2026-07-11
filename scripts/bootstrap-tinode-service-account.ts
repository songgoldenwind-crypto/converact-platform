import { fileURLToPath } from 'node:url';

export interface TinodeServiceAccountBootstrapConfig {
  wsUrl: string;
  apiKey: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface TinodeServiceAccountBootstrapResult {
  status: 'created' | 'existing';
}

interface WebSocketLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

class TinodeBootstrapProtocolError extends Error {
  constructor(readonly code: number, text: string) {
    super(`Tinode service account bootstrap failed: ${code} ${text}`.trim());
  }
}

export function tinodeServiceAccountBootstrapConfigFromEnv(
  env: NodeJS.ProcessEnv
): TinodeServiceAccountBootstrapConfig {
  const wsUrl = required(env, 'TINODE_WS_URL');
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('TINODE_WS_URL must use ws or wss');
  }
  const apiKey = required(env, 'TINODE_API_KEY');
  const username = required(env, 'TINODE_BASIC_USER');
  if (!/^[a-zA-Z0-9_.-]{3,96}$/.test(username)) {
    throw new Error('TINODE_BASIC_USER must be 3..96 safe characters');
  }
  const password = required(env, 'TINODE_BASIC_PASSWORD');
  if (password.length < 12 || new Set(['admin', 'password', 'tinode']).has(password.toLowerCase())) {
    throw new Error('TINODE_BASIC_PASSWORD must not use a weak value');
  }
  const timeoutMs = Number(env.TINODE_BOOTSTRAP_TIMEOUT_MS || 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000) {
    throw new Error('TINODE_BOOTSTRAP_TIMEOUT_MS must be an integer between 250 and 60000');
  }
  return { wsUrl, apiKey, username, password, timeoutMs };
}

export async function bootstrapTinodeServiceAccount(
  config: TinodeServiceAccountBootstrapConfig,
  WebSocketImpl: WebSocketConstructor = globalThis.WebSocket as unknown as WebSocketConstructor
): Promise<TinodeServiceAccountBootstrapResult> {
  if (!WebSocketImpl) throw new Error('WebSocket runtime is unavailable');
  const url = new URL(config.wsUrl);
  url.searchParams.set('apikey', config.apiKey);
  const socket = new WebSocketImpl(url.toString());
  try {
    await waitForOpen(socket, config.timeoutMs);
    await request(socket, 'hi', {
      id: 'bootstrap-hi',
      ver: '0.22',
      ua: 'OPC iveKit Tinode bootstrap'
    }, config.timeoutMs);
    const secret = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    try {
      await request(socket, 'acc', {
        id: 'bootstrap-account',
        user: `new${config.username}`,
        scheme: 'basic',
        secret,
        login: true,
        tags: ['opc:service-account'],
        desc: {
          defacs: { auth: 'JRWS', anon: 'N' },
          public: { fn: 'OPC iveKit service' },
          private: { source: 'opc-ivekit-bootstrap' }
        }
      }, config.timeoutMs);
      return { status: 'created' };
    } catch (error) {
      if (!(error instanceof TinodeBootstrapProtocolError) || error.code !== 409) throw error;
      await request(socket, 'login', {
        id: 'bootstrap-login',
        scheme: 'basic',
        secret
      }, config.timeoutMs);
      return { status: 'existing' };
    }
  } finally {
    socket.close();
  }
}

async function waitForOpen(socket: WebSocketLike, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Tinode WebSocket open timed out')), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error('Tinode WebSocket open failed'));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      error ? reject(error) : resolve();
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

async function request(
  socket: WebSocketLike,
  kind: 'hi' | 'acc' | 'login',
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = String(payload.id || '');
    const timer = setTimeout(() => finish(new Error(`Tinode ${kind} request timed out`)), timeoutMs);
    const onMessage = (event: { data?: unknown }) => {
      let packet: { ctrl?: { id?: string; code?: number; text?: string } };
      try {
        packet = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const ctrl = packet.ctrl;
      if (!ctrl || ctrl.id !== id) return;
      if ((ctrl.code || 0) >= 300) {
        finish(new TinodeBootstrapProtocolError(ctrl.code || 500, ctrl.text || 'request rejected'));
        return;
      }
      finish(undefined, ctrl as Record<string, unknown>);
    };
    const onClose = () => finish(new Error(`Tinode WebSocket closed during ${kind}`));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      error ? reject(error) : resolve(value || {});
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.send(JSON.stringify({ [kind]: payload }));
  });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

async function main(): Promise<void> {
  const result = await bootstrapTinodeServiceAccount(
    tinodeServiceAccountBootstrapConfigFromEnv(process.env)
  );
  console.log(`Tinode service account ${result.status}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
