import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  CreateBucketCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createObjectStorage } from '../../../../src/storage/object-storage.js';

interface MatrixResult {
  status: 'passed';
  bucket: string;
  recovery_key: string;
  checks: Record<string, 'passed' | 'not_supported_upstream'>;
  durations_ms: Record<string, number>;
}

const mode = process.argv[2] || '';

await main();

async function main(): Promise<void> {
  if (mode === 'ready') {
    await s3Client().send(new ListBucketsCommand({}));
    process.stdout.write('{"status":"ready"}\n');
    return;
  }
  if (mode === 'matrix') return runMatrix(process.argv[3]);
  if (mode === 'expect-outage') return expectOutage(process.argv[3]);
  if (mode === 'recovery') return verifyRecovery(process.argv[3]);
  if (mode === 'finalize') {
    return finalizeEvidence(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
  }
  throw new Error('usage: probe.ts matrix|expect-outage|recovery|finalize ...');
}

async function runMatrix(statePath: string | undefined): Promise<void> {
  if (!statePath) throw new Error('matrix state path is required');
  const client = s3Client();
  const bucket = requiredEnv('S3_BUCKET');
  await ensureBucket(client, bucket);
  const storage = createObjectStorage(process.env);
  const durations: Record<string, number> = {};

  const small = Buffer.from(`ivekit-seaweedfs-small-${randomUUID()}`);
  const smallObject = await measured(durations, 'small_object', () => storage.upload({
    tenantId: 'acceptance',
    keyPrefix: 'seaweedfs',
    resourceId: `small-${randomUUID()}`,
    filename: 'small.bin',
    contentType: 'application/octet-stream',
    body: small
  }));
  assertBuffer('small download', await storage.download(smallObject.key), small);
  const smallHead = await storage.head(smallObject.key);
  if (!smallHead || smallHead.size_bytes !== small.length) throw new Error('small HEAD verification failed');

  const large = randomBytes(16 * 1024 * 1024);
  const largeObject = await measured(durations, 'large_object', () => storage.upload({
    tenantId: 'acceptance',
    keyPrefix: 'seaweedfs',
    resourceId: `large-${randomUUID()}`,
    filename: 'large.bin',
    contentType: 'application/octet-stream',
    body: large
  }));
  assertBuffer('large download', await storage.download(largeObject.key, large.length), large);

  const parts = [randomBytes(5 * 1024 * 1024), randomBytes(5 * 1024 * 1024), randomBytes(1024 * 1024)];
  const multipart = await storage.initiateMultipart({
    tenantId: 'acceptance',
    keyPrefix: 'seaweedfs',
    resourceId: `multipart-${randomUUID()}`,
    contentType: 'application/octet-stream'
  });
  const uploadedParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const sha256 = sha256Hex(parts[index]);
    uploadedParts.push(await storage.uploadPart({
      upload_id: multipart.upload_id,
      key: multipart.key,
      part_number: index + 1,
      body: parts[index],
      sha256
    }));
  }
  const multipartBody = Buffer.concat(parts);
  await measured(durations, 'multipart_complete', () => storage.completeMultipart({
    upload_id: multipart.upload_id,
    key: multipart.key,
    parts: uploadedParts,
    size_bytes: multipartBody.length,
    sha256: sha256Hex(multipartBody)
  }));
  assertBuffer(
    'multipart download',
    await storage.download(multipart.key, multipartBody.length),
    multipartBody
  );

  const abandoned = await storage.initiateMultipart({
    tenantId: 'acceptance',
    keyPrefix: 'seaweedfs',
    resourceId: `abort-${randomUUID()}`,
    contentType: 'application/octet-stream'
  });
  const abandonedPart = randomBytes(5 * 1024 * 1024);
  await storage.uploadPart({
    upload_id: abandoned.upload_id,
    key: abandoned.key,
    part_number: 1,
    body: abandonedPart,
    sha256: sha256Hex(abandonedPart)
  });
  if (await storage.abortMultipart(abandoned) !== 'aborted') throw new Error('multipart abort failed');

  const ranged = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: largeObject.key,
    Range: 'bytes=1024-4095'
  }));
  const rangeBody = ranged.Body ? Buffer.from(await ranged.Body.transformToByteArray()) : Buffer.alloc(0);
  assertBuffer('range download', rangeBody, large.subarray(1024, 4096));

  await client.send(new PutBucketVersioningCommand({
    Bucket: bucket,
    VersioningConfiguration: { Status: 'Enabled' }
  }));
  const versionedKey = `acceptance/seaweedfs/versioned-${randomUUID()}`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: versionedKey, Body: 'version-one' }));
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: versionedKey, Body: 'version-two' }));
  const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: versionedKey }));
  if ((versions.Versions || []).filter((version) => version.Key === versionedKey).length < 2) {
    throw new Error('S3 versioning did not retain both object versions');
  }

  const recoveryBody = Buffer.from(`ivekit-seaweedfs-recovery-${randomUUID()}`);
  const recoveryObject = await storage.upload({
    tenantId: 'acceptance',
    keyPrefix: 'seaweedfs',
    resourceId: `recovery-${randomUUID()}`,
    filename: 'recovery.bin',
    contentType: 'application/octet-stream',
    body: recoveryBody
  });
  await writeFile(statePath, `${JSON.stringify({
    key: recoveryObject.key,
    sha256: sha256Hex(recoveryBody)
  })}\n`, { mode: 0o600 });

  if (await storage.delete(smallObject.key) !== 'deleted') throw new Error('small delete failed');
  if (await storage.download(smallObject.key) !== null) throw new Error('deleted small object is still readable');
  await storage.delete(largeObject.key);
  await storage.delete(multipart.key);

  const result: MatrixResult = {
    status: 'passed',
    bucket,
    recovery_key: recoveryObject.key,
    checks: {
      put_get_head_delete: 'passed',
      large_object: 'passed',
      multipart_complete: 'passed',
      multipart_abort: 'passed',
      range_get: 'passed',
      versioning: 'passed',
      object_lock_worm: 'not_supported_upstream'
    },
    durations_ms: durations
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function expectOutage(statePath: string | undefined): Promise<void> {
  const state = await readState(statePath);
  const storage = createObjectStorage(process.env);
  const started = Date.now();
  let failedClosed = false;
  try {
    await Promise.race([
      storage.download(state.key),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('storage outage timeout')), 5_000))
    ]);
  } catch {
    failedClosed = true;
  }
  if (!failedClosed) throw new Error('object storage request unexpectedly succeeded during outage');
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    request_failed_closed: true,
    elapsed_ms: Date.now() - started,
    media_hot_path: 'not_run_real_livekit_egress'
  })}\n`);
}

async function verifyRecovery(statePath: string | undefined): Promise<void> {
  const state = await readState(statePath);
  const storage = createObjectStorage(process.env);
  const body = await storage.download(state.key);
  if (!body || sha256Hex(body) !== state.sha256) throw new Error('recovery object verification failed');
  process.stdout.write(`${JSON.stringify({ status: 'passed', object_recovered: true })}\n`);
}

async function finalizeEvidence(
  matrixPath: string | undefined,
  outagePath: string | undefined,
  recoveryPath: string | undefined,
  outputPath: string | undefined
): Promise<void> {
  if (!matrixPath || !outagePath || !recoveryPath || !outputPath) {
    throw new Error('finalize requires matrix, outage, recovery and output paths');
  }
  const evidence = {
    schema_version: 1,
    status: 'passed_controlled_server',
    completed_at: new Date().toISOString(),
    image: requiredEnv('SEAWEEDFS_IMAGE'),
    topology: ['master', 'volume', 'filer', 's3'],
    matrix: JSON.parse(await readFile(matrixPath, 'utf8')),
    outage: JSON.parse(await readFile(outagePath, 'utf8')),
    recovery: JSON.parse(await readFile(recoveryPath, 'utf8')),
    target_kubernetes: 'not_run_target_kubernetes',
    cross_zone_failure: 'not_run_target_kubernetes',
    livekit_egress_storage_isolation: 'not_run_real_livekit_egress',
    object_lock_worm: 'not_supported_upstream'
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = String((error as { name?: unknown }).name || '');
    if (!['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'].includes(name)) throw error;
  }
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: requiredEnv('S3_ENDPOINT'),
    region: requiredEnv('S3_REGION'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('AWS_SECRET_ACCESS_KEY')
    },
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 2_000,
      requestTimeout: 10_000
    })
  });
}

async function readState(path: string | undefined): Promise<{ key: string; sha256: string }> {
  if (!path) throw new Error('state path is required');
  return JSON.parse(await readFile(path, 'utf8')) as { key: string; sha256: string };
}

async function measured<T>(
  durations: Record<string, number>,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    return await operation();
  } finally {
    durations[name] = Date.now() - started;
  }
}

function assertBuffer(label: string, actual: Buffer | null, expected: Buffer): void {
  if (!actual || !actual.equals(expected)) throw new Error(`${label} content mismatch`);
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
