import { createHash, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';

export const TINODE_RECEIVE_ONLY_ACCESS_MODE = 'JRP';

export interface ChatTopicInput {
  tenant_id: string;
  session_id: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatTopicBinding {
  provider: 'local' | 'tinode';
  provider_topic_id: string;
  provider_status: 'bound' | 'failed';
  metadata: Record<string, unknown>;
}

export interface ChatUserInput {
  tenant_id: string;
  identity: string;
  display_name?: string;
  provider_user_id?: string;
}

export interface ChatUserBinding {
  provider_user_id: string;
  provider_auth_token?: string;
  metadata: Record<string, unknown>;
}

export interface ChatParticipantInput extends ChatUserInput {
  session_id: string;
  provider_topic_id: string;
  access_mode?: string;
}

export interface ChatPublishInput {
  tenant_id: string;
  session_id: string;
  provider_topic_id: string;
  sender_identity: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface ChatPublishResult {
  provider: 'local' | 'tinode';
  provider_topic_id: string;
  provider_message_id: string;
  provider_sync_status: 'published' | 'skipped' | 'failed';
  metadata: Record<string, unknown>;
}

export interface ChatGateway {
  provider: 'local' | 'tinode';
  ensureTopic(input: ChatTopicInput): Promise<ChatTopicBinding>;
  ensureUser(input: ChatUserInput): Promise<ChatUserBinding>;
  addParticipant(input: ChatParticipantInput): Promise<void>;
  removeParticipant(input: ChatParticipantInput): Promise<void>;
  publishMessage(input: ChatPublishInput): Promise<ChatPublishResult>;
}

export class LocalChatGateway implements ChatGateway {
  readonly provider = 'local' as const;

  async ensureTopic(input: ChatTopicInput): Promise<ChatTopicBinding> {
    return {
      provider: this.provider,
      provider_topic_id: `local:${input.tenant_id}:${input.session_id}`,
      provider_status: 'bound',
      metadata: {
        mode: 'local_mirror',
        title: input.title || '',
        ...(input.metadata || {})
      }
    };
  }

  async ensureUser(input: ChatUserInput): Promise<ChatUserBinding> {
    return {
      provider_user_id: input.provider_user_id || `local:${input.tenant_id}:${input.identity}`,
      metadata: { mode: 'local_mirror', display_name: input.display_name || '' }
    };
  }

  async addParticipant(_input: ChatParticipantInput): Promise<void> {
    return;
  }

  async removeParticipant(_input: ChatParticipantInput): Promise<void> {
    return;
  }

  async publishMessage(input: ChatPublishInput): Promise<ChatPublishResult> {
    return {
      provider: this.provider,
      provider_topic_id: input.provider_topic_id,
      provider_message_id: '',
      provider_sync_status: 'skipped',
      metadata: { mode: 'local_mirror' }
    };
  }
}

export class TinodeChatGateway implements ChatGateway {
  readonly provider = 'tinode' as const;

  constructor(private readonly config: TinodeGatewayConfig) {}

  async ensureTopic(input: ChatTopicInput): Promise<ChatTopicBinding> {
    if (this.hasWireConfig()) {
      const client = new TinodeWireClient(this.config);
      try {
        const topic = await client.createGroupTopic(input);
        return {
          provider: this.provider,
          provider_topic_id: topic,
          provider_status: 'bound',
          metadata: {
            base_url: tinodeMetadataUrl(this.config.base_url),
            title: input.title || '',
            protocol: 'tinode_websocket',
            ...(input.metadata || {})
          }
        };
      } finally {
        client.close();
      }
    }
    return {
      provider: this.provider,
      provider_topic_id: tinodeTopicNameForSession(input.tenant_id, input.session_id),
      provider_status: 'bound',
      metadata: {
        base_url: tinodeMetadataUrl(this.config.base_url),
        title: input.title || '',
        ...(input.metadata || {})
      }
    };
  }

  async ensureUser(input: ChatUserInput): Promise<ChatUserBinding> {
    if (!input.provider_user_id && this.hasUserProvisioningConfig()) {
      const client = new TinodeWireClient(this.config);
      try {
        const user = await client.createBasicAccount(input);
        return {
          provider_user_id: user.provider_user_id,
          provider_auth_token: user.provider_auth_token,
          metadata: {
            base_url: tinodeMetadataUrl(this.config.base_url),
            display_name: input.display_name || '',
            protocol: 'tinode_websocket',
            auth_scheme: 'basic',
            username: user.username
          }
        };
      } finally {
        client.close();
      }
    }
    return {
      provider_user_id: input.provider_user_id || tinodeUserNameForIdentity(input.tenant_id, input.identity),
      metadata: {
        base_url: tinodeMetadataUrl(this.config.base_url),
        display_name: input.display_name || ''
      }
    };
  }

  async addParticipant(input: ChatParticipantInput): Promise<void> {
    if (this.hasWireConfig()) {
      const client = new TinodeWireClient(this.config);
      try {
        await client.grantTopicAccess(
          input.provider_topic_id,
          input.provider_user_id || tinodeUserNameForIdentity(input.tenant_id, input.identity),
          input.access_mode || TINODE_RECEIVE_ONLY_ACCESS_MODE
        );
      } finally {
        client.close();
      }
    }
    return;
  }

  async removeParticipant(input: ChatParticipantInput): Promise<void> {
    if (this.hasWireConfig()) {
      const client = new TinodeWireClient(this.config);
      try {
        await client.grantTopicAccess(
          input.provider_topic_id,
          input.provider_user_id || tinodeUserNameForIdentity(input.tenant_id, input.identity),
          input.access_mode || 'N'
        );
      } finally {
        client.close();
      }
    }
    return;
  }

  async publishMessage(input: ChatPublishInput): Promise<ChatPublishResult> {
    if (this.hasWireConfig()) {
      const client = new TinodeWireClient(this.config);
      try {
        const seq = await client.publishText(input.provider_topic_id, input.body, input.metadata);
        return {
          provider: this.provider,
          provider_topic_id: input.provider_topic_id,
          provider_message_id: seq,
          provider_sync_status: 'published',
          metadata: {
            base_url: tinodeMetadataUrl(this.config.base_url),
            protocol: 'tinode_websocket'
          }
        };
      } finally {
        client.close();
      }
    }
    return {
      provider: this.provider,
      provider_topic_id: input.provider_topic_id,
      provider_message_id: '',
      provider_sync_status: 'failed',
      metadata: {
        base_url: tinodeMetadataUrl(this.config.base_url),
        reason: 'tinode_protocol_not_connected'
      }
    };
  }

  private hasWireConfig(): boolean {
    return Boolean(resolveTinodeWsUrl(this.config) && (this.config.auth_token || this.config.basic_user));
  }

  private hasUserProvisioningConfig(): boolean {
    return Boolean(resolveTinodeWsUrl(this.config) && this.config.user_password_secret);
  }
}

export function configuredChatGateway(env: NodeJS.ProcessEnv = process.env): ChatGateway {
  const baseUrl = String(env.TINODE_BASE_URL || '').trim();
  const wsUrl = String(env.TINODE_WS_URL || '').trim();
  if (!baseUrl && !wsUrl) return new LocalChatGateway();
  return new TinodeChatGateway({
    base_url: baseUrl || wsUrl,
    ws_url: wsUrl || undefined,
    api_key: env.TINODE_API_KEY ? String(env.TINODE_API_KEY) : undefined,
    auth_token: env.TINODE_AUTH_TOKEN ? String(env.TINODE_AUTH_TOKEN) : undefined,
    basic_user: env.TINODE_BASIC_USER ? String(env.TINODE_BASIC_USER) : undefined,
    basic_password: env.TINODE_BASIC_PASSWORD ? String(env.TINODE_BASIC_PASSWORD) : undefined,
    user_password_secret: env.TINODE_USER_PASSWORD_SECRET ? String(env.TINODE_USER_PASSWORD_SECRET) : undefined,
    timeout_ms: tinodeRequestTimeoutMs(env)
  });
}

export function tinodeRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.TINODE_REQUEST_TIMEOUT_MS || '').trim();
  if (!raw) return 5_000;
  return validTinodeTimeout(Number(raw));
}

export function tinodeMinimumDeliveryLeaseMs(requestTimeoutMs: number): number {
  return validTinodeTimeout(requestTimeoutMs) * 5 + 1_000;
}

export function tinodeTopicNameForSession(tenantId: string, sessionId: string): string {
  return `grp_${stableTinodeToken(tenantId)}_${stableTinodeToken(sessionId)}`;
}

function tinodeUserNameForIdentity(tenantId: string, identity: string): string {
  return `usr_${stableTinodeToken(tenantId)}_${stableTinodeToken(identity)}`;
}

function stableTinodeToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'default';
}

