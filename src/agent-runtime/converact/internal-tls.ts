import { readFileSync, statSync } from 'node:fs';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import { isAbsolute } from 'node:path';

export interface IveKitInternalTlsConfig {
  port: number;
  tls: HttpsServerOptions;
}

const MAX_TLS_FILE_BYTES = 65_536;

export function loadIveKitInternalTlsConfig(
  env: NodeJS.ProcessEnv = process.env
): IveKitInternalTlsConfig | null {
  const fields = {
    port: String(env.OPC_IVEKIT_INTERNAL_TLS_PORT || '').trim(),
    key: String(env.OPC_IVEKIT_INTERNAL_TLS_KEY_FILE || '').trim(),
    cert: String(env.OPC_IVEKIT_INTERNAL_TLS_CERT_FILE || '').trim(),
    ca: String(env.OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE || '').trim()
  };
  const configured = Object.values(fields).filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== Object.keys(fields).length) {
    throw new Error('iveKit internal TLS fields must be configured together');
  }
  const port = Number(fields.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OPC_IVEKIT_INTERNAL_TLS_PORT is invalid');
  }
  return {
    port,
    tls: {
      key: readTlsFile(fields.key, 'OPC_IVEKIT_INTERNAL_TLS_KEY_FILE', true),
      cert: readTlsFile(fields.cert, 'OPC_IVEKIT_INTERNAL_TLS_CERT_FILE', false),
      ca: readTlsFile(fields.ca, 'OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE', false),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    }
  };
}

function readTlsFile(path: string, field: string, secret: boolean): Buffer {
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`${field} must be a file`);
  if (metadata.size < 1 || metadata.size > MAX_TLS_FILE_BYTES) {
    throw new Error(`${field} size is invalid`);
  }
  if (secret && process.platform !== 'win32' && (metadata.mode & 0o037) !== 0) {
    throw new Error(`${field} permissions are too broad`);
  }
  const value = readFileSync(path);
  if (value.length < 1 || value.length > MAX_TLS_FILE_BYTES) {
    throw new Error(`${field} size is invalid`);
  }
  return value;
}
