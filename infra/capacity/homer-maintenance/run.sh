#!/usr/bin/env bash
set -euo pipefail

OUTPUT_FILE="${OUTPUT_FILE:?OUTPUT_FILE is required}"
ARTIFACT_ROOT="${ARTIFACT_ROOT:?ARTIFACT_ROOT is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEP_SENDER="${HEP_SENDER:-$SCRIPT_DIR/send-hep3.py}"
HOMER_IMAGE="${HOMER_IMAGE:-ivekit/homer:11.0.297-ivekit.2-ac4e1ae7}"
HOMER_IMAGE_ID="${HOMER_IMAGE_ID:-sha256:d062461067849bbec3d4b84473f309d7e3b216bb29284d4124fc9960f361e389}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16.10-alpine3.22}"
POSTGRES_IMAGE_ID="${POSTGRES_IMAGE_ID:-sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
OLD_PACKET_COUNT="${OLD_PACKET_COUNT:-200}"
FRESH_PACKET_COUNT="${FRESH_PACKET_COUNT:-200}"
OLD_TIMESTAMP_OFFSET_SECONDS="${OLD_TIMESTAMP_OFFSET_SECONDS:--3456000}"
EXPIRE_OLDER_THAN="${EXPIRE_OLDER_THAN:-1s}"
RUN_ID="${RUN_ID:-homer-maint-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"

NETWORK_NAME="$RUN_ID"
POSTGRES_NAME="$RUN_ID-postgres"
HOMER_NAME="$RUN_ID-homer"
POSTGRES_VOLUME="$RUN_ID-postgres"
RUN_ROOT="$ARTIFACT_ROOT/$RUN_ID"
DATA_DIR="$RUN_ROOT/data"
STATE_DIR="$RUN_ROOT/state"
POSTGRES_ENV="$RUN_ROOT/postgres.env"
HOMER_ENV="$RUN_ROOT/homer.env"
LABEL="ivekit.validation=$RUN_ID"
OLD_PREFIX="$RUN_ID-old"
FRESH_PREFIX="$RUN_ID-fresh"
OLD_CAPTURE_ID_BASE=10000
FRESH_CAPTURE_ID_BASE=20000
CLEANED=0

bounded_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  [[ "$value" =~ ^[0-9]+$ ]] || {
    printf '%s must be an integer\n' "$name" >&2
    exit 64
  }
  (( value >= minimum && value <= maximum )) || {
    printf '%s must be between %s and %s\n' "$name" "$minimum" "$maximum" >&2
    exit 64
  }
}

require_file() {
  [[ -f "$1" ]] || {
    printf 'required file is missing: %s\n' "$1" >&2
    exit 66
  }
}

actual_image_id() {
  docker image inspect "$1" --format '{{.Id}}'
}

assert_image_id() {
  local image="$1"
  local expected="$2"
  local actual
  actual="$(actual_image_id "$image")"
  [[ "$actual" == "$expected" ]] || {
    printf 'image ID mismatch for %s: expected %s, got %s\n' \
      "$image" "$expected" "$actual" >&2
    exit 65
  }
}

cleanup_resources() {
  local ids
  ids="$(docker ps -aq --filter "label=$LABEL")"
  if [[ -n "$ids" ]]; then
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  docker volume rm "$POSTGRES_VOLUME" >/dev/null 2>&1 || true
  rm -f "$POSTGRES_ENV" "$HOMER_ENV"
  rm -rf "$DATA_DIR" "$STATE_DIR"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( CLEANED == 0 )); then
    cleanup_resources
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_postgres() {
  local attempt
  for attempt in $(seq 1 90); do
    if [[ "$(docker inspect "$POSTGRES_NAME" \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      2>/dev/null || true)" == "healthy" ]]; then
      return 0
    fi
    sleep 1
  done
  printf 'isolated PostgreSQL did not become healthy\n' >&2
  return 1
}

