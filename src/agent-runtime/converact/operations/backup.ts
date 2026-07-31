import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

import { REQUIRED_MIGRATIONS } from './readiness.js';

export interface IveKitBackupArtifact {
  file: string;
  sha256: string;
  size_bytes: number;
}

export interface IveKitBackupManifest {
  schema_version: 1;
  backup_id: string;
  status: 'complete';
  created_at: string;
  source_commit: string;
  database: IveKitBackupArtifact & { name: 'ivekit'; format: 'postgres_custom' };
  dependent_databases: Array<IveKitBackupArtifact & {
    name: string;
    format: 'postgres_custom';
  }>;
  objects: IveKitBackupArtifact & { object_count: number };
  required_migrations: string[];
}

export interface IveKitObjectBackupEntry {
  key: string;
  backup_file: string;
  sha256: string;
  size_bytes: number;
  etag: string;
}

export async function createIveKitBackupManifest(input: {
  directory: string;
  backup_id: string;
  created_at: string;
  source_commit?: string;
  database_file: string;
  object_manifest_file: string;
  object_count: number;
  dependent_database_files?: Array<{ name: string; file: string }>;
}): Promise<IveKitBackupManifest> {
  const directory = resolve(input.directory);
  const database = await artifact(directory, input.database_file);
  const objects = await artifact(directory, input.object_manifest_file);
  const dependentDatabases = await Promise.all((input.dependent_database_files || []).map(
    async (database) => ({
      ...await artifact(directory, database.file),
      name: safeDatabaseName(database.name),
      format: 'postgres_custom' as const
    })
  ));
  if (new Set(dependentDatabases.map((database) => database.name)).size !== dependentDatabases.length) {
    throw backupError('manifest_database_duplicate');
  }
  return {
    schema_version: 1,
    backup_id: safeId(input.backup_id),
    status: 'complete',
    created_at: timestamp(input.created_at),
    source_commit: sourceCommit(input.source_commit),
    database: { ...database, name: 'ivekit', format: 'postgres_custom' },
    dependent_databases: dependentDatabases,
    objects: {
      ...objects,
      object_count: nonNegativeInteger(input.object_count)
    },
    required_migrations: [...REQUIRED_MIGRATIONS]
  };
}

export async function validateIveKitBackupSet(input: {
  directory: string;
  manifest_file?: string;
  manifest_sha256_file?: string;
}): Promise<IveKitBackupManifest> {
  const directory = resolve(input.directory);
  const manifestPath = containedPath(directory, input.manifest_file || 'manifest.json');
  const manifestHashPath = containedPath(
    directory,
    input.manifest_sha256_file || 'manifest.sha256'
  );
  const [manifestBytes, expectedManifestHash] = await Promise.all([
    readFile(manifestPath),
    readFile(manifestHashPath, 'utf8')
  ]);
  if (sha256(manifestBytes) !== expectedManifestHash.trim()) throw backupError('manifest_checksum_mismatch');
  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw backupError('manifest_invalid');
  }
  const manifest = parseManifest(value);
  for (const expected of REQUIRED_MIGRATIONS) {
    if (!manifest.required_migrations.includes(expected)) throw backupError('manifest_migration_gap');
  }
  await verifyArtifact(directory, manifest.database);
  for (const database of manifest.dependent_databases) await verifyArtifact(directory, database);
  await verifyArtifact(directory, manifest.objects);
  await verifyObjectArtifacts(directory, manifest.objects.file, manifest.objects.object_count);
  return manifest;
}

export async function readIveKitObjectBackupEntries(
  directory: string,
  file: string
): Promise<IveKitObjectBackupEntry[]> {
  const bytes = await readFile(containedPath(resolve(directory), file), 'utf8');
  if (Buffer.byteLength(bytes) > 268_435_456) throw backupError('object_manifest_too_large');
  const lines = bytes.split('\n').filter(Boolean);
  if (lines.length > 10_000_000) throw backupError('object_manifest_too_large');
  return lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw backupError('object_manifest_invalid');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw backupError('object_manifest_invalid');
    }
    const input = value as Record<string, unknown>;
    return {
      key: objectKey(input.key),
      backup_file: objectBackupFile(input.backup_file),
      sha256: digest(input.sha256),
      size_bytes: nonNegativeInteger(input.size_bytes),
      etag: safeEtag(input.etag)
    };
  });
}

