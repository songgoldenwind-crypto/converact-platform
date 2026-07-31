import type { IveKitChatClientPlan } from '@opc/ivekit-sdk';
import type { ChatConnectionState, ChatConvergenceTrigger, ChatScheduler } from './types.js';

export interface TinodeDataPacket { seq?: unknown; }
export interface TinodeInfoPacket { what?: unknown; seq?: unknown; from?: unknown; }
export interface TinodePresencePacket { what?: unknown; src?: unknown; }

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
  onDisconnect?: (error?: unknown) => void;
  connect(): Promise<unknown>;
  loginToken(token: string): Promise<unknown>;
  getTopic(name: string): TinodeTopicLike;
  disconnect(): void;
}

export interface ReceiveOnlyTinodeAdapterInput {
  getPlan(): Promise<IveKitChatClientPlan>;
  clientFactory?: (config: Record<string, unknown>) => TinodeClientLike | Promise<TinodeClientLike>;
  scheduler?: ChatScheduler;
  random?: () => number;
  backoffMs?: readonly number[];
  stableConnectionMs?: number;
  onStateChange?: (state: ChatConnectionState) => void;
  onInvalidate?: (trigger: ChatConvergenceTrigger, sequence?: number) => void;
  onInfo?: (packet: TinodeInfoPacket) => void;
  onPresence?: (packet: TinodePresencePacket) => void;
  onError?: (error: Error) => void;
}

