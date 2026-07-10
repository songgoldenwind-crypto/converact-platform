/**
 * RustPBX RWI v1 client (action/action_id async protocol, /rwi/v1).
 * Separate from legacy rwi-client.ts (request_id/command sync model).
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export interface RwiV1ClientConfig {
  url: string;
  authToken?: string;
  reconnectInterval?: number;
}

type EventHandler = (message: Record<string, unknown>) => void;

function buildRwiV1Url(url: string, authToken?: string): string {
  const parsed = new URL(url);
  if (authToken && !parsed.searchParams.has('token')) {
    parsed.searchParams.set('token', authToken);
  }
  return parsed.toString();
}

export class RwiV1Client {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private readonly handlers = new Set<EventHandler>();

  constructor(private readonly config: RwiV1ClientConfig) {
    this.reconnectDelay = config.reconnectInterval ?? 1000;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;

    const headers: Record<string, string> = {};
    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }

    const ws = new WebSocket(buildRwiV1Url(this.config.url, this.config.authToken), 'rwi-v1', {
      headers,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onError);
        this.connected = true;
        this.reconnectDelay = this.config.reconnectInterval ?? 1000;
        resolve();
      };
      const onError = (error: Error) => {
        ws.off('open', onOpen);
        reject(error);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(String(data)) as Record<string, unknown>;
          for (const handler of this.handlers) handler(message);
        } catch (error) {
          console.warn('[rwi-v1] invalid message:', error);
        }
      });
      ws.on('close', () => {
        this.connected = false;
        this.scheduleReconnect();
      });
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
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  onMessage(handler: EventHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: EventHandler): void {
    this.handlers.delete(handler);
  }

  sendAction(action: string, params: Record<string, unknown>): string {
    if (!this.isConnected() || !this.ws) {
      throw new Error('RWI v1 client is not connected');
    }
    const actionId = randomUUID();
    this.ws.send(JSON.stringify({ action, action_id: actionId, params }));
    return actionId;
  }

  subscribe(contexts: string[]): string {
    return this.sendAction('session.subscribe', { contexts });
  }

  answer(callId: string): string {
    return this.sendAction('call.answer', { call_id: callId });
  }

  hangup(callId: string, reason = 'normal'): string {
    return this.sendAction('call.hangup', { call_id: callId, reason });
  }

  /** Legacy OPC gather_digits envelope → best-effort RWI v1 action name. */
  sendLegacyCommand(command: string, params: Record<string, unknown>): string {
    return this.sendAction(command, params);
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

export function readRwiV1Config(): { url: string | null; authToken?: string } {
  const url = process.env.RUSTPBX_RWI_URL || process.env.OPC_RUSTPBX_RWI_URL || null;
  const authToken = process.env.RUSTPBX_RWI_TOKEN || process.env.OPC_RUSTPBX_RWI_TOKEN;
  return { url, authToken };
}