wait_homer() {
  local attempt
  for attempt in $(seq 1 120); do
    if docker run --rm --network "$NETWORK_NAME" "$ALPINE_IMAGE" \
      wget -qO- "http://$HOMER_NAME:8080/health" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$(docker inspect "$HOMER_NAME" --format '{{.State.Status}}' \
      2>/dev/null || true)" == "exited" ]]; then
      docker logs "$HOMER_NAME" >&2 || true
      return 1
    fi
    sleep 1
  done
  printf 'isolated HOMER did not become healthy\n' >&2
  return 1
}

query_count() {
  local prefix="$1"
  docker exec "$HOMER_NAME" /usr/local/bin/homer cli \
    --config-path /etc/homer \
    --query "SELECT count(*) AS rows FROM hep_proto_1_call WHERE session_id LIKE '${prefix}-%'" \
    2>/dev/null |
    awk -F'|' '/^\|[[:space:]]*[0-9]+[[:space:]]*\|/ {
      value=$2; gsub(/[[:space:]]/, "", value); print value; exit
    }'
}

wait_count() {
  local prefix="$1"
  local expected="$2"
  local attempt
  local actual=0
  for attempt in $(seq 1 90); do
    actual="$(query_count "$prefix")"
    if [[ "$actual" == "$expected" ]]; then
      printf '%s\n' "$actual"
      return 0
    fi
    sleep 1
  done
  printf 'HEP rows for %s did not reach %s; observed %s\n' \
    "$prefix" "$expected" "$actual" >&2
  return 1
}

postgres_scalar() {
  local sql="$1"
  docker exec "$POSTGRES_NAME" sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"' \
    sh "$sql"
}

parquet_file_count() {
  find "$DATA_DIR" -type f -name '*.parquet' | wc -l | tr -d ' '
}

start_homer() {
  docker start "$HOMER_NAME" >/dev/null
  wait_homer
}

stop_homer() {
  docker stop -t 30 "$HOMER_NAME" >/dev/null
}

run_maintenance() {
  local output="$1"
  docker run --rm \
    --name "$RUN_ID-maintenance" \
    --label "$LABEL" \
    --network "$NETWORK_NAME" \
    --env-file "$HOMER_ENV" \
    --user 10001:10001 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001 \
    --mount "type=bind,source=$DATA_DIR,target=/var/lib/homer/data" \
    --mount "type=bind,source=$STATE_DIR,target=/var/lib/homer/state" \
    "$HOMER_IMAGE" system \
    --config-path /etc/homer \
    --compaction-retention-days "$RETENTION_DAYS" \
    --compaction-force \
    --compaction-expire-older-than "$EXPIRE_OLDER_THAN" \
    --compaction-merge-list \
    --compaction-merge-list-limit 20 >"$output" 2>&1
}

sanitize_artifacts() {
  python3 - "$POSTGRES_ENV" "$HOMER_ENV" "$RUN_ROOT" <<'PY'
from pathlib import Path
import re
import sys

env_paths = [Path(sys.argv[1]), Path(sys.argv[2])]
root = Path(sys.argv[3])
secret_values = []
for path in env_paths:
    for line in path.read_text().splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if re.search(r"(PASSWORD|TOKEN|SECRET)", key) and value:
            secret_values.append(value)
        if key == "POSTGRES_PASSWORD" and value:
            secret_values.append(value)

dsn_pattern = re.compile(
    r"(postgres(?:ql)?:(?://|/)[^:\s/@]+:)([^@\s]+)(@)",
    re.IGNORECASE,
)
libpq_password = re.compile(r"(password=)([^\s]+)", re.IGNORECASE)
for path in sorted(root.iterdir()):
    if not path.is_file() or path in env_paths or path.name == "secret-scan.txt":
        continue
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        continue
    for value in secret_values:
        text = text.replace(value, "<redacted>")
    text = dsn_pattern.sub(r"\1<redacted>\3", text)
    text = libpq_password.sub(r"\1<redacted>", text)
    path.write_text(text)

violations = []
for path in sorted(root.iterdir()):
    if not path.is_file() or path in env_paths or path.name == "secret-scan.txt":
        continue
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        continue
    if any(value in text for value in secret_values):
        violations.append(f"{path.name}: exact secret")
    for match in dsn_pattern.finditer(text):
        if match.group(2) != "<redacted>":
            violations.append(f"{path.name}: PostgreSQL URI credential")
    for match in libpq_password.finditer(text):
        if match.group(2) != "<redacted>":
            violations.append(f"{path.name}: libpq password")

scan = root / "secret-scan.txt"
if violations:
    scan.write_text("failed\n" + "\n".join(violations) + "\n")
    raise SystemExit("artifact secret scan failed")
scan.write_text("passed\n")
PY
}

