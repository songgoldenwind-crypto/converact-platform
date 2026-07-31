import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { resolveS3ConnectionConfig } from './s3-connection-config.js';
import { dirname, join, resolve, sep } from 'node:path';

import { id } from '../db-compat.js';

const MAX_PART_NUMBER = 10_000;
const MAX_OBJECT_KEY_LENGTH = 1024;

export interface ObjectStorageUploadInput {
  tenantId: string;
  filename: string;
  body: Buffer;
  contentType: string;
  keyPrefix?: string;
  resourceId?: string;
}

export interface ObjectStorageObject {
  key: string;
  size_bytes: number;
  etag: string;
}

export interface ObjectStorageUploadResult extends ObjectStorageObject {
  storage_url: string;
}

export interface ObjectStorageMultipartInput {
  tenantId: string;
  contentType: string;
  keyPrefix?: string;
  resourceId?: string;
}

export interface ObjectStorageMultipartSession {
  upload_id: string;
  key: string;
  storage_url: string;
}

export interface ObjectStorageUploadPartInput {
  upload_id: string;
  key: string;
  part_number: number;
  body: Buffer;
  sha256: string;
}

export interface ObjectStoragePartResult {
  part_number: number;
  size_bytes: number;
  etag: string;
  sha256: string;
}

export interface ObjectStorageCompletedPart {
  part_number: number;
  etag: string;
  sha256?: string;
}

export interface ObjectStorageCompleteMultipartInput {
  upload_id: string;
  key: string;
  parts: ObjectStorageCompletedPart[];
  size_bytes: number;
  sha256: string;
}

export interface ObjectStorageMultipartIdentity {
  upload_id: string;
  key: string;
}

export interface ObjectStorage {
  upload(input: ObjectStorageUploadInput): Promise<ObjectStorageUploadResult>;
  download(key: string, maxBytes?: number): Promise<Buffer | null>;
  head(key: string): Promise<ObjectStorageObject | null>;
  delete(key: string): Promise<'deleted' | 'not_found'>;
  initiateMultipart(input: ObjectStorageMultipartInput): Promise<ObjectStorageMultipartSession>;
  uploadPart(input: ObjectStorageUploadPartInput): Promise<ObjectStoragePartResult>;
  completeMultipart(input: ObjectStorageCompleteMultipartInput): Promise<ObjectStorageUploadResult>;
  abortMultipart(input: ObjectStorageMultipartIdentity): Promise<'aborted' | 'not_found'>;
}

interface LocalMultipartManifest {
  schema_version: 1;
  upload_id: string;
  key: string;
  content_type: string;
  storage_url: string;
}

