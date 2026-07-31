import TinodeSdk from 'tinode-sdk';

import type { CollaborationChatClientPlan } from './collaboration-chat.js';

export interface TinodeDataPacket {
  topic?: unknown;
  seq?: unknown;
  from?: unknown;
  ts?: unknown;
  head?: Record<string, unknown>;
  content?: unknown;
}

export interface TinodeInfoPacket {
  what?: unknown;
  seq?: unknown;
  from?: unknown;
}

export interface TinodePresencePacket {
  what?: unknown;
  src?: unknown;
}

export interface TinodeTopicLike {
  onData?: (packet?: TinodeDataPacket) => void;
  onInfo?: (packet?: TinodeInfoPacket) => void;
  onPres?: (packet?: TinodePresencePacket) => void;
  subscribe(): Promise<unknown>;
  leave?(unsub?: boolean): Promise<unknown>;
  noteRecv(sequence: number): void;
  noteRead(sequence: number): void;
  noteKeyPress(): void;
}

export interface TinodeClientLike {
  onConnect?: () => void;
  onDisconnect?: (error?: unknown) => void;
  connect(): Promise<unknown>;
  loginToken(token: string): Promise<unknown>;
  getTopic(name: string): TinodeTopicLike;
  disconnect(): void;
}

export interface TinodeRealtimeMessage {
  topic: string;
  sequence: number;
  from: string;
  timestamp: string;
  opc_message_id: string;
  content: unknown;
}

export interface TinodeRealtimeInfo {
  what: string;
  sequence: number;
  from: string;
}

export interface TinodeRealtimePresence {
  what: string;
  source: string;
}

export type TinodeConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface TinodeRealtimeAdapterInput {
  plan: CollaborationChatClientPlan;
  clientFactory?: (config: Record<string, unknown>) => TinodeClientLike;
  onMessage?: (message: TinodeRealtimeMessage) => void;
  onInfo?: (info: TinodeRealtimeInfo) => void;
  onPresence?: (presence: TinodeRealtimePresence) => void;
  onConnectionChange?: (state: TinodeConnectionState) => void;
  onError?: (error: Error) => void;
}

export class TinodeRealtimeAdapter {
  private client: TinodeClientLike | null = null;
  private topic: TinodeTopicLike | null = null;
  private connected = false;
  private connectionGeneration = 0;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly input: TinodeRealtimeAdapterInput) {}

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const generation = ++this.connectionGeneration;
    const pending = this.connectClient(generation);
    const tracked = pending.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  private async connectClient(generation: number): Promise<void> {
    const config = clientConfig(this.input.plan);
    this.input.onConnectionChange?.('connecting');
    const factory = this.input.clientFactory || defaultTinodeClientFactory;
    const client = factory(config);
    this.client = client;
    client.onDisconnect = (error) => {
      if (this.client !== client) return;
      this.connectionGeneration += 1;
      this.connected = false;
      this.client = null;
      this.topic = null;
      this.input.onConnectionChange?.('disconnected');
      if (error) this.input.onError?.(asError(error));
    };
    try {
      await client.connect();
      this.assertCurrentConnection(generation, client);
      await client.loginToken(this.input.plan.auth_token);
      this.assertCurrentConnection(generation, client);
      const topic = client.getTopic(this.input.plan.provider_topic_id);
      this.topic = topic;
      topic.onData = (packet) => {
        if (packet) this.input.onMessage?.(normalizeMessage(packet));
      };
      topic.onInfo = (packet) => {
        if (packet) this.input.onInfo?.(normalizeInfo(packet));
      };
      topic.onPres = (packet) => {
        if (packet) this.input.onPresence?.(normalizePresence(packet));
      };
      this.connected = true;
      await topic.subscribe();
      this.assertCurrentConnection(generation, client);
      this.input.onConnectionChange?.('connected');
    } catch (error) {
      const normalized = asError(error);
      if (this.connectionGeneration === generation && this.client === client) {
        this.connected = false;
        this.client = null;
        this.topic = null;
        this.input.onConnectionChange?.('disconnected');
        this.input.onError?.(normalized);
      }
      client.disconnect();
      throw normalized;
    }
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration += 1;
    const topic = this.topic;
    const client = this.client;
    this.topic = null;
    this.client = null;
    this.connected = false;
    if (topic?.leave) await topic.leave(false).catch(() => undefined);
    client?.disconnect();
    this.input.onConnectionChange?.('disconnected');
  }

  noteReceived(sequence: number): void {
    this.requireTopic().noteRecv(validSequence(sequence));
  }

  noteRead(sequence: number): void {
    this.requireTopic().noteRead(validSequence(sequence));
  }

  noteTyping(): void {
    this.requireTopic().noteKeyPress();
  }

  private requireTopic(): TinodeTopicLike {
    if (!this.connected || !this.topic) throw new Error('Tinode realtime topic is not connected');
    return this.topic;
  }

  private assertCurrentConnection(generation: number, client: TinodeClientLike): void {
    if (this.connectionGeneration !== generation || this.client !== client) {
      throw new Error('Tinode connection cancelled');
    }
  }
}

function defaultTinodeClientFactory(config: Record<string, unknown>): TinodeClientLike {
  return new TinodeSdk.Tinode(
    config as unknown as ConstructorParameters<typeof TinodeSdk.Tinode>[0]
  ) as unknown as TinodeClientLike;
}

function clientConfig(plan: CollaborationChatClientPlan): Record<string, unknown> {
  if (plan.provider !== 'tinode' || !plan.provider_topic_id || !plan.ws_url || !plan.api_key) {
    throw new Error('Tinode client plan is required');
  }
  if (!plan.auth_token) throw new Error('Tinode auth token is required');
  const url = new URL(plan.ws_url);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Tinode websocket URL must use ws or wss');
  }
  return {
    host: url.host,
    secure: url.protocol === 'wss:',
    appName: 'OPC iveKit Chat',
    apiKey: plan.api_key,
    transport: 'ws',
    persist: false
  };
}

function normalizeMessage(packet: TinodeDataPacket): TinodeRealtimeMessage {
  const head = packet.head && typeof packet.head === 'object' ? packet.head : {};
  const timestamp = packet.ts instanceof Date
    ? packet.ts.toISOString()
    : String(packet.ts || '');
  return {
    topic: String(packet.topic || ''),
    sequence: finiteSequence(packet.seq),
    from: String(packet.from || ''),
    timestamp,
    opc_message_id: String(head['x-opc-message-id'] || ''),
    content: packet.content
  };
}

function normalizeInfo(packet: TinodeInfoPacket): TinodeRealtimeInfo {
  return {
    what: String(packet.what || ''),
    sequence: finiteSequence(packet.seq),
    from: String(packet.from || '')
  };
}

function normalizePresence(packet: TinodePresencePacket): TinodeRealtimePresence {
  return { what: String(packet.what || ''), source: String(packet.src || '') };
}

function validSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Tinode sequence must be a positive safe integer');
  return value;
}

function finiteSequence(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
