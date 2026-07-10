# iveKit Production Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default iveKit production Compose path fail closed until its PostgreSQL databases, PgBouncer connection, and private MinIO recordings bucket are ready, while keeping Chatwoot outside the default startup path.

**Architecture:** Add two small idempotent shell initializers and run them as one-shot Compose services. Service dependencies use `service_healthy` or `service_completed_successfully`; the self-hosted Tinode overlay only extends the fixed database set, and Chatwoot is isolated behind the `omnichannel` profile.

**Tech Stack:** POSIX shell, PostgreSQL 16/`psql`, MinIO Client `RELEASE.2025-08-13T08-35-41Z`, Docker Compose, Node.js test runner, TypeScript.

---

## File Map

| File | Responsibility |
| --- | --- |
| `infra/scripts/bootstrap-postgres-databases.sh` | Validate and idempotently create the fixed PostgreSQL database set. |
| `infra/scripts/bootstrap-minio-bucket.sh` | Wait for MinIO, create the recordings bucket, force private access, and verify it. |
| `test/production-bootstrap-scripts.test.ts` | Execute both scripts with fake command binaries and verify behavior without Docker. |
| `test/video-readiness-compose.test.ts` | Enforce bootstrap service, dependency, profile, and PostgreSQL-only Compose contracts. |
| `infra/docker-compose.production.yml` | Define the base one-shot services and readiness dependencies. |
| `infra/docker-compose.tinode.yml` | Extend the database request and gate self-hosted Tinode startup. |
| `infra/env.example` | Document bounded MinIO bootstrap tuning inputs. |
| `docs/审核文档.md` | Record the finding, code correction, local evidence, and remaining server evidence. |
| `docs/ivekit-led-integration-guide.md` | Give LED engineers exact external/self-hosted startup order and Chatwoot boundary. |
| `docs/livekit-im-full-capability-plan.md` | Mark local production bootstrap complete without claiming real runtime acceptance. |

### Task 1: PostgreSQL Database Bootstrap

**Files:**
- Create: `infra/scripts/bootstrap-postgres-databases.sh`
- Create: `test/production-bootstrap-scripts.test.ts`

- [x] **Step 1: Write the PostgreSQL bootstrap behavior tests**

Create the test file with a temporary fake `psql` executable. The fake records calls, stores created database names as marker files, and supports a forced create failure:

```ts
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POSTGRES_SCRIPT = join(ROOT, 'infra/scripts/bootstrap-postgres-databases.sh');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function createFakePsql(binDir: string): void {
  writeExecutable(join(binDir, 'psql'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_PSQL_LOG"
case "$*" in
  *"CREATE DATABASE"*)
    if [ "\${FAKE_PSQL_CREATE_FAIL:-0}" = "1" ]; then exit 9; fi
    database=$(printf '%s' "$*" | sed -n "s/.*CREATE DATABASE \\\"\\([^\\\"]*\\)\\\".*/\\1/p")
    : > "$FAKE_PSQL_STATE/$database"
    ;;
  *"SELECT 1 FROM pg_database"*)
    database=$(printf '%s' "$*" | sed -n "s/.*datname = '\\([^']*\\)'.*/\\1/p")
    if [ -f "$FAKE_PSQL_STATE/$database" ]; then printf '1\\n'; fi
    ;;
esac
`);
}