export class LocalObjectStorage implements ObjectStorage {
  readonly rootDir: string;
  private readonly multipartRoot: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.multipartRoot = join(this.rootDir, '.multipart');
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.multipartRoot, { recursive: true });
  }

  async upload(input: ObjectStorageUploadInput): Promise<ObjectStorageUploadResult> {
    const key = opaqueObjectKey(input);
    const fullPath = requiredUploadPath(this.rootDir, key);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeExclusiveAtomic(fullPath, input.body);
    return {
      key,
      storage_url: localStorageUrl(key),
      size_bytes: input.body.length,
      etag: sha256Buffer(input.body)
    };
  }

  async download(key: string, maxBytes?: number): Promise<Buffer | null> {
    const fullPath = requiredUploadPath(this.rootDir, key);
    if (!existsSync(fullPath)) return null;
    const size = statSync(fullPath).size;
    assertDownloadSize(size, maxBytes);
    const content = readFileSync(fullPath);
    assertDownloadSize(content.length, maxBytes);
    return content;
  }

  async head(key: string): Promise<ObjectStorageObject | null> {
    const fullPath = requiredUploadPath(this.rootDir, key);
    if (!existsSync(fullPath)) return null;
    return {
      key,
      size_bytes: statSync(fullPath).size,
      etag: await sha256File(fullPath)
    };
  }

  async delete(key: string): Promise<'deleted' | 'not_found'> {
    const fullPath = requiredUploadPath(this.rootDir, key);
    if (!existsSync(fullPath)) return 'not_found';
    unlinkSync(fullPath);
    return 'deleted';
  }

  async initiateMultipart(input: ObjectStorageMultipartInput): Promise<ObjectStorageMultipartSession> {
    const key = opaqueObjectKey(input);
    if (await this.head(key)) throw storageError('object already exists', 409, 'object_exists');
    const uploadId = `mpu_${randomUUID()}`;
    const directory = this.multipartDirectory(uploadId);
    mkdirSync(directory, { recursive: false });
    const manifest: LocalMultipartManifest = {
      schema_version: 1,
      upload_id: uploadId,
      key,
      content_type: contentTypeValue(input.contentType),
      storage_url: localStorageUrl(key)
    };
    writeJsonAtomic(join(directory, 'manifest.json'), manifest);
    return { upload_id: uploadId, key, storage_url: manifest.storage_url };
  }

  async uploadPart(input: ObjectStorageUploadPartInput): Promise<ObjectStoragePartResult> {
    const normalized = normalizePartInput(input);
    const manifest = this.readManifest(normalized.upload_id, normalized.key);
    const partPath = join(this.multipartDirectory(manifest.upload_id), `${normalized.part_number}.part`);
    if (existsSync(partPath)) {
      const existingHash = await sha256File(partPath);
      const existingSize = statSync(partPath).size;
      if (existingHash !== normalized.sha256 || existingSize !== normalized.body.length) {
        throw storageError('multipart part already contains different content', 409, 'multipart_part_conflict');
      }
      return {
        part_number: normalized.part_number,
        size_bytes: existingSize,
        etag: existingHash,
        sha256: existingHash
      };
    }
    writeExclusiveAtomic(partPath, normalized.body);
    return {
      part_number: normalized.part_number,
      size_bytes: normalized.body.length,
      etag: normalized.sha256,
      sha256: normalized.sha256
    };
  }

  async completeMultipart(input: ObjectStorageCompleteMultipartInput): Promise<ObjectStorageUploadResult> {
    const normalized = normalizeCompleteInput(input);
    const existing = await this.head(normalized.key);
    if (existing) return assertCompletedObject(existing, normalized, localStorageUrl(normalized.key));
    const manifest = this.readManifest(normalized.upload_id, normalized.key);
    const directory = this.multipartDirectory(manifest.upload_id);
    const parts = normalizeCompletedParts(normalized.parts);
    const temporary = `${requiredUploadPath(this.rootDir, normalized.key)}.tmp-${randomUUID()}`;
    mkdirSync(dirname(temporary), { recursive: true });
    try {
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const partPath = join(directory, `${part.part_number}.part`);
        if (!existsSync(partPath)) {
          throw storageError('multipart part is missing', 409, 'multipart_part_missing');
        }
        const actual = await sha256File(partPath);
        if (actual !== unquoteEtag(part.etag) || (part.sha256 && actual !== part.sha256)) {
          throw storageError('multipart part checksum changed', 409, 'multipart_part_checksum_conflict');
        }
        await pipeline(
          createReadStream(partPath),
          createWriteStream(temporary, { flags: index === 0 ? 'wx' : 'a' })
        );
      }
      const size = statSync(temporary).size;
      if (size !== normalized.size_bytes) {
        throw storageError('multipart object size does not match', 409, 'multipart_size_conflict');
      }
      const checksum = await sha256File(temporary);
      if (checksum !== normalized.sha256) {
        throw storageError('multipart object checksum does not match', 409, 'multipart_checksum_conflict');
      }
      const finalPath = requiredUploadPath(this.rootDir, normalized.key);
      try {
        linkSync(temporary, finalPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const finalObject = await this.head(normalized.key);
        if (!finalObject) throw error;
        const completed = assertCompletedObject(finalObject, normalized, manifest.storage_url);
        rmSync(directory, { recursive: true, force: true });
        return completed;
      }
      rmSync(directory, { recursive: true, force: true });
      return {
        key: normalized.key,
        storage_url: manifest.storage_url,
        size_bytes: size,
        etag: checksum
      };
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  async abortMultipart(input: ObjectStorageMultipartIdentity): Promise<'aborted' | 'not_found'> {
    const uploadId = uploadIdValue(input.upload_id);
    objectKeyValue(input.key);
    const directory = this.multipartDirectory(uploadId);
    if (!existsSync(directory)) return 'not_found';
    const manifest = this.readManifest(uploadId, input.key);
    if (manifest.key !== input.key) throw storageError('multipart identity does not match', 409, 'multipart_identity_conflict');
    rmSync(directory, { recursive: true, force: true });
    return 'aborted';
  }

  private multipartDirectory(uploadIdInput: string): string {
    const uploadId = uploadIdValue(uploadIdInput);
    return requiredUploadPath(this.multipartRoot, uploadId);
  }

  private readManifest(uploadIdInput: string, keyInput: string): LocalMultipartManifest {
    const uploadId = uploadIdValue(uploadIdInput);
    const key = objectKeyValue(keyInput);
    const path = join(this.multipartDirectory(uploadId), 'manifest.json');
    if (!existsSync(path)) throw storageError('multipart upload not found', 404, 'multipart_upload_not_found');
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw storageError('multipart manifest is invalid', 500, 'multipart_manifest_invalid');
    }
    const manifest = parsed as Partial<LocalMultipartManifest>;
    if (
      manifest.schema_version !== 1 || manifest.upload_id !== uploadId || manifest.key !== key ||
      typeof manifest.content_type !== 'string' || typeof manifest.storage_url !== 'string'
    ) {
      throw storageError('multipart identity does not match', 409, 'multipart_identity_conflict');
    }
    return manifest as LocalMultipartManifest;
  }
}

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly bucket: string,
    private readonly region: string,
    private readonly endpoint: string | undefined,
    private readonly publicBaseUrl: string,
    private readonly credentials?: { accessKeyId: string; secretAccessKey: string },
    private readonly forcePathStyle = Boolean(endpoint)
  ) {}

  async upload(input: ObjectStorageUploadInput): Promise<ObjectStorageUploadResult> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const key = opaqueObjectKey(input);
    try {
      await (await this.client()).send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: contentTypeValue(input.contentType),
        ChecksumSHA256: sha256Base64(input.body),
        IfNoneMatch: '*'
      }));
    } catch (error) {
      if (isPreconditionFailed(error)) throw storageError('object already exists', 409, 'object_exists');
      throw error;
    }
    return {
      key,
      storage_url: this.storageUrl(key),
      size_bytes: input.body.length,
      etag: sha256Buffer(input.body)
    };
  }

  async download(keyInput: string, maxBytes?: number): Promise<Buffer | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const key = objectKeyValue(keyInput);
    try {
      const result = await (await this.client()).send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      if (!result.Body) return null;
      assertDownloadSize(Number(result.ContentLength || 0), maxBytes);
      const content = Buffer.from(await result.Body.transformToByteArray());
      assertDownloadSize(content.length, maxBytes);
      return content;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async head(keyInput: string): Promise<ObjectStorageObject | null> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const key = objectKeyValue(keyInput);
    try {
      const result = await (await this.client()).send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return {
        key,
        size_bytes: Number(result.ContentLength || 0),
        etag: unquoteEtag(String(result.ETag || result.ChecksumSHA256 || ''))
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(keyInput: string): Promise<'deleted' | 'not_found'> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const key = objectKeyValue(keyInput);
    if (!await this.head(key)) return 'not_found';
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    return 'deleted';
  }

  async initiateMultipart(input: ObjectStorageMultipartInput): Promise<ObjectStorageMultipartSession> {
    const { CreateMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const key = opaqueObjectKey(input);
    if (await this.head(key)) throw storageError('object already exists', 409, 'object_exists');
    const result = await (await this.client()).send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentTypeValue(input.contentType),
      ChecksumAlgorithm: 'SHA256',
      ChecksumType: 'COMPOSITE'
    }));
    if (!result.UploadId) throw storageError('S3 did not create a multipart upload', 503, 'multipart_create_failed');
    return { upload_id: result.UploadId, key, storage_url: this.storageUrl(key) };
  }

  async uploadPart(input: ObjectStorageUploadPartInput): Promise<ObjectStoragePartResult> {
    const { UploadPartCommand } = await import('@aws-sdk/client-s3');
    const normalized = normalizePartInput(input);
    const result = await (await this.client()).send(new UploadPartCommand({
      Bucket: this.bucket,
      Key: normalized.key,
      UploadId: normalized.upload_id,
      PartNumber: normalized.part_number,
      Body: normalized.body,
      ContentLength: normalized.body.length,
      ChecksumSHA256: Buffer.from(normalized.sha256, 'hex').toString('base64')
    }));
    const etag = unquoteEtag(String(result.ETag || ''));
    if (!etag) throw storageError('S3 part response is missing ETag', 503, 'multipart_part_etag_missing');
    return {
      part_number: normalized.part_number,
      size_bytes: normalized.body.length,
      etag,
      sha256: normalized.sha256
    };
  }

  async completeMultipart(input: ObjectStorageCompleteMultipartInput): Promise<ObjectStorageUploadResult> {
    const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const normalized = normalizeCompleteInput(input);
    const parts = normalizeCompletedParts(normalized.parts);
    if (parts.some((part) => !part.sha256)) {
      throw storageError('S3 multipart completion requires each part SHA-256', 400, 'multipart_part_sha256_required');
    }
    await (await this.client()).send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: normalized.key,
      UploadId: normalized.upload_id,
      ChecksumType: 'COMPOSITE',
      MpuObjectSize: normalized.size_bytes,
      MultipartUpload: {
        Parts: parts.map((part) => ({
          PartNumber: part.part_number,
          ETag: quoteEtag(part.etag),
          ChecksumSHA256: Buffer.from(part.sha256 || '', 'hex').toString('base64')
        }))
      }
    }));
    const head = await this.head(normalized.key);
    if (!head || head.size_bytes !== normalized.size_bytes) {
      throw storageError('S3 completed object could not be verified', 503, 'multipart_complete_unverified');
    }
    return { ...head, storage_url: this.storageUrl(normalized.key) };
  }

  async abortMultipart(input: ObjectStorageMultipartIdentity): Promise<'aborted' | 'not_found'> {
    const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const uploadId = uploadIdValue(input.upload_id);
    const key = objectKeyValue(input.key);
    try {
      await (await this.client()).send(new AbortMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId
      }));
      return 'aborted';
    } catch (error) {
      if (isNotFound(error) || String((error as { name?: unknown }).name || '') === 'NoSuchUpload') {
        return 'not_found';
      }
      throw error;
    }
  }

  private async client() {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      region: this.region,
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle,
      ...(this.credentials ? { credentials: this.credentials } : {})
    });
  }

  private storageUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
}

