import { createReadStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteLocalUpload, readLocalUpload } from '../storage/object-storage.js';
import type {
  EgressRecord,
  RecordingObjectContentResult,
  RecordingObjectDeleteResult,
  RecordingObjectStreamResult
} from './livekit/types.js';

export type { RecordingObjectContentResult } from './livekit/types.js';
export type RecordingObjectReadStatus = RecordingObjectContentResult['status'];

export async function resolveRecordingObjectStream(
  recording: Pick<EgressRecord, 'storage_url'> | { storage_url: string },
  deps: RecordingObjectResolverDeps = {}
): Promise<RecordingObjectStreamResult> {
  const storageUrl = String(recording.storage_url || '').trim();
  if (!storageUrl) return { status: 'missing_storage_url', error: 'missing_storage_url' };
  const maxBytes = recordingObjectMaxBytes(deps.maxBytes);
  const localUploadKey = localUploadKeyFromUrl(storageUrl);
  if (localUploadKey) {
    const content = readLocalUpload(localUploadKey);
    if (!content) return { status: 'not_found', source: 'local_upload', error: 'local_upload_not_found' };
    assertRecordingObjectExportSize(content.length, maxBytes);
    return { status: 'readable', source: 'local_upload', size_bytes: content.length, stream: oneChunk(content) };
  }
  if (storageUrl.startsWith('file://')) {
    const path = fileURLToPath(storageUrl);
    if (!localPathAllowed(path, deps.allowUnsafeLocalPaths)) return { status: 'forbidden', source: 'file', error: 'local_path_not_allowed' };
    return openFileStream(path, 'file', maxBytes);
  }
  if (storageUrl.startsWith('http://') || storageUrl.startsWith('https://')) {
    if (!httpOriginAllowed(storageUrl)) return { status: 'forbidden', source: 'http', error: 'http_origin_not_allowed' };
    return openHttpStream(storageUrl, deps.fetch || fetch, recordingHttpTimeoutMs(deps.httpTimeoutMs), maxBytes);
  }
  if (storageUrl.startsWith('s3://')) {
    const parsed = new URL(storageUrl);
    if (!s3BucketAllowed(parsed.hostname)) return { status: 'forbidden', source: 's3', error: 's3_bucket_not_allowed' };
    return openS3Stream(parsed.hostname, decodeURIComponent(parsed.pathname.replace(/^\//, '')), maxBytes);
  }
  if (isAbsolute(storageUrl)) {
    if (!localPathAllowed(storageUrl, deps.allowUnsafeLocalPaths)) return { status: 'forbidden', source: 'file', error: 'local_path_not_allowed' };
    return openFileStream(storageUrl, 'file', maxBytes);
  }
  const bucket = configuredS3Bucket();
  if (bucket && storageUrl.startsWith(`${bucket}/`)) return openS3Stream(bucket, storageUrl.slice(bucket.length + 1), maxBytes);
  const root = configuredLocalRoot();
  if (root) return openFileStream(join(root, safeRelativePath(storageUrl)), 'local_path', maxBytes);
  return { status: 'unsupported', error: 'unsupported_storage_url' };
}

async function openFileStream(
  path: string,
  source: 'file' | 'local_path',
  maxBytes: number
): Promise<RecordingObjectStreamResult> {
  try {
    const size = (await stat(path)).size;
    assertRecordingObjectExportSize(size, maxBytes);
    return {
      status: 'readable',
      source,
      size_bytes: size,
      stream: boundedAsyncIterable(createReadStream(path), maxBytes)
    };
  } catch (error) {
    if (Number((error as { status?: number }).status || 0) === 413) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 'not_found' : code === 'EACCES' ? 'forbidden' : 'fetch_failed',
      source,
      error: code === 'ENOENT' ? 'local_object_not_found' : code === 'EACCES' ? 'local_object_forbidden' : 'local_object_read_failed'
    };
  }
}

async function openHttpStream(
  storageUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number
): Promise<RecordingObjectStreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(storageUrl, { signal: controller.signal });
    if (!response.ok) {
      clearTimeout(timeout);
      return {
        status: response.status === 401 || response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : 'fetch_failed',
        source: 'http',
        error: `http_${response.status}`
      };
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize) assertRecordingObjectExportSize(declaredSize, maxBytes);
    if (!response.body) {
      clearTimeout(timeout);
      return { status: 'not_found', source: 'http', error: 'empty_http_body' };
    }
    return {
      status: 'readable',
      source: 'http',
      ...(declaredSize ? { size_bytes: declaredSize } : {}),
      stream: boundedWebStream(response.body, maxBytes, () => clearTimeout(timeout))
    };
  } catch (error) {
    clearTimeout(timeout);
    if (Number((error as { status?: number }).status || 0) === 413) throw error;
    return { status: 'fetch_failed', source: 'http', error: controller.signal.aborted ? 'http_fetch_timeout' : 'http_fetch_failed' };
  }
}

