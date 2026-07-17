import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, type Dirent } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  stat,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  createIveKitBackupManifest,
  postgresClientEnvironment,
  readIveKitObjectBackupEntries,
  requiredRestoreConfirmation,
  sha256,
  validateIveKitBackupSet,
  type IveKitBackupManifest,
  type IveKitObjectBackupEntry
} from './backup.js';
import { REQUIRED_MIGRATIONS } from './readiness.js';

export interface IveKitProcessResult {
  stdout: string;
  stderr: string;
}

export type IveKitProcessRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
) => Promise<IveKitProcessResult>;

export interface IveKitBackupObject {
  key: string;
  etag: string;
  body: Readable;
}

export interface IveKitBackupObjectSource {
  list(): AsyncIterable<IveKitBackupObject>;
}

export interface IveKitRestoreObjectTarget {
  put(entry: IveKitObjectBackupEntry, sourcePath: string): Promise<void>;
}

export interface IveKitBackupResult {
  status: 'complete';
  directory: string;
  manifest: IveKitBackupManifest;
}

export interface IveKitRestoreResult {
  status: 'validated' | 'restored';
  backup_id: string;
  object_count: number;
  database_restored: boolean;
  database_count: number;
  databases_restored: number;
  objects_restored: number;
}

const execFileAsync = promisify(execFile);

const REQUIRED_RESTORE_TABLES = [
  'ivekit_notifications',
  'ivekit_notification_deliveries',
  'ivekit_audit_events',
  'ivekit_rate_limit_buckets',
  'ivekit_retention_policies',
  'ivekit_legal_holds',
  'ivekit_runtime_heartbeats'
] as const;

export async function runIveKitBackup(input: {
  directory: string;
  backup_id: string;
  env?: NodeJS.ProcessEnv;
  source_commit?: string;
  created_at?: string;
  processRunner?: IveKitProcessRunner;
  objectSource?: IveKitBackupObjectSource;
}): Promise<IveKitBackupResult> {
  const directory = resolve(input.directory);
  const env = input.env || process.env;
  const runner = input.processRunner || runProcess;
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await writeJsonExclusive(join(directory, '.ivekit-backup'), {
    schema_version: 1,
    backup_id: input.backup_id,
    status: 'partial'
  });
  try {
    const databaseProfiles = backupDatabaseProfiles(env);
    for (const database of databaseProfiles) {
      const databasePath = join(directory, database.file);
      await runner(env.OPC_IVEKIT_PG_DUMP_BIN || 'pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--file=${databasePath}`
      ], {
        env: postgresClientEnvironment(env, database.connection_url),
        cwd: directory
      });
      await assertRegularFile(databasePath, 'database_dump_missing');
    }

    await mkdir(join(directory, 'objects'), { mode: 0o700 });
    const objectManifest = await open(join(directory, 'objects.jsonl'), 'wx', 0o600);
    let objectCount = 0;
    try {
      const source = input.objectSource || createBackupObjectSource(env);
      for await (const object of source.list()) {
        const key = safeObjectKey(object.key);
        const backupFile = `objects/${sha256(key)}.bin`;
        const measured = await writeMeasuredStream(object.body, join(directory, backupFile));
        const entry: IveKitObjectBackupEntry = {
          key,
          backup_file: backupFile,
          sha256: measured.sha256,
          size_bytes: measured.size_bytes,
          etag: safeEtag(object.etag)
        };
        await objectManifest.write(`${JSON.stringify(entry)}\n`);
        objectCount += 1;
      }
    } finally {
      await objectManifest.close();
    }

    const manifest = await createIveKitBackupManifest({
      directory,
      backup_id: input.backup_id,
      created_at: input.created_at || new Date().toISOString(),
      source_commit: input.source_commit || env.IVEKIT_SOURCE_COMMIT || '',
      database_file: 'database.dump',
      object_manifest_file: 'objects.jsonl',
      object_count: objectCount,
      dependent_database_files: databaseProfiles.slice(1).map((database) => ({
        name: database.name,
        file: database.file
      }))
    });
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(directory, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'manifest.sha256'), `${sha256(manifestBytes)}\n`, {
      flag: 'wx', mode: 0o600
    });
    await validateIveKitBackupSet({ directory });
    await replaceJson(join(directory, '.ivekit-backup'), {
      schema_version: 1,
      backup_id: manifest.backup_id,
      status: 'complete',
      completed_at: new Date().toISOString()
    });
    return { status: 'complete', directory, manifest };
  } catch (error) {
    await replaceJson(join(directory, '.ivekit-backup'), {
      schema_version: 1,
      backup_id: input.backup_id,
      status: 'partial',
      failed_at: new Date().toISOString(),
      error_code: safeErrorCode(error)
    }).catch(() => undefined);
    throw error;
  }
}