require_file "$HEP_SENDER"
bounded_integer RETENTION_DAYS "$RETENTION_DAYS" 1 3650
bounded_integer OLD_PACKET_COUNT "$OLD_PACKET_COUNT" 1 100000
bounded_integer FRESH_PACKET_COUNT "$FRESH_PACKET_COUNT" 1 100000
[[ "$OLD_TIMESTAMP_OFFSET_SECONDS" =~ ^-[0-9]+$ ]] || {
  printf 'OLD_TIMESTAMP_OFFSET_SECONDS must be a negative integer\n' >&2
  exit 64
}
[[ "$EXPIRE_OLDER_THAN" =~ ^[1-9][0-9]*(s|m|h)$ ]] || {
  printf 'EXPIRE_OLDER_THAN must be a positive Go duration using s, m or h\n' >&2
  exit 64
}
[[ "$RUN_ID" =~ ^homer-maint-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || {
  printf 'RUN_ID has an invalid format\n' >&2
  exit 64
}
[[ "$RUN_ROOT" == "$ARTIFACT_ROOT"/homer-maint-* ]] || {
  printf 'run root escaped the artifact root\n' >&2
  exit 64
}

assert_image_id "$HOMER_IMAGE" "$HOMER_IMAGE_ID"
assert_image_id "$POSTGRES_IMAGE" "$POSTGRES_IMAGE_ID"
mkdir -p "$RUN_ROOT" "$DATA_DIR" "$STATE_DIR" "$(dirname "$OUTPUT_FILE")"
chown 10001:10001 "$DATA_DIR" "$STATE_DIR"
chmod 700 "$DATA_DIR" "$STATE_DIR"

postgres_password="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
node_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
jwt_secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
{
  printf 'POSTGRES_USER=homer\n'
  printf 'POSTGRES_DB=homer_catalog\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
} >"$POSTGRES_ENV"
{
  printf 'HOME=/var/lib/homer\n'
  printf 'HOMER_INGEST_ENABLE=true\n'
  printf 'HOMER_INGEST_WORKER_COUNT=2\n'
  printf 'HOMER_INGEST_QUEUE_SIZE=10000\n'
  printf 'HOMER_INGEST_UDP_ENABLE=true\n'
  printf 'HOMER_INGEST_UDP_HOST=0.0.0.0\n'
  printf 'HOMER_INGEST_UDP_PORT=9060\n'
  printf 'HOMER_INGEST_UDP_MULTICORE=false\n'
  printf 'HOMER_INGEST_TCP_ENABLE=false\n'
  printf 'HOMER_INGEST_HTTP_ENABLE=false\n'
  printf 'HOMER_INGEST_HTTPS_ENABLE=false\n'
  printf 'HOMER_INGEST_HEP_HEPV2_ENABLE=false\n'
  printf 'HOMER_INGEST_HEP_HEPV3_ENABLE=true\n'
  printf 'HOMER_INGEST_HEP_PROTOBUF_ENABLE=false\n'
  printf 'HOMER_STORAGE_ENABLE=true\n'
  printf 'HOMER_STORAGE_DUCKLAKE_CATALOG_TYPE=postgres\n'
  printf 'HOMER_STORAGE_DUCKLAKE_CATALOG_PATH=postgres://homer:%s@%s:5432/homer_catalog?sslmode=disable\n' \
    "$postgres_password" "$POSTGRES_NAME"
  printf 'HOMER_STORAGE_DUCKLAKE_DATA_PATH=/var/lib/homer/data/parquet\n'
  printf 'HOMER_STORAGE_DUCKLAKE_LAKE_NAME=homer_lake\n'
  printf 'HOMER_STORAGE_DUCKLAKE_BATCH_SIZE=100\n'
  printf 'HOMER_STORAGE_DUCKLAKE_FLUSH_INTERVAL_SEC=1\n'
  printf 'HOMER_STORAGE_DUCKLAKE_SEARCH_BUFFER=true\n'
  printf 'HOMER_STORAGE_DUCKLAKE_SHARD_COUNT=1\n'
  printf 'HOMER_STORAGE_DUCKLAKE_DATA_INLINING_ROW_LIMIT=0\n'
  printf 'HOMER_STORAGE_DUCKLAKE_TUNING_THREADS=2\n'
  printf 'HOMER_STORAGE_DUCKLAKE_TUNING_MEMORY_LIMIT=1GB\n'
  printf 'HOMER_STORAGE_DUCKLAKE_TUNING_TEMP_DIRECTORY=/var/lib/homer/data/.duckdb-spill\n'
  printf 'HOMER_STORAGE_DUCKLAKE_COMPACTION_ENABLE=false\n'
  printf 'HOMER_STORAGE_DUCKLAKE_COMPACTION_CHECK_INTERVAL_SEC=3600\n'
  printf 'HOMER_STORAGE_DUCKLAKE_STORAGE_POLICY_ENABLE=false\n'
  printf 'HOMER_NODE_ENABLE=true\n'
  printf 'HOMER_NODE_FLIGHT_SERVER_HOST=0.0.0.0\n'
  printf 'HOMER_NODE_FLIGHT_SERVER_PORT=50051\n'
  printf 'HOMER_NODE_FLIGHT_SERVER_AUTH_TOKEN=%s\n' "$node_token"
  printf 'HOMER_NODE_DUCKLAKE_LAKE_NAME=homer_lake\n'
  printf 'HOMER_NODE_DUCKLAKE_VOLUMES_0_NAME=default\n'
  printf 'HOMER_NODE_DUCKLAKE_VOLUMES_0_TYPE=local\n'
  printf 'HOMER_NODE_DUCKLAKE_VOLUMES_0_CATALOG_TYPE=postgres\n'
  printf 'HOMER_NODE_DUCKLAKE_VOLUMES_0_CATALOG_PATH=postgres://homer:%s@%s:5432/homer_catalog?sslmode=disable\n' \
    "$postgres_password" "$POSTGRES_NAME"
  printf 'HOMER_NODE_DUCKLAKE_VOLUMES_0_PATH=/var/lib/homer/data/parquet\n'
  printf 'HOMER_COORDINATOR_ENABLE=true\n'
  printf 'HOMER_COORDINATOR_HTTP_SERVER_ENABLE=true\n'
  printf 'HOMER_COORDINATOR_HTTP_SERVER_HOST=0.0.0.0\n'
  printf 'HOMER_COORDINATOR_HTTP_SERVER_PORT=8080\n'
  printf 'HOMER_COORDINATOR_HTTP_SERVER_STATIC_PATH=/usr/local/homer-core/dist\n'
  printf 'HOMER_COORDINATOR_NODES_0_NAME=local\n'
  printf 'HOMER_COORDINATOR_NODES_0_HOST=127.0.0.1\n'
  printf 'HOMER_COORDINATOR_NODES_0_PORT=50051\n'
  printf 'HOMER_COORDINATOR_NODES_0_TOKEN=%s\n' "$node_token"
  printf 'HOMER_COORDINATOR_SETTINGS_DB_PATH=/var/lib/homer/state/homer_settings.duckdb\n'
  printf 'HOMER_COORDINATOR_JWT_SECRET=%s\n' "$jwt_secret"
  printf 'HOMER_COORDINATOR_AUTH_ADMIN_USER=admin\n'
  printf '%s\n' 'HOMER_COORDINATOR_AUTH_ADMIN_PASSWORD_HASH=$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
  printf 'HOMER_PROMETHEUS_ENABLE=false\n'
  printf 'HOMER_LOG_JSON=true\n'
  printf 'HOMER_LOG_OUTPUT_0=stdout\n'
} >"$HOMER_ENV"
chmod 600 "$POSTGRES_ENV" "$HOMER_ENV"
unset postgres_password node_token jwt_secret

docker network create --label "$LABEL" "$NETWORK_NAME" >/dev/null
docker volume create --label "$LABEL" "$POSTGRES_VOLUME" >/dev/null
docker run -d \
  --name "$POSTGRES_NAME" \
  --label "$LABEL" \
  --network "$NETWORK_NAME" \
  --env-file "$POSTGRES_ENV" \
  --health-cmd 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 90 \
  --mount "type=volume,source=$POSTGRES_VOLUME,target=/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" >/dev/null
wait_postgres

docker create \
  --name "$HOMER_NAME" \
  --label "$LABEL" \
  --network "$NETWORK_NAME" \
  --env-file "$HOMER_ENV" \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001 \
  --mount "type=bind,source=$DATA_DIR,target=/var/lib/homer/data" \
  --mount "type=bind,source=$STATE_DIR,target=/var/lib/homer/state" \
  "$HOMER_IMAGE" \
  --config-path /etc/homer \
  --pid-file /tmp/homer-core.pid >/dev/null
start_homer

homer_ip="$(docker inspect "$HOMER_NAME" \
  --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}")"
python3 "$HEP_SENDER" \
  --udp "$homer_ip:9060" \
  --count "$OLD_PACKET_COUNT" \
  --prefix "$OLD_PREFIX" \
  --timestamp-offset-seconds "$OLD_TIMESTAMP_OFFSET_SECONDS" \
  --capture-id-base "$OLD_CAPTURE_ID_BASE" >"$RUN_ROOT/send-old.log"
old_rows_before="$(wait_count "$OLD_PREFIX" "$OLD_PACKET_COUNT")"
sleep 2
python3 "$HEP_SENDER" \
  --udp "$homer_ip:9060" \
  --count "$FRESH_PACKET_COUNT" \
  --prefix "$FRESH_PREFIX" \
  --timestamp-offset-seconds 0 \
  --capture-id-base "$FRESH_CAPTURE_ID_BASE" >"$RUN_ROOT/send-fresh.log"
fresh_rows_before="$(wait_count "$FRESH_PREFIX" "$FRESH_PACKET_COUNT")"
sleep 2

snapshot_count_before="$(postgres_scalar 'SELECT count(*) FROM ducklake_snapshot')"
data_file_count_before="$(postgres_scalar 'SELECT count(*) FROM ducklake_data_file')"
parquet_files_before="$(parquet_file_count)"
docker inspect "$HOMER_NAME" "$POSTGRES_NAME" \
  --format '{{.Name}}|{{.Image}}|{{.Config.User}}|{{.State.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}' \
  >"$RUN_ROOT/container-identities.txt"
docker network inspect "$NETWORK_NAME" \
  --format '{{range .Containers}}{{.Name}}|{{.IPv4Address}}{{println}}{{end}}' |
  sort >"$RUN_ROOT/network-members-before.txt"
docker logs "$HOMER_NAME" >"$RUN_ROOT/homer-ingest.log" 2>&1

stop_homer
run_maintenance "$RUN_ROOT/maintenance-first.log"
start_homer
old_rows_after="$(wait_count "$OLD_PREFIX" 0)"
fresh_rows_after="$(wait_count "$FRESH_PREFIX" "$FRESH_PACKET_COUNT")"
snapshot_count_after_first="$(postgres_scalar 'SELECT count(*) FROM ducklake_snapshot')"
data_file_count_after_first="$(postgres_scalar 'SELECT count(*) FROM ducklake_data_file')"
parquet_files_after_first="$(parquet_file_count)"

stop_homer
sleep 2
run_maintenance "$RUN_ROOT/maintenance-idempotent.log"
start_homer
old_rows_after_idempotent="$(wait_count "$OLD_PREFIX" 0)"
fresh_rows_after_idempotent="$(wait_count "$FRESH_PREFIX" "$FRESH_PACKET_COUNT")"
snapshot_count_after_idempotent="$(postgres_scalar 'SELECT count(*) FROM ducklake_snapshot')"
data_file_count_after_idempotent="$(postgres_scalar 'SELECT count(*) FROM ducklake_data_file')"
parquet_files_after_idempotent="$(parquet_file_count)"
docker logs "$HOMER_NAME" >"$RUN_ROOT/homer-after-maintenance.log" 2>&1

printf '%s\n' "$old_rows_before" >"$RUN_ROOT/old-rows-before.txt"
printf '%s\n' "$fresh_rows_before" >"$RUN_ROOT/fresh-rows-before.txt"
printf '%s\n' "$old_rows_after" >"$RUN_ROOT/old-rows-after.txt"
printf '%s\n' "$fresh_rows_after" >"$RUN_ROOT/fresh-rows-after.txt"
printf '%s\n' "$old_rows_after_idempotent" >"$RUN_ROOT/old-rows-after-idempotent.txt"
printf '%s\n' "$fresh_rows_after_idempotent" >"$RUN_ROOT/fresh-rows-after-idempotent.txt"
printf '%s,%s,%s\n' \
  "$snapshot_count_before" "$snapshot_count_after_first" "$snapshot_count_after_idempotent" \
  >"$RUN_ROOT/snapshot-counts.csv"
printf '%s,%s,%s\n' \
  "$data_file_count_before" "$data_file_count_after_first" "$data_file_count_after_idempotent" \
  >"$RUN_ROOT/catalog-file-counts.csv"
printf '%s,%s,%s\n' \
  "$parquet_files_before" "$parquet_files_after_first" "$parquet_files_after_idempotent" \
  >"$RUN_ROOT/parquet-file-counts.csv"

sanitize_artifacts
cleanup_resources
CLEANED=1
test_resources_remaining="$(
  docker ps -aq --filter "label=ivekit.validation=$RUN_ID" | wc -l | tr -d ' '
)"
printf '%s\n' "$test_resources_remaining" >"$RUN_ROOT/test-resources-remaining.txt"

