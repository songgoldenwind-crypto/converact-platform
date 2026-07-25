#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
COMPOSE_FILE="$ROOT_DIR/services/ivekit-service/acceptance/seaweedfs-s3/docker-compose.yml"
PROBE="$ROOT_DIR/services/ivekit-service/acceptance/seaweedfs-s3/probe.ts"
NODE_BIN=${NODE_BIN:-node}
SEAWEEDFS_IMAGE=${SEAWEEDFS_IMAGE:-chrislusf/seaweedfs:4.40@sha256:52194fba4fecd0083c842158b3a902ba6e04a63619b2b0efcd08007bdb6a4602}
SEAWEEDFS_S3_HOST_PORT=${SEAWEEDFS_S3_HOST_PORT:-18333}
PROJECT="ivekit-seaweedfs-$(date -u +%Y%m%d%H%M%S)-$$"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ivekit-seaweedfs.XXXXXX")
STATE_FILE="$WORK_DIR/state.json"
MATRIX_FILE="$WORK_DIR/matrix.json"
OUTAGE_FILE="$WORK_DIR/outage.json"
RECOVERY_FILE="$WORK_DIR/recovery.json"
EVIDENCE_FILE=${SEAWEEDFS_EVIDENCE_FILE:-"$ROOT_DIR/.runtime/seaweedfs-s3-evidence.json"}
SEAWEEDFS_ACCESS_KEY=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
SEAWEEDFS_SECRET_KEY=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
S3_BUCKET="ivekit-seaweedfs-$(date -u +%Y%m%d)-$$"
export SEAWEEDFS_IMAGE SEAWEEDFS_S3_HOST_PORT SEAWEEDFS_ACCESS_KEY SEAWEEDFS_SECRET_KEY
export S3_ENDPOINT="http://127.0.0.1:$SEAWEEDFS_S3_HOST_PORT"
export S3_BUCKET S3_REGION=us-east-1 S3_FORCE_PATH_STYLE=true
export AWS_ACCESS_KEY_ID="$SEAWEEDFS_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$SEAWEEDFS_SECRET_KEY"
export OPC_OBJECT_STORAGE_REQUIRED=1 NODE_NO_WARNINGS=1

compose() {
  docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

safe_logs() {
  compose logs --no-color --tail 120 2>&1 | \
    sed "s/$SEAWEEDFS_ACCESS_KEY/[REDACTED]/g; s/$SEAWEEDFS_SECRET_KEY/[REDACTED]/g"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

case "$SEAWEEDFS_IMAGE" in
  *@sha256:[a-f0-9][a-f0-9]*) ;;
  *) printf '%s\n' 'SEAWEEDFS_IMAGE must be pinned by sha256 digest' >&2; exit 1 ;;
esac
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'required command is unavailable: docker' >&2
  exit 1
fi
if ! "$NODE_BIN" --version >/dev/null 2>&1; then
  printf '%s\n' 'NODE_BIN is unavailable' >&2
  exit 1
fi
mkdir -p "$(dirname "$EVIDENCE_FILE")"

compose config >/dev/null
printf '%s\n' 'SeaweedFS phase: starting isolated topology'
compose up --detach

attempt=0
while :; do
  if "$NODE_BIN" --import tsx "$PROBE" ready >/dev/null 2>&1; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    safe_logs >&2
    printf '%s\n' 'SeaweedFS S3 gateway did not become reachable' >&2
    exit 1
  fi
  sleep 2
done

printf '%s\n' 'SeaweedFS phase: running production S3 provider matrix'
if ! "$NODE_BIN" --import tsx "$PROBE" matrix "$STATE_FILE" >"$MATRIX_FILE"; then
  safe_logs >&2
  exit 1
fi
printf '%s\n' 'SeaweedFS phase: injecting S3 gateway outage'
compose stop s3 >/dev/null
"$NODE_BIN" --import tsx "$PROBE" expect-outage "$STATE_FILE" >"$OUTAGE_FILE"
compose up --detach s3 >/dev/null

attempt=0
while :; do
  if "$NODE_BIN" --import tsx "$PROBE" ready >/dev/null 2>&1; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    safe_logs >&2
    printf '%s\n' 'SeaweedFS S3 gateway did not recover' >&2
    exit 1
  fi
  sleep 2
done

printf '%s\n' 'SeaweedFS phase: verifying recovery and writing evidence'
"$NODE_BIN" --import tsx "$PROBE" recovery "$STATE_FILE" >"$RECOVERY_FILE"
"$NODE_BIN" --import tsx "$PROBE" finalize \
  "$MATRIX_FILE" "$OUTAGE_FILE" "$RECOVERY_FILE" "$EVIDENCE_FILE"

compose down --volumes --remove-orphans >/dev/null
if docker ps --all --format '{{.Names}}' | grep -q "^${PROJECT}-"; then
  printf '%s\n' 'SeaweedFS acceptance containers were not cleaned up' >&2
  exit 1
fi
printf 'SeaweedFS S3 controlled acceptance passed: %s\n' "$EVIDENCE_FILE"