export async function runIveKitRestore(input: {
  directory: string;
  execute?: boolean;
  env?: NodeJS.ProcessEnv;
  processRunner?: IveKitProcessRunner;
  objectTarget?: IveKitRestoreObjectTarget;
}): Promise<IveKitRestoreResult> {
  const directory = resolve(input.directory);
  const manifest = await validateIveKitBackupSet({ directory });
  if (!input.execute) {
    return {
      status: 'validated',
      backup_id: manifest.backup_id,
      object_count: manifest.objects.object_count,
      database_restored: false,
      database_count: 1 + manifest.dependent_databases.length,
      databases_restored: 0,
      objects_restored: 0
    };
  }

  const env = input.env || process.env;
  requiredRestoreConfirmation(manifest.backup_id, env.IVEKIT_RESTORE_CONFIRM);
  if (env.IVEKIT_RESTORE_TARGET_EMPTY !== '1') {
    throw operationError('restore_empty_target_assertion_required');
  }
  const runner = input.processRunner || runProcess;
  const databases = [manifest.database, ...manifest.dependent_databases].map((database) => ({
    ...database,
    environment: restoreDatabaseEnvironment(env, database.name)
  }));
  for (const database of databases) {
    const empty = await runner(env.OPC_IVEKIT_PSQL_BIN || 'psql', [
      '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      '-c', `SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'`
    ], { env: database.environment, cwd: directory });
    if (empty.stdout.trim() !== '0') throw operationError('restore_target_not_empty');
  }

  let databasesRestored = 0;
  for (const database of databases) {
    await runner(env.OPC_IVEKIT_PG_RESTORE_BIN || 'pg_restore', [
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      join(directory, database.file)
    ], { env: database.environment, cwd: directory });
    const validationSql = database.name === 'ivekit'
      ? restoreValidationSql()
      : `SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'`;
    const postRestore = await runner(env.OPC_IVEKIT_PSQL_BIN || 'psql', [
      '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      '-c', validationSql
    ], { env: database.environment, cwd: directory });
    if (database.name === 'ivekit') {
      if (postRestore.stdout.trim() !== '0|0') {
        throw operationError('restore_database_validation_failed');
      }
    } else if (!positiveIntegerOutput(postRestore.stdout)) {
      throw operationError('restore_dependent_database_validation_failed');
    }
    databasesRestored += 1;
  }

  const entries = await readIveKitObjectBackupEntries(directory, manifest.objects.file);
  const target = input.objectTarget || createRestoreObjectTarget(env);
  let restored = 0;
  for (const entry of entries) {
    await target.put(entry, join(directory, entry.backup_file));
    restored += 1;
  }
  return {
    status: 'restored',
    backup_id: manifest.backup_id,
    object_count: entries.length,
    database_restored: true,
    database_count: databases.length,
    databases_restored: databasesRestored,
    objects_restored: restored
  };
}

interface BackupDatabaseProfile {
  name: string;
  file: string;
  connection_url?: string;
}

function backupDatabaseProfiles(env: NodeJS.ProcessEnv): BackupDatabaseProfile[] {
  const profiles: BackupDatabaseProfile[] = [{
    name: 'ivekit',
    file: 'database.dump',
    connection_url: env.OPC_IVEKIT_ADMIN_DATABASE_URL || env.DATABASE_URL
  }];
  for (const dependency of [
    { name: 'tinode', variable: 'OPC_IVEKIT_TINODE_ADMIN_DATABASE_URL' },
    { name: 'rustpbx', variable: 'OPC_IVEKIT_RUSTPBX_ADMIN_DATABASE_URL' }
  ]) {
    const connectionUrl = String(env[dependency.variable] || '').trim();
    if (connectionUrl) profiles.push({
      name: dependency.name,
      file: `database-${dependency.name}.dump`,
      connection_url: connectionUrl
    });
  }
  return profiles;
}

function restoreDatabaseEnvironment(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  if (name === 'ivekit') {
    return postgresClientEnvironment(env, env.OPC_IVEKIT_ADMIN_DATABASE_URL || env.DATABASE_URL);
  }
  const variable = `OPC_IVEKIT_${name.toUpperCase().replaceAll('-', '_')}_ADMIN_DATABASE_URL`;
  const connectionUrl = String(env[variable] || '').trim();
  if (!connectionUrl) throw operationError('restore_dependent_database_configuration_missing');
  return postgresClientEnvironment(env, connectionUrl);
}

export function createIveKitBackupId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-');
  return `ivekit-${timestamp}-${randomUUID()}`;
}

export function createBackupObjectSource(env: NodeJS.ProcessEnv): IveKitBackupObjectSource {
  const config = s3Config(env);
  return config ? new S3BackupObjectSource(config) : new LocalBackupObjectSource(
    env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads')
  );
}

export function createRestoreObjectTarget(env: NodeJS.ProcessEnv): IveKitRestoreObjectTarget {
  const config = s3Config(env);
  return config ? new S3RestoreObjectTarget(config) : new LocalRestoreObjectTarget(
    env.OPC_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads')
  );
}

export async function runProcess(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
): Promise<IveKitProcessResult> {
  const result = await execFileAsync(executable, args, {
    env: options.env,
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

class LocalBackupObjectSource implements IveKitBackupObjectSource {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async *list(): AsyncIterable<IveKitBackupObject> {
    const metadata = await stat(this.root).catch(() => null);
    if (!metadata?.isDirectory()) throw operationError('local_object_root_missing');
    for await (const file of walkRegularFiles(this.root, this.root)) {
      const key = relative(this.root, file).split(sep).join('/');
      yield { key: safeObjectKey(key), etag: '', body: createReadStream(file) };
    }
  }
}

interface S3Configuration {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

class S3BackupObjectSource implements IveKitBackupObjectSource {
  constructor(private readonly config: S3Configuration) {}

  async *list(): AsyncIterable<IveKitBackupObject> {
    const { GetObjectCommand, ListObjectsV2Command, S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientOptions(this.config));
    let continuationToken: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: this.config.prefix || undefined,
        ContinuationToken: continuationToken
      }));
      for (const item of page.Contents || []) {
        if (!item.Key) continue;
        const object = await client.send(new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: item.Key
        }));
        if (!object.Body) throw operationError('s3_object_body_missing');
        yield {
          key: safeObjectKey(item.Key),
          etag: safeEtag(String(item.ETag || '')),
          body: sdkBodyToReadable(object.Body)
        };
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuationToken) throw operationError('s3_pagination_invalid');
    } while (continuationToken);
  }
}

