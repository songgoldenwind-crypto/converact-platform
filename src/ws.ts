import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import type { IveKitTenantEvent } from './agent-runtime/converact/tenant-event-store.js';
import { IveKitTenantEventStore } from './agent-runtime/converact/tenant-event-store.js';
import { verifyAccessToken, type AuthRole } from './middleware/auth.js';
import { getRedisPubSub } from './redis-pubsub.js';

export interface WsClient {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  role: AuthRole;
  expiresAt?: number;
  expiryTimer?: NodeJS.Timeout;
  replaying?: boolean;
  pendingEvents?: IveKitTenantEvent[];
  deliveredEventIds?: Set<string>;
}

interface WsEnvelope {
  type: string;
  data?: unknown;
  timestamp?: string;
  event_id?: string;
  cursor?: string;
}

export interface InitWebSocketOptions {
  eventStore?: IveKitTenantEventStore;
}

interface BufferedBroadcast {
  tenantId: string;
  event: string;
  data: unknown;
  recipients: string[];
  idempotencyKey?: string;
}

export interface WsBroadcastOptions {
  idempotency_key?: string;
}

const clientsByTenant = new Map<string, Set<WsClient>>();
const broadcastBuffer = new AsyncLocalStorage<BufferedBroadcast[]>();
let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let pubSubStarted = false;
let tenantEventStore: IveKitTenantEventStore | null = null;

const WS_BROADCAST_CHANNEL = 'ws:broadcast';
const WS_INSTANCE_ID = randomUUID();
const DELIVERED_EVENT_CACHE = 1_000;

export function initWebSocket(server: HttpServer, options: InitWebSocketOptions = {}): WebSocketServer {
  if (options.eventStore) tenantEventStore = options.eventStore;
  if (wss) return wss;

  wss = new WebSocketServer({
    server,
    path: '/ws',
    handleProtocols: (protocols) => protocols.has('ivekit.v1') ? 'ivekit.v1' : false
  });

  wss.on('connection', (ws, req) => {
    const requestUrl = new URL(req.url || '/ws', 'http://localhost');
    const token = websocketAccessToken(req.headers['sec-websocket-protocol']) ||
      requestUrl.searchParams.get('token');
    const auth = verifyAccessToken(token);

    if (!auth?.tenantId || !auth.userId) {
      ws.close(4001, 'unauthorized');
      return;
    }

    const client: WsClient = {
      ws,
      tenantId: auth.tenantId,
      userId: auth.userId,
      role: auth.role,
      expiresAt: auth.expiresAt,
      replaying: Boolean(tenantEventStore),
      pendingEvents: [],
      deliveredEventIds: new Set()
    };

    if (auth.expiresAt) {
      const remainingMs = Math.max(0, auth.expiresAt * 1_000 - Date.now());
      client.expiryTimer = setTimeout(() => ws.close(4001, 'access token expired'), remainingMs);
      client.expiryTimer.unref?.();
    }

    addClient(client);
    if (tenantEventStore) {
      void initializeDurableClient(client, requestUrl.searchParams.get('cursor') || '');
    } else {
      sendToClient(client, { type: 'connected', data: { userId: auth.userId, tenantId: auth.tenantId } });
    }

    ws.on('close', () => removeClient(client));
    ws.on('error', () => removeClient(client));
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
  });

  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      const sock = ws as WebSocket & { isAlive?: boolean };
      if (sock.isAlive === false) {
        ws.terminate();
        continue;
      }
      sock.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  void startPubSubListener();
  return wss;
}

export async function wsBroadcast(tenantId: string, event: string, data: unknown): Promise<void> {
  const buffered = broadcastBuffer.getStore();
  if (buffered && isDurableIveKitEvent(event)) {
    buffered.push({ tenantId, event, data, recipients: [] });
    return;
  }
  await publishBroadcast(tenantId, event, data);
}

export async function wsBroadcastPersisted(event: IveKitTenantEvent): Promise<void> {
  if (tenantEventStore) {
    await broadcastDurableLocal(event);
    await publishRedis({ origin: WS_INSTANCE_ID, durableEvent: event });
    return;
  }
  broadcastLegacyLocal(event.tenant_id, event.type, event.data);
  await publishRedis({
    origin: WS_INSTANCE_ID,
    tenantId: event.tenant_id,
    event: event.type,
    data: event.data
  });
}

export async function wsBroadcastToUsers(
  tenantId: string,
  userIds: string[],
  event: string,
  data: unknown,
  options: WsBroadcastOptions = {}
): Promise<void> {
  const recipients = [...new Set(userIds.map((userId) => String(userId || '').trim()).filter(Boolean))];
  if (recipients.length === 0) return;
  const buffered = broadcastBuffer.getStore();
  if (buffered && isDurableIveKitEvent(event)) {
    buffered.push({ tenantId, event, data, recipients, idempotencyKey: options.idempotency_key });
    return;
  }
  await publishBroadcast(tenantId, event, data, recipients, options.idempotency_key);
}

