#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
ACCEPTANCE_DIR="$ROOT_DIR/services/converact-service/acceptance/platform-fault-matrix"
COMPOSE_FILE="$ACCEPTANCE_DIR/docker-compose.yml"
DATABASE_PROBE="$ACCEPTANCE_DIR/database-probe.ts"
MEDIA_PROBE="$ACCEPTANCE_DIR/synthetic-media.mjs"
NODE_BIN=${NODE_BIN:-node}
NODE_IMAGE=${CONVERACT_G02_NODE_IMAGE:-}
CONFIRMATION=${CONVERACT_G02_FAULT_CONFIRM:-}
RUN_ID=${CONVERACT_G02_FAULT_RUN_ID:-}
SOURCE_COMMIT=${CONVERACT_G02_SOURCE_COMMIT:-}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT:-}
MEDIA_DURATION_MS=${CONVERACT_G02_MEDIA_DURATION_MS:-30000}
PROJECT=
EVIDENCE_DIR=
COMPOSE_ACTIVE=0
MEDIA_PID=

if [[ "$CONFIRMATION" != "G02_PLATFORM_FAULT_MATRIX" ]]; then
  printf '%s\n' 'CONVERACT_G02_FAULT_CONFIRM must equal G02_PLATFORM_FAULT_MATRIX' >&2
  exit 2