async function openS3Stream(bucket: string, key: string, maxBytes: number): Promise<RecordingObjectStreamResult> {
  if (!bucket || !key) return { status: 'missing_storage_url', source: 's3', error: 'missing_s3_bucket_or_key' };
  try {
    const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    const result = await new S3Client(s3ClientConfig()).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) return { status: 'not_found', source: 's3', error: 'empty_s3_body' };
    if (result.ContentLength != null) assertRecordingObjectExportSize(result.ContentLength, maxBytes);
    if (!isAsyncIterable(result.Body)) return { status: 'unsupported', source: 's3', error: 's3_body_not_streamable' };
    return {
      status: 'readable',
      source: 's3',
      ...(result.ContentLength != null ? { size_bytes: result.ContentLength } : {}),
      stream: boundedAsyncIterable(result.Body, maxBytes)
    };
  } catch (error) {
    if (Number((error as { status?: number }).status || 0) === 413) throw error;
    const details = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
    const statusCode = details.$metadata?.httpStatusCode;
    const status = statusCode === 401 || statusCode === 403 ? 'forbidden' : statusCode === 404 || details.name === 'NoSuchKey' ? 'not_found' : 'fetch_failed';
    return { status, source: 's3', error: status === 'not_found' ? 's3_object_not_found' : status === 'forbidden' ? 's3_object_forbidden' : 's3_read_failed' };
  }
}

async function* oneChunk(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content;
}

async function* boundedAsyncIterable(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes: number
): AsyncIterable<Uint8Array> {
  let total = 0;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    assertRecordingObjectExportSize(total, maxBytes);
    yield chunk;
  }
}