export async function runWithWsBroadcastBuffer<T>(fn: () => Promise<T>): Promise<{
  result: T;
  flush(): Promise<void>;
}> {
  const pending: BufferedBroadcast[] = [];
  const result = await broadcastBuffer.run(pending, fn);
  return {
    result,
    async flush() {
      for (const item of pending) {
        await publishBroadcast(
          item.tenantId, item.event, item.data, item.recipients, item.idempotencyKey
        );
      }
    }
  };
}

export function getWsClientCount(tenantId?: string): number {
  if (tenantId) return clientsByTenant.get(tenantId)?.size ?? 0;
  let total = 0;
  for (const set of clientsByTenant.values()) total += set.size;
  return total;
}

export async function shutdownWebSocket(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (wss) {
    await new Promise<void>((resolve) => {
      wss!.close(() => resolve());
    });
    wss = null;
  }
  clientsByTenant.clear();
  pubSubStarted = false;
  tenantEventStore = null;
}

function addClient(client: WsClient): void {
  let set = clientsByTenant.get(client.tenantId);
  if (!set) {
    set = new Set();
    clientsByTenant.set(client.tenantId, set);
  }
  set.add(client);
}

function removeClient(client: WsClient): void {
  if (client.expiryTimer) clearTimeout(client.expiryTimer);
  client.expiryTimer = undefined;
  const set = clientsByTenant.get(client.tenantId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) clientsByTenant.delete(client.tenantId);
}

function websocketAccessToken(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const protocol = raw.split(',').map((item) => item.trim()).find((item) => item.startsWith('ivekit.jwt.'));
  return protocol ? protocol.slice('ivekit.jwt.'.length) : '';
}

function broadcastLegacyLocal(
  tenantId: string,
  event: string,
  data: unknown,
  userIds?: ReadonlySet<string>
): void {
  const set = clientsByTenant.get(tenantId);
  if (!set) return;
  const envelope: WsEnvelope = {
    type: event,
    data,
    timestamp: new Date().toISOString()
  };
  for (const client of set) {
    if (userIds && !userIds.has(client.userId)) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      sendToClient(client, envelope);
    }
  }
}

async function broadcastDurableLocal(event: IveKitTenantEvent): Promise<void> {
  const set = clientsByTenant.get(event.tenant_id);
  if (!set || !tenantEventStore) return;
  const ready: WsClient[] = [];
  for (const client of set) {
    if (client.replaying) {
      client.pendingEvents?.push(event);
      continue;
    }
    if (client.ws.readyState === WebSocket.OPEN) ready.push(client);
  }
  if (ready.length === 0) return;
  const visible = await tenantEventStore.canViewMany(
    event,
    ready.map((client) => ({ user_id: client.userId, role: client.role }))
  );
  for (let index = 0; index < ready.length; index += 1) {
    if (visible[index]) sendDurableEvent(ready[index], event);
  }
}

function sendDurableEvent(client: WsClient, event: IveKitTenantEvent): void {
  sendToClient(client, {
    type: event.type,
    data: event.data,
    timestamp: event.timestamp,
    event_id: event.event_id,
    cursor: event.cursor
  });
}

function sendToClient(client: WsClient, envelope: WsEnvelope): void {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (envelope.event_id) {
    const delivered = client.deliveredEventIds || new Set<string>();
    client.deliveredEventIds = delivered;
    if (delivered.has(envelope.event_id)) return;
    delivered.add(envelope.event_id);
    if (delivered.size > DELIVERED_EVENT_CACHE) {
      const oldest = delivered.values().next().value;
      if (oldest) delivered.delete(oldest);
    }
  }
  client.ws.send(JSON.stringify(envelope));
}

async function startPubSubListener(): Promise<void> {
  if (pubSubStarted) return;
  pubSubStarted = true;
  try {
    const redis = await getRedisPubSub();
    await redis.subscribe(WS_BROADCAST_CHANNEL, async (message) => {
      try {
        const parsed = JSON.parse(message) as {
          origin?: string;
          tenantId?: string;
          userIds?: string[];
          event?: string;
          data?: unknown;
          durableEvent?: IveKitTenantEvent;
        };
        if (parsed.origin === WS_INSTANCE_ID) return;
        if (parsed.durableEvent) {
          await broadcastDurableLocal(parsed.durableEvent);
          return;
        }
        if (!parsed.tenantId || !parsed.event) return;
        broadcastLegacyLocal(
          parsed.tenantId,
          parsed.event,
          parsed.data,
          parsed.userIds ? new Set(parsed.userIds) : undefined
        );
      } catch (error) {
        console.warn('[ws] invalid pubsub payload:', error);
      }
    });
  } catch (error) {
    pubSubStarted = false;
    console.warn('[ws] pubsub listener disabled:', error);
  }
}

