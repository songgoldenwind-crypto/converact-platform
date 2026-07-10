import { createHmac, timingSafeEqual } from 'node:crypto';

import type { RemoteConsentScope } from './types.js';
import type { RustDeskGatewaySession } from './rustdesk-gateway-session-store.js';
import type { RemoteGatewayTarget } from './remote-gateway-adapter.js';
import { rustDeskApiServer, rustDeskPublicKey, rustDeskServerKeyFingerprint } from './rustdesk-client-config.js';

export interface RustDeskGatewayLaunchPlan {
  external_id: string;
  status: RustDeskGatewaySession['status'];
  launch_url: string;
  target: RemoteGatewayTarget;
  permissions: RemoteConsentScope[];
  runtime: {
    rustdesk_id: string;
    id_server: string;
    relay_server: string;
    api_server: string;
    server_key_fingerprint: string;
    public_key_configured: string;
    public_key_source: string;
  };
  client_config: {
    public_key_configured: boolean;
    public_key_source: string;
    manual_fields: {
      id_server: string;
      relay_server: string;
      api_server?: string;
      key: string;
    };
  };
  actions: {
    can_launch: boolean;
    open_url: string;
    protocol_url: string;
  };
  metadata: Record<string, unknown>;
  created_at: string;
  ended_at: string | null;
}

export function rustDeskLaunchUrl(externalId: string): string {
  const baseUrl = normalizeRustDeskLaunchBaseUrl(String(
    process.env.OPC_RUSTDESK_LAUNCH_BASE_URL ||
    process.env.OPC_BASE_URL ||
    process.env.OPC_REMOTE_GATEWAY_BASE_URL ||
    'http://localhost:3000'
  ));
  const expiresAt = new Date(Date.now() + rustDeskLaunchTokenTtlMs()).toISOString();
  const token = rustDeskLaunchToken(externalId, expiresAt);
  if (!token) throw new Error('RustDesk launch secret is not configured');
  const params = new URLSearchParams({
    session_id: externalId,
    expires_at: expiresAt,
    token
  });
  return `${baseUrl}/remote/rustdesk/launch?${params.toString()}`;
}

function normalizeRustDeskLaunchBaseUrl(rawBaseUrl: string): string {
  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('RustDesk launch base URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('RustDesk launch base URL must use http(s)');
  }
  return baseUrl;
}

export function isValidRustDeskLaunchToken(externalId: string, token: string, expiresAt: string): boolean {
  const expiresAtMs = new Date(String(expiresAt || '').trim()).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
  const expected = rustDeskLaunchToken(externalId, expiresAt);
  if (!expected || !token) return false;
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  if (expectedBuffer.length !== tokenBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, tokenBuffer);
}

export function rustDeskRuntimeMetadata(input: Record<string, unknown>, target: RemoteGatewayTarget): Record<string, unknown> {
  const metadata = bodyObject(input.metadata);
  const fingerprint = rustDeskServerKeyFingerprint();
  const apiServer = rustDeskApiServer();
  if (apiServer.error) throw new Error(apiServer.error);
  return {
    ...metadata,
    rustdesk_id: target.id,
    id_server: String(process.env.OPC_RUSTDESK_ID_SERVER || ''),
    relay_server: String(process.env.OPC_RUSTDESK_RELAY_SERVER || ''),
    api_server: apiServer.value,
    ...(fingerprint ? { server_key_fingerprint: fingerprint } : {})
  };
}

export function rustDeskLaunchPlan(session: RustDeskGatewaySession): RustDeskGatewayLaunchPlan {
  const runtime = rustDeskRuntimeFromSession(session);
  const canLaunch = session.status === 'active';
  return {
    external_id: session.external_id,
    status: session.status,
    launch_url: canLaunch ? session.launch_url : '',
    target: session.target,
    permissions: session.permissions,
    runtime,
    client_config: rustDeskClientConfigForLaunch(runtime),
    actions: {
      can_launch: canLaunch,
      open_url: canLaunch ? session.launch_url : '',
      protocol_url: canLaunch ? rustDeskProtocolUrl(session, runtime) : ''
    },
    metadata: session.metadata,
    created_at: session.created_at,
    ended_at: session.ended_at
  };
}