const systemScheduler: ChatScheduler = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class ReceiveOnlyTinodeAdapter {
  private client: TinodeClientLike | null = null;
  private topic: TinodeTopicLike | null = null;
  private generation = 0;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: unknown = null;
  private stableTimer: unknown = null;
  private reconnectAttempt = 0;
  private networkOnline = true;
  private disposed = false;
  private fatal = false;
  private state: ChatConnectionState = 'idle';
  private readonly scheduler: ChatScheduler;
  private readonly backoffMs: readonly number[];

  constructor(private readonly input: ReceiveOnlyTinodeAdapterInput) {
    this.scheduler = input.scheduler || systemScheduler;
    this.backoffMs = validBackoff(input.backoffMs);
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Tinode adapter is disposed'));
    if (this.fatal) return Promise.reject(new Error('Tinode adapter is in fatal state'));
    if (!this.networkOnline) return Promise.reject(new Error('Tinode network is offline'));
    if (this.state === 'online') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.clearReconnectTimer();
    const generation = ++this.generation;
    const pending = this.connectGeneration(generation);
    const tracked = pending.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    this.connectPromise = null;
    this.reconnectAttempt = 0;
    this.clearTimers();
    await this.releaseConnection();
    this.setState('closed');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disconnect();
  }

  setNetworkOnline(online: boolean): void {
    if (this.disposed || this.networkOnline === online) return;
    this.networkOnline = online;
    if (!online) {
      this.generation += 1;
      this.connectPromise = null;
      this.reconnectAttempt = 0;
      this.clearTimers();
      void this.releaseConnection();
      this.setState('offline');
      return;
    }
    if (!this.fatal) this.scheduleReconnect(0);
  }

  forceReconnect(): void {
    if (this.disposed || this.fatal || !this.networkOnline) return;
    this.generation += 1;
    this.connectPromise = null;
    this.clearTimers();
    void this.releaseConnection();
    this.setState('reconnecting');
    this.scheduleReconnect(0);
  }

  noteReceived(sequence: number): void { this.requireTopic().noteRecv(validSequence(sequence)); }
  noteRead(sequence: number): void { this.requireTopic().noteRead(validSequence(sequence)); }
  noteTyping(): void { this.requireTopic().noteKeyPress(); }

  private async connectGeneration(generation: number): Promise<void> {
    this.setState(this.reconnectAttempt ? 'reconnecting' : 'connecting');
    let client: TinodeClientLike | null = null;
    try {
      const plan = await this.input.getPlan();
      this.assertCurrent(generation);
      const factory = this.input.clientFactory || defaultClientFactory;
      client = await factory(clientConfig(plan));
      this.client = client;
      client.onDisconnect = (error) => this.handleDisconnect(generation, client!, error);
      await client.connect();
      this.assertCurrent(generation, client);
      await client.loginToken(plan.auth_token);
      this.assertCurrent(generation, client);
      const topic = client.getTopic(plan.provider_topic_id);
      this.topic = topic;
      topic.onData = (packet) => {
        if (!packet || !this.isCurrent(generation, client!)) return;
        this.input.onInvalidate?.('tinode_data', finiteSequence(packet.seq));
      };
      topic.onInfo = (packet) => { if (packet && this.isCurrent(generation, client!)) this.input.onInfo?.(packet); };
      topic.onPres = (packet) => { if (packet && this.isCurrent(generation, client!)) this.input.onPresence?.(packet); };
      await topic.subscribe();
      this.assertCurrent(generation, client);
      this.setState('online');
      if (this.reconnectAttempt) this.input.onInvalidate?.('reconnect');
      this.stableTimer = this.scheduler.setTimeout(
        () => { this.reconnectAttempt = 0; this.stableTimer = null; },
        this.input.stableConnectionMs ?? 10_000
      );
    } catch (cause) {
      const error = asError(cause);
      if (client) {
        client.onDisconnect = undefined;
        client.disconnect();
      }
      if (!this.isGenerationCurrent(generation)) throw error;
      this.client = null;
      this.topic = null;
      if (authStatus(cause)) {
        this.fatal = true;
        this.setState('fatal');
      } else if (this.networkOnline && !this.disposed) {
        this.setState('reconnecting');
        this.input.onError?.(error);
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  private handleDisconnect(generation: number, client: TinodeClientLike, error?: unknown): void {
    if (!this.isCurrent(generation, client)) return;
    this.generation += 1;
    this.client = null;
    this.topic = null;
    this.clearStableTimer();
    if (!this.networkOnline || this.disposed || this.fatal) return;
    this.setState('reconnecting');
    if (error) this.input.onError?.(asError(error));
    this.scheduleReconnect();
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (this.reconnectTimer || this.disposed || this.fatal || !this.networkOnline) return;
    const index = Math.min(this.reconnectAttempt, this.backoffMs.length - 1);
    const base = delayOverride ?? this.backoffMs[index];
    const random = Math.min(1, Math.max(0, this.input.random?.() ?? Math.random()));
    const jitter = delayOverride == null ? Math.floor(base * 0.25 * random) : 0;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, base + jitter);
  }

  private async releaseConnection(): Promise<void> {
    const topic = this.topic;
    const client = this.client;
    this.topic = null;
    this.client = null;
    if (topic?.leave) await topic.leave(false).catch(() => undefined);
    if (client) {
      client.onDisconnect = undefined;
      client.disconnect();
    }
  }

  private requireTopic(): TinodeTopicLike {
    if (this.state !== 'online' || !this.topic) throw new Error('Tinode receive-only topic is not connected');
    return this.topic;
  }

  private assertCurrent(generation: number, client?: TinodeClientLike): void {
    if (!this.isGenerationCurrent(generation) || (client && this.client !== client)) {
      throw new Error('Tinode connection cancelled');
    }
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.generation === generation && !this.disposed;
  }

  private isCurrent(generation: number, client: TinodeClientLike): boolean {
    return this.isGenerationCurrent(generation) && this.client === client;
  }

  private setState(state: ChatConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.input.onStateChange?.(state);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearStableTimer(): void {
    if (this.stableTimer) this.scheduler.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private clearTimers(): void { this.clearReconnectTimer(); this.clearStableTimer(); }
}

async function defaultClientFactory(config: Record<string, unknown>): Promise<TinodeClientLike> {
  const TinodeSdk = await import('tinode-sdk');
  const Tinode = TinodeSdk.Tinode || TinodeSdk.default?.Tinode;
  if (!Tinode) throw new Error('Tinode SDK constructor is unavailable');
  return new Tinode(config as never) as unknown as TinodeClientLike;
}

function clientConfig(plan: IveKitChatClientPlan): Record<string, unknown> {
  if (plan.provider !== 'tinode' || !plan.provider_topic_id || !plan.ws_url || !plan.api_key) {
    throw new Error('Tinode client plan is required');
  }
  if (!plan.auth_token) throw Object.assign(new Error('Tinode auth token is required'), { status: 401 });
  const url = new URL(plan.ws_url);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Tinode websocket URL must use ws or wss');
  return { host: url.host, secure: url.protocol === 'wss:', appName: 'iveKit Reference', apiKey: plan.api_key, transport: 'ws', persist: false };
}

function validSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Tinode sequence must be a positive safe integer');
  return value;
}

function finiteSequence(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function authStatus(error: unknown): 401 | 403 | null {
  const value = error as { status?: number; code?: number };
  const status = Number(value.status || value.code || 0);
  return status === 401 || status === 403 ? status : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof Event !== 'undefined' && error instanceof Event) return new Error('Tinode connection failed');
  const message = (error as { message?: unknown } | null)?.message;
  return new Error(typeof message === 'string' && message ? message : String(error));
}

function validBackoff(value: readonly number[] | undefined): readonly number[] {
  const schedule = value?.length ? [...value] : [1_000, 2_000, 5_000, 10_000, 30_000];
  if (schedule.length > 10 || schedule.some((delay) => !Number.isInteger(delay) || delay < 100 || delay > 60_000)) {
    throw new Error('Tinode backoff must contain 1-10 integer delays from 100 to 60000ms');
  }
  return schedule;
}