/** For tests */
export function _resetWsState(): void {
  clientsByTenant.clear();
  pubSubStarted = false;
  tenantEventStore = null;
}

async function publishBroadcast(
  tenantId: string,
  event: string,
  data: unknown,
  recipients: string[] = [],
  idempotencyKey?: string
): Promise<void> {
  if (tenantEventStore && isDurableIveKitEvent(event)) {
    try {
      const durableEvent = await tenantEventStore.append({
        tenant_id: tenantId,
        type: event,
        data,
        audience_user_ids: recipients,
        idempotency_key: idempotencyKey
      });
      await broadcastDurableLocal(durableEvent);
      await publishRedis({ origin: WS_INSTANCE_ID, durableEvent });
    } catch (error) {
      console.error('[ws] durable event publish failed:', error);
    }
    return;
  }

  broadcastLegacyLocal(tenantId, event, data, recipients.length ? new Set(recipients) : undefined);
  await publishRedis({
    origin: WS_INSTANCE_ID,
    tenantId,
    ...(recipients.length ? { userIds: recipients } : {}),
    event,
    data
  });
}

async function publishRedis(payload: unknown): Promise<void> {
  try {
    const redis = await getRedisPubSub();
    await redis.publish(WS_BROADCAST_CHANNEL, JSON.stringify(payload));
  } catch (error) {
    console.warn('[ws] redis publish failed:', error);
  }
}

async function initializeDurableClient(client: WsClient, resumeCursor: string): Promise<void> {
  if (!tenantEventStore) return;
  try {
    const headCursor = await tenantEventStore.headCursor(client.tenantId);
    if (!resumeCursor) {
      sendToClient(client, {
        type: 'connected',
        data: {
          userId: client.userId,
          tenantId: client.tenantId,
          head_cursor: headCursor,
          replay_from: null,
          replayed_events: 0,
          snapshot_required: false
        }
      });
      client.replaying = false;
      await flushPendingEvents(client);
      return;
    }

    const replayed: IveKitTenantEvent[] = [];
    let cursor = resumeCursor;
    let recovery: Awaited<ReturnType<IveKitTenantEventStore['list']>> | null = null;
    do {
      recovery = await tenantEventStore.list({
        tenant_id: client.tenantId,
        user_id: client.userId,
        role: client.role,
        cursor,
        limit: 200
      });
      if (recovery.snapshot_required) break;
      replayed.push(...recovery.items);
      cursor = recovery.next_cursor;
      if (replayed.length > wsReplayLimit()) break;
    } while (recovery.has_more);

    const exceedsLimit = replayed.length > wsReplayLimit();
    if (recovery?.snapshot_required || exceedsLimit) {
      sendToClient(client, {
        type: 'connected',
        data: {
          userId: client.userId,
          tenantId: client.tenantId,
          head_cursor: headCursor,
          replay_from: resumeCursor,
          replayed_events: 0,
          snapshot_required: true,
          reason: exceedsLimit ? 'replay_limit_exceeded' : recovery?.reason
        }
      });
    } else {
      sendToClient(client, {
        type: 'connected',
        data: {
          userId: client.userId,
          tenantId: client.tenantId,
          head_cursor: headCursor,
          replay_from: resumeCursor,
          replayed_events: replayed.length,
          snapshot_required: false
        }
      });
      for (const event of replayed) sendDurableEvent(client, event);
    }
  } catch (error) {
    console.error('[ws] durable replay failed:', error);
    sendToClient(client, {
      type: 'connected',
      data: {
        userId: client.userId,
        tenantId: client.tenantId,
        head_cursor: '',
        replay_from: resumeCursor || null,
        replayed_events: 0,
        snapshot_required: true,
        reason: 'replay_unavailable'
      }
    });
  } finally {
    client.replaying = false;
    await flushPendingEvents(client);
  }
}

async function flushPendingEvents(client: WsClient): Promise<void> {
  if (!tenantEventStore || client.ws.readyState !== WebSocket.OPEN) return;
  const pending = client.pendingEvents || [];
  client.pendingEvents = [];
  for (const event of pending) {
    if (await tenantEventStore.canView(event, { user_id: client.userId, role: client.role })) {
      sendDurableEvent(client, event);
    }
  }
}

function wsReplayLimit(): number {
  const value = Number(process.env.OPC_IVEKIT_WS_REPLAY_MAX_EVENTS || 500);
  return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : 500;
}

function isDurableIveKitEvent(event: string): boolean {
  return /^(?:collaboration|ivekit|notification|remote)\./.test(event);
}