function runBootstrap(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-postgres-bootstrap-'));
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const logFile = join(dir, 'psql.log');
  mkdirSync(binDir);
  mkdirSync(stateDir);
  createFakePsql(binDir);
  const env = {
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
  return { dir, env, logFile, run: () => spawnSync('sh', [POSTGRES_SCRIPT], { cwd: ROOT, env, encoding: 'utf8' }) };
}

test('PostgreSQL bootstrap creates requested databases once and verifies them', () => {
  const fixture = runBootstrap();
  const first = fixture.run();
  const second = fixture.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const log = readFileSync(fixture.logFile, 'utf8');
  assert.equal((log.match(/CREATE DATABASE "keycloak"/g) ?? []).length, 1);
  assert.equal((log.match(/CREATE DATABASE "tinode"/g) ?? []).length, 1);
  assert.equal(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`.includes('postgres-test-secret'), false);
});

test('PostgreSQL bootstrap rejects unsupported database names before psql', () => {
  const fixture = runBootstrap({ OPC_POSTGRES_BOOTSTRAP_DATABASES: 'keycloak,customer_data' });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported database: customer_data/);
  assert.equal(existsSync(fixture.logFile), false);
});

test('PostgreSQL bootstrap requires credentials and the opc owner', () => {
  for (const overrides of [{ POSTGRES_PASSWORD: '' }, { POSTGRES_USER: 'postgres' }]) {
    const fixture = runBootstrap(overrides);
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(fixture.logFile), false);
  }
});

test('PostgreSQL bootstrap propagates create failures without leaking secrets', () => {
  const fixture = runBootstrap({ FAKE_PSQL_CREATE_FAIL: '1' });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes('postgres-test-secret'), false);
});
```

Keep the fixture directory so a failed assertion leaves its command log available under the OS temporary directory.

- [x] **Step 2: Run the test and confirm the missing-script failure**

Run:

```bash
node --import tsx --test test/production-bootstrap-scripts.test.ts
```

Expected: all PostgreSQL cases fail because `infra/scripts/bootstrap-postgres-databases.sh` does not exist.

- [x] **Step 3: Implement the idempotent PostgreSQL initializer**

Create the script with fixed identifiers and no connection URL logging:

```sh
#!/bin/sh
set -eu

fail() {
  printf 'postgres bootstrap: %s\n' "$1" >&2
  exit 1
}

databases=${OPC_POSTGRES_BOOTSTRAP_DATABASES:-}
host=${POSTGRES_HOST:-postgres}
port=${POSTGRES_PORT:-5432}
user=${POSTGRES_USER:-opc}
password=${POSTGRES_PASSWORD:-}
maintenance_database=${POSTGRES_MAINTENANCE_DATABASE:-postgres}

[ -n "$databases" ] || fail 'OPC_POSTGRES_BOOTSTRAP_DATABASES is required'
[ -n "$password" ] || fail 'POSTGRES_PASSWORD is required'
[ "$user" = 'opc' ] || fail 'POSTGRES_USER must be opc'
case "$databases" in
  ,*|*,|*,,*) fail 'database list contains an empty name' ;;
esac

old_ifs=$IFS
IFS=,
for database in $databases; do
  case "$database" in
    opc|keycloak|tinode|chatwoot) ;;
    *) fail "unsupported database: $database" ;;
  esac
done
IFS=$old_ifs

export PGPASSWORD=$password
IFS=,
for database in $databases; do
  existing=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
  if [ "$existing" != '1' ]; then
    psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
      -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database\" OWNER \"opc\""
  fi
  verified=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
  [ "$verified" = '1' ] || fail "database verification failed: $database"
  owner=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = '$database'")
  [ "$owner" = "$user" ] || fail "database owner verification failed: $database"
  printf 'postgres bootstrap: %s ready\n' "$database"
done
IFS=$old_ifs
unset PGPASSWORD
```

Make it executable:

```bash
chmod +x infra/scripts/bootstrap-postgres-databases.sh
```

- [x] **Step 4: Run the PostgreSQL tests and verify green**

Run:

```bash
node --import tsx --test test/production-bootstrap-scripts.test.ts
```

Expected: 4 tests pass; process output contains database names but never `postgres-test-secret`.

- [x] **Step 5: Commit the PostgreSQL bootstrap slice**

```bash
git add infra/scripts/bootstrap-postgres-databases.sh test/production-bootstrap-scripts.test.ts
git commit -m "feat(infra): bootstrap PostgreSQL databases"
```

### Task 2: Private MinIO Bucket Bootstrap

**Files:**
- Create: `infra/scripts/bootstrap-minio-bucket.sh`
- Modify: `test/production-bootstrap-scripts.test.ts`

- [x] **Step 1: Add MinIO retry, idempotence, privacy, and redaction tests**

Extend the test file with `MINIO_SCRIPT` and a fake `mc` executable. The fake fails `alias set` for the requested number of attempts, records bucket state, and returns `private` only after `anonymous set none`:

```ts
const MINIO_SCRIPT = join(ROOT, 'infra/scripts/bootstrap-minio-bucket.sh');

function createFakeMc(binDir: string): void {
  writeExecutable(join(binDir, 'mc'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_MC_LOG"
case "$1 $2" in
  "alias set")
    count=0
    if [ -f "$FAKE_MC_STATE/alias-count" ]; then count=$(cat "$FAKE_MC_STATE/alias-count"); fi
    count=$((count + 1)); printf '%s' "$count" > "$FAKE_MC_STATE/alias-count"
    if [ "$count" -le "\${FAKE_MC_ALIAS_FAILURES:-0}" ]; then exit 7; fi
    ;;
  "mb --ignore-existing") : > "$FAKE_MC_STATE/bucket" ;;
  "anonymous set") : > "$FAKE_MC_STATE/private" ;;
  "anonymous get") [ -f "$FAKE_MC_STATE/private" ] && printf "Access permission is 'private'\\n" ;;
  "stat opc/recordings") [ -f "$FAKE_MC_STATE/bucket" ] ;;
esac
`);
}

function runMinioBootstrap(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-minio-bootstrap-'));
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const logFile = join(dir, 'mc.log');
  mkdirSync(binDir);
  mkdirSync(stateDir);
  createFakeMc(binDir);
  const env = {
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
  return { env, logFile, run: () => spawnSync('sh', [MINIO_SCRIPT], { cwd: ROOT, env, encoding: 'utf8' }) };
}

test('MinIO bootstrap retries, creates a private bucket, and verifies it', () => {
  const fixture = runMinioBootstrap({ FAKE_MC_ALIAS_FAILURES: '2' });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(fixture.logFile, 'utf8');
  assert.equal((log.match(/^alias set /gm) ?? []).length, 3);
  assert.match(log, /^mb --ignore-existing opc\/recordings$/m);
  assert.match(log, /^anonymous set none opc\/recordings$/m);
  assert.match(log, /^anonymous get opc\/recordings$/m);
  assert.match(log, /^stat opc\/recordings$/m);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-secret'), false);
});

test('MinIO bootstrap remains successful when run repeatedly', () => {
  const fixture = runMinioBootstrap();
  assert.equal(fixture.run().status, 0);
  assert.equal(fixture.run().status, 0);
});

test('MinIO bootstrap rejects invalid bucket names before mc', () => {
  const fixture = runMinioBootstrap({ MINIO_BUCKET: '../recordings' });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(fixture.logFile), false);
});

test('MinIO bootstrap fails after bounded readiness retries without leaking credentials', () => {
  const fixture = runMinioBootstrap({ FAKE_MC_ALIAS_FAILURES: '99', MINIO_INIT_MAX_ATTEMPTS: '2' });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal((readFileSync(fixture.logFile, 'utf8').match(/^alias set /gm) ?? []).length, 2);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-secret'), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('minio-test-access'), false);
});
```

- [x] **Step 2: Run the expanded test and confirm only MinIO cases fail**

Run:

```bash
node --import tsx --test test/production-bootstrap-scripts.test.ts
```

Expected: the 4 PostgreSQL cases pass and the 4 MinIO cases fail because the MinIO script is absent.

- [x] **Step 3: Implement the MinIO initializer**

Create the bounded, private initializer:

```sh
#!/bin/sh
set -eu

fail() {
  printf 'minio bootstrap: %s\n' "$1" >&2
  exit 1
}

endpoint=${MINIO_ENDPOINT:-}
bucket=${MINIO_BUCKET:-}
access_key=${MINIO_ACCESS_KEY:-}
secret_key=${MINIO_SECRET_KEY:-}
max_attempts=${MINIO_INIT_MAX_ATTEMPTS:-30}
retry_seconds=${MINIO_INIT_RETRY_SECONDS:-2}

[ -n "$endpoint" ] || fail 'MINIO_ENDPOINT is required'
[ -n "$access_key" ] || fail 'MINIO_ACCESS_KEY is required'
[ -n "$secret_key" ] || fail 'MINIO_SECRET_KEY is required'
case "$max_attempts" in ''|*[!0-9]*|0) fail 'MINIO_INIT_MAX_ATTEMPTS must be a positive integer' ;; esac
case "$retry_seconds" in ''|*[!0-9]*) fail 'MINIO_INIT_RETRY_SECONDS must be a non-negative integer' ;; esac
case "$bucket" in ''|*[!a-z0-9.-]*|.*|*.) fail 'MINIO_BUCKET is invalid' ;; esac
[ "${#bucket}" -ge 3 ] && [ "${#bucket}" -le 63 ] || fail 'MINIO_BUCKET length must be 3..63'

