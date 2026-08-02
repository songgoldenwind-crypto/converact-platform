#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
ACCEPTANCE_DIR="$ROOT_DIR/services/converact-service/acceptance/platform-fault-matrix"
COMPOSE_FILE="$ACCEPTANCE_DIR/docker-compose.yml"
DATABASE_PROBE="$ACCEPTANCE_DIR/database-probe.ts"
RESTORE_PROBE="$ACCEPTANCE_DIR/restore-probe.ts"
IDENTITY_PROBE="$ACCEPTANCE_DIR/identity-probe.mjs"
SECRET_SCANNER="$ACCEPTANCE_DIR/evidence-secret-scan.mjs"
NODE_BIN=${NODE_BIN:-node}
NODE_IMAGE=${CONVERACT_G02_NODE_IMAGE:-}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-}
CONFIRMATION=${CONVERACT_G02_RESTORE_CONFIRM:-}
RUN_ID=${CONVERACT_G02_FAULT_RUN_ID:-}
SOURCE_COMMIT=${CONVERACT_G02_SOURCE_COMMIT:-}
SOURCE_PROJECT="converact-g02-${RUN_ID}-source"
TARGET_PROJECT="converact-g02-${RUN_ID}-target"
SOURCE_ACTIVE=0
TARGET_ACTIVE=0
SOURCE_ADDRESS=
TARGET_ADDRESS=

if [[ "$CONFIRMATION" != "G02_PLATFORM_RESTORE_EVIDENCE" ]]; then
  printf '%s\n' 'CONVERACT_G02_RESTORE_CONFIRM must equal G02_PLATFORM_RESTORE_EVIDENCE' >&2
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
NODE_BIN_PATH=$(command -v "$NODE_BIN" || true)
if [[ -z "$NODE_BIN_PATH" || ! -x "$NODE_BIN_PATH" ]]; then
  printf '%s\n' 'NODE_BIN must resolve to an executable' >&2
  exit 2
fi
NODE_VERSION=$("$NODE_BIN_PATH" --version)
if [[ ! "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' 'restore campaign requires Node v24' >&2
  exit 2
fi
if [[ ! -f "$ROOT_DIR/package-lock.json" || ! -d "$ROOT_DIR/node_modules/tsx" ]]; then
  printf '%s\n' 'exact-source npm dependencies must be installed before the campaign' >&2
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

EVIDENCE_ROOT="$ROOT_DIR/.runtime/platform-fault-matrix"
EVIDENCE_DIR="$EVIDENCE_ROOT/$RUN_ID"
WORK_ROOT="$ROOT_DIR/.runtime/platform-restore/$RUN_ID"
BACKUP_DIR="$WORK_ROOT/backup"
SOURCE_UPLOADS="$WORK_ROOT/source-objects"
TARGET_UPLOADS="$WORK_ROOT/target-objects"
if [[ -e "$EVIDENCE_DIR" || -e "$WORK_ROOT" ]]; then
  printf '%s\n' 'campaign run id already exists' >&2
  exit 2
fi
mkdir -p -m 0700 "$EVIDENCE_ROOT" "$(dirname "$WORK_ROOT")"
mkdir -m 0700 "$EVIDENCE_DIR" "$WORK_ROOT" "$SOURCE_UPLOADS" "$TARGET_UPLOADS"

POSTGRES_PASSWORD=$(openssl rand -hex 24)
CONVERACT_RUNTIME_DB_PASSWORD=$(openssl rand -hex 24)
export POSTGRES_IMAGE POSTGRES_PASSWORD CONVERACT_RUNTIME_DB_PASSWORD
export PGDATABASE=opc PGUSER=opc_admin PGPASSWORD="$POSTGRES_PASSWORD" PGPORT=5432
export CONVERACT_G02_FAULT_RUN_ID="$RUN_ID"
export CONVERACT_G02_SOURCE_COMMIT="$SOURCE_COMMIT"
export CONVERACT_G02_RESTORE_CONFIRM="$CONFIRMATION"
export CONVERACT_G02_STARTED_AT
CONVERACT_G02_STARTED_AT=$("$NODE_BIN_PATH" -e 'process.stdout.write(new Date().toISOString())')

compose_source() {
  timeout -k 5 120 docker compose --project-name "$SOURCE_PROJECT" --file "$COMPOSE_FILE" "$@"
}

compose_target() {
  timeout -k 5 120 docker compose --project-name "$TARGET_PROJECT" --file "$COMPOSE_FILE" "$@"
}

cleanup() {
  if [[ "$SOURCE_ACTIVE" -eq 1 ]]; then
    compose_source down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ "$TARGET_ACTIVE" -eq 1 ]]; then
    compose_target down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

snapshot_unrelated() {
  docker ps -a \
    --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.CreatedAt}}' \
    | LC_ALL=C sort
}