export function postgresClientEnvironment(
  env: NodeJS.ProcessEnv,
  connectionUrl = env.OPC_IVEKIT_ADMIN_DATABASE_URL || env.DATABASE_URL
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    LANG: env.LANG || 'C.UTF-8',
    PGCONNECT_TIMEOUT: env.PGCONNECT_TIMEOUT || '10'
  };
  if (connectionUrl) {
    let url: URL;
    try {
      url = new URL(connectionUrl);
    } catch {
      throw backupError('database_configuration_invalid');
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw backupError('database_configuration_invalid');
    }
    output.PGHOST = decodeURIComponent(url.hostname);
    output.PGPORT = url.port || '5432';
    output.PGDATABASE = decodeURIComponent(url.pathname.replace(/^\//, ''));
    output.PGUSER = decodeURIComponent(url.username);
    output.PGPASSWORD = decodeURIComponent(url.password);
    output.PGSSLMODE = url.searchParams.get('sslmode') || env.PGSSLMODE;
  } else {
    for (const key of [
      'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
      'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY'
    ]) output[key] = env[key];
  }
  for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER']) {
    if (!output[key]) throw backupError('database_configuration_invalid');
  }
  return Object.fromEntries(
    Object.entries(output).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export function requiredRestoreConfirmation(backupId: string, provided: string | undefined): void {
  if (provided !== `RESTORE:${safeId(backupId)}`) throw backupError('restore_confirmation_required');
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function artifact(directory: string, file: string): Promise<IveKitBackupArtifact> {
  const path = containedPath(directory, file);
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
  if (!metadata.isFile()) throw backupError('artifact_invalid');
  return { file: basename(path), sha256: sha256(bytes), size_bytes: metadata.size };
}

async function verifyArtifact(directory: string, artifactInput: IveKitBackupArtifact): Promise<void> {
  const path = containedPath(directory, artifactInput.file);
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
  if (!metadata.isFile() || metadata.size !== artifactInput.size_bytes
    || sha256(bytes) !== artifactInput.sha256) throw backupError('artifact_checksum_mismatch');
}

async function verifyObjectArtifacts(
  directory: string,
  manifestFile: string,
  expectedCount: number
): Promise<void> {
  const entries = await readIveKitObjectBackupEntries(directory, manifestFile);
  if (entries.length !== expectedCount) throw backupError('object_count_mismatch');
  const seenKeys = new Set<string>();
  const seenFiles = new Set<string>();
  for (const entry of entries) {
    if (seenKeys.has(entry.key) || seenFiles.has(entry.backup_file)) {
      throw backupError('object_manifest_duplicate');
    }
    seenKeys.add(entry.key);
    seenFiles.add(entry.backup_file);
    const path = containedRelativePath(directory, entry.backup_file);
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    if (!metadata.isFile() || metadata.size !== entry.size_bytes
      || sha256(bytes) !== entry.sha256) throw backupError('object_checksum_mismatch');
  }
}

function parseManifest(value: unknown): IveKitBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw backupError('manifest_invalid');
  const input = value as Record<string, any>;
  if (input.schema_version !== 1 || input.status !== 'complete'
    || !Array.isArray(input.required_migrations)) throw backupError('manifest_invalid');
  return {
    schema_version: 1,
    backup_id: safeId(input.backup_id),
    status: 'complete',
    created_at: timestamp(input.created_at),
    source_commit: sourceCommit(input.source_commit),
    database: {
      ...parseArtifact(input.database, 'postgres_custom'),
      name: input.database?.name === undefined ? 'ivekit' : primaryDatabaseName(input.database.name),
      format: 'postgres_custom'
    },
    dependent_databases: parseDependentDatabases(input.dependent_databases),
    objects: {
      ...parseArtifact(input.objects),
      object_count: nonNegativeInteger(input.objects?.object_count)
    },
    required_migrations: input.required_migrations.map((item: unknown) => safeMigration(item))
  };
}

function parseDependentDatabases(value: unknown): IveKitBackupManifest['dependent_databases'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw backupError('manifest_invalid');
  const databases = value.map((item) => {
    const input = item as Record<string, unknown>;
    return {
      ...parseArtifact(item, 'postgres_custom'),
      name: safeDatabaseName(input?.name),
      format: 'postgres_custom' as const
    };
  });
  if (new Set(databases.map((database) => database.name)).size !== databases.length) {
    throw backupError('manifest_database_duplicate');
  }
  return databases;
}

function parseArtifact(value: unknown, format?: string): IveKitBackupArtifact & { format?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw backupError('manifest_invalid');
  const input = value as Record<string, unknown>;
  if (format && input.format !== format) throw backupError('manifest_invalid');
  return {
    file: safeFilename(input.file),
    sha256: digest(input.sha256),
    size_bytes: nonNegativeInteger(input.size_bytes),
    ...(format ? { format } : {})
  };
}

function containedPath(directory: string, file: string): string {
  const safe = safeFilename(file);
  const path = resolve(directory, safe);
  if (!path.startsWith(`${directory}${sep}`)) throw backupError('artifact_path_invalid');
  return path;
}

function containedRelativePath(directory: string, file: string): string {
  const safe = objectBackupFile(file);
  const path = resolve(directory, safe);
  if (!path.startsWith(`${directory}${sep}`)) throw backupError('artifact_path_invalid');
  return path;
}

function safeFilename(value: unknown): string {
  if (typeof value !== 'string' || value !== basename(value)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value)) throw backupError('artifact_path_invalid');
  return value;
}

function objectBackupFile(value: unknown): string {
  if (typeof value !== 'string' || !/^objects\/[a-f0-9]{64}\.bin$/.test(value)) {
    throw backupError('object_manifest_invalid');
  }
  return value;
}

function objectKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024
    || /[\r\n\0]/.test(value) || value.startsWith('/') || value.split('/').includes('..')) {
    throw backupError('object_manifest_invalid');
  }
  return value;
}

function safeEtag(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 255 || /[\r\n\0]/.test(value)) {
    throw backupError('object_manifest_invalid');
  }
  return value;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw backupError('manifest_invalid');
  }
  return value;
}

function safeMigration(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{3}_[a-z0-9_]{1,100}$/.test(value)) {
    throw backupError('manifest_invalid');
  }
  return value;
}

function primaryDatabaseName(value: unknown): 'ivekit' {
  if (value !== 'ivekit') throw backupError('manifest_invalid');
  return 'ivekit';
}

function safeDatabaseName(value: unknown): string {
  if (typeof value !== 'string' || value === 'ivekit'
    || !/^[a-z][a-z0-9_-]{0,62}$/.test(value)) throw backupError('manifest_invalid');
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw backupError('manifest_invalid');
  return value;
}

function timestamp(value: unknown): string {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw backupError('manifest_invalid');
  return date.toISOString();
}

function sourceCommit(value: unknown): string {
  const text = String(value || '').toLowerCase();
  if (text && !/^[a-f0-9]{40}$/.test(text)) throw backupError('manifest_invalid');
  return text;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw backupError('manifest_invalid');
  return number;
}

function backupError(code: string): Error {
  return Object.assign(new Error(code), { code, status: 422 });
}
