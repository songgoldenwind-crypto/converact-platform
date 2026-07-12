import { WebSocket } from 'ws';

export interface TinodeInboundPullInput {
  provider_topic_id: string;
  last_data_seq: number;
  last_del_id: number;
  limit: number;
}

export interface TinodeInboundWirePacket {
  data?: Record<string, any>;
  meta?: Record<string, any>;
  pres?: Record<string, any>;
}

export interface TinodeInboundSource {
  pull(input: TinodeInboundPullInput): Promise<TinodeInboundWirePacket[]>;
}

export interface TinodeInboundWireConfig {
  ws_url: string;
  api_key?: string;
  auth_token?: string;
  basic_user?: string;
  basic_password?: string;
  timeout_ms?: number;
  settle_ms?: number;
}

export class TinodeInboundWireSource implements TinodeInboundSource {
  private readonly config: Required<Pick<TinodeInboundWireConfig, 'ws_url' | 'timeout_ms' | 'settle_ms'>> & TinodeInboundWireConfig;

  constructor(config: TinodeInboundWireConfig) {
    const wsUrl = configuredWsUrl(config.ws_url, config.api_key);
    if (!config.auth_token && !config.basic_user) {
      throw new Error('Tinode inbound source requires token or basic authentication');
    }
    this.config = {
      ...config,
      ws_url: wsUrl,
      timeout_ms: boundedInteger(config.timeout_ms ?? 5_000, 250, 60_000, 'timeout_ms'),
      settle_ms: boundedInteger(config.settle_ms ?? 50, 0, 1_000, 'settle_ms')
    };
  }

  async pull(input: TinodeInboundPullInput): Promise<TinodeInboundWirePacket[]> {
    const topic = required(input.provider_topic_id, 'provider_topic_id');
    const lastDataSeq = nonNegativeInteger(input.last_data_seq, 'last_data_seq');
    const lastDelId = nonNegativeInteger(input.last_del_id, 'last_del_id');
    const limit = boundedInteger(input.limit, 1, 200, 'limit');
    const session = new TinodeInboundWireSession(this.config, limit * 2 + 10);
    try {
      await session.connect();
      await session.request('hi', { ver: '0.22', ua: 'OPC iveKit TinodeInbound' });
      await session.request('login', loginPayload(this.config));
      session.capture = true;
      await session.request('sub', {
        topic,
        get: {
          what: 'data del',
          data: { since: lastDataSeq + 1, limit },
          del: { since: lastDelId + 1, limit }
        }
      });
      if (this.config.settle_ms > 0) await delay(this.config.settle_ms);
      return [...session.packets];
    } finally {
      session.close();
    }
  }
}

export function configuredTinodeInboundSource(
  env: NodeJS.ProcessEnv = process.env
): TinodeInboundWireSource | null {
  const rawWsUrl = String(env.TINODE_WS_URL || '').trim() || defaultTinodeWsUrl(String(env.TINODE_BASE_URL || ''));
  if (!rawWsUrl) return null;
  return new TinodeInboundWireSource({
    ws_url: rawWsUrl,
    api_key: value(env.TINODE_API_KEY),
    auth_token: value(env.TINODE_AUTH_TOKEN),
    basic_user: value(env.TINODE_BASIC_USER),
    basic_password: value(env.TINODE_BASIC_PASSWORD),
    timeout_ms: optionalInteger(env.TINODE_REQUEST_TIMEOUT_MS),
    settle_ms: optionalInteger(env.OPC_TINODE_INBOUND_SETTLE_MS)
  });
}

class TinodeInboundWireSession {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly packets: TinodeInboundWirePacket[] = [];
  capture = false;

  constructor(private readonly config: TinodeInboundWireConfig & { timeout_ms: number }, private readonly maxPackets: number) {}

  async connect(): Promise<void> {
    this.socket = new WebSocket(this.config.ws_url);
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('error', (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    this.socket.on('close', () => this.rejectAll(new Error('Tinode inbound websocket closed')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tinode inbound websocket open timeout')), this.config.timeout_ms);
      this.socket!.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket!.once('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  request(kind: 'hi' | 'login' | 'sub', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Tinode inbound websocket is not open'));
    }
    const id = `opc-inbound-${this.nextId++}`;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tinode inbound ${kind} request timed out`));
      }, this.config.timeout_ms);
      this.pending.set(id, { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ [kind]: { id, ...payload } }));
    return promise;
  }

  close(): void {
    this.rejectAll(new Error('Tinode inbound session closed'));
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      this.socket.close();
    }
    this.socket = null;
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let packet: TinodeInboundWirePacket & { ctrl?: Record<string, unknown> };
    try {
      packet = JSON.parse(String(raw)) as TinodeInboundWirePacket & { ctrl?: Record<string, unknown> };
    } catch {
      return;
    }
    if (this.capture && supportedPacket(packet)) {
      if (this.packets.length >= this.maxPackets) {
        this.rejectAll(new Error('Tinode inbound packet count exceeds the pull limit'));
        this.socket?.close();
        return;
      }
      this.packets.push(packet);
    }
    const ctrl = packet.ctrl;
    const id = String(ctrl?.id || '');
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const code = Number(ctrl?.code || 0);
    if (code >= 300) {
      pending.reject(Object.assign(new Error(`Tinode inbound request failed: ${code}`), { code }));
    } else {
      pending.resolve(ctrl || {});
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function supportedPacket(packet: TinodeInboundWirePacket): boolean {
  return Boolean(
    packet.data ||
    packet.meta?.del ||
    (packet.pres && String(packet.pres.what || '') === 'del')
  );
}

function loginPayload(config: TinodeInboundWireConfig): Record<string, unknown> {
  if (config.auth_token) return { scheme: 'token', secret: config.auth_token };
  return {
    scheme: 'basic',
    secret: Buffer.from(`${config.basic_user}:${config.basic_password || ''}`).toString('base64')
  };
}

function configuredWsUrl(raw: string, apiKey?: string): string {
  const url = new URL(required(raw, 'ws_url'));
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Tinode inbound ws_url must use ws or wss');
  if (apiKey && !url.searchParams.has('apikey')) url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function defaultTinodeWsUrl(baseUrl: string): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v0/channels`;
  return url.toString();
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('Tinode inbound numeric environment value must be an integer');
  return parsed;
}

function required(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function value(input: string | undefined): string | undefined {
  const normalized = String(input || '').trim();
  return normalized || undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
