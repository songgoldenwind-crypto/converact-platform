import { createConnection } from 'node:net';

import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_SCANNER_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CLAMD_CHUNK_BYTES = 64 * 1024;

export type FileThreatScannerMode = 'controlled' | 'self_hosted' | 'third_party';
export type FileThreatStatus = 'clean' | 'infected';

export interface FileThreatScanInput {
  tenant_id: string;
  secure_file_id: string;
  filename: string;
  detected_mime: string;
  content: Buffer;
}

export interface FileThreatScanResult {
  status: FileThreatStatus;
  engine: string;
  threat_code?: string;
  provider_request_id?: string;
  metadata: Record<string, unknown>;
}

export interface FileThreatScanner {
  readonly name: string;
  readonly mode: FileThreatScannerMode;
  scan(input: FileThreatScanInput): Promise<FileThreatScanResult>;
}

export class FileThreatScannerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'FileThreatScannerError';
  }
}

export class ControlledFileThreatScanner implements FileThreatScanner {
  readonly name = 'controlled-file-threat-scanner';
  readonly mode = 'controlled' as const;

  async scan(input: FileThreatScanInput): Promise<FileThreatScanResult> {
    assertScanInput(input, DEFAULT_MAX_BYTES);
    const eicar = input.content.includes(
      Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE', 'ascii')
    );
    return eicar
      ? {
          status: 'infected',
          engine: 'controlled',
          threat_code: 'eicar_test_signature',
          metadata: {}
        }
      : { status: 'clean', engine: 'controlled', metadata: {} };
  }
}

export type ClamdTransport = (
  content: Buffer,
  options: {
    host: string;
    port: number;
    timeoutMs: number;
    maxBytes: number;
    chunkBytes: number;
  }
) => Promise<string | Buffer>;

export interface ClamdFileThreatScannerConfig {
  host?: string;
  port?: number;
  timeoutMs?: number;
  maxBytes?: number;
  chunkBytes?: number;
  transport?: ClamdTransport;
  name?: string;
}

export function createClamdFileThreatScanner(
  config: ClamdFileThreatScannerConfig = {}
): FileThreatScanner {
  const host = boundedSingleLine(config.host || '127.0.0.1', 'clamd host', 255);
  const port = boundedInteger(config.port ?? 3310, 1, 65_535, 'clamd port');
  const timeoutMs = boundedInteger(config.timeoutMs ?? 30_000, 1_000, 300_000, 'clamd timeoutMs');
  const maxBytes = boundedInteger(config.maxBytes ?? DEFAULT_MAX_BYTES, 1, 10 * 1024 * 1024 * 1024, 'clamd maxBytes');
  const chunkBytes = boundedInteger(config.chunkBytes ?? DEFAULT_CLAMD_CHUNK_BYTES, 1_024, 1024 * 1024, 'clamd chunkBytes');
  const transport = config.transport || clamdSocketTransport;
  return {
    name: config.name || 'clamav',
    mode: 'self_hosted',
    async scan(input) {
      assertScanInput(input, maxBytes);
      let response: string | Buffer;
      try {
        response = await transport(input.content, { host, port, timeoutMs, maxBytes, chunkBytes });
      } catch (error) {
        if (error instanceof FileThreatScannerError) throw error;
        const code = String((error as { code?: unknown })?.code || '');
        if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
          throw scannerError('file threat scanner timed out', 'scanner_timeout', true);
        }
        throw scannerError('file threat scanner is unavailable', 'scanner_unavailable', true);
      }
      return parseClamdResponse(response);
    }
  };
}

export function encodeClamdInstream(content: Buffer, chunkBytes = DEFAULT_CLAMD_CHUNK_BYTES): Buffer {
  const boundedChunkBytes = boundedInteger(chunkBytes, 1, 1024 * 1024, 'clamd chunkBytes');
  const chunks: Buffer[] = [Buffer.from('zINSTREAM\0', 'ascii')];
  for (let offset = 0; offset < content.length; offset += boundedChunkBytes) {
    const chunk = content.subarray(offset, Math.min(content.length, offset + boundedChunkBytes));
    const size = Buffer.allocUnsafe(4);
    size.writeUInt32BE(chunk.length, 0);
    chunks.push(size, chunk);
  }
  chunks.push(Buffer.alloc(4));
  return Buffer.concat(chunks);
}

export interface HttpFileThreatScannerConfig {
  mode: 'self_hosted' | 'third_party';
  baseUrl: string;
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  maxBytes?: number;
  name?: string;
  fetch?: typeof fetch;
}

