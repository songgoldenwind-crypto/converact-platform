import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POSTGRES_SCRIPT = join(ROOT, 'infra/scripts/bootstrap-postgres-databases.sh');
const MINIO_SCRIPT = join(ROOT, 'infra/scripts/bootstrap-minio-bucket.sh');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function createFakePsql(binDir: string): void {
  writeExecutable(join(binDir, 'psql'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_PSQL_LOG"
database=
case "$*" in
  *keycloak*) database=keycloak ;;
  *tinode*) database=tinode ;;
  *chatwoot*) database=chatwoot ;;
  *rustpbx*) database=rustpbx ;;
  *opc*) database=opc ;;
esac
case "$*" in
  *"CREATE DATABASE"*)
    if [ "\${FAKE_PSQL_CREATE_FAIL:-0}" = "1" ]; then exit 9; fi
    : > "$FAKE_PSQL_STATE/$database"
    ;;
  *"SELECT r.rolname FROM pg_database"*)
    if [ -f "$FAKE_PSQL_STATE/$database" ]; then
      if [ "\${FAKE_PSQL_WRONG_OWNER:-0}" = "1" ]; then
        printf 'postgres\n'
      elif [ "$database" = 'rustpbx' ]; then
        printf 'rustpbx_app\n'
      else
        printf 'opc\n'
      fi
    fi
    ;;
  *"SELECT 1 FROM pg_database"*)
    if [ -f "$FAKE_PSQL_STATE/$database" ]; then printf '1\n'; fi
    ;;
esac
`);
}

function createPostgresFixture(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-postgres-bootstrap-'));
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const logFile = join(dir, 'psql.log');
  mkdirSync(binDir);
  mkdirSync(stateDir);
  createFakePsql(binDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    POSTGRES_HOST: 'postgres',
    POSTGRES_PORT: '5432',
    POSTGRES_USER: 'opc',
    POSTGRES_PASSWORD: 'postgres-test-secret',
    POSTGRES_MAINTENANCE_DATABASE: 'postgres',
    CONVERACT_POSTGRES_BOOTSTRAP_DATABASES: 'keycloak,tinode',
    FAKE_PSQL_LOG: logFile,
    FAKE_PSQL_STATE: stateDir,
    ...overrides
  };

  return {
    env,
    logFile,
    stateDir,
    run: () => spawnSync('sh', [POSTGRES_SCRIPT], { cwd: ROOT, env, encoding: 'utf8' })
  };
}

function createFakeMc(binDir: string): void {
  writeExecutable(join(binDir, 'mc'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_MC_LOG"
case "$1 $2" in
  "alias set")
    count=0
    if [ -f "$FAKE_MC_STATE/alias-count" ]; then count=$(cat "$FAKE_MC_STATE/alias-count"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_MC_STATE/alias-count"
    if [ "$count" -le "\${FAKE_MC_ALIAS_FAILURES:-0}" ]; then exit 7; fi
    ;;
  "mb --ignore-existing")
    : > "$FAKE_MC_STATE/bucket"
    ;;
  "anonymous set")
    if [ "\${FAKE_MC_SKIP_PRIVATE_MARKER:-0}" != "1" ]; then : > "$FAKE_MC_STATE/private"; fi
    ;;
  "anonymous get")
    if [ -f "$FAKE_MC_STATE/private" ]; then
      printf "Access permission is 'private'\n"
    else
      printf "Access permission is 'public'\n"
    fi
    ;;
  "stat opc/recordings")
    if [ "\${FAKE_MC_STAT_FAIL:-0}" = "1" ]; then exit 8; fi
    [ -f "$FAKE_MC_STATE/bucket" ]
    ;;
esac
`);
}

function createMinioFixture(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-minio-bootstrap-'));
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const logFile = join(dir, 'mc.log');
  mkdirSync(binDir);
  mkdirSync(stateDir);
  createFakeMc(binDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_BUCKET: 'recordings',
    MINIO_ACCESS_KEY: 'minio-test-access',
    MINIO_SECRET_KEY: 'minio-test-secret',
    MINIO_INIT_MAX_ATTEMPTS: '3',
    MINIO_INIT_RETRY_SECONDS: '0',
    FAKE_MC_LOG: logFile,
    FAKE_MC_STATE: stateDir,
    ...overrides
  };

  return {
    logFile,
    run: () => spawnSync('sh', [MINIO_SCRIPT], { cwd: ROOT, env, encoding: 'utf8' })
  };
}

test('PostgreSQL bootstrap creates requested databases once and verifies them', () => {
  const fixture = createPostgresFixture();
  const first = fixture.run();
  const second = fixture.run();

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const log = readFileSync(fixture.logFile, 'utf8');
  assert.equal((log.match(/CREATE DATABASE "keycloak"/g) ?? []).length, 1);
  assert.equal((log.match(/CREATE DATABASE "tinode"/g) ?? []).length, 1);
  assert.equal(
    `${first.stdout}${first.stderr}${second.stdout}${second.stderr}`.includes('postgres-test-secret'),
    false
  );
});

test('PostgreSQL bootstrap rejects unsupported database names before psql', () => {
  const fixture = createPostgresFixture({
    CONVERACT_POSTGRES_BOOTSTRAP_DATABASES: 'keycloak,customer_data'
  });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported database: customer_data/);
  assert.equal(existsSync(fixture.logFile), false);
});

