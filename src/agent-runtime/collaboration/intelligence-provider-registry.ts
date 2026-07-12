import { isIP } from 'node:net';

export type IntelligenceProviderCapability = 'ocr' | 'asr' | 'quality_review' | 'translation';
export type IntelligenceProviderMode = 'self_hosted' | 'third_party';

export interface IntelligenceProviderProfile {
  id: string;
  capability: IntelligenceProviderCapability;
  mode: IntelligenceProviderMode;
  base_url: string;
  endpoint: string;
  health_endpoint: string;
  token_env: string;
  timeout_ms: number;
  name: string;
  legacy: boolean;
}

export interface SafeIntelligenceProviderProfile {
  id: string;
  capability: IntelligenceProviderCapability;
  mode: IntelligenceProviderMode;
  name: string;
  configured: boolean;
  token_configured: boolean;
}

export interface IntelligenceProviderRegistry {
  list(): IntelligenceProviderProfile[];
  listSafe(): SafeIntelligenceProviderProfile[];
  profile(id: string): IntelligenceProviderProfile | null;
  requireProfile(id: string, capability: IntelligenceProviderCapability): IntelligenceProviderProfile;
  defaultProfile(capability: IntelligenceProviderCapability): IntelligenceProviderProfile | null;
  resolveToken(profile: IntelligenceProviderProfile): string | undefined;
}

const CAPABILITIES = new Set<IntelligenceProviderCapability>([
  'ocr',
  'asr',
  'quality_review',
  'translation'
]);
const MODES = new Set<IntelligenceProviderMode>(['self_hosted', 'third_party']);
const PROFILE_FIELDS = new Set([
  'id',
  'capability',
  'mode',
  'base_url',
  'endpoint',
  'health_endpoint',
  'token_env',
  'timeout_ms',
  'name'
]);

export function createIntelligenceProviderRegistry(
  env: NodeJS.ProcessEnv = process.env
): IntelligenceProviderRegistry {
  const profiles = parseConfiguredProfiles(env.OPC_IVEKIT_PROVIDER_PROFILES_JSON);
  const defaults = new Map<IntelligenceProviderCapability, string>();
  for (const legacy of legacyProfiles(env)) {
    if (profiles.some((profile) => profile.id === legacy.id)) {
      throw new Error(`duplicate provider profile id: ${legacy.id}`);
    }
    profiles.push(legacy);
    defaults.set(legacy.capability, legacy.id);
  }
  const byId = new Map<string, IntelligenceProviderProfile>();
  for (const profile of profiles) {
    if (byId.has(profile.id)) throw new Error(`duplicate provider profile id: ${profile.id}`);
    byId.set(profile.id, profile);
  }

  return {
    list: () => profiles.map(copyProfile),
    listSafe: () => profiles.map((profile) => ({
      id: profile.id,
      capability: profile.capability,
      mode: profile.mode,
      name: profile.name,
      configured: true,
      token_configured: !profile.token_env || Boolean(String(env[profile.token_env] || '').trim())
    })),
    profile: (id) => {
      const profile = byId.get(String(id || '').trim());
      return profile ? copyProfile(profile) : null;
    },
    requireProfile: (id, capability) => {
      const profile = byId.get(String(id || '').trim());
      if (!profile) throw new Error(`provider profile not found: ${id}`);
      if (profile.capability !== capability) {
        throw new Error(`provider profile ${id} has capability ${profile.capability}, expected ${capability}`);
      }
      return copyProfile(profile);
    },
    defaultProfile: (capability) => {
      const id = defaults.get(capability);
      const profile = id ? byId.get(id) : undefined;
      return profile ? copyProfile(profile) : null;
    },
    resolveToken: (profile) => {
      const trustedProfile = byId.get(String(profile.id || '').trim());
      if (!trustedProfile) throw new Error(`provider profile not found: ${profile.id}`);
      if (!trustedProfile.token_env) return undefined;
      const value = String(env[trustedProfile.token_env] || '').trim();
      return value || undefined;
    }
  };
}

