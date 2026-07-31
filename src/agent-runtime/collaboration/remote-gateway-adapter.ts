import type { RemoteConsentScope, RemoteToolProvider } from './types.js';
import { rustDeskGatewayMetadata } from './rustdesk-gateway-security.js';

export type RemoteGatewayProvider = 'meshcentral' | 'guacamole' | 'rustdesk';

export interface RemoteGatewayTarget {
  type: 'device' | 'connection' | 'browser' | string;
  id: string;
  display_name?: string;
}

export interface RemoteGatewaySessionInput {
  provider: RemoteGatewayProvider;
  external_id: string;
  launch_url: string;
  target: RemoteGatewayTarget;
  permissions: readonly RemoteConsentScope[];
  metadata?: Record<string, unknown>;
}

export interface NormalizedRemoteGatewaySession {
  provider: RemoteToolProvider;
  external_id: string;
  launch_url: string;
  metadata: Record<string, unknown>;
}

export function normalizeRemoteGatewaySession(input: RemoteGatewaySessionInput): NormalizedRemoteGatewaySession {
  const provider = normalizeGatewayProvider(input.provider);
  const externalId = String(input.external_id || '').trim();
  const launchUrl = String(input.launch_url || '').trim();
  const metadata = input.provider === 'rustdesk'
    ? rustDeskGatewayMetadata(input.metadata)
    : input.metadata || {};
  if (!externalId) {
    throw Object.assign(new Error('remote gateway external_id is required'), { status: 400 });
  }
  if (!isHttpUrl(launchUrl)) {
    throw Object.assign(new Error('remote gateway launch_url must be http(s)'), { status: 400 });
  }
  if (!input.target?.id) {
    throw Object.assign(new Error('remote gateway target id is required'), { status: 400 });
  }
  return {
    provider,
    external_id: externalId,
    launch_url: launchUrl,
    metadata: {
      ...metadata,
      gateway_provider: provider,
      target_type: input.target.type,
      target_id: stringMetadata(metadata, 'target_id') || input.target.id,
      target_display_name: stringMetadata(metadata, 'target_display_name') || input.target.display_name || '',
      permissions: [...input.permissions]
    }
  };
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeGatewayProvider(provider: string): RemoteGatewayProvider {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'meshcentral' || normalized === 'guacamole' || normalized === 'rustdesk') {
    return normalized;
  }
  throw Object.assign(new Error('unsupported remote gateway provider'), { status: 400 });
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://');
}
