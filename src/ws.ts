import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyAccessToken } from './middleware/auth.js';
import { getRedisPubSub } from './redis-pubsub.js';

export interface WsClient {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  role: string;
  expiresAt?: number;
  expiryTimer?: NodeJS.Timeout;
}

interface WsEnvelope {
  type: string;
  data?: unknown;
  timestamp?: string;
}

const clientsByTenant = new Map<string, Set<WsClient>>();
let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let pubSubStarted = false;

const WS_BROADCAST_CHANNEL = 'ws:broadcast';

export function initWebSocket(server: HttpServer): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({
    server,
    path: '/ws',
    handleProtocols: (protocols) => protocols.has('ivekit.v1') ? 'ivekit.v1' : false
  });

  wss.on('connection', (ws, req) => {
    const token = websocketAccessToken(req.headers['sec-websocket-protocol']) ||
      new URL(req.url || '/ws', 'http://localhost').searchParams.get('token');
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
      expiresAt: auth.expiresAt
    };

    if (auth.expiresAt) {
      const remainingMs = Math.max(0, auth.expiresAt * 1_000 - Date.now());
      client.expiryTimer = setTimeout(() => ws.close(4001, 'access token expired'), remainingMs);
      client.expiryTimer.unref?.();
    }

    addClient(client);
    sendToSocket(ws, { type: 'connected', data: { userId: auth.userId, tenantId: auth.tenantId } });

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

export function wsBroadcast(tenantId: string, event: string, data: unknown): void {
  broadcastLocal(tenantId, event, data);
  void getRedisPubSub()
    .then((redis) => redis.publish(WS_BROADCAST_CHANNEL, JSON.stringify({ tenantId, event, data })))
    .catch((error) => {
      console.warn('[ws] redis publish failed:', error);
    });
}

export function wsBroadcastToUsers(
  tenantId: string,
  userIds: string[],
  event: string,
  data: unknown
): void {
  const recipients = [...new Set(userIds.map((userId) => String(userId || '').trim()).filter(Boolean))];
  if (recipients.length === 0) return;
  broadcastLocal(tenantId, event, data, new Set(recipients));
  void getRedisPubSub()
    .then((redis) => redis.publish(
      WS_BROADCAST_CHANNEL,
      JSON.stringify({ tenantId, userIds: recipients, event, data })
    ))
    .catch((error) => {
      console.warn('[ws] redis targeted publish failed:', error);
    });
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

function broadcastLocal(
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
      sendToSocket(client.ws, envelope);
    }
  }
}

function sendToSocket(ws: WebSocket, envelope: WsEnvelope): void {
  ws.send(JSON.stringify(envelope));
}

async function startPubSubListener(): Promise<void> {
  if (pubSubStarted) return;
  pubSubStarted = true;
  try {
    const redis = await getRedisPubSub();
    await redis.subscribe(WS_BROADCAST_CHANNEL, (message) => {
      try {
        const parsed = JSON.parse(message) as {
          tenantId?: string;
          userIds?: string[];
          event?: string;
          data?: unknown;
        };
        if (!parsed.tenantId || !parsed.event) return;
        broadcastLocal(
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
}