export function createHttpFileThreatScanner(config: HttpFileThreatScannerConfig): FileThreatScanner {
  const baseUrl = boundedSingleLine(config.baseUrl, 'scanner baseUrl', 2_048);
  const endpoint = new URL(
    String(config.endpoint || '/v1/scan').replace(/^\//, ''),
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  ).toString();
  const timeoutMs = boundedInteger(config.timeoutMs ?? 30_000, 1_000, 300_000, 'scanner timeoutMs');
  const maxBytes = boundedInteger(config.maxBytes ?? DEFAULT_MAX_BYTES, 1, 10 * 1024 * 1024 * 1024, 'scanner maxBytes');
  const fetchImpl = config.fetch || fetch;
  const token = String(config.token || '');
  return {
    name: config.name || `${config.mode}-file-threat-scanner`,
    mode: config.mode,
    async scan(input) {
      assertScanInput(input, maxBytes);
      const form = new FormData();
      form.set(
        'file',
        new Blob([new Uint8Array(input.content)], { type: input.detected_mime }),
        input.filename
      );
      form.set('tenant_id', input.tenant_id);
      form.set('secure_file_id', input.secure_file_id);
      form.set('detected_mime', input.detected_mime);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          body: form,
          signal: controller.signal
        });
      } catch {
        const timedOut = controller.signal.aborted;
        throw scannerError(
          timedOut ? 'file threat scanner timed out' : 'file threat scanner is unavailable',
          timedOut ? 'scanner_timeout' : 'scanner_unavailable',
          true
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw scannerError(
          `file threat scanner returned HTTP ${response.status}`,
          `scanner_http_${response.status}`,
          response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
          response.status
        );
      }
      const payload = await readBoundedJson(response);
      if (!isRecord(payload) || (payload.status !== 'clean' && payload.status !== 'infected')) {
        throw scannerError('file threat scanner returned an invalid response', 'scanner_invalid_response', false);
      }
      const threatCode = payload.status === 'infected'
        ? safeThreatCode(payload.threat_code || payload.threat || payload.signature)
        : '';
      if (payload.status === 'infected' && !threatCode) {
        throw scannerError('file threat scanner omitted threat code', 'scanner_invalid_response', false);
      }
      const engine = safeEngine(payload.engine || config.name || 'http-scanner');
      return {
        status: payload.status,
        engine,
        ...(threatCode ? { threat_code: threatCode } : {}),
        ...(payload.request_id || payload.provider_request_id
          ? { provider_request_id: sanitizeProviderRequestId(payload.request_id || payload.provider_request_id) }
          : {}),
        metadata: sanitizeProviderMetadata(payload.metadata, { secretValues: [token] })
      };
    }
  };
}

async function clamdSocketTransport(
  content: Buffer,
  options: {
    host: string;
    port: number;
    timeoutMs: number;
    maxBytes: number;
    chunkBytes: number;
  }
): Promise<string> {
  if (content.length > options.maxBytes) {
    throw scannerError('file exceeds scanner size limit', 'scanner_size_limit', false, 413);
  }
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port });
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    const finish = (error?: unknown, response?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response || '');
    };
    socket.setTimeout(options.timeoutMs, () => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('error', finish);
    socket.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > 4_096) {
        finish(scannerError('ClamAV response is too large', 'scanner_invalid_response', false));
        return;
      }
      responseChunks.push(chunk);
      const response = Buffer.concat(responseChunks);
      if (response.includes(0)) finish(undefined, response.toString('utf8'));
    });
    socket.once('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
      for (let offset = 0; offset < content.length; offset += options.chunkBytes) {
        const chunk = content.subarray(offset, Math.min(content.length, offset + options.chunkBytes));
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

function parseClamdResponse(responseInput: string | Buffer): FileThreatScanResult {
  const responseBuffer = Buffer.isBuffer(responseInput)
    ? responseInput
    : Buffer.from(String(responseInput), 'utf8');
  if (responseBuffer.length > 4_096) {
    throw scannerError('ClamAV response is too large', 'scanner_invalid_response', false);
  }
  const response = responseBuffer.toString('utf8').replace(/\0+$/g, '').trim();
  if (/^(?:stream|fd): OK$/i.test(response)) {
    return { status: 'clean', engine: 'clamav', metadata: {} };
  }
  const infected = /^(?:stream|fd): (.+) FOUND$/i.exec(response);
  if (infected) {
    const threatCode = safeThreatCode(infected[1]);
    if (!threatCode) throw scannerError('ClamAV response is invalid', 'scanner_invalid_response', false);
    return { status: 'infected', engine: 'clamav', threat_code: threatCode, metadata: {} };
  }
  if (/size limit exceeded/i.test(response)) {
    throw scannerError('file exceeds scanner size limit', 'scanner_size_limit', false, 413);
  }
  if (/ ERROR$/i.test(response)) {
    throw scannerError('ClamAV could not scan the file', 'scanner_engine_error', true);
  }
  throw scannerError('ClamAV response is invalid', 'scanner_invalid_response', false);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_SCANNER_RESPONSE_BYTES) {
    throw scannerError('file threat scanner response is too large', 'scanner_response_too_large', false);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_SCANNER_RESPONSE_BYTES) {
    throw scannerError('file threat scanner response is too large', 'scanner_response_too_large', false);
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw scannerError('file threat scanner returned invalid JSON', 'scanner_invalid_response', false);
  }
}

function assertScanInput(input: FileThreatScanInput, maxBytes: number): void {
  boundedSingleLine(input.tenant_id, 'tenant_id', 255);
  boundedSingleLine(input.secure_file_id, 'secure_file_id', 255);
  boundedSingleLine(input.filename, 'filename', 512);
  boundedSingleLine(input.detected_mime, 'detected_mime', 255);
  if (!Buffer.isBuffer(input.content) || input.content.length === 0) {
    throw scannerError('file content is required', 'scanner_input_invalid', false, 400);
  }
  if (input.content.length > maxBytes) {
    throw scannerError('file exceeds scanner size limit', 'scanner_size_limit', false, 413);
  }
}

function safeThreatCode(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function safeEngine(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'file-threat-scanner';
}

function boundedSingleLine(value: unknown, field: string, max: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\u0000]/.test(text)) {
    throw scannerError(`${field} is invalid`, 'scanner_configuration_invalid', false, 400);
  }
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw scannerError(`${field} is invalid`, 'scanner_configuration_invalid', false, 400);
  }
  return parsed;
}

function scannerError(
  message: string,
  code: string,
  retryable: boolean,
  status?: number
): FileThreatScannerError {
  return new FileThreatScannerError(message, code, retryable, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
