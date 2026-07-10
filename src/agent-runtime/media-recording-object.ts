import { readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteLocalUpload, readLocalUpload } from '../storage/object-storage.js';
import type {
  EgressRecord,
  RecordingObjectContentResult,
  RecordingObjectDeleteResult
} from './livekit/types.js';

export type { RecordingObjectContentResult } from './livekit/types.js';
export type RecordingObjectReadStatus = RecordingObjectContentResult['status'];

export interface RecordingObjectResolverDeps {
  fetch?: typeof fetch;
  allowUnsafeLocalPaths?: boolean;
  httpTimeoutMs?: number;
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

  const localUploadKey = localUploadKeyFromUrl(storageUrl);
  if (localUploadKey) {
    const content = readLocalUpload(localUploadKey);
    return content
      ? { status: 'readable', source: 'local_upload', content }
      : { status: 'not_found', source: 'local_upload', error: 'local_upload_not_found' };
  }

  if (storageUrl.startsWith('file://')) {
    const path = fileURLToPath(storageUrl);
    if (!localPathAllowed(path, deps.allowUnsafeLocalPaths)) {
      return { status: 'forbidden', source: 'file', error: 'local_path_not_allowed' };
    }
    return readFileObject(path, 'file');
  }

  if (storageUrl.startsWith('http://') || storageUrl.startsWith('https://')) {
    if (!httpOriginAllowed(storageUrl)) {
      return { status: 'forbidden', source: 'http', error: 'http_origin_not_allowed' };
    }
    return readHttpObject(storageUrl, deps.fetch || fetch, recordingHttpTimeoutMs(deps.httpTimeoutMs));
  }

  if (storageUrl.startsWith('s3://')) {
    const parsed = new URL(storageUrl);
    const bucket = parsed.hostname;
    if (!s3BucketAllowed(bucket)) {
      return { status: 'forbidden', source: 's3', error: 's3_bucket_not_allowed' };
    }
    return readS3Object(bucket, decodeURIComponent(parsed.pathname.replace(/^\//, '')));
  }

  if (isAbsolute(storageUrl)) {
    if (!localPathAllowed(storageUrl, deps.allowUnsafeLocalPaths)) {
      return { status: 'forbidden', source: 'file', error: 'local_path_not_allowed' };
    }
    return readFileObject(storageUrl, 'file');
  }

  const configuredBucket = process.env.S3_BUCKET || process.env.OPC_S3_BUCKET || process.env.MINIO_BUCKET || '';
  if (configuredBucket && storageUrl.startsWith(`${configuredBucket}/`)) {
    return readS3Object(configuredBucket, storageUrl.slice(configuredBucket.length + 1));
  }

  const localRoot = process.env.OPC_RECORDING_OBJECT_DIR || process.env.LIVEKIT_EGRESS_RECORDING_DIR || '';
  if (localRoot) {
    return readFileObject(join(localRoot, safeRelativePath(storageUrl)), 'local_path');
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
  source: 'file' | 'local_path'
): Promise<RecordingObjectContentResult> {
  try {
    return { status: 'readable', source, content: await readFile(path) };
  } catch (error) {
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
  timeoutMs: number
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
    return {
      status: 'readable',
      source: 'http',
      content: Buffer.from(await response.arrayBuffer())
    };
  } catch (error) {
    return {
      status: 'fetch_failed',
      source: 'http',
      error: controller.signal.aborted ? 'http_fetch_timeout' : 'http_fetch_failed'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readS3Object(bucket: string, key: string): Promise<RecordingObjectContentResult> {
  if (!bucket || !key) return { status: 'missing_storage_url', source: 's3', error: 'missing_s3_bucket_or_key' };
  try {
    const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientConfig());
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) return { status: 'not_found', source: 's3', error: 'empty_s3_body' };
    return { status: 'readable', source: 's3', content: await streamBodyToBuffer(result.Body) };
  } catch (error) {
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

async function streamBodyToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const maybeTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeTransform.transformToByteArray === 'function') {
    return Buffer.from(await maybeTransform.transformToByteArray());
  }
  const maybeArrayBuffer = body as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof maybeArrayBuffer.arrayBuffer === 'function') {
    return Buffer.from(await maybeArrayBuffer.arrayBuffer());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