class LocalRestoreObjectTarget implements IveKitRestoreObjectTarget {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(entry: IveKitObjectBackupEntry, sourcePath: string): Promise<void> {
    const target = containedObjectPath(this.root, entry.key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') throw operationError('restore_object_exists');
      throw error;
    }
  }
}

class S3RestoreObjectTarget implements IveKitRestoreObjectTarget {
  constructor(private readonly config: S3Configuration) {}

  async put(entry: IveKitObjectBackupEntry, sourcePath: string): Promise<void> {
    const { HeadObjectCommand, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientOptions(this.config));
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: entry.key }));
      throw operationError('restore_object_exists');
    } catch (error) {
      if (String((error as { code?: unknown }).code || '') === 'restore_object_exists') throw error;
      const status = Number(
        (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode || 0
      );
      const name = String((error as { name?: unknown }).name || '');
      if (status !== 404 && name !== 'NotFound' && name !== 'NoSuchKey') throw error;
    }
    await client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: entry.key,
      Body: createReadStream(sourcePath),
      ContentLength: entry.size_bytes,
      ChecksumSHA256: Buffer.from(entry.sha256, 'hex').toString('base64'),
      IfNoneMatch: '*'
    }));
  }
}

async function* walkRegularFiles(root: string, directory: string): AsyncIterable<string> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (directory === root && entry.name === '.multipart') continue;
    const path = join(directory, entry.name);
    await assertWalkEntry(path, entry);
    if (entry.isDirectory()) yield* walkRegularFiles(root, path);
    else if (entry.isFile()) yield path;
  }
}