let storageSingleton: ObjectStorage | null = null;
let localStorageRoot: string | null = null;

export function createObjectStorage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  if (env !== process.env) return configuredObjectStorage(env);
  if (storageSingleton) return storageSingleton;
  storageSingleton = configuredObjectStorage(env);
  if (storageSingleton instanceof LocalObjectStorage) {
    localStorageRoot = storageSingleton.rootDir;
  }
  return storageSingleton;
}

function configuredObjectStorage(env: NodeJS.ProcessEnv): ObjectStorage {
  const config = resolveS3ConnectionConfig(env);
  if (config) {
    const publicBaseUrl =
      env.S3_PUBLIC_BASE_URL ||
      (config.endpoint
        ? `${config.endpoint.replace(/\/$/, '')}/${config.bucket}`
        : `https://${config.bucket}.s3.${config.region}.amazonaws.com`);
    return new S3ObjectStorage(
      config.bucket,
      config.region,
      config.endpoint,
      publicBaseUrl,
      config.credentials,
      config.forcePathStyle
    );
  }
  if (requiredSharedObjectStorage(env.OPC_OBJECT_STORAGE_REQUIRED)) {
    throw new Error(
      'shared object storage is required: configure S3_BUCKET, OPC_S3_BUCKET, or MINIO_BUCKET'
    );
  }
  return new LocalObjectStorage(env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads'));
}

function requiredSharedObjectStorage(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function resetObjectStorageForTests(): void {
  storageSingleton = null;
  localStorageRoot = null;
}

export function readLocalUpload(key: string, maxBytes?: number): Buffer | null {
  const root = localStorageRoot || process.env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
  const fullPath = requiredUploadPath(root, key);
  if (!existsSync(fullPath)) return null;
  assertDownloadSize(statSync(fullPath).size, maxBytes);
  const content = readFileSync(fullPath);
  assertDownloadSize(content.length, maxBytes);
  return content;
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

export function objectStorageKeyFor(input: {
  tenantId: string;
  keyPrefix?: string;
  resourceId?: string;
}): string {
  const tenant = safeKeySegment(input.tenantId, 'tenantId');
  const prefix = safeKeySegment(input.keyPrefix || 'objects', 'keyPrefix');
  const resource = input.resourceId
    ? safeKeySegment(input.resourceId, 'resourceId')
    : safeKeySegment(id('object'), 'resourceId');
  return objectKeyValue(`${tenant}/${prefix}/${resource}`);
}

function opaqueObjectKey(input: {
  tenantId: string;
  keyPrefix?: string;
  resourceId?: string;
}): string {
  return objectStorageKeyFor(input);
}

function normalizePartInput(input: ObjectStorageUploadPartInput): ObjectStorageUploadPartInput {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body || '');
  if (body.length === 0) throw storageError('multipart part body is empty', 400, 'multipart_part_empty');
  const expected = sha256Value(input.sha256, 'sha256');
  const actual = sha256Buffer(body);
  if (expected !== actual) throw storageError('multipart part SHA-256 does not match body', 400, 'multipart_part_checksum_invalid');
  return {
    upload_id: uploadIdValue(input.upload_id),
    key: objectKeyValue(input.key),
    part_number: boundedInteger(input.part_number, 1, MAX_PART_NUMBER, 'part_number'),
    body,
    sha256: expected
  };
}

function normalizeCompleteInput(
  input: ObjectStorageCompleteMultipartInput
): ObjectStorageCompleteMultipartInput {
  return {
    upload_id: uploadIdValue(input.upload_id),
    key: objectKeyValue(input.key),
    parts: normalizeCompletedParts(input.parts),
    size_bytes: boundedInteger(input.size_bytes, 1, Number.MAX_SAFE_INTEGER, 'size_bytes'),
    sha256: sha256Value(input.sha256, 'sha256')
  };
}

function normalizeCompletedParts(partsInput: ObjectStorageCompletedPart[]): ObjectStorageCompletedPart[] {
  if (!Array.isArray(partsInput) || partsInput.length === 0 || partsInput.length > MAX_PART_NUMBER) {
    throw storageError('multipart completion parts are invalid', 400, 'multipart_parts_invalid');
  }
  const parts = partsInput.map((part) => ({
    part_number: boundedInteger(part.part_number, 1, MAX_PART_NUMBER, 'part_number'),
    etag: boundedSingleLine(unquoteEtag(part.etag), 'etag', 255),
    ...(part.sha256 ? { sha256: sha256Value(part.sha256, 'part_sha256') } : {})
  })).sort((left, right) => left.part_number - right.part_number);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].part_number !== index + 1) {
      throw storageError('multipart parts must be contiguous from one', 400, 'multipart_parts_non_contiguous');
    }
  }
  return parts;
}

