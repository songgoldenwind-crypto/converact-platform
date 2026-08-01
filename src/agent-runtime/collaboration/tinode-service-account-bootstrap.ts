import { resolveConveractEnv } from '../../config/converact-env.js';
import { Pool } from 'pg';

import type { PgQueryable } from '../../db-pg.js';
import { tinodeServerApiKey } from './tinode-env.js';

const TINODE_ROOT_AUTH_LEVEL = 30;

export interface TinodeServiceAccountBootstrapConfig {
  wsUrl: string;
  apiKey: string;
  username: string;
  password: string;
  timeoutMs: number;
  postgresDsn?: string;
}

export interface TinodeServiceAccountBootstrapResult {
  status: 'created' | 'existing';
  authLevel: 'root';
}

interface WebSocketLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;
type TinodeRootAccountPromoter = (username: string) => Promise<void>;

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
  const apiKey = tinodeServerApiKey(env);
  if (!apiKey) throw new Error('TINODE_ROOT_API_KEY is required');
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
  const postgresDsn = required(env, 'TINODE_POSTGRES_DSN');
  let parsedPostgresDsn: URL;
  try {
    parsedPostgresDsn = new URL(postgresDsn);
  } catch {
    throw new Error('TINODE_POSTGRES_DSN must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsedPostgresDsn.protocol)) {
    throw new Error('TINODE_POSTGRES_DSN must use postgres or postgresql');
  }
  return { wsUrl, apiKey, username, password, timeoutMs, postgresDsn };
}

export async function bootstrapTinodeServiceAccount(
  config: TinodeServiceAccountBootstrapConfig,
  WebSocketImpl: WebSocketConstructor = globalThis.WebSocket as unknown as WebSocketConstructor,
  rootAccountPromoter?: TinodeRootAccountPromoter
): Promise<TinodeServiceAccountBootstrapResult> {
  if (!WebSocketImpl) throw new Error('WebSocket runtime is unavailable');
  const initial = await ensureServiceAccount(config, WebSocketImpl);
  if (initial.authLevel === 'root') {
    return { status: initial.status, authLevel: 'root' };
  }

  const promote = rootAccountPromoter || configuredRootAccountPromoter(config);
  await promote(config.username);
  const verifiedAuthLevel = await loginServiceAccount(config, WebSocketImpl);
  if (verifiedAuthLevel !== 'root') {
    throw new Error(
      `Tinode service account must authenticate at root level after promotion; received ${verifiedAuthLevel || 'unknown'}`
    );
  }
  return { status: initial.status, authLevel: 'root' };
}

export async function promoteTinodeBasicAccountToRoot(
  pg: PgQueryable,
  username: string
): Promise<void> {
  const result = await pg.query<{ authlvl: number }>(
    `UPDATE auth
        SET authlvl = $1
      WHERE uname = $2
        AND scheme = $3
      RETURNING authlvl`,
    [TINODE_ROOT_AUTH_LEVEL, `basic:${username.toLowerCase()}`, 'basic']
  );
  if (result.rowCount !== 1 || Number(result.rows[0]?.authlvl) !== TINODE_ROOT_AUTH_LEVEL) {
    throw new Error(
      `Tinode root promotion expected exactly one basic credential, updated ${result.rowCount || 0}`
    );
  }
}

async function ensureServiceAccount(
  config: TinodeServiceAccountBootstrapConfig,
  WebSocketImpl: WebSocketConstructor
): Promise<{ status: 'created' | 'existing'; authLevel: string }> {
  return withTinodeSocket(config, WebSocketImpl, async (socket) => {
    const secret = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    try {
      const response = await request(socket, 'acc', {
        id: 'bootstrap-account',
        user: `new${config.username}`,
        scheme: 'basic',
        secret,
        login: true,
        tags: ['converact:service-account'],
        desc: {
          defacs: { auth: 'JRWS', anon: 'N' },
          public: { fn: 'Converact Fabric service' },
          private: { source: 'converact-fabric-bootstrap' }
        }
      }, config.timeoutMs);
      return { status: 'created', authLevel: responseAuthLevel(response) };
    } catch (error) {
      if (
        !(error instanceof TinodeBootstrapProtocolError) ||
        (error.code !== 304 && error.code !== 409)
      ) throw error;
      const response = await request(socket, 'login', {
        id: 'bootstrap-login',
        scheme: 'basic',
        secret
      }, config.timeoutMs);
      return { status: 'existing', authLevel: responseAuthLevel(response) };
    }
  });
}

async function loginServiceAccount(
  config: TinodeServiceAccountBootstrapConfig,
  WebSocketImpl: WebSocketConstructor
): Promise<string> {
  return withTinodeSocket(config, WebSocketImpl, async (socket) => {
    const response = await request(socket, 'login', {
      id: 'bootstrap-root-login',
      scheme: 'basic',
      secret: Buffer.from(`${config.username}:${config.password}`).toString('base64')
    }, config.timeoutMs);
    return responseAuthLevel(response);
  });
}

async function withTinodeSocket<T>(
  config: TinodeServiceAccountBootstrapConfig,
  WebSocketImpl: WebSocketConstructor,
  operation: (socket: WebSocketLike) => Promise<T>
): Promise<T> {
  const url = new URL(config.wsUrl);
  url.searchParams.set('apikey', config.apiKey);
  const socket = new WebSocketImpl(url.toString());
  try {
    await waitForOpen(socket, config.timeoutMs);
    await request(socket, 'hi', {
      id: 'bootstrap-hi',
      ver: '0.22',
      ua: 'Converact Fabric Tinode bootstrap'
    }, config.timeoutMs);
    return await operation(socket);
  } finally {
    socket.close();
  }
}

function configuredRootAccountPromoter(
  config: TinodeServiceAccountBootstrapConfig
): TinodeRootAccountPromoter {
  if (!config.postgresDsn) {
    throw new Error(
      'TINODE_POSTGRES_DSN is required to promote the Tinode service account to root'
    );
  }
  return async (username) => {
    const pool = new Pool({
      connectionString: config.postgresDsn,
      max: 1,
      connectionTimeoutMillis: config.timeoutMs,
      query_timeout: config.timeoutMs,
      application_name: 'converact-tinode-bootstrap'
    });
    try {
      await promoteTinodeBasicAccountToRoot(pool, username);
    } finally {
      await pool.end();
    }
  };
}

function responseAuthLevel(response: Record<string, unknown>): string {
  const params = response.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
  return String((params as Record<string, unknown>).authlvl || '').trim().toLowerCase();
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
  const value = String(resolveConveractEnv(env, key) || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