test('PostgreSQL bootstrap requires credentials and the opc owner', () => {
  const cases: Array<{ overrides: NodeJS.ProcessEnv; expectedError: RegExp }> = [
    {
      overrides: { POSTGRES_PASSWORD: '' },
      expectedError: /POSTGRES_PASSWORD is required/
    },
    {
      overrides: { POSTGRES_USER: 'postgres' },
      expectedError: /POSTGRES_USER must be opc/
    }
  ];

  for (const { overrides, expectedError } of cases) {
    const fixture = createPostgresFixture(overrides);
    const result = fixture.run();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    assert.equal(existsSync(fixture.logFile), false);
  }
});

test('PostgreSQL bootstrap propagates create failures without leaking secrets', () => {
  const fixture = createPostgresFixture({ FAKE_PSQL_CREATE_FAIL: '1' });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(readFileSync(fixture.logFile, 'utf8'), /CREATE DATABASE "keycloak"/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('postgres-test-secret'), false);
});

test('PostgreSQL bootstrap rejects an existing database owned by another role', () => {
  const fixture = createPostgresFixture({
    CONVERACT_POSTGRES_BOOTSTRAP_DATABASES: 'keycloak',
    FAKE_PSQL_WRONG_OWNER: '1'
  });
  writeFileSync(join(fixture.stateDir, 'keycloak'), '', 'utf8');
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /database owner verification failed: keycloak/);
  assert.doesNotMatch(readFileSync(fixture.logFile, 'utf8'), /CREATE DATABASE/);
});

test('PostgreSQL bootstrap isolates RustPBX behind its dedicated role', () => {
  const fixture = createPostgresFixture({
    CONVERACT_POSTGRES_BOOTSTRAP_DATABASES: 'rustpbx',
    RUSTPBX_DB_PASSWORD: 'rustpbx-database-secret'
  });
  const result = fixture.run();

  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(fixture.logFile, 'utf8');
  assert.match(log, /CREATE DATABASE "rustpbx" OWNER "rustpbx_app"/);
  assert.match(log, /ALTER DATABASE "rustpbx" OWNER TO "rustpbx_app"/);
  assert.match(log, /REVOKE CONNECT ON DATABASE rustpbx FROM PUBLIC/);
  assert.equal(`${result.stdout}${result.stderr}${log}`.includes('rustpbx-database-secret'), false);
});

test('PostgreSQL bootstrap refuses RustPBX without its distinct password', () => {
  const fixture = createPostgresFixture({
    CONVERACT_POSTGRES_BOOTSTRAP_DATABASES: 'rustpbx',
    RUSTPBX_DB_PASSWORD: ''
  });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUSTPBX_DB_PASSWORD is required for rustpbx/);
  assert.equal(existsSync(fixture.logFile), false);
});

test('MinIO bootstrap retries, creates a private bucket, and verifies it', () => {
  const fixture = createMinioFixture({ FAKE_MC_ALIAS_FAILURES: '2' });
  const result = fixture.run();

  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(fixture.logFile, 'utf8');
  assert.equal((log.match(/^alias set /gm) ?? []).length, 3);
  assert.match(log, /^mb --ignore-existing opc\/recordings$/m);
  assert.match(log, /^anonymous set none opc\/recordings$/m);
  assert.match(log, /^anonymous get opc\/recordings$/m);
  assert.match(log, /^stat opc\/recordings$/m);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-secret'), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-access'), false);
});

test('MinIO bootstrap remains successful when run repeatedly', () => {
  const fixture = createMinioFixture();

  assert.equal(fixture.run().status, 0);
  assert.equal(fixture.run().status, 0);
});

test('MinIO bootstrap rejects invalid bucket names before mc', () => {
  const fixture = createMinioFixture({ MINIO_BUCKET: '../recordings' });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MINIO_BUCKET is invalid/);
  assert.equal(existsSync(fixture.logFile), false);
});

test('MinIO bootstrap requires endpoint and credentials before mc', () => {
  const cases: Array<{ overrides: NodeJS.ProcessEnv; expectedError: RegExp }> = [
    { overrides: { MINIO_ENDPOINT: '' }, expectedError: /MINIO_ENDPOINT is required/ },
    { overrides: { MINIO_ACCESS_KEY: '' }, expectedError: /MINIO_ACCESS_KEY is required/ },
    { overrides: { MINIO_SECRET_KEY: '' }, expectedError: /MINIO_SECRET_KEY is required/ }
  ];

  for (const { overrides, expectedError } of cases) {
    const fixture = createMinioFixture(overrides);
    const result = fixture.run();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    assert.equal(existsSync(fixture.logFile), false);
  }
});

test('MinIO bootstrap fails after bounded readiness retries without leaking credentials', () => {
  const fixture = createMinioFixture({
    FAKE_MC_ALIAS_FAILURES: '99',
    MINIO_INIT_MAX_ATTEMPTS: '2'
  });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /endpoint not ready after 2 attempts/);
  assert.equal((readFileSync(fixture.logFile, 'utf8').match(/^alias set /gm) ?? []).length, 2);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-secret'), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-access'), false);
});

test('MinIO bootstrap fails when private access cannot be verified', () => {
  const fixture = createMinioFixture({ FAKE_MC_SKIP_PRIVATE_MARKER: '1' });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bucket privacy verification failed: recordings/);
  assert.match(readFileSync(fixture.logFile, 'utf8'), /^anonymous get opc\/recordings$/m);
});

test('MinIO bootstrap fails when the created bucket cannot be statted', () => {
  const fixture = createMinioFixture({ FAKE_MC_STAT_FAIL: '1' });
  const result = fixture.run();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bucket verification failed: recordings/);
  assert.match(readFileSync(fixture.logFile, 'utf8'), /^stat opc\/recordings$/m);
});