attempt=1
while ! mc alias set opc "$endpoint" "$access_key" "$secret_key" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$max_attempts" ]; then fail "endpoint not ready after $max_attempts attempts"; fi
  printf 'minio bootstrap: waiting for endpoint (attempt %s/%s)\n' "$attempt" "$max_attempts" >&2
  attempt=$((attempt + 1))
  sleep "$retry_seconds"
done

mc mb --ignore-existing "opc/$bucket" >/dev/null
mc anonymous set none "opc/$bucket" >/dev/null
privacy=$(mc anonymous get "opc/$bucket")
case "$privacy" in *private*) ;; *) fail "bucket privacy verification failed: $bucket" ;; esac
mc stat "opc/$bucket" >/dev/null || fail "bucket verification failed: $bucket"
printf 'minio bootstrap: %s ready and private\n' "$bucket"
```

Make it executable:

```bash
chmod +x infra/scripts/bootstrap-minio-bucket.sh
```

- [x] **Step 4: Run all script tests and verify green**

Run:

```bash
node --import tsx --test test/production-bootstrap-scripts.test.ts
```

Expected: 12 tests pass; database owner mismatch, bounded retries, missing inputs, privacy failure, and stat failure are covered; no test process output contains either fake secret.

- [x] **Step 5: Commit the MinIO bootstrap slice**

```bash
git add infra/scripts/bootstrap-minio-bucket.sh test/production-bootstrap-scripts.test.ts
git commit -m "feat(infra): bootstrap private MinIO bucket"
```

### Task 3: Compose Startup Gates And Chatwoot Boundary

**Files:**
- Modify: `test/video-readiness-compose.test.ts`
- Modify: `infra/docker-compose.production.yml`
- Modify: `infra/docker-compose.tinode.yml`
- Modify: `infra/env.example`

- [x] **Step 1: Write static Compose contract tests**

Add tests that inspect only the relevant service blocks:

```ts
test('production compose gates databases, PgBouncer, and object storage', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const postgresBootstrap = readServiceBlock(compose, 'postgres-bootstrap');
  const minioInit = readServiceBlock(compose, 'minio-init');

  assert.match(postgresBootstrap, /image: postgres:16-alpine/);
  assert.equal(readServiceEnvironment(compose, 'postgres-bootstrap').OPC_POSTGRES_BOOTSTRAP_DATABASES, 'keycloak');
  assert.ok(readServiceVolumes(compose, 'postgres-bootstrap').includes('./scripts/bootstrap-postgres-databases.sh:/bootstrap/bootstrap-postgres-databases.sh:ro'));
  assert.match(postgresBootstrap, /postgres:\n\s+condition: service_healthy/);
  assert.match(readServiceBlock(compose, 'pgbouncer'), /postgres-bootstrap:\n\s+condition: service_completed_successfully/);
  assert.match(readServiceBlock(compose, 'pgbouncer'), /healthcheck:[\s\S]*psql -X[\s\S]*-p 6432/);
  assert.match(readServiceBlock(compose, 'pgbouncer'), /-Atqc 'SELECT 1' >\/dev\/null 2>&1/);
  assert.match(readServiceBlock(compose, 'keycloak'), /postgres-bootstrap:\n\s+condition: service_completed_successfully/);

  assert.match(minioInit, /image: minio\/mc:RELEASE\.2025-08-13T08-35-41Z/);
  assert.ok(readServiceVolumes(compose, 'minio-init').includes('./scripts/bootstrap-minio-bucket.sh:/bootstrap/bootstrap-minio-bucket.sh:ro'));
  for (const serviceName of ['livekit-egress', 'rustpbx', 'opc']) {
    assert.match(readServiceBlock(compose, serviceName), /minio-init:\n\s+condition: service_completed_successfully/);
  }
  assert.match(readServiceBlock(compose, 'opc'), /pgbouncer:\n\s+condition: service_healthy/);
});

