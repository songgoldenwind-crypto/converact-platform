import type { RemoteToolProvider } from './types.js';

export interface NormalizedExternalRemoteTool {
  provider: RemoteToolProvider;
  external_id: string;
  launch_url: string;
  metadata: Record<string, unknown>;
}

export function normalizeExternalRemoteTool(input: {
  provider: RemoteToolProvider;
  external_id?: string;
  launch_url?: string;
  metadata?: Record<string, unknown>;
}): NormalizedExternalRemoteTool {
  const provider = String(input.provider || 'external_link').toLowerCase();
  const externalId = String(input.external_id || '').trim();
  const launchUrl = String(input.launch_url || defaultLaunchUrl(provider, externalId)).trim();
  return {
    provider,
    external_id: externalId,
    launch_url: launchUrl,
    metadata: {
      ...(input.metadata || {}),
      normalized_provider: provider,
      normalized_external_id: normalizeExternalId(provider, externalId)
    }
  };
}

function defaultLaunchUrl(provider: string, externalId: string): string {
  const compact = normalizeExternalId(provider, externalId);
  if (!compact) return '';
  switch (provider) {
    case 'anydesk':
      return `anydesk:${compact}`;
    case 'teamviewer':
      return `teamviewer10://control?device=${encodeURIComponent(compact)}`;
    case 'rustdesk':
      return `rustdesk:${compact}`;
    case 'zoom':
    case 'google_meet':
    case 'external_link':
    default:
      return externalId.startsWith('http://') || externalId.startsWith('https://') ? externalId : '';
  }
}

function normalizeExternalId(provider: string, externalId: string): string {
  if (provider === 'anydesk' || provider === 'teamviewer') {
    return externalId.replace(/\D/g, '');
  }
  return externalId.trim();
}