async function assertWalkEntry(path: string, entry: Dirent): Promise<void> {
  if (entry.isSymbolicLink()) throw operationError('local_object_symlink_forbidden');
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw operationError('local_object_type_forbidden');
  }
}

async function writeMeasuredStream(body: Readable, destination: string): Promise<{
  sha256: string;
  size_bytes: number;
}> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      hash.update(bytes);
      callback(null, bytes);
    }
  });
  await pipeline(body, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return { sha256: hash.digest('hex'), size_bytes: size };
}

function s3Config(env: NodeJS.ProcessEnv): S3Configuration | null {
  const bucket = String(env.S3_BUCKET || env.OPC_S3_BUCKET || env.MINIO_BUCKET || '').trim();
  if (!bucket) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw operationError('s3_bucket_invalid');
  }
  const accessKeyId = String(
    env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || env.MINIO_ACCESS_KEY || ''
  );
  const secretAccessKey = String(
    env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || env.MINIO_SECRET_KEY || ''
  );
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw operationError('s3_credentials_incomplete');
  }
  return {
    bucket,
    region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT || env.MINIO_ENDPOINT,
    prefix: safeS3Prefix(env.OPC_IVEKIT_BACKUP_OBJECT_PREFIX || ''),
    ...(accessKeyId ? { credentials: { accessKeyId, secretAccessKey } } : {})
  };
}

function s3ClientOptions(config: S3Configuration) {
  return {
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint),
    ...(config.credentials ? { credentials: config.credentials } : {})
  };
}

function sdkBodyToReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function') {
    const stream = (
      body as { transformToWebStream(): ReadableStream<Uint8Array> }
    ).transformToWebStream();
    return Readable.fromWeb(stream);
  }
  if (body && Symbol.asyncIterator in Object(body)) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw operationError('s3_object_stream_invalid');
}

function restoreValidationSql(): string {
  const migrations = REQUIRED_MIGRATIONS.map((value) => `('${value}')`).join(',');
  const tables = REQUIRED_RESTORE_TABLES.map((value) => `('${value}')`).join(',');
  return `WITH expected_migration(version) AS (VALUES ${migrations}), expected_table(name) AS (VALUES ${tables}) SELECT (SELECT COUNT(*) FROM expected_migration e WHERE NOT EXISTS (SELECT 1 FROM schema_migrations m WHERE m.version = e.version)) || '|' || (SELECT COUNT(*) FROM expected_table e WHERE to_regclass('public.' || e.name) IS NULL)`;
}

function safeObjectKey(value: string): string {
  if (!value || value.length > 1024 || /[\r\n\0]/.test(value) || value.startsWith('/')
    || value.split('/').includes('..')) throw operationError('object_key_invalid');
  return value;
}

function safeEtag(value: string): string {
  const text = value.replace(/^"|"$/g, '');
  if (text.length > 255 || /[\r\n\0]/.test(text)) throw operationError('object_etag_invalid');
  return text;
}

function safeS3Prefix(value: string): string {
  if (value.length > 1024 || /[\r\n\0]/.test(value) || value.startsWith('/')
    || value.split('/').includes('..')) throw operationError('s3_prefix_invalid');
  return value;
}

function containedObjectPath(root: string, key: string): string {
  const path = resolve(root, safeObjectKey(key));
  if (!path.startsWith(`${root}${sep}`)) throw operationError('object_key_invalid');
  return path;
}

async function assertRegularFile(path: string, code: string): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw operationError(code);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

function safeErrorCode(error: unknown): string {
  const value = String((error as { code?: unknown }).code || 'backup_failed');
  return /^[a-z0-9_]{1,100}$/.test(value) ? value : 'backup_failed';
}

function nodeErrorCode(error: unknown): string {
  return String((error as { code?: unknown }).code || '');
}

function positiveIntegerOutput(value: string): boolean {
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0;
}

function operationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