test('self-hosted Tinode extends the database bootstrap and waits for it', () => {
  const overlay = readFileSync(PRODUCTION_TINODE_COMPOSE_PATH, 'utf8');
  assert.equal(readServiceEnvironment(overlay, 'postgres-bootstrap').OPC_POSTGRES_BOOTSTRAP_DATABASES, 'keycloak,tinode');
  assert.match(readServiceBlock(overlay, 'tinode'), /postgres-bootstrap:\n\s+condition: service_completed_successfully/);
});

test('Chatwoot is opt-in and production bootstrap remains PostgreSQL-only', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  assert.match(readServiceBlock(compose, 'chatwoot'), /profiles: \["omnichannel"\]/);
  assert.doesNotMatch(compose, /sqlite|OPC_DB_PATH/i);
});
```

- [x] **Step 2: Run focused Compose tests and verify the new contracts fail**

Run:

```bash
node --import tsx --test test/video-readiness-compose.test.ts
```

Expected: existing tests pass; the three new tests fail because bootstrap services and dependency conditions are absent.

- [x] **Step 3: Add the PostgreSQL and MinIO one-shot services**

Add `postgres-bootstrap` after `postgres` and `minio-init` after `minio`:

```yaml
  postgres-bootstrap:
    image: postgres:16-alpine
    entrypoint: ["/bin/sh", "/bootstrap/bootstrap-postgres-databases.sh"]
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: "5432"
      POSTGRES_USER: opc
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_MAINTENANCE_DATABASE: postgres
      OPC_POSTGRES_BOOTSTRAP_DATABASES: keycloak
    volumes:
      - ./scripts/bootstrap-postgres-databases.sh:/bootstrap/bootstrap-postgres-databases.sh:ro
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  minio-init:
    image: minio/mc:RELEASE.2025-08-13T08-35-41Z
    entrypoint: ["/bin/sh", "/bootstrap/bootstrap-minio-bucket.sh"]
    environment:
      MINIO_ENDPOINT: http://minio:9000
      MINIO_BUCKET: ${MINIO_BUCKET:-recordings}
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY:-minioadmin}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY:-minioadmin}
      MINIO_INIT_MAX_ATTEMPTS: ${MINIO_INIT_MAX_ATTEMPTS:-30}
      MINIO_INIT_RETRY_SECONDS: ${MINIO_INIT_RETRY_SECONDS:-2}
    volumes:
      - ./scripts/bootstrap-minio-bucket.sh:/bootstrap/bootstrap-minio-bucket.sh:ro
    depends_on:
      minio:
        condition: service_started
    restart: "no"