export interface TinodeGatewayConfig {
  base_url: string;
  ws_url?: string;
  api_key?: string;
  auth_token?: string;
  basic_user?: string;
  basic_password?: string;
  user_password_secret?: string;
  timeout_ms?: number;
}

interface TinodeCtrl {
  id?: string;
  topic?: string;
  code?: number;
  text?: string;
  params?: Record<string, unknown>;
}

class TinodeRequestError extends Error {
  constructor(readonly code: number, text?: string) {
    super(`Tinode request failed: ${code} ${text || ''}`.trim());
  }
}

class TinodeWireClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private helloSent = false;
  private loggedIn = false;
  private readonly pending = new Map<string, {
    resolve: (ctrl: TinodeCtrl) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly config: TinodeGatewayConfig) {}

  async createBasicAccount(input: ChatUserInput): Promise<{
    provider_user_id: string;
    provider_auth_token: string;
    username: string;
  }> {
    await this.connectAndHello();
    const username = tinodeBasicUsernameForIdentity(input.tenant_id, input.identity);
    const legacyUsername = legacyTinodeBasicUsernameForIdentity(input.tenant_id, input.identity);
    const password = tinodeBasicPasswordForIdentity(this.config.user_password_secret || '', input.tenant_id, input.identity);
    if (legacyUsername !== username) {
      try {
        return await this.loginBasicAccount(legacyUsername, password);
      } catch (error) {
        if (!(error instanceof TinodeRequestError) || ![401, 404].includes(error.code)) throw error;
      }
    }
    let ctrl: TinodeCtrl;
    try {
      ctrl = await this.request('acc', {
        user: `new${stableTinodeToken(input.tenant_id)}_${stableTinodeToken(input.identity)}`,
        scheme: 'basic',
        secret: Buffer.from(`${username}:${password}`).toString('base64'),
        login: true,
        tags: [
          `opc:${stableTinodeToken(input.tenant_id)}`,
          `opc-user:${stableTinodeToken(input.identity)}`
        ],
        desc: {
          defacs: {
            auth: 'JRWS',
            anon: 'N'
          },
          public: {
            fn: input.display_name || input.identity,
            'x-opc-tenant': input.tenant_id,
            'x-opc-identity': input.identity
          },
          private: {
            source: 'opc-ivekit',
            tenant_id: input.tenant_id,
            identity: input.identity
          }
        }
      });
    } catch (error) {
      if (error instanceof TinodeRequestError && (error.code === 304 || error.code === 409)) {
        return this.loginBasicAccount(username, password);
      }
      throw error;
    }
    const providerUserId = String(ctrl.params?.user || '').trim();
    const token = String(ctrl.params?.token || '').trim();
    if (!providerUserId) throw new Error('Tinode did not return user id');
    return { provider_user_id: providerUserId, provider_auth_token: token, username };
  }

  async createGroupTopic(input: ChatTopicInput): Promise<string> {
    await this.connectAndLogin();
    const ctrl = await this.request('sub', {
      topic: 'new',
      set: {
        desc: {
          public: {
            fn: input.title || input.session_id,
            'x-opc-tenant': input.tenant_id,
            'x-opc-session': input.session_id
          }
        }
      }
    });
    const topic = String(ctrl.topic || ctrl.params?.topic || '').trim();
    if (!topic) throw new Error('Tinode did not return topic id');
    return topic;
  }

  async publishText(topic: string, body: string, metadata?: Record<string, unknown>): Promise<string> {
    await this.connectAndLogin();
    await this.request('sub', { topic });
    const head = tinodePublishHead(metadata);
    const ctrl = await this.request('pub', {
      topic,
      noecho: true,
      ...(Object.keys(head).length ? { head } : {}),
      content: body
    });
    return String(ctrl.params?.seq || ctrl.params?.seq_id || ctrl.id || '');
  }

  async grantTopicAccess(topic: string, user: string, mode: string): Promise<void> {
    await this.connectAndLogin();
    await this.request('sub', { topic, bkg: true });
    try {
      await this.request('set', {
        topic,
        sub: { user, mode }
      });
    } catch (error) {
      if (!(error instanceof TinodeRequestError) || error.code !== 304) throw error;
    }
  }

  close(): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Tinode request ${id} cancelled`));
    }
    this.pending.clear();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
  }

  private async connectAndLogin(): Promise<void> {
    await this.connectAndHello();
    if (this.loggedIn) return;
    await this.request('login', this.loginPayload());
    this.loggedIn = true;
  }

  private async loginBasicAccount(username: string, password: string): Promise<{
    provider_user_id: string;
    provider_auth_token: string;
    username: string;
  }> {
    const ctrl = await this.request('login', {
      scheme: 'basic',
      secret: Buffer.from(`${username}:${password}`).toString('base64')
    });
    this.loggedIn = true;
    const providerUserId = String(ctrl.params?.user || '').trim();
    const token = String(ctrl.params?.token || '').trim();
    if (!providerUserId) throw new Error('Tinode did not return user id');
    return { provider_user_id: providerUserId, provider_auth_token: token, username };
  }

  private async connectAndHello(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.helloSent) return;
    const wsUrl = resolveTinodeWsUrl(this.config);
    if (!wsUrl) throw new Error('Tinode websocket URL is not configured');
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.socket = new WebSocket(wsUrl);
      this.socket.on('message', (raw) => this.handleMessage(raw));
      this.socket.on('error', (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
      this.socket.on('close', () => this.rejectAll(new Error('Tinode websocket closed')));
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Tinode websocket open timeout')), this.timeoutMs());
        this.socket!.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        this.socket!.once('error', (error) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    }
    await this.request('hi', {
      ver: '0.22',
      ua: 'OPC iveKit ChatGateway'
    });
    this.helloSent = true;
  }

  private loginPayload(): Record<string, unknown> {
    if (this.config.auth_token) {
      return { scheme: 'token', secret: this.config.auth_token };
    }
    if (this.config.basic_user) {
      const raw = `${this.config.basic_user}:${this.config.basic_password || ''}`;
      return { scheme: 'basic', secret: Buffer.from(raw).toString('base64') };
    }
    throw new Error('Tinode auth token or basic credentials are required');
  }

  private request(kind: 'hi' | 'acc' | 'login' | 'sub' | 'set' | 'pub', payload: Record<string, unknown>): Promise<TinodeCtrl> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Tinode websocket is not open'));
    }
    const id = `opc-${this.nextId++}`;
    const message = { [kind]: { id, ...payload } };
    const promise = new Promise<TinodeCtrl>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tinode ${kind} request timed out`));
      }, this.timeoutMs());
      this.pending.set(id, { resolve, reject, timer });
    });
    socket.send(JSON.stringify(message));
    return promise;
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let packet: { ctrl?: TinodeCtrl };
    try {
      packet = JSON.parse(String(raw)) as { ctrl?: TinodeCtrl };
    } catch {
      return;
    }
    const ctrl = packet.ctrl;
    if (!ctrl?.id) return;
    const pending = this.pending.get(ctrl.id);
    if (!pending) return;
    this.pending.delete(ctrl.id);
    clearTimeout(pending.timer);
    if (ctrl.code && ctrl.code >= 300) {
      pending.reject(new TinodeRequestError(ctrl.code, ctrl.text));
      return;
    }
    pending.resolve(ctrl);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private timeoutMs(): number {
    return validTinodeTimeout(this.config.timeout_ms ?? 5_000);
  }
}

function validTinodeTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 250 || value > 60_000) {
    throw new Error('Tinode request timeout must be an integer between 250 and 60000 milliseconds');
  }
  return value;
}

function tinodePublishHead(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const messageId = safeTinodeHeadValue(metadata?.opc_message_id);
  const idempotencyKey = safeTinodeHeadValue(metadata?.idempotency_key);
  return {
    ...(messageId ? { 'x-opc-message-id': messageId } : {}),
    ...(idempotencyKey ? { 'x-opc-idempotency-key': idempotencyKey } : {})
  };
}

function safeTinodeHeadValue(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) return '';
  return normalized.slice(0, 128);
}

function tinodeMetadataUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, value.endsWith('/') ? '/' : '');
  } catch {
    return '';
  }
}

function resolveTinodeWsUrl(config: TinodeGatewayConfig): string {
  const raw = String(config.ws_url || '').trim() || defaultTinodeWsUrl(config.base_url);
  if (!raw) return '';
  const url = new URL(raw);
  if (config.api_key && !url.searchParams.has('apikey')) {
    url.searchParams.set('apikey', config.api_key);
  }
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

export function tinodeBasicUsernameForIdentity(tenantId: string, identity: string): string {
  const suffix = createHash('sha256')
    .update(`${tenantId}:${identity}`)
    .digest('hex')
    .slice(0, 12);
  const tenant = stableTinodeToken(tenantId).slice(0, 4) || 'none';
  const participant = stableTinodeToken(identity).slice(0, 4) || 'none';
  return `opc_${tenant}_${participant}_${suffix}`;
}

export function legacyTinodeBasicUsernameForIdentity(tenantId: string, identity: string): string {
  const readable = `opc_${stableTinodeToken(tenantId)}_${stableTinodeToken(identity)}`;
  if (readable.length <= 26) return readable;
  const suffix = createHash('sha256')
    .update(`${tenantId}:${identity}`)
    .digest('hex')
    .slice(0, 12);
  return `${readable.slice(0, 13)}_${suffix}`;
}

function tinodeBasicPasswordForIdentity(secret: string, tenantId: string, identity: string): string {
  if (!secret) throw new Error('Tinode user password secret is required');
  return `opc_${createHmac('sha256', secret)
    .update(`${tenantId}:${identity}`)
    .digest('base64url')
    .slice(0, 28)}`;
}
