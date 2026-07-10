import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { id } from '../db.js';

export interface ObjectStorageUploadInput {
  tenantId: string;
  filename: string;
  body: Buffer;
  contentType: string;
  keyPrefix?: string;
}

export interface ObjectStorage {
  upload(input: ObjectStorageUploadInput): Promise<{ storage_url: string; key: string }>;
}

class LocalObjectStorage implements ObjectStorage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  async upload(input: ObjectStorageUploadInput): Promise<{ storage_url: string; key: string }> {
    const prefix = input.keyPrefix ? `${safeKeySegment(input.keyPrefix)}/` : '';
    const key = `${safeKeySegment(input.tenantId)}/${prefix}${safeFilename(input.filename, 'screen', 'webm')}`;
    const fullPath = join(this.rootDir, key);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, input.body);
    return { key, storage_url: `/api/call-center/media/${key}` };
  }
}

class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly bucket: string,
    private readonly region: string,
    private readonly endpoint: string | undefined,
    private readonly publicBaseUrl: string,
    private readonly credentials?: { accessKeyId: string; secretAccessKey: string }
  ) {}

  async upload(input: ObjectStorageUploadInput): Promise<{ storage_url: string; key: string }> {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: this.region,
      endpoint: this.endpoint,
      forcePathStyle: Boolean(this.endpoint),
      ...(this.credentials ? { credentials: this.credentials } : {})
    });
    const prefix = safeKeySegment(input.keyPrefix || 'screen-recordings');
    const key = `${safeKeySegment(input.tenantId)}/${prefix}/${safeFilename(input.filename, 'screen', 'webm')}`;
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType
      })
    );
    return { key, storage_url: `${this.publicBaseUrl}/${key}` };
  }
}

let storageSingleton: ObjectStorage | null = null;
let localStorageRoot: string | null = null;

export function createObjectStorage(): ObjectStorage {
  if (storageSingleton) return storageSingleton;
  const bucket = process.env.S3_BUCKET || process.env.OPC_S3_BUCKET || process.env.MINIO_BUCKET || '';
  if (bucket) {
    const region = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
    const endpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY || '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_SECRET_KEY || '';
    const publicBaseUrl =
      process.env.S3_PUBLIC_BASE_URL ||
      (endpoint
        ? `${endpoint.replace(/\/$/, '')}/${bucket}`
        : `https://${bucket}.s3.${region}.amazonaws.com`);
    storageSingleton = new S3ObjectStorage(
      bucket,
      region,
      endpoint,
      publicBaseUrl,
      accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined
    );
    return storageSingleton;
  }
  localStorageRoot = process.env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
  storageSingleton = new LocalObjectStorage(localStorageRoot);
  return storageSingleton;
}

export function readLocalUpload(key: string): Buffer | null {
  const root = localStorageRoot || process.env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
  const fullPath = resolveUploadPath(root, key);
  if (!fullPath) return null;
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath);
}

export function deleteLocalUpload(key: string): 'deleted' | 'not_found' | 'forbidden' {
  const root = localStorageRoot || process.env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
  const fullPath = resolveUploadPath(root, key);
  if (!fullPath) return 'forbidden';
  if (!existsSync(fullPath)) return 'not_found';
  unlinkSync(fullPath);
  return 'deleted';
}

export function isLocalObjectStorage(): boolean {
  createObjectStorage();
  return Boolean(localStorageRoot);
}

function resolveUploadPath(root: string, key: string): string | null {
  const resolvedRoot = resolve(root);
  const fullPath = resolve(resolvedRoot, key);
  if (fullPath !== resolvedRoot && !fullPath.startsWith(`${resolvedRoot}${sep}`)) return null;
  return fullPath;
}

function safeKeySegment(value: string): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown';
}

function safeFilename(value: string, prefix: string, extension: string): string {
  const filename = String(value || '').trim();
  if (!filename) return `${id(prefix)}.${extension}`;
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_') || `${id(prefix)}.${extension}`;
}