```

- [x] **Step 4: Replace start-order dependencies with readiness conditions**

Use these exact dependency contracts:

```yaml
  pgbouncer:
    depends_on:
      postgres-bootstrap:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD-SHELL", "PGPASSWORD=$$POSTGRESQL_PASSWORD psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 6432 -U $$POSTGRESQL_USERNAME -d $$POSTGRESQL_DATABASE -Atqc 'SELECT 1' >/dev/null 2>&1"]
      interval: 5s
      timeout: 3s
      retries: 10

  keycloak:
    depends_on:
      postgres-bootstrap:
        condition: service_completed_successfully

  livekit-egress:
    depends_on:
      livekit:
        condition: service_started
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully

  rustpbx:
    depends_on:
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully

  opc:
    depends_on:
      pgbouncer:
        condition: service_healthy
      redis:
        condition: service_healthy
      nats:
        condition: service_started
      livekit:
        condition: service_started
      rustpbx:
        condition: service_started
      minio-init:
        condition: service_completed_successfully
```

Do not retain a second direct `postgres` dependency under PgBouncer or Keycloak; `postgres-bootstrap` already waits for healthy PostgreSQL.

- [x] **Step 5: Extend the Tinode overlay and isolate Chatwoot**

Add the overlay service extension and conditional dependency:

```yaml
  postgres-bootstrap:
    environment:
      OPC_POSTGRES_BOOTSTRAP_DATABASES: keycloak,tinode

  tinode:
    depends_on:
      postgres-bootstrap:
        condition: service_completed_successfully

  opc:
    depends_on:
      tinode:
        condition: service_started
