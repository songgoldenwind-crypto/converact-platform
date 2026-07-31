import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from '@aws-sdk/client-s3';

import type { CapacityEvidenceObjectStore } from './worker-runtime.js';

export interface S3CapacityEvidenceConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  force_path_style?: boolean;
  access_key_id?: string;
  secret_access_key?: string;
}

export class S3CapacityEvidenceObjectStore implements CapacityEvidenceObjectStore {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(config: S3CapacityEvidenceConfig) {
    this.#bucket = bucket(config.bucket);
    this.#client = new S3Client(s3ClientConfig(config));
  }

  async put(input: {
    key: string;
    body: Uint8Array;
    sha256: string;
    content_type: 'application/json';
    signal: AbortSignal;
  }): Promise<{ object_uri: string }> {
    const key = objectKey(input.key);
    await this.#client.send(new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      Body: input.body,
      ContentType: input.content_type,
      Metadata: { sha256: input.sha256 }
    }), { abortSignal: input.signal });
    return { object_uri: `s3://${this.#bucket}/${key}` };
  }

  async get(input: {
    object_uri: string;
    maximum_bytes: number;
    signal: AbortSignal;
  }): Promise<Uint8Array> {
    if (!Number.isSafeInteger(input.maximum_bytes) || input.maximum_bytes < 1 ||
        input.maximum_bytes > 64 * 1024 * 1024) {
      throw new Error('capacity evidence read limit is invalid');
    }
    const key = parseCapacityEvidenceObjectUri(input.object_uri, this.#bucket);
    const result = await this.#client.send(new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key
    }), { abortSignal: input.signal });
    if (result.ContentLength != null && result.ContentLength > input.maximum_bytes) {
      throw new Error('capacity evidence object exceeds the read limit');
    }
    if (!result.Body || !(Symbol.asyncIterator in Object(result.Body))) {
      throw new Error('capacity evidence object has no readable body');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > input.maximum_bytes) {
        throw new Error('capacity evidence object exceeds the read limit');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  }
}

export function parseCapacityEvidenceObjectUri(value: string, expectedBucket: string): string {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(value);
  if (!match) throw new Error('capacity evidence object URI is invalid');
  if (match[1] !== expectedBucket) throw new Error('capacity evidence object bucket mismatch');
  return objectKey(match[2]);
}

function s3ClientConfig(config: S3CapacityEvidenceConfig): S3ClientConfig {
  const result: S3ClientConfig = {
    region: String(config.region || '')
  };
  if (!result.region) throw new Error('capacity evidence S3 region is required');
  if (config.endpoint) {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username || endpoint.password) {
      throw new Error('capacity evidence S3 endpoint is invalid');
    }
    result.endpoint = endpoint.toString();
  }
  result.forcePathStyle = config.force_path_style === true;
  const accessKeyId = String(config.access_key_id || '');
  const secretAccessKey = String(config.secret_access_key || '');
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('capacity evidence S3 credentials are incomplete');
  }
  if (accessKeyId) {
    result.credentials = {
      accessKeyId,
      secretAccessKey
    };
  }
  return result;
}

function bucket(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) {
    throw new Error('capacity evidence S3 bucket is invalid');
  }
  return value;
}

function objectKey(value: string): string {
  if (!value || value.length > 1024 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(value) ||
      value.split('/').some((part) => part === '' || part === '..')) {
    throw new Error('capacity evidence object key is invalid');
  }
  return value;
}