wait_postgres() {
  local project=$1
  local attempt=0
  until timeout -k 2 5 docker compose --project-name "$project" --file "$COMPOSE_FILE" \
    exec --no-TTY postgres pg_isready -U opc_admin -d opc >/dev/null 2>&1
  do
    attempt=$((attempt + 1))
    if (( attempt >= 90 )); then return 1; fi
    sleep 0.5
  done
}

postgres_address() {
  local project=$1
  local container network
  container=$(docker compose --project-name "$project" --file "$COMPOSE_FILE" ps --quiet postgres)
  network="${project}_validation"
  docker inspect --format \
    "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$container"
}

validation_resources() {
  local count=0 project
  for project in "$SOURCE_PROJECT" "$TARGET_PROJECT"; do
    count=$((count + $(docker ps -a \
      --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | wc -l)))
    count=$((count + $(docker volume ls \
      --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' | wc -l)))
    count=$((count + $(docker network ls \
      --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | wc -l)))
  done
  printf '%s' "$count"
}

BEFORE_CONTAINERS="$EVIDENCE_DIR/unrelated-containers-before.tsv"
AFTER_CONTAINERS="$EVIDENCE_DIR/unrelated-containers-after.tsv"
PREPARE_RESULT="$EVIDENCE_DIR/source-prepare.json"
BACKUP_RESULT="$EVIDENCE_DIR/backup-result.json"
EMPTY_RESULT="$EVIDENCE_DIR/target-empty.json"
RESTORE_RESULT="$EVIDENCE_DIR/restore-result.json"
VERIFY_RESULT="$EVIDENCE_DIR/restore-verify.json"
CLEAN_RESULT="$EVIDENCE_DIR/restore-clean.json"
IDENTITY_RESULT="$EVIDENCE_DIR/evidence-identity.json"
FINAL_RESULT="$EVIDENCE_DIR/restore-controlled-evidence.json"
RAW_MANIFEST="$EVIDENCE_DIR/raw-output.sha256"
SUPPLEMENTAL_MANIFEST="$EVIDENCE_DIR/supplemental-manifest.sha256"

snapshot_unrelated >"$BEFORE_CONTAINERS"

SOURCE_ACTIVE=1
compose_source up --detach postgres >"$EVIDENCE_DIR/source-up.log" 2>&1
wait_postgres "$SOURCE_PROJECT"
SOURCE_ADDRESS=$(postgres_address "$SOURCE_PROJECT")
SOURCE_CONTAINER=$(compose_source ps --quiet postgres)
if [[ -z "$SOURCE_ADDRESS" || ! "$SOURCE_CONTAINER" =~ ^[a-f0-9]{12,64}$ ]]; then
  printf '%s\n' 'source PostgreSQL identity unavailable' >&2
  exit 1
fi
export PGHOST="$SOURCE_ADDRESS" CONVERACT_UPLOAD_DIR="$SOURCE_UPLOADS"
CONVERACT_FABRIC_MIGRATIONS_DIR="$ROOT_DIR/src/migrations" \
  "$NODE_BIN_PATH" --import tsx "$ROOT_DIR/src/converact-init-runtime-role.ts" \
  >"$EVIDENCE_DIR/source-runtime-role.log" 2>&1
CONVERACT_FABRIC_MIGRATIONS_DIR="$ROOT_DIR/src/migrations" \
  "$NODE_BIN_PATH" --import tsx "$ROOT_DIR/src/converact-migrate.ts" \
  >"$EVIDENCE_DIR/source-migrations.log" 2>&1
"$NODE_BIN_PATH" --import tsx "$DATABASE_PROBE" prepare "$PREPARE_RESULT" \
  >"$EVIDENCE_DIR/source-prepare.log" 2>&1
"$NODE_BIN_PATH" --import tsx "$RESTORE_PROBE" backup \
  "$SOURCE_CONTAINER" "$BACKUP_DIR" "$BACKUP_RESULT" \
  >"$EVIDENCE_DIR/backup.log" 2>&1
cp "$BACKUP_DIR/manifest.json" "$EVIDENCE_DIR/backup-manifest.json"
cp "$BACKUP_DIR/manifest.sha256" "$EVIDENCE_DIR/backup-manifest.sha256"
cp "$BACKUP_DIR/objects.jsonl" "$EVIDENCE_DIR/backup-objects.jsonl"
compose_source down --volumes --remove-orphans >"$EVIDENCE_DIR/source-down.log" 2>&1
SOURCE_ACTIVE=0

TARGET_ACTIVE=1
compose_target up --detach postgres >"$EVIDENCE_DIR/target-up.log" 2>&1
wait_postgres "$TARGET_PROJECT"
TARGET_ADDRESS=$(postgres_address "$TARGET_PROJECT")
TARGET_CONTAINER=$(compose_target ps --quiet postgres)
if [[ -z "$TARGET_ADDRESS" || ! "$TARGET_CONTAINER" =~ ^[a-f0-9]{12,64}$ \
  || "$SOURCE_CONTAINER" == "$TARGET_CONTAINER" ]]; then
  printf '%s\n' 'target PostgreSQL identity unavailable or not distinct' >&2
  exit 1
fi
export PGHOST="$TARGET_ADDRESS" CONVERACT_UPLOAD_DIR="$TARGET_UPLOADS"
"$NODE_BIN_PATH" --import tsx "$ROOT_DIR/src/converact-init-runtime-role.ts" \
  >"$EVIDENCE_DIR/target-runtime-role-before.log" 2>&1
"$NODE_BIN_PATH" --import tsx "$RESTORE_PROBE" empty "$TARGET_CONTAINER" "$EMPTY_RESULT" \
  >"$EVIDENCE_DIR/target-empty.log" 2>&1
"$NODE_BIN_PATH" --import tsx "$RESTORE_PROBE" orchestrate \
  "$TARGET_CONTAINER" "$BACKUP_DIR" "$BACKUP_RESULT" "$EMPTY_RESULT" \
  "$RESTORE_RESULT" "$VERIFY_RESULT" \
  >"$EVIDENCE_DIR/restore-orchestrate.log" 2>&1
compose_target down --volumes --remove-orphans >"$EVIDENCE_DIR/target-down.log" 2>&1
TARGET_ACTIVE=0

snapshot_unrelated >"$AFTER_CONTAINERS"
VALIDATION_REMAINING=$(validation_resources)
"$NODE_BIN_PATH" --import tsx "$RESTORE_PROBE" cleanup \
  "$VERIFY_RESULT" "$BEFORE_CONTAINERS" "$AFTER_CONTAINERS" "$VALIDATION_REMAINING" "$CLEAN_RESULT" \
  >"$EVIDENCE_DIR/restore-clean.log" 2>&1

CONFIG_SHA256=$(
  cd "$ROOT_DIR"
  sha256sum \
    src/agent-runtime/converact/operations/backup.ts \
    src/agent-runtime/converact/operations/backup-runner.ts \
    src/converact-backup.ts \
    src/converact-restore.ts \
    services/converact-service/acceptance/platform-fault-matrix/campaign-evidence.mjs \
    services/converact-service/acceptance/platform-fault-matrix/database-probe.ts \
    services/converact-service/acceptance/platform-fault-matrix/docker-compose.yml \
    services/converact-service/acceptance/platform-fault-matrix/evidence-contract.mjs \
    services/converact-service/acceptance/platform-fault-matrix/evidence-secret-scan.mjs \
    services/converact-service/acceptance/platform-fault-matrix/identity-probe.mjs \
    services/converact-service/acceptance/platform-fault-matrix/restore-accept.sh \
    services/converact-service/acceptance/platform-fault-matrix/restore-probe.ts \
    | sha256sum | awk '{print $1}'
)

mapfile -d '' -t RAW_ARTIFACTS < <(
  find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$RAW_MANIFEST")" -print0 \
    | LC_ALL=C sort -z
)
"$NODE_BIN_PATH" "$SECRET_SCANNER" "$RAW_MANIFEST" "${RAW_ARTIFACTS[@]}"

export CONVERACT_G02_CONFIG_SHA256="$CONFIG_SHA256"
export CONVERACT_G02_RAW_OUTPUT_SHA256
CONVERACT_G02_RAW_OUTPUT_SHA256=$(sha256sum "$RAW_MANIFEST" | awk '{print $1}')
export CONVERACT_G02_IMAGE_DIGESTS_JSON="[\"$POSTGRES_IMAGE\",\"$NODE_IMAGE\"]"
export CONVERACT_G02_NODE_BINARY_SHA256
CONVERACT_G02_NODE_BINARY_SHA256=$(sha256sum "$NODE_BIN_PATH" | awk '{print $1}')
export CONVERACT_G02_NODE_VERSION="$NODE_VERSION"
export CONVERACT_G02_HOST
CONVERACT_G02_HOST=$(hostname)
export CONVERACT_G02_HARDWARE
CONVERACT_G02_HARDWARE="$(uname -srmo); $(nproc) vCPU; $(awk '/MemTotal/ {printf "%.1f GiB RAM", $2/1024/1024}' /proc/meminfo); Node $NODE_VERSION"
export CONVERACT_G02_CLOCK="UTC wall clock; Node monotonic performance clock; $(cat /sys/devices/system/clocksource/clocksource0/current_clocksource 2>/dev/null || printf unknown) kernel clocksource"
export CONVERACT_G02_WORKLOAD="distinct source and empty target PostgreSQL containers; production backup/restore; one object; runtime RLS and append-only verification; measured RPO/RTO"
export CONVERACT_G02_SEED="$RUN_ID"

"$NODE_BIN_PATH" "$IDENTITY_PROBE" "$IDENTITY_RESULT"
"$NODE_BIN_PATH" --import tsx "$RESTORE_PROBE" finalize \
  "$IDENTITY_RESULT" "$BACKUP_RESULT" "$CLEAN_RESULT" "$FINAL_RESULT" \
  >"$EVIDENCE_DIR/restore-finalize.log" 2>&1

mapfile -d '' -t FINAL_ARTIFACTS < <(
  find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$SUPPLEMENTAL_MANIFEST")" -print0 \
    | LC_ALL=C sort -z
)
"$NODE_BIN_PATH" "$SECRET_SCANNER" "$SUPPLEMENTAL_MANIFEST" "${FINAL_ARTIFACTS[@]}"
"$NODE_BIN_PATH" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "verified_controlled" || value.production_eligible !== false) process.exit(1);
' "$FINAL_RESULT"
printf '{"status":"verified_controlled","production_eligible":false,"evidence_directory":"%s"}\n' "$EVIDENCE_DIR"
