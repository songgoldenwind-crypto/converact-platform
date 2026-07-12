export type RustDeskGatewayAccessMode = 'attended' | 'unattended';

const PUBLIC_METADATA_KEYS = new Set([
  'access_mode',
  'api_server',
  'business_ref_id',
  'business_ref_type',
  'collaboration_session_id',
  'gateway_provider',
  'id_server',
  'permissions',
  'relay_server',
  'remote_session_id',
  'rustdesk_device_id',
  'rustdesk_device_last_seen_actor',
  'rustdesk_device_last_seen_at',
  'rustdesk_device_runtime_status',
  'rustdesk_id',
  'rustdesk_target_mode',
  'server_key_fingerprint',
  'site',
  'source',
  'target_display_name',
  'target_id',
  'target_type',
  'tenant_id'
]);

export function rustDeskGatewayAccessMode(value: unknown): RustDeskGatewayAccessMode {
  if (value === undefined) return 'attended';
  if (value === 'attended' || value === 'unattended') return value;
  throw Object.assign(new Error('access_mode must be attended or unattended'), { status: 400 });
}

export function rustDeskGatewayMetadata(
  value: unknown,
  field = 'RustDesk gateway metadata'
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw Object.assign(new Error(`${field} must be an object`), { status: 400 });
  }
  return copySafeRecord(value, field);
}

export function projectPublicRustDeskGatewayMetadata(value: unknown): Record<string, unknown> {
  const metadata = rustDeskGatewayMetadata(value);
  const projected: Record<string, unknown> = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    if (metadata[key] !== undefined) projected[key] = metadata[key];
  }
  return projected;
}

function copySafeRecord(value: Record<string, unknown>, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) sensitiveMetadata(path, key);
    if (entry !== undefined) result[key] = copySafeValue(entry, `${path}.${key}`);
  }
  return result;
}

function copySafeValue(value: unknown, path: string): unknown {
  if (typeof value === 'string') {
    if (isPrivateKeyMaterial(value) || isCredentialBearingUrl(value)) sensitiveMetadata(path);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => copySafeValue(entry, `${path}[${index}]`));
  if (isRecord(value)) return copySafeRecord(value, path);
  return value;
}

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = words.join('');
  if (words.some((word) => [
    'password',
    'passphrase',
    'secret',
    'token',
    'credential',
    'auth',
    'authorization',
    'cookie'
  ].includes(word))) return true;
  return joined.includes('password') ||
    joined.includes('passphrase') ||
    joined.includes('secret') ||
    joined.includes('token') ||
    joined.includes('credential') ||
    joined.includes('privatekey') ||
    joined.includes('apikey') ||
    (joined.includes('auth') && !joined.startsWith('author')) ||
    joined.includes('authorization') ||
    joined.includes('cookie');
}

function isPrivateKeyMaterial(value: string): boolean {
  return /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value);
}

function isCredentialBearingUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    return [...url.searchParams.keys()].some(isSensitiveKey);
  } catch {
    return false;
  }
}

function sensitiveMetadata(path: string, key = ''): never {
  const location = key ? `${path}.${key}` : path;
  throw Object.assign(new Error(`RustDesk gateway metadata contains sensitive material at ${location}`), {
    status: 400
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