python3 - "$RUN_ROOT" "$OUTPUT_FILE" "$RUN_ID" "$RETENTION_DAYS" \
  "$EXPIRE_OLDER_THAN" "$OLD_TIMESTAMP_OFFSET_SECONDS" \
  "$OLD_PACKET_COUNT" "$FRESH_PACKET_COUNT" \
  "$HOMER_IMAGE" "$HOMER_IMAGE_ID" "$POSTGRES_IMAGE" "$POSTGRES_IMAGE_ID" \
  "$HEP_SENDER" "$0" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
output = Path(sys.argv[2])
run_id = sys.argv[3]
retention_days = int(sys.argv[4])
expire_older_than = sys.argv[5]
old_offset = int(sys.argv[6])
old_packets = int(sys.argv[7])
fresh_packets = int(sys.argv[8])
homer_image = sys.argv[9]
homer_image_id = sys.argv[10]
postgres_image = sys.argv[11]
postgres_image_id = sys.argv[12]
sender = Path(sys.argv[13]).resolve()
runner = Path(sys.argv[14]).resolve()

def integer(name):
    return int((root / name).read_text().strip())

def triple(name):
    return [int(value) for value in (root / name).read_text().strip().split(",")]

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

old_before = integer("old-rows-before.txt")
fresh_before = integer("fresh-rows-before.txt")
old_after = integer("old-rows-after.txt")
fresh_after = integer("fresh-rows-after.txt")
old_idempotent = integer("old-rows-after-idempotent.txt")
fresh_idempotent = integer("fresh-rows-after-idempotent.txt")
snapshots = triple("snapshot-counts.csv")
catalog_files = triple("catalog-file-counts.csv")
parquet_files = triple("parquet-file-counts.csv")
remaining = integer("test-resources-remaining.txt")
first_log = (root / "maintenance-first.log").read_text()
idempotent_log = (root / "maintenance-idempotent.log").read_text()
secret_scan_passed = (root / "secret-scan.txt").read_text().strip() == "passed"
checks = {
    "old_rows_seeded": old_before == old_packets,
    "fresh_rows_seeded": fresh_before == fresh_packets,
    "old_rows_deleted": old_after == 0,
    "fresh_rows_preserved": fresh_after == fresh_packets,
    "idempotent_old_rows": old_idempotent == 0,
    "idempotent_fresh_rows": fresh_idempotent == fresh_packets,
    "first_compaction_completed": "Compaction force completed" in first_log,
    "idempotent_compaction_completed": "Compaction force completed" in idempotent_log,
    "test_resources_removed": remaining == 0,
    "secret_scan_passed": secret_scan_passed,
    "sensitive_inputs_removed": not (root / "postgres.env").exists() and
        not (root / "homer.env").exists() and secret_scan_passed,
}
artifacts = {}
for path in sorted(root.iterdir()):
    if path.is_file():
        artifacts[path.name] = sha256(path)
