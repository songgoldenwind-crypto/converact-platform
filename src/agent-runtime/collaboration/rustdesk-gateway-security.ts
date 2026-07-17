export type RustDeskGatewayAccessMode = 'attended' | 'unattended';

const PUBLIC_METADATA_KEYS = new Set([
  'access_mode',
  'api_server',
  'business_ref_id',
  'business_ref_type',
  'collaboration_session_id',
  'controller_rustdesk_id',
  'gateway_provider',
  'id_server',
  'ivekit_cell_id',
  'ivekit_owner_epoch',
  'ivekit_owner_node_id',
  'ivekit_reservation_id',
  'ivekit_region_id',
  'ivekit_zone_id',
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

const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_NODES = 10_000;

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

export function hasRustDeskGatewayAccessModeAlias(value: unknown): boolean {
  return hasMetadataAlias(value, (key) => normalizedMetadataKey(key) === 'accessmode');
}

export function hasRustDeskGatewayUnattendedAlias(value: unknown): boolean {
  return hasMetadataAlias(value, (key, entry) => {
    const normalizedKey = normalizedMetadataKey(key);
    const normalizedEntry = typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
    return normalizedKey.includes('unattended') ||
      ((normalizedKey === 'accessmode' || normalizedKey === 'mode') && normalizedEntry === 'unattended');
  });
}

function copySafeRecord(value: Record<string, unknown>, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const states = new WeakMap<object, 'visiting' | 'done'>([[value, 'visiting']]);
  const copies = new WeakMap<object, MetadataContainer>([[value, result]]);
  const stack: CopyFrame[] = [copyFrame(value, result, path, 0)];
  let nodes = 1;

  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.index >= frame.entries.length) {
      states.set(frame.source, 'done');
      stack.pop();
      continue;
    }
    const [key, entry] = frame.entries[frame.index++];
    nodes += 1;
    if (nodes > MAX_METADATA_NODES) metadataTraversalLimit('node');
    const location = metadataLocation(frame.path, key, Array.isArray(frame.source));
    if (!Array.isArray(frame.source) && isSensitiveKey(String(key))) {
      sensitiveMetadata(frame.path, String(key));
    }
    if (typeof entry === 'string') {
      if (isPrivateKeyMaterial(entry) || isCredentialBearingUrl(entry)) sensitiveMetadata(location);
      assignMetadata(frame.target, key, entry);
      continue;
    }
    if (!isMetadataContainer(entry)) {
      if (entry !== undefined) assignMetadata(frame.target, key, entry);
      continue;
    }
    const depth = frame.depth + 1;
    if (depth > MAX_METADATA_DEPTH) metadataTraversalLimit('depth');
    const state = states.get(entry);
    if (state === 'visiting') metadataCycle(location);
    if (state === 'done') {
      assignMetadata(frame.target, key, copies.get(entry));
      continue;
    }
    const copy: MetadataContainer = Array.isArray(entry) ? [] : {};
    assignMetadata(frame.target, key, copy);
    states.set(entry, 'visiting');
    copies.set(entry, copy);
    stack.push(copyFrame(entry, copy, location, depth));
  }
  return result;
}

function hasMetadataAlias(
  value: unknown,
  predicate: (key: string, entry: unknown) => boolean
): boolean {
  if (!isMetadataContainer(value)) return false;
  const states = new WeakMap<object, 'visiting' | 'done'>([[value, 'visiting']]);
  const stack: ScanFrame[] = [scanFrame(value, 0)];
  let nodes = 1;
  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.index >= frame.entries.length) {
      states.set(frame.source, 'done');
      stack.pop();
      continue;
    }
    const [key, entry] = frame.entries[frame.index++];
    nodes += 1;
    if (nodes > MAX_METADATA_NODES) metadataTraversalLimit('node');
    if (!Array.isArray(frame.source) && predicate(String(key), entry)) return true;
    if (!isMetadataContainer(entry)) continue;
    const depth = frame.depth + 1;
    if (depth > MAX_METADATA_DEPTH) metadataTraversalLimit('depth');
    const state = states.get(entry);
    if (state === 'visiting') metadataCycle('RustDesk gateway metadata');
    if (state === 'done') continue;
    states.set(entry, 'visiting');
    stack.push(scanFrame(entry, depth));
  }
  return false;
}

function normalizedMetadataKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

type MetadataContainer = Record<string, unknown> | unknown[];

interface ScanFrame {
  source: MetadataContainer;
  entries: Array<[string | number, unknown]>;
  index: number;
  depth: number;
}

interface CopyFrame extends ScanFrame {
  target: MetadataContainer;
  path: string;
}

function scanFrame(source: MetadataContainer, depth: number): ScanFrame {
  return { source, entries: metadataEntries(source), index: 0, depth };
}

function copyFrame(
  source: MetadataContainer,
  target: MetadataContainer,
  path: string,
  depth: number
): CopyFrame {
  return { ...scanFrame(source, depth), target, path };
}

function metadataEntries(value: MetadataContainer): Array<[string | number, unknown]> {
  return Array.isArray(value)
    ? value.map((entry, index) => [index, entry])
    : Object.entries(value);
}

function isMetadataContainer(value: unknown): value is MetadataContainer {
  return Array.isArray(value) || isRecord(value);
}

function assignMetadata(target: MetadataContainer, key: string | number, value: unknown): void {
  if (Array.isArray(target)) target[Number(key)] = value;
  else target[String(key)] = value;
}

function metadataLocation(path: string, key: string | number, array: boolean): string {
  return array ? `${path}[${key}]` : `${path}.${key}`;
}

function metadataTraversalLimit(kind: 'depth' | 'node'): never {
  throw Object.assign(new Error(`RustDesk gateway metadata exceeds ${kind} limit`), { status: 413 });
}

function metadataCycle(path: string): never {
  throw Object.assign(new Error(`RustDesk gateway metadata contains cyclic input at ${path}`), { status: 400 });
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
