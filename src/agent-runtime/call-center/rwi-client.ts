import { randomUUID } from 'node:crypto';
import type {
  RWIEvent,
  RWIOriginateParams,
  RWIRequestMessage,
  RWIResponseMessage
} from './rwi-types.js';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export interface RWIClientConfig {
  url: string;
  authToken?: string;
  reconnectInterval?: number;
  requestTimeout?: number;
  createWebSocket?: (url: string) => WebSocketLike;
}

type PendingRequest = {
  resolve: (value: RWIResponseMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const WS_OPEN = 1;

export class RWINotConnectedError extends Error {
  constructor() {
    super('RWI client is not connected');
    this.name = 'RWINotConnectedError';
  }
}

export function buildRWIUrl(config: { url: string; authToken?: string }): string {
  if (!config.authToken) return config.url;
  const url = new URL(config.url);
  url.username = 'rwi';
  url.password = config.authToken;
  return url.toString();
}

export function parseRWIMessage(raw: string): RWIResponseMessage | RWIEvent | null {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload.event) return payload as unknown as RWIEvent;
    if (payload.request_id) return payload as unknown as RWIResponseMessage;
    return null;
  } catch {
    return null;
  }
}

export interface RWIClientLike {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  originate(params: import('./rwi-types.js').RWIOriginateParams): Promise<{ call_id: string }>;
  transfer(callId: string, target: string): Promise<void>;
  hold(callId: string, options?: { music_url?: string }): Promise<void>;
  unhold(callId: string): Promise<void>;
  playAudio(callId: string, mediaUrl: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  bridge(callId: string, targetUri: string): Promise<void>;
  onEvent(handler: (event: RWIEvent) => void): void;
  offEvent(handler: (event: RWIEvent) => void): void;
}

export class RWIClient implements RWIClientLike {
  private ws: WebSocketLike | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<(event: RWIEvent) => void>();

  constructor(private readonly config: RWIClientConfig) {
    this.reconnectDelay = config.reconnectInterval ?? 1000;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WS_OPEN) return;

    const createWebSocket = this.config.createWebSocket ?? ((url: string) => new WebSocket(url) as WebSocketLike);
    const ws = createWebSocket(buildRWIUrl(this.config));
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.connected = true;
        this.reconnectDelay = this.config.reconnectInterval ?? 1000;
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = (event: { error?: Error }) => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        reject(event.error || new Error('RWI websocket connection failed'));
      };
      const onMessage = (event: { data: string | ArrayBuffer }) => {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        this.handleMessage(raw);
      };
      const onClose = () => {
        this.connected = false;
        this.scheduleReconnect();
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RWINotConnectedError());
    }
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WS_OPEN;
  }

  onEvent(handler: (event: RWIEvent) => void): void {
    this.eventHandlers.add(handler);
  }

  offEvent(handler: (event: RWIEvent) => void): void {
    this.eventHandlers.delete(handler);
  }

  async originate(params: RWIOriginateParams): Promise<{ call_id: string }> {
    const response = await this.sendCommand('originate', { ...params });
    if (!response.success) {
      throw Object.assign(new Error(response.message || response.error || 'originate failed'), {
        code: response.error || 'originate_failed'
      });
    }
    return { call_id: String(response.call_id || response.data?.call_id || '') };
  }

  async hangup(callId: string): Promise<void> {
    await this.sendCommand('hangup', { call_id: callId });
  }

  async bridge(callId: string, targetUri: string): Promise<void> {
    await this.sendCommand('bridge', { call_id: callId, target: targetUri });
  }

  async transfer(callId: string, target: string): Promise<void> {
    await this.sendCommand('transfer', { call_id: callId, target });
  }

  async hold(callId: string, options?: { music_url?: string }): Promise<void> {
    const params: Record<string, unknown> = { call_id: callId };
    if (options?.music_url) params.music_url = options.music_url;
    await this.sendCommand('hold', params);
  }

  async unhold(callId: string): Promise<void> {
    await this.sendCommand('unhold', { call_id: callId });
  }

  async playAudio(callId: string, mediaUrl: string): Promise<void> {
    await this.sendCommand('play_audio', { call_id: callId, media_url: mediaUrl });
  }

  private async sendCommand(command: RWIRequestMessage['command'], params: Record<string, unknown>) {
    if (!this.isConnected() || !this.ws) throw new RWINotConnectedError();

    const requestId = randomUUID();
    const message: RWIRequestMessage = { request_id: requestId, command, params };
    const timeoutMs = this.config.requestTimeout ?? 10_000;

    const response = await new Promise<RWIResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(Object.assign(new Error(`RWI ${command} timed out`), { code: 'timeout' }));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(message));
    });

    return response;
  }

  private handleMessage(raw: string): void {
    const parsed = parseRWIMessage(raw);
    if (!parsed) return;

    if ('event' in parsed && parsed.event === 'call_state_change') {
      for (const handler of this.eventHandlers) handler(parsed);
      return;
    }

    if ('request_id' in parsed) {
      const pending = this.pendingRequests.get(parsed.request_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(parsed.request_id);
      pending.resolve(parsed);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }
}

export function readRWIConfig(): { url: string | null; authToken?: string } {
  const url = process.env.RUSTPBX_RWI_URL || process.env.OPC_RUSTPBX_RWI_URL || null;
  const authToken = process.env.RUSTPBX_RWI_TOKEN || process.env.OPC_RUSTPBX_RWI_TOKEN;
  return { url, authToken };
}