```

Add this line to the existing production `chatwoot` service:

```yaml
    profiles: ["omnichannel"]
```

Add the bounded MinIO initializer inputs beside the MinIO variables in `infra/env.example`:

```dotenv
MINIO_INIT_MAX_ATTEMPTS=30
MINIO_INIT_RETRY_SECONDS=2
```

- [x] **Step 6: Run focused tests and verify green**

Run:

```bash
node --import tsx --test test/production-bootstrap-scripts.test.ts test/video-readiness-compose.test.ts
```

Expected: all script tests and all Compose contract tests pass.

- [x] **Step 7: Commit the Compose dependency slice**

```bash
git add infra/docker-compose.production.yml infra/docker-compose.tinode.yml infra/env.example test/video-readiness-compose.test.ts
git commit -m "feat(infra): gate iveKit production startup"
```

### Task 4: Rendered Compose Acceptance

**Files:**
- Modify only if validation exposes a concrete merge/interpolation defect: `infra/docker-compose.production.yml`
- Modify only if validation exposes a concrete merge/interpolation defect: `infra/docker-compose.tinode.yml`

- [x] **Step 1: Validate the external Tinode base model**

Run:

```bash
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml config --quiet
```

Expected: exit code 0.

- [x] **Step 2: Prove Chatwoot is absent by default and present only when requested**

Run:

```bash
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml config --services
```

Expected: output includes `postgres-bootstrap` and `minio-init`, and does not include `chatwoot`.

Run:

```bash
COMPOSE_DISABLE_ENV_FILE=1 docker compose --profile omnichannel --env-file infra/env.example \
  -f infra/docker-compose.production.yml config --services
```

Expected: output includes `chatwoot`.

- [x] **Step 3: Prove self-hosted Tinode remains fail closed with empty secrets**

Run:

```bash
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml -f infra/docker-compose.tinode.yml config --quiet
```

Expected: non-zero with a required `TINODE_AUTH_TOKEN_KEY` or `TINODE_UID_ENCRYPTION_KEY` interpolation error.

- [x] **Step 4: Validate the configured self-hosted Tinode merged model**

Run:

```bash
TINODE_POSTGRES_DSN='postgresql://opc:test@postgres:5432/tinode?sslmode=disable' \
TINODE_AUTH_TOKEN_KEY='0123456789abcdef0123456789abcdef' \
TINODE_UID_ENCRYPTION_KEY='0123456789abcdef' \
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml -f infra/docker-compose.tinode.yml config --quiet
```

Expected: exit code 0.

- [x] **Step 5: Inspect the merged bootstrap and dependency values**

Run the configured self-hosted command again without `--quiet`, then verify its output contains:

```text
OPC_POSTGRES_BOOTSTRAP_DATABASES: keycloak,tinode
condition: service_completed_successfully
MINIO_INIT_MAX_ATTEMPTS: "30"
profiles:
  - omnichannel