result = {
    "schema_version": "1.0.0",
    "suite": "iveKit HOMER isolated retention and compaction",
    "run_id": run_id,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "status": "controlled_pass" if all(checks.values()) else "controlled_failed",
    "scope": "controlled_server_isolated_catalog",
    "capacity_claim": "none",
    "production_capacity_evidence": False,
    "configuration": {
        "retention_days": retention_days,
        "old_timestamp_offset_seconds": old_offset,
        "old_packet_count": old_packets,
        "fresh_packet_count": fresh_packets,
        "expire_older_than": expire_older_than,
    },
    "source": {
        "runner_sha256": sha256(runner),
        "hep_sender_sha256": sha256(sender),
        "homer_image": homer_image,
        "homer_image_id": homer_image_id,
        "postgres_image": postgres_image,
        "postgres_image_id": postgres_image_id,
    },
    "rows": {
        "old_before": old_before,
        "fresh_before": fresh_before,
        "old_after": old_after,
        "fresh_after": fresh_after,
        "old_after_idempotent": old_idempotent,
        "fresh_after_idempotent": fresh_idempotent,
    },
    "maintenance": {
        "snapshot_counts": {
            "before": snapshots[0],
            "after_first": snapshots[1],
            "after_idempotent": snapshots[2],
        },
        "catalog_data_file_counts": {
            "before": catalog_files[0],
            "after_first": catalog_files[1],
            "after_idempotent": catalog_files[2],
        },
        "parquet_file_counts": {
            "before": parquet_files[0],
            "after_first": parquet_files[1],
            "after_idempotent": parquet_files[2],
        },
    },
    "checks": checks,
    "test_resources_remaining": remaining,
    "sensitive_inputs_removed": checks["sensitive_inputs_removed"],
    "artifacts": artifacts,
}
output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
print(json.dumps({
    "status": result["status"],
    "output_file": str(output),
    "rows": result["rows"],
}))
if result["status"] != "controlled_pass":
    raise SystemExit(1)
PY