fi
if [[ ! "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_FAULT_RUN_ID is invalid' >&2
  exit 2
fi
if [[ ! "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_SOURCE_COMMIT must be an exact commit' >&2
  exit 2
fi
if [[ ! "$POSTGRES_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'POSTGRES_IMAGE must be an immutable digest reference' >&2
  exit 2
fi
if [[ ! "$NODE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_NODE_IMAGE must be an immutable digest reference' >&2
  exit 2
fi
if [[ ! "$MEDIA_DURATION_MS" =~ ^[0-9]+$ ]] || (( MEDIA_DURATION_MS < 5000 || MEDIA_DURATION_MS > 300000 )); then
  printf '%s\n' 'CONVERACT_G02_MEDIA_DURATION_MS must be between 5000 and 300000' >&2
  exit 2
fi
if [[ ! -f "$ROOT_DIR/package-lock.json" || ! -d "$ROOT_DIR/node_modules/tsx" ]]; then
  printf '%s\n' 'exact-source npm dependencies must be installed before the campaign' >&2
  exit 2
fi
NODE_BIN_PATH=$(command -v "$NODE_BIN" || true)
if [[ -z "$NODE_BIN_PATH" || ! -x "$NODE_BIN_PATH" ]]; then
  printf '%s\n' 'NODE_BIN must resolve to an executable' >&2
  exit 2
fi
NODE_VERSION=$("$NODE_BIN_PATH" --version)
if [[ ! "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' 'fault campaign requires Node v24' >&2
  exit 2
fi
NODE_BINARY_SHA256=$(sha256sum "$NODE_BIN_PATH" | awk '{print $1}')
if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '%s\n' 'campaign source must be an exact Git checkout' >&2
  exit 2
fi
ACTUAL_SOURCE_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD)
if [[ "$ACTUAL_SOURCE_COMMIT" != "$SOURCE_COMMIT" ]]; then
  printf '%s\n' 'campaign source commit does not match Git HEAD' >&2
  exit 2
fi
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' 'campaign source worktree must be clean' >&2
  exit 2
fi

reserve_loopback_port() {
  "$NODE_BIN" -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") process.exit(1);
      server.close((error) => {
        if (error) process.exit(1);
        process.stdout.write(String(address.port));
      });
    });
  '
}

if [[ -z "$POSTGRES_HOST_PORT" ]]; then POSTGRES_HOST_PORT=$(reserve_loopback_port); fi
if [[ ! "$POSTGRES_HOST_PORT" =~ ^[0-9]+$ ]] || (( POSTGRES_HOST_PORT < 1024 || POSTGRES_HOST_PORT > 65535 )); then
  printf '%s\n' 'POSTGRES_HOST_PORT must be an unprivileged TCP port' >&2
  exit 2
fi

POSTGRES_PASSWORD=$(openssl rand -hex 24)
CONVERACT_RUNTIME_DB_PASSWORD=$(openssl rand -hex 24)
PROJECT="converact-g02-$RUN_ID"
EVIDENCE_ROOT="$ROOT_DIR/.runtime/platform-fault-matrix"
EVIDENCE_DIR="$EVIDENCE_ROOT/$RUN_ID"
if [[ -e "$EVIDENCE_DIR" ]]; then
  printf '%s\n' 'campaign evidence directory already exists' >&2
  exit 2
fi
mkdir -p -m 0700 "$EVIDENCE_ROOT"
mkdir -m 0700 "$EVIDENCE_DIR"

compose() {
  timeout -k 5 60 docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

cleanup() {
  if [[ -n "${MEDIA_PID:-}" ]] && kill -0 "$MEDIA_PID" >/dev/null 2>&1; then
    kill -TERM "$MEDIA_PID" >/dev/null 2>&1 || true
    timeout -k 1 3 tail --pid="$MEDIA_PID" -f /dev/null >/dev/null 2>&1 || true
  fi
  if [[ "$COMPOSE_ACTIVE" -eq 1 ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

export POSTGRES_IMAGE POSTGRES_HOST_PORT POSTGRES_PASSWORD
export CONVERACT_RUNTIME_DB_PASSWORD
export PGHOST=127.0.0.1 PGPORT="$POSTGRES_HOST_PORT" PGDATABASE=opc PGUSER=opc_admin PGPASSWORD="$POSTGRES_PASSWORD"
export CONVERACT_G02_FAULT_RUN_ID="$RUN_ID"
export CONVERACT_G02_STARTED_AT
CONVERACT_G02_STARTED_AT=$("$NODE_BIN" -e 'process.stdout.write(new Date().toISOString())')

compose config --quiet

if [[ "${1:-}" == 'plan' ]]; then
  printf '{"status":"validated","project":"%s","production_eligible":false}\n' "$PROJECT"
  exit 0
fi
if [[ "${1:-}" != 'database' ]]; then
  printf '%s\n' 'usage: accept.sh plan|database' >&2
  exit 2
fi

snapshot_unrelated() {
  docker ps -a \
    --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.CreatedAt}}' \
    | LC_ALL=C sort
}

wait_postgres() {
  local attempt=0
  until compose exec --no-TTY postgres pg_isready -U opc_admin -d opc >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if (( attempt >= 90 )); then
      compose logs --no-color --tail 120 postgres >&2 || true
      return 1
    fi
    sleep 0.5
  done
}

wait_file() {
  local path=$1
  local pid=$2
  local attempt=0
  until [[ -f "$path" ]]; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" || true
      return 1
    fi
    attempt=$((attempt + 1))
    if (( attempt >= 200 )); then return 1; fi
    sleep 0.1
  done
}

BEFORE_CONTAINERS="$EVIDENCE_DIR/unrelated-containers-before.tsv"
AFTER_CONTAINERS="$EVIDENCE_DIR/unrelated-containers-after.tsv"
PREPARE_RESULT="$EVIDENCE_DIR/database-prepare.json"
OUTAGE_RESULT="$EVIDENCE_DIR/database-outage.json"
RESTART_RESULT="$EVIDENCE_DIR/database-restart.json"
RECOVER_RESULT="$EVIDENCE_DIR/database-recover.json"
MEDIA_RESULT="$EVIDENCE_DIR/synthetic-media.json"
MEDIA_READY="$EVIDENCE_DIR/synthetic-media-ready.json"
FAULT_WINDOW="$EVIDENCE_DIR/fault-window.json"
IDENTITY_RESULT="$EVIDENCE_DIR/evidence-identity.json"
FINAL_RESULT="$EVIDENCE_DIR/database-controlled-evidence.json"
RAW_MANIFEST="$EVIDENCE_DIR/raw-output.sha256"

snapshot_unrelated >"$BEFORE_CONTAINERS"
COMPOSE_ACTIVE=1
compose up --detach postgres >"$EVIDENCE_DIR/postgres-up.log" 2>&1
wait_postgres

CONVERACT_FABRIC_MIGRATIONS_DIR="$ROOT_DIR/src/migrations" \
  "$NODE_BIN" --import tsx "$ROOT_DIR/src/converact-init-runtime-role.ts" \
  >"$EVIDENCE_DIR/runtime-role.log" 2>&1
CONVERACT_FABRIC_MIGRATIONS_DIR="$ROOT_DIR/src/migrations" \
  "$NODE_BIN" --import tsx "$ROOT_DIR/src/converact-migrate.ts" \
  >"$EVIDENCE_DIR/migrations.log" 2>&1

"$NODE_BIN" --import tsx "$DATABASE_PROBE" prepare "$PREPARE_RESULT" \
  >"$EVIDENCE_DIR/database-prepare.log" 2>&1

"$NODE_BIN" "$MEDIA_PROBE" "$MEDIA_RESULT" "$MEDIA_READY" "$FAULT_WINDOW" "$MEDIA_DURATION_MS" \
  >"$EVIDENCE_DIR/synthetic-media.log" 2>&1 &
MEDIA_PID=$!
wait_file "$MEDIA_READY" "$MEDIA_PID"

CONTAINER_ID_BEFORE=$(compose ps --quiet postgres)
STARTED_AT_BEFORE=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER_ID_BEFORE")
FAULT_STARTED_AT=$("$NODE_BIN" -e 'process.stdout.write(new Date().toISOString())')
compose stop --timeout 5 postgres >"$EVIDENCE_DIR/postgres-stop.log" 2>&1
"$NODE_BIN" --import tsx "$DATABASE_PROBE" outage "$OUTAGE_RESULT" \
  >"$EVIDENCE_DIR/database-outage.log" 2>&1
compose start postgres >"$EVIDENCE_DIR/postgres-start.log" 2>&1
wait_postgres
FAULT_COMPLETED_AT=$("$NODE_BIN" -e 'process.stdout.write(new Date().toISOString())')
CONTAINER_ID_AFTER=$(compose ps --quiet postgres)
STARTED_AT_AFTER=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER_ID_AFTER")
"$NODE_BIN" -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[3], JSON.stringify({
    started_at: process.argv[1], completed_at: process.argv[2]
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
' "$FAULT_STARTED_AT" "$FAULT_COMPLETED_AT" "$FAULT_WINDOW"

"$NODE_BIN" --import tsx "$DATABASE_PROBE" recover "$RECOVER_RESULT" \
  >"$EVIDENCE_DIR/database-recover.log" 2>&1
if ! timeout -k 2 $(( MEDIA_DURATION_MS / 1000 + 10 )) tail --pid="$MEDIA_PID" -f /dev/null; then
  printf '%s\n' 'synthetic media probe did not finish within its bound' >&2
  exit 1
fi
wait "$MEDIA_PID"
MEDIA_PID=

compose logs --no-color postgres >"$EVIDENCE_DIR/postgres.log" 2>&1
compose down --volumes --remove-orphans >"$EVIDENCE_DIR/postgres-down.log" 2>&1
COMPOSE_ACTIVE=0
snapshot_unrelated >"$AFTER_CONTAINERS"
VALIDATION_REMAINING=$(docker ps -a \
  --filter "label=com.docker.compose.project=$PROJECT" --format '{{.ID}}' | wc -l | tr -d ' ')

"$NODE_BIN" --import tsx "$DATABASE_PROBE" restart \
  "$CONTAINER_ID_BEFORE" "$STARTED_AT_BEFORE" "$CONTAINER_ID_AFTER" "$STARTED_AT_AFTER" \
  "$BEFORE_CONTAINERS" "$AFTER_CONTAINERS" "$VALIDATION_REMAINING" "$RESTART_RESULT" \
  >"$EVIDENCE_DIR/database-restart.log" 2>&1

CONFIG_SHA256=$(
  cd "$ROOT_DIR"
  sha256sum \
    services/converact-service/acceptance/platform-fault-matrix/accept.sh \
    services/converact-service/acceptance/platform-fault-matrix/database-probe.ts \
    services/converact-service/acceptance/platform-fault-matrix/docker-compose.yml \
    services/converact-service/acceptance/platform-fault-matrix/evidence-contract.mjs \
    services/converact-service/acceptance/platform-fault-matrix/synthetic-media.mjs \
    | sha256sum | awk '{print $1}'
)

for file in \
  "$BEFORE_CONTAINERS" "$AFTER_CONTAINERS" "$PREPARE_RESULT" "$OUTAGE_RESULT" \
  "$RESTART_RESULT" "$RECOVER_RESULT" "$MEDIA_RESULT" "$FAULT_WINDOW" \
  "$EVIDENCE_DIR/runtime-role.log" "$EVIDENCE_DIR/migrations.log" \
  "$EVIDENCE_DIR/postgres.log"; do
  hash=$(sha256sum "$file" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$(basename "$file")" >>"$RAW_MANIFEST"
done
RAW_OUTPUT_SHA256=$(sha256sum "$RAW_MANIFEST" | awk '{print $1}')

export CONVERACT_G02_SOURCE_COMMIT="$SOURCE_COMMIT"
export CONVERACT_G02_CONFIG_SHA256="$CONFIG_SHA256"
export CONVERACT_G02_RAW_OUTPUT_SHA256="$RAW_OUTPUT_SHA256"
export CONVERACT_G02_NODE_IMAGE="$NODE_IMAGE"
export CONVERACT_G02_NODE_BINARY_SHA256="$NODE_BINARY_SHA256"
export CONVERACT_G02_NODE_VERSION="$NODE_VERSION"
export CONVERACT_G02_HOST
CONVERACT_G02_HOST=$(hostname)
export CONVERACT_G02_HARDWARE
CONVERACT_G02_HARDWARE="$(uname -srmo); $(nproc) vCPU; $(awk '/MemTotal/ {printf "%.1f GiB RAM", $2/1024/1024}' /proc/meminfo); Node $NODE_VERSION"
export CONVERACT_G02_CLOCK="UTC wall clock; Node monotonic performance clock; $(cat /sys/devices/system/clocksource/clocksource0/current_clocksource 2>/dev/null || printf unknown) kernel clocksource"
export CONVERACT_G02_WORKLOAD="single PostgreSQL restart; one runtime role; two tenants; one inbox event; three effect stages; one usage key; ${MEDIA_DURATION_MS}ms synthetic UDP at 20ms interval"
export CONVERACT_G02_SEED="$RUN_ID"

"$NODE_BIN" --import tsx "$DATABASE_PROBE" identity "$IDENTITY_RESULT" \
  >"$EVIDENCE_DIR/evidence-identity.log" 2>&1
"$NODE_BIN" --import tsx "$DATABASE_PROBE" finalize \
  "$IDENTITY_RESULT" "$PREPARE_RESULT" "$OUTAGE_RESULT" "$RESTART_RESULT" \
  "$RECOVER_RESULT" "$MEDIA_RESULT" "$FINAL_RESULT"

printf 'evidence_directory=%s\n' "$EVIDENCE_DIR"