function assertCompletedObject(
  object: ObjectStorageObject,
  input: ObjectStorageCompleteMultipartInput,
  storageUrl: string
): ObjectStorageUploadResult {
  if (object.size_bytes !== input.size_bytes || object.etag !== input.sha256) {
    throw storageError('existing object does not match multipart completion', 409, 'multipart_completion_conflict');
  }
  return { ...object, storage_url: storageUrl };
}

function writeExclusiveAtomic(path: string, content: Buffer): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, content, { flag: 'wx' });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (isAlreadyExists(error)) throw storageError('object already exists', 409, 'object_exists');
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function resolveUploadPath(root: string, key: string): string | null {
  const resolvedRoot = resolve(root);
  const fullPath = resolve(resolvedRoot, key);
  if (fullPath !== resolvedRoot && !fullPath.startsWith(`${resolvedRoot}${sep}`)) return null;
  return fullPath;
}

function requiredUploadPath(root: string, keyInput: string): string {
  const key = objectKeyValue(keyInput);
  const path = resolveUploadPath(root, key);
  if (!path) throw storageError('object key is outside storage root', 400, 'object_key_invalid');
  return path;
}

function objectKeyValue(value: unknown): string {
  const key = boundedSingleLine(value, 'object_key', MAX_OBJECT_KEY_LENGTH);
  if (
    key.startsWith('/') || key.endsWith('/') || key.includes('\\') ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw storageError('object_key is invalid', 400, 'object_key_invalid');
  }
  return key;
}