```

Expected: all four contracts are present and no rendered line contains the three temporary Tinode secret values outside the expected environment fields.

- [x] **Step 6: Commit only if Compose validation required a correction**

When a concrete correction was necessary:

```bash
git add infra/docker-compose.production.yml infra/docker-compose.tinode.yml
git commit -m "fix(infra): correct bootstrap compose merge"
```

When no correction was necessary, record the commands in the documentation task without creating an empty commit.

### Task 5: Documentation And Full Local Verification

**Files:**
- Modify: `docs/审核文档.md`
- Modify: `docs/ivekit-led-integration-guide.md`
- Modify: `docs/livekit-im-full-capability-plan.md`

- [x] **Step 1: Update the architecture audit**

Add a dated audit entry stating all of the following:

```text
- production PostgreSQL previously created only opc, leaving keycloak/tinode startup dependent on manual database work;
- production MinIO previously had no recordings bucket bootstrap;
- the new one-shot initializers are idempotent, fixed-allowlist/private, and fail closed;
- PgBouncer/Keycloak/Tinode/Egress/RustPBX/OPC now use explicit readiness conditions;
- Chatwoot is behind the omnichannel profile and is not claimed production-ready;
- fake-command tests and Compose rendering are local evidence only;
- real database persistence, object writes, Egress, restart recovery, and server E2E remain unverified because no server upload was performed.
```

- [x] **Step 2: Update the LED integration runbook**

Document these startup modes exactly:

```bash
# External/shared Tinode
docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml up -d

# Self-hosted Tinode
docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml \
  -f infra/docker-compose.tinode.yml up -d

# Chatwoot is explicitly separate and not part of iveKit readiness
docker compose --profile omnichannel --env-file infra/env.example \
  -f infra/docker-compose.production.yml up -d chatwoot
```

Explain that `postgres-bootstrap` and `minio-init` may appear as exited with code 0 after successful startup; that is expected for one-shot services.

- [x] **Step 3: Update the capability plan status**

Add a 2026-07-11 production-bootstrap note that marks local code/configuration complete and leaves these acceptance items open:

```text
real PostgreSQL fresh/existing-volume bootstrap, real PgBouncer health,
real MinIO bucket persistence/privacy, LiveKit Egress object creation,
service restart recovery, and end-to-end server execution
```

Remove the obsolete statements that MinIO bucket initialization and PostgreSQL multi-database initialization are still missing in code; retain wording that they are still unverified in a real runtime.

- [x] **Step 4: Run focused and full regression gates**

Run:

```bash
node --import tsx --test test/production-bootstrap-scripts.test.ts test/video-readiness-compose.test.ts
npm run typecheck
npm test
npm --prefix frontend run build
npm run test:ai-agent
npm run check:sidecars
git diff --check
```

Expected: every command exits 0. The frontend may retain its existing non-fatal chunk-size warning; record it as a warning, not a failure.

Execution note: the clean repository's ignored AI `.venv` lacked pytest, so the original workspace's complete read-only venv ran the current repository tests with explicit `PYTHONPATH` (30/30). The sandbox also rejected the `tsx` CLI IPC pipe for `check:sidecars`; the equivalent `node --import tsx scripts/check-sidecars.ts all` completed Go, Python, and Rust checks.

- [x] **Step 5: Run repository safety scans**

Run:

```bash
git grep -nEi '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' -- ':!package-lock.json' ':!test/**'
find . -type f -size +20M -not -path './.git/*' -not -path './node_modules/*' -not -path './frontend/node_modules/*' -not -path './services/ai-agent-py/.venv/*' -not -path './services/voice-media-rs/target/*' -print
find . -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -not -path './.git/*' -not -path './node_modules/*' -not -path './frontend/node_modules/*' -not -path './services/ai-agent-py/.venv/*' -not -path './services/voice-media-rs/target/*' -print
```

Expected: no credential matches, no unexpected file above 20 MB, and no SQLite database file.

- [x] **Step 6: Commit documentation and verification record**

```bash
git add docs/审核文档.md docs/ivekit-led-integration-guide.md docs/livekit-im-full-capability-plan.md
git commit -m "docs: record iveKit bootstrap readiness"
```

- [ ] **Step 7: Push and verify the clean GitHub repository only**

Run:

```bash
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
git status --short
```

Expected: local and remote `main` hashes match and status is empty. Do not copy files, run SSH, or upload artifacts to the deployment server.

## Completion Boundary

This plan completes the local Option A slice only. It must not close the persistent deployment/E2E goal: real Docker startup, database and bucket persistence, LiveKit Egress writes, Tinode runtime behavior, RustDesk clients, and browser/server acceptance remain pending until the user explicitly allows server upload.
