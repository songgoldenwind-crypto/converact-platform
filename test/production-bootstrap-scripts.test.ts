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
  *opc*) database=opc ;;
esac
case "$*" in
  *"CREATE DATABASE"*)
    if [ "\${FAKE_PSQL_CREATE_FAIL:-0}" = "1" ]; then exit 9; fi
    : > "$FAKE_PSQL_STATE/$database"
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
    OPC_POSTGRES_BOOTSTRAP_DATABASES: 'keycloak,tinode',
    FAKE_PSQL_LOG: logFile,
    FAKE_PSQL_STATE: stateDir,
    ...overrides
  };

  return {
    env,
    logFile,
    run: () => spawnSync('sh', [POSTGRES_SCRIPT], { cwd: ROOT, env, encoding: 'utf8' })
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
    OPC_POSTGRES_BOOTSTRAP_DATABASES: 'keycloak,customer_data'
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