function uploadIdValue(value: unknown): string {
  const uploadId = boundedSingleLine(value, 'upload_id', 512);
  if (!/^[a-zA-Z0-9._~+\/-]+$/.test(uploadId)) {
    throw storageError('upload_id is invalid', 400, 'upload_id_invalid');
  }
  return uploadId;
}

function safeKeySegment(value: unknown, field: string): string {
  const segment = boundedSingleLine(value, field, 255).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!segment || segment === '.' || segment === '..') {
    throw storageError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return segment;
}

function contentTypeValue(value: unknown): string {
  const contentType = boundedSingleLine(value, 'contentType', 255).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) {
    throw storageError('contentType is invalid', 400, 'content_type_invalid');
  }
  return contentType;
}

function sha256Value(value: unknown, field: string): string {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw storageError(`${field} must be a SHA-256 digest`, 400, `${field}_invalid`);
  }
  return hash;
}

function boundedSingleLine(value: unknown, field: string, max: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\u0000]/.test(text)) {
    throw storageError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw storageError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return parsed;
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64(value: Buffer): string {
  return createHash('sha256').update(value).digest('base64');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function localStorageUrl(key: string): string {
  return `/api/call-center/media/${key}`;
}

function assertDownloadSize(size: number, maxBytes?: number): void {
  if (maxBytes && size > maxBytes) {
    throw storageError('object exceeds configured download size limit', 413, 'object_too_large');
  }
}

function unquoteEtag(value: string): string {
  return String(value || '').trim().replace(/^"|"$/g, '');
}

function quoteEtag(value: string): string {
  return `"${unquoteEtag(value)}"`;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate?.name === 'NoSuchKey' || candidate?.name === 'NotFound' ||
    Number(candidate?.$metadata?.httpStatusCode || 0) === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate?.name === 'PreconditionFailed' || Number(candidate?.$metadata?.httpStatusCode || 0) === 412;
}

function storageError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}
