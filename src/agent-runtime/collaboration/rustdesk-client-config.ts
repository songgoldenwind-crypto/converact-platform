import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type RustDeskPublicKeySource = 'env' | 'file' | 'none';

export interface RustDeskPublicKeyInfo {
  value: string;
  source: RustDeskPublicKeySource;
  file_path: string;
  error?: string;
}

export interface RustDeskClientConfig {
  provider: 'rustdesk';
  id_server: string;
  relay_server: string;
  api_server: string;
  api_server_error?: string;
  public_key: string;
  public_key_source: RustDeskPublicKeySource;
  public_key_file: string;
  public_key_configured: boolean;
  public_key_error?: string;
  server_key_fingerprint: string;
  manual_fields: {
    id_server: string;
    relay_server: string;
    api_server?: string;
    key: string;
  };
}

export function rustDeskPublicKey(env: NodeJS.ProcessEnv = process.env): RustDeskPublicKeyInfo {
  const envValue = String(env.OPC_RUSTDESK_PUBLIC_KEY || '');
  if (envValue) return validatedRustDeskPublicKey(envValue, 'env', '');
  const filePath = String(env.OPC_RUSTDESK_PUBLIC_KEY_FILE || '').trim();
  if (!filePath) return { value: '', source: 'none', file_path: '' };
  try {
    const fileValue = readFileSync(filePath, 'utf8');
    if (!fileValue.trim()) {
      return { value: '', source: 'none', file_path: filePath, error: `RustDesk public key file is empty: ${filePath}` };
    }
    if (fileValue) return validatedRustDeskPublicKey(fileValue, 'file', filePath);
  } catch {
    return { value: '', source: 'none', file_path: filePath, error: `RustDesk public key file cannot be read: ${filePath}` };
  }
  return { value: '', source: 'none', file_path: filePath, error: `RustDesk public key file is empty: ${filePath}` };
}

function validatedRustDeskPublicKey(
  value: string,
  source: Exclude<RustDeskPublicKeySource, 'none'>,
  filePath: string
): RustDeskPublicKeyInfo {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return invalidRustDeskPublicKey(filePath);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    return invalidRustDeskPublicKey(filePath);
  }
  return { value, source, file_path: filePath };
}

function invalidRustDeskPublicKey(filePath: string): RustDeskPublicKeyInfo {
  return {
    value: '',
    source: 'none',
    file_path: filePath,
    error: 'RustDesk public key must be canonical single-line standard base64 decoding to exactly 32 bytes'
  };
}

export function rustDeskServerKeyFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const publicKey = rustDeskPublicKey(env);
  const key = publicKey.value || String(env.OPC_RUSTDESK_SERVER_KEY || '').trim();
  if (!key) return '';
  return `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export function rustDeskApiServer(env: NodeJS.ProcessEnv = process.env): { value: string; error?: string } {
  const value = String(env.OPC_RUSTDESK_API_SERVER || '').trim();
  if (!value) return { value: '' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { value, error: 'RustDesk API server must be a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { value, error: 'RustDesk API server must use http(s)' };
  }
  return { value };
}

export function rustDeskClientConfig(env: NodeJS.ProcessEnv = process.env): RustDeskClientConfig {
  const publicKey = rustDeskPublicKey(env);
  const idServer = String(env.OPC_RUSTDESK_ID_SERVER || '').trim();
  const relayServer = String(env.OPC_RUSTDESK_RELAY_SERVER || '').trim();
  const apiServer = rustDeskApiServer(env);
  const manualFields = {
    id_server: idServer,
    relay_server: relayServer,
    ...(apiServer.value ? { api_server: apiServer.value } : {}),
    key: publicKey.value
  };
  return {
    provider: 'rustdesk',
    id_server: idServer,
    relay_server: relayServer,
    api_server: apiServer.value,
    ...(apiServer.error ? { api_server_error: apiServer.error } : {}),
    public_key: publicKey.value,
    public_key_source: publicKey.source,
    public_key_file: publicKey.file_path,
    public_key_configured: Boolean(publicKey.value),
    ...(publicKey.error ? { public_key_error: publicKey.error } : {}),
    server_key_fingerprint: rustDeskServerKeyFingerprint(env),
    manual_fields: manualFields
  };
}