async function* boundedWebStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  onDone: () => void
): AsyncIterable<Uint8Array> {
  const reader = source.getReader();
  let complete = false;
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      total += next.value.byteLength;
      assertRecordingObjectExportSize(total, maxBytes);
      yield next.value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    onDone();
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

export interface RecordingObjectResolverDeps {
  fetch?: typeof fetch;
  allowUnsafeLocalPaths?: boolean;
  httpTimeoutMs?: number;
  maxBytes?: number;
}

export interface RecordingObjectDeleteDeps {
  allowUnsafeLocalPaths?: boolean;
}

export async function resolveRecordingObjectContent(
  recording: Pick<EgressRecord, 'storage_url'> | { storage_url: string },
  deps: RecordingObjectResolverDeps = {}
): Promise<RecordingObjectContentResult> {
  const storageUrl = String(recording.storage_url || '').trim();
  if (!storageUrl) return { status: 'missing_storage_url', error: 'missing_storage_url' };
  const maxBytes = recordingObjectMaxBytes(deps.maxBytes);

  const localUploadKey = localUploadKeyFromUrl(storageUrl);
  if (localUploadKey) {
    const content = readLocalUpload(localUploadKey);
    if (content) assertRecordingObjectExportSize(content.length, maxBytes);
    return content
      ? { status: 'readable', source: 'local_upload', content }
      : { status: 'not_found', source: 'local_upload', error: 'local_upload_not_found' };
  }

  if (storageUrl.startsWith('file://')) {
    const path = fileURLToPath(storageUrl);
    if (!localPathAllowed(path, deps.allowUnsafeLocalPaths)) {
      return { status: 'forbidden', source: 'file', error: 'local_path_not_allowed' };
    }
    return readFileObject(path, 'file', maxBytes);
  }

  if (storageUrl.startsWith('http://') || storageUrl.startsWith('https://')) {
    if (!httpOriginAllowed(storageUrl)) {
      return { status: 'forbidden', source: 'http', error: 'http_origin_not_allowed' };
    }
    return readHttpObject(storageUrl, deps.fetch || fetch, recordingHttpTimeoutMs(deps.httpTimeoutMs), maxBytes);
  }

  if (storageUrl.startsWith('s3://')) {
    const parsed = new URL(storageUrl);
    const bucket = parsed.hostname;
    if (!s3BucketAllowed(bucket)) {
      return { status: 'forbidden', source: 's3', error: 's3_bucket_not_allowed' };
    }
    return readS3Object(bucket, decodeURIComponent(parsed.pathname.replace(/^\//, '')), maxBytes);
  }

  if (isAbsolute(storageUrl)) {
    if (!localPathAllowed(storageUrl, deps.allowUnsafeLocalPaths)) {
      return { status: 'forbidden', source: 'file', error: 'local_path_not_allowed' };
    }
    return readFileObject(storageUrl, 'file', maxBytes);
  }

  const configuredBucket = process.env.S3_BUCKET || process.env.OPC_S3_BUCKET || process.env.MINIO_BUCKET || '';
  if (configuredBucket && storageUrl.startsWith(`${configuredBucket}/`)) {
    return readS3Object(configuredBucket, storageUrl.slice(configuredBucket.length + 1), maxBytes);
  }

  const localRoot = process.env.OPC_RECORDING_OBJECT_DIR || process.env.LIVEKIT_EGRESS_RECORDING_DIR || '';
  if (localRoot) {
    return readFileObject(join(localRoot, safeRelativePath(storageUrl)), 'local_path', maxBytes);
  }

  return { status: 'unsupported', error: 'unsupported_storage_url' };
}

export async function deleteRecordingObject(
  recording: Pick<EgressRecord, 'storage_url'> | { storage_url: string },
  deps: RecordingObjectDeleteDeps = {}
): Promise<RecordingObjectDeleteResult> {
  const storageUrl = String(recording.storage_url || '').trim();
  if (!storageUrl) return { status: 'not_found', error: 'missing_storage_url' };

  const localUploadKey = localUploadKeyFromUrl(storageUrl);
  if (localUploadKey) {
    const result = deleteLocalUpload(localUploadKey);
    if (result === 'forbidden') {
      return { status: 'delete_failed', source: 'local_upload', error: 'local_path_not_allowed' };
    }
    return { status: result, source: 'local_upload' };
  }

  if (storageUrl.startsWith('file://')) {
    const path = fileURLToPath(storageUrl);
    if (!localPathAllowed(path, deps.allowUnsafeLocalPaths)) {
      return { status: 'delete_failed', source: 'file', error: 'local_path_not_allowed' };
    }
    return deleteFileObject(path, 'file');
  }

  if (storageUrl.startsWith('s3://')) {
    const parsed = new URL(storageUrl);
    const bucket = parsed.hostname;
    if (!s3BucketAllowed(bucket)) {
      return { status: 'delete_failed', source: 's3', error: 's3_bucket_not_allowed' };
    }
    return deleteS3Object(bucket, decodeURIComponent(parsed.pathname.replace(/^\//, '')));
  }

  if (storageUrl.startsWith('http://') || storageUrl.startsWith('https://')) {
    return { status: 'unsupported', source: 'http', error: 'http_delete_not_supported' };
  }

  if (isAbsolute(storageUrl)) {
    if (!localPathAllowed(storageUrl, deps.allowUnsafeLocalPaths)) {
      return { status: 'delete_failed', source: 'file', error: 'local_path_not_allowed' };
    }
    return deleteFileObject(storageUrl, 'file');
  }

  const configuredBucket = configuredS3Bucket();
  if (configuredBucket && storageUrl.startsWith(`${configuredBucket}/`)) {
    return deleteS3Object(configuredBucket, storageUrl.slice(configuredBucket.length + 1));
  }

  const localRoot = configuredLocalRoot();
  if (localRoot) {
    return deleteFileObject(join(localRoot, safeRelativePath(storageUrl)), 'local_path');
  }

  return { status: 'unsupported', error: 'unsupported_storage_url' };
}

function localUploadKeyFromUrl(storageUrl: string): string | null {
  let pathname = storageUrl;
  if (storageUrl.startsWith('http://') || storageUrl.startsWith('https://')) {
    try {
      pathname = new URL(storageUrl).pathname;
    } catch {
      return null;
    }
  }
  const prefixes = ['/api/call-center/media/', '/api/collaboration/media/'];
  const prefix = prefixes.find((value) => pathname.startsWith(value));
  if (!prefix) return null;
  return safeRelativePath(decodeURIComponent(pathname.slice(prefix.length)));
}

function safeRelativePath(value: string): string {
  const normalized = normalize(value).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized.replace(/^[/\\]+/, '');
}

async function readFileObject(
  path: string,
  source: 'file' | 'local_path',
  maxBytes: number
): Promise<RecordingObjectContentResult> {
  try {
    assertRecordingObjectExportSize((await stat(path)).size, maxBytes);
    return { status: 'readable', source, content: await readFile(path) };
  } catch (error) {
    if (Number((error as { status?: number }).status || 0) === 413) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 'not_found' : code === 'EACCES' ? 'forbidden' : 'fetch_failed',
      source,
      error: code === 'ENOENT' ? 'local_object_not_found' : code === 'EACCES' ? 'local_object_forbidden' : 'local_object_read_failed'
    };
  }
}

async function deleteFileObject(
  path: string,
  source: 'file' | 'local_path'
): Promise<RecordingObjectDeleteResult> {
  try {
    await unlink(path);
    return { status: 'deleted', source };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'not_found', source };
    return {
      status: 'delete_failed',
      source,
      error: code === 'EACCES' ? 'local_object_forbidden' : 'local_object_delete_failed'
    };
  }
}

async function readHttpObject(
  storageUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number
): Promise<RecordingObjectContentResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(storageUrl, { signal: controller.signal });
    if (!response.ok) {
      return {
        status: response.status === 401 || response.status === 403
          ? 'forbidden'
          : response.status === 404
            ? 'not_found'
            : 'fetch_failed',
        source: 'http',
        error: `http_${response.status}`
      };
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize) assertRecordingObjectExportSize(declaredSize, maxBytes);
    return {
      status: 'readable',
      source: 'http',
      content: await readWebResponseBody(response, maxBytes)
    };
  } catch (error) {
    if (Number((error as { status?: number }).status || 0) === 413) throw error;
    return {
      status: 'fetch_failed',
      source: 'http',
      error: controller.signal.aborted ? 'http_fetch_timeout' : 'http_fetch_failed'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readS3Object(bucket: string, key: string, maxBytes: number): Promise<RecordingObjectContentResult> {
  if (!bucket || !key) return { status: 'missing_storage_url', source: 's3', error: 'missing_s3_bucket_or_key' };
  try {
    const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientConfig());
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) return { status: 'not_found', source: 's3', error: 'empty_s3_body' };
    if (result.ContentLength != null) assertRecordingObjectExportSize(result.ContentLength, maxBytes);
    return { status: 'readable', source: 's3', content: await streamBodyToBuffer(result.Body, maxBytes) };
  } catch (error) {
    if (Number((error as { status?: number }).status || 0) === 413) throw error;
    const details = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
    const statusCode = details.$metadata?.httpStatusCode;
    const status = statusCode === 401 || statusCode === 403
      ? 'forbidden'
      : statusCode === 404 || details.name === 'NoSuchKey'
        ? 'not_found'
        : 'fetch_failed';
    return { status, source: 's3', error: status === 'not_found' ? 's3_object_not_found' : status === 'forbidden' ? 's3_object_forbidden' : 's3_read_failed' };
  }
}

async function deleteS3Object(bucket: string, key: string): Promise<RecordingObjectDeleteResult> {
  if (!bucket || !key) return { status: 'not_found', source: 's3', error: 'missing_s3_bucket_or_key' };
  try {
    const { DeleteObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientConfig());
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { status: 'deleted', source: 's3' };
  } catch (error) {
    const details = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
    const statusCode = details.$metadata?.httpStatusCode;
    if (statusCode === 404 || details.name === 'NoSuchKey') return { status: 'not_found', source: 's3' };
    return {
      status: 'delete_failed',
      source: 's3',
      error: statusCode === 401 || statusCode === 403 ? 's3_object_forbidden' : 's3_delete_failed'
    };
  }
}

function s3ClientConfig() {
  const endpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_SECRET_KEY || '';
  return {
    region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    endpoint,
    forcePathStyle: Boolean(endpoint),
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {})
  };
}

function configuredS3Bucket(): string {
  return process.env.S3_BUCKET || process.env.OPC_S3_BUCKET || process.env.MINIO_BUCKET || '';
}

function s3BucketAllowed(bucket: string): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const configured = configuredS3Bucket();
  return Boolean(configured) && bucket === configured;
}

function recordingHttpTimeoutMs(explicit?: number): number {
  const value = explicit ?? Number(process.env.OPC_RECORDING_HTTP_TIMEOUT_MS || 15_000);
  if (!Number.isFinite(value) || value < 1 || value > 300_000) return 15_000;
  return Math.floor(value);
}

function configuredLocalRoot(): string {
  return process.env.OPC_RECORDING_OBJECT_DIR || process.env.LIVEKIT_EGRESS_RECORDING_DIR || '';
}

function localPathAllowed(path: string, allowUnsafeLocalPaths = process.env.NODE_ENV !== 'production'): boolean {
  if (allowUnsafeLocalPaths) return true;
  const roots = [configuredLocalRoot(), process.env.OPC_UPLOAD_DIR || ''].filter(Boolean);
  return roots.some((root) => isWithinRoot(path, root));
}

function isWithinRoot(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function httpOriginAllowed(storageUrl: string): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const configured = [
    ...(process.env.OPC_RECORDING_HTTP_ALLOWED_ORIGINS || '').split(','),
    process.env.S3_PUBLIC_BASE_URL || '',
    process.env.S3_ENDPOINT || '',
    process.env.MINIO_ENDPOINT || ''
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    });
  try {
    return configured.includes(new URL(storageUrl).origin);
  } catch {
    return false;
  }
}

async function streamBodyToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    assertRecordingObjectExportSize(body.byteLength, maxBytes);
    return Buffer.from(body);
  }
  if (!isAsyncIterable(body)) {
    throw Object.assign(new Error('recording object body is not streamable'), { status: 502 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    assertRecordingObjectExportSize(total, maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readWebResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      assertRecordingObjectExportSize(total, maxBytes);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

export function recordingObjectMaxBytes(explicit?: number): number {
  const value = explicit ?? Number(process.env.OPC_RECORDING_EXPORT_MAX_BYTES || 67_108_864);
  if (!Number.isInteger(value) || value < 1 || value > 1_073_741_824) return 67_108_864;
  return value;
}

export function assertRecordingObjectExportSize(size: number, maxBytes = recordingObjectMaxBytes()): void {
  if (size <= maxBytes) return;
  throw Object.assign(new Error(`recording object exceeds export limit (${maxBytes} bytes)`), { status: 413 });
}