export function rustDeskLaunchHtml(plan: RustDeskGatewayLaunchPlan): string {
  const protocolLink = plan.actions.protocol_url
    ? `<a class="button" href="${escapeHtml(plan.actions.protocol_url)}">Open RustDesk</a>`
    : '<span class="muted">RustDesk protocol URL is not configured.</span>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RustDesk Remote Launch</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f7f8fa; }
    main { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
    h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.2; }
    dl { display: grid; grid-template-columns: 160px 1fr; gap: 10px 16px; margin: 24px 0; }
    dt { color: #5b6673; }
    dd { margin: 0; word-break: break-word; }
    .button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px; border-radius: 6px; background: #1769aa; color: #fff; text-decoration: none; }
    .muted { color: #6b7280; }
    pre { overflow: auto; padding: 16px; border-radius: 6px; background: #111827; color: #f9fafb; }
  </style>
</head>
<body>
  <main>
    <h1>RustDesk Remote Launch</h1>
    <dl>
      <dt>Session</dt><dd>${escapeHtml(plan.external_id)}</dd>
      <dt>Status</dt><dd>${escapeHtml(plan.status)}</dd>
      <dt>Target</dt><dd>${escapeHtml(plan.target.display_name || plan.target.id)}</dd>
      <dt>RustDesk ID</dt><dd>${escapeHtml(plan.runtime.rustdesk_id)}</dd>
      <dt>ID server</dt><dd>${escapeHtml(plan.runtime.id_server || '-')}</dd>
      <dt>Relay server</dt><dd>${escapeHtml(plan.runtime.relay_server || '-')}</dd>
      <dt>API server</dt><dd>${escapeHtml(plan.runtime.api_server || '-')}</dd>
      <dt>Server key</dt><dd>${escapeHtml(plan.runtime.server_key_fingerprint || '-')}</dd>
    </dl>
    ${protocolLink}
    <pre id="launch-plan">${escapeHtml(JSON.stringify(plan, null, 2))}</pre>
  </main>
  <script>window.__RUSTDESK_LAUNCH_PLAN__ = ${jsonForHtml(plan)};</script>
</body>
</html>`;
}

function rustDeskLaunchSecret(): string {
  return String(
    process.env.OPC_RUSTDESK_LAUNCH_SECRET ||
    process.env.OPC_RUSTDESK_API_TOKEN ||
    process.env.OPC_REMOTE_GATEWAY_API_TOKEN ||
    process.env.OPC_RUSTDESK_SERVER_KEY ||
    ''
  ).trim();
}

function rustDeskLaunchTokenTtlMs(): number {
  const rawTtl = String(process.env.OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS || '').trim();
  if (!rawTtl) return 15 * 60 * 1000;
  if (!/^\d+$/.test(rawTtl)) {
    throw new Error('RustDesk launch token ttl must be a positive integer');
  }
  const ttlMs = Number(rawTtl);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('RustDesk launch token ttl must be a positive integer');
  }
  return ttlMs;
}

function rustDeskLaunchToken(externalId: string, expiresAt: string): string {
  const secret = rustDeskLaunchSecret();
  if (!secret) return '';
  return createHmac('sha256', secret).update(`${externalId}:${expiresAt}`).digest('hex');
}

function rustDeskRuntimeFromSession(session: RustDeskGatewaySession): RustDeskGatewayLaunchPlan['runtime'] {
  const metadata = session.metadata || {};
  const publicKey = rustDeskPublicKey();
  const apiServer = rustDeskApiServer();
  if (apiServer.error) throw new Error(apiServer.error);
  return {
    rustdesk_id: String(metadata.rustdesk_id || session.target.id),
    id_server: String(metadata.id_server || process.env.OPC_RUSTDESK_ID_SERVER || ''),
    relay_server: String(metadata.relay_server || process.env.OPC_RUSTDESK_RELAY_SERVER || ''),
    api_server: String(metadata.api_server || apiServer.value),
    server_key_fingerprint: String(metadata.server_key_fingerprint || rustDeskServerKeyFingerprint()),
    public_key_configured: publicKey.value ? 'true' : 'false',
    public_key_source: publicKey.source
  };
}

function rustDeskClientConfigForLaunch(
  runtime: RustDeskGatewayLaunchPlan['runtime']
): RustDeskGatewayLaunchPlan['client_config'] {
  const publicKey = rustDeskPublicKey();
  return {
    public_key_configured: Boolean(publicKey.value),
    public_key_source: publicKey.source,
    manual_fields: {
      id_server: runtime.id_server,
      relay_server: runtime.relay_server,
      ...(runtime.api_server ? { api_server: runtime.api_server } : {}),
      key: publicKey.value
    }
  };
}

function rustDeskProtocolUrl(
  session: RustDeskGatewaySession,
  runtime: RustDeskGatewayLaunchPlan['runtime']
): string {
  const template = String(process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE || '').trim();
  if (!template) return '';
  const replacements: Record<string, string> = {
    external_id: session.external_id,
    rustdesk_id: runtime.rustdesk_id,
    id_server: runtime.id_server,
    relay_server: runtime.relay_server,
    api_server: runtime.api_server,
    public_key: rustDeskPublicKey().value
  };
  const protocolUrl = template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(replacements, key)) {
      throw new Error(`RustDesk protocol URL template contains unsupported placeholder: ${key}`);
    }
    return encodeURIComponent(replacements[key] || '');
  });
  if (!isRustDeskProtocolUrl(protocolUrl)) {
    throw new Error('RustDesk protocol URL template must produce a rustdesk:// URL');
  }
  return protocolUrl;
}

export function isRustDeskProtocolUrl(protocolUrl: string): boolean {
  const value = protocolUrl.trim();
  if (!value.toLowerCase().startsWith('rustdesk://')) return false;
  try {
    return new URL(value).protocol === 'rustdesk:';
  } catch {
    return false;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonForHtml(value: unknown): string {
  return (JSON.stringify(value) || 'null').replace(/</g, '\\u003c');
}

function bodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