function parseConfiguredProfiles(raw: string | undefined): IntelligenceProviderProfile[] {
  if (!String(raw || '').trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error('OPC_IVEKIT_PROVIDER_PROFILES_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('OPC_IVEKIT_PROVIDER_PROFILES_JSON must be an array');
  if (parsed.length > 100) throw new Error('provider profile count cannot exceed 100');
  return parsed.map((profile, index) => normalizeProfile(profile, `provider profile ${index + 1}`, false));
}

function normalizeProfile(value: unknown, label: string, legacy: boolean): IntelligenceProviderProfile {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const unsupported = Object.keys(value).filter((field) => !PROFILE_FIELDS.has(field));
  if (unsupported.length) throw new Error(`${label} has unsupported field: ${unsupported[0]}`);
  const id = String(value.id || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`${label} profile id must be lowercase and contain only letters, digits, _ or -`);
  }
  const capability = String(value.capability || '').trim() as IntelligenceProviderCapability;
  if (!CAPABILITIES.has(capability)) throw new Error(`${label} capability is invalid`);
  const mode = String(value.mode || '').trim() as IntelligenceProviderMode;
  if (!MODES.has(mode)) throw new Error(`${label} mode must be self_hosted or third_party`);
  const baseUrl = normalizeBaseUrl(value.base_url, mode, label);
  const endpoint = normalizeEndpoint(value.endpoint, defaultEndpoint(capability), `${label} endpoint`);
  const healthEndpoint = normalizeEndpoint(value.health_endpoint, '/health', `${label} health_endpoint`);
  const tokenEnv = String(value.token_env || '').trim();
  if (tokenEnv && !/^[A-Z][A-Z0-9_]{1,127}$/.test(tokenEnv)) {
    throw new Error(`${label} token_env must name an uppercase environment variable`);
  }
  const timeoutMs = value.timeout_ms == null ? 30_000 : Number(value.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error(`${label} timeout_ms must be between 1000 and 300000`);
  }
  const name = String(value.name || id).trim();
  if (!name || name.length > 100) throw new Error(`${label} name must be between 1 and 100 characters`);
  return {
    id,
    capability,
    mode,
    base_url: baseUrl,
    endpoint,
    health_endpoint: healthEndpoint,
    token_env: tokenEnv,
    timeout_ms: timeoutMs,
    name,
    legacy
  };
}

function legacyProfiles(env: NodeJS.ProcessEnv): IntelligenceProviderProfile[] {
  const definitions: Array<{
    capability: IntelligenceProviderCapability;
    id: string;
    prefix: string;
    endpoint: string;
  }> = [
    { capability: 'ocr', id: 'legacy-ocr', prefix: 'OPC_OCR', endpoint: '/v1/ocr' },
    { capability: 'asr', id: 'legacy-asr', prefix: 'OPC_ASR', endpoint: '/v1/asr' },
    {
      capability: 'quality_review',
      id: 'legacy-quality',
      prefix: 'OPC_QUALITY_REVIEW',
      endpoint: '/v1/quality-review'
    },
    {
      capability: 'translation',
      id: 'legacy-translation',
      prefix: 'OPC_TRANSLATION',
      endpoint: '/v1/translate'
    }
  ];
  const profiles: IntelligenceProviderProfile[] = [];
  for (const definition of definitions) {
    const baseUrl = String(env[`${definition.prefix}_BASE_URL`] || '').trim();
    if (!baseUrl) continue;
    const mode = String(env[`${definition.prefix}_PROVIDER_MODE`] || 'self_hosted').trim();
    const defaultName = definition.capability === 'quality_review'
      ? `${mode}-quality-review`
      : `${mode}-${definition.capability}`;
    profiles.push(normalizeProfile({
      id: definition.id,
      capability: definition.capability,
      mode,
      base_url: baseUrl,
      endpoint: env[`${definition.prefix}_ENDPOINT`] || definition.endpoint,
      health_endpoint: env[`${definition.prefix}_HEALTH_ENDPOINT`] || '/health',
      token_env: env[`${definition.prefix}_TOKEN`] ? `${definition.prefix}_TOKEN` : '',
      timeout_ms: env[`${definition.prefix}_TIMEOUT_MS`]
        ? Number(env[`${definition.prefix}_TIMEOUT_MS`])
        : 30_000,
      name: env[`${definition.prefix}_PROVIDER_NAME`] || defaultName
    }, definition.id, true));
  }
  return profiles;
}

function normalizeBaseUrl(
  value: unknown,
  mode: IntelligenceProviderMode,
  label: string
): string {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} base_url must be an absolute HTTP URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} base_url must use HTTP or HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${label} base_url cannot contain credentials`);
  if (url.search) throw new Error(`${label} base_url cannot contain a query`);
  if (url.hash) throw new Error(`${label} base_url cannot contain a fragment`);
  if (mode === 'third_party' && url.protocol !== 'https:') {
    throw new Error(`${label} third-party base_url must use HTTPS`);
  }
  if (mode === 'self_hosted' && url.protocol === 'http:' && !isPrivateOrContainerHost(url.hostname)) {
    throw new Error(`${label} self-hosted HTTP base_url must use a private or container host`);
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeEndpoint(value: unknown, fallback: string, label: string): string {
  const endpoint = String(value || fallback).trim();
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('..')) {
    throw new Error(`${label} must be an absolute path without traversal`);
  }
  if (endpoint.includes('?') || endpoint.includes('#') || endpoint.includes('\\')) {
    throw new Error(`${label} cannot contain query, fragment, or backslash`);
  }
  return endpoint;
}

function defaultEndpoint(capability: IntelligenceProviderCapability): string {
  if (capability === 'quality_review') return '/v1/quality-review';
  if (capability === 'translation') return '/v1/translate';
  return `/v1/${capability}`;
}

function isPrivateOrContainerHost(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = hostname.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ipVersion === 6) {
    return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
  }
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(hostname);
}

function copyProfile(profile: IntelligenceProviderProfile): IntelligenceProviderProfile {
  return { ...profile };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
