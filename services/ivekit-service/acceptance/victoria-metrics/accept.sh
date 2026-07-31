#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SERVER_IP="64.225.122.227"
if [[ "${IVEKIT_VALIDATION_SERVER_IP:-}" != "$EXPECTED_SERVER_IP" ]]; then
  echo "IVEKIT_VALIDATION_SERVER_IP must identify the controlled validation server" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PACKAGE_DIR="$ROOT/services/ivekit-service/acceptance/victoria-metrics"
PROJECT="ivekit_vm_accept_${$}_${RANDOM}"
RUNTIME_DIR="/tmp/$PROJECT"
EVIDENCE_FILE="${IVEKIT_VM_EVIDENCE_FILE:-$ROOT/docs/evidence/wave2-victoria-metrics-runtime-2026-07-22.json}"
NODE="${IVEKIT_NODE_BIN:-/opt/opc-wave123-validation-20260722/cache/toolchain/bin/node}"
COMPOSE=(docker compose -p "$PROJECT" -f "$PACKAGE_DIR/docker-compose.yml")
EXPECTED_LED=(
  led-platform-admin-1
  led-platform-api-1
  led-platform-edge-1
  led-platform-minio-1
  led-platform-postgres-1
  led-platform-system-tasks-1
  led-platform-web-1
)
CLEANED=0
CURRENT_STAGE="bootstrap"

mkdir -p "$RUNTIME_DIR/data" "$RUNTIME_DIR/backup" "$(dirname "$EVIDENCE_FILE")"
chown -R 1000:1000 "$RUNTIME_DIR"
export VM_ACCEPT_DATA_DIR="$RUNTIME_DIR/data"
export VM_ACCEPT_BACKUP_DIR="$RUNTIME_DIR/backup"

cleanup() {
  local status=$?
  if [[ "$status" != "0" && "$CLEANED" != "1" ]]; then
    echo "VictoriaMetrics acceptance failed during stage: $CURRENT_STAGE" >&2
    "${COMPOSE[@]}" ps >&2 || true
    "${COMPOSE[@]}" logs --no-color --tail 120 >&2 || true
  fi
  if [[ "$CLEANED" != "1" ]]; then
    "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$RUNTIME_DIR"
  return "$status"
}
trap cleanup EXIT

assert_led() {
  mapfile -t actual < <(docker ps --format '{{.Names}}' | grep '^led-platform-' | sort)
  if [[ "${actual[*]}" != "${EXPECTED_LED[*]}" ]]; then
    echo "LED container invariant failed" >&2
    printf '%s\n' "${actual[@]}" >&2
    exit 3
  fi
}

mapped_port() {
  local line
  line="$("${COMPOSE[@]}" port "$1" "$2")"
  printf '%s\n' "${line##*:}"
}

wait_http() {
  local endpoint="$1"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 1 "$endpoint" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_http_closed() {
  local endpoint="$1"
  for _ in $(seq 1 30); do
    if ! curl --silent --show-error --max-time 1 "$endpoint" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

source_value() {
  "$NODE" "$PACKAGE_DIR/probe.mjs" source "$SOURCE_ENDPOINT"
}

query_value() {
  "$NODE" "$PACKAGE_DIR/probe.mjs" query "$VM_ENDPOINT"
}

wait_source_at_least() {
  local expected="$1"
  local value
  for _ in $(seq 1 60); do
    value="$(source_value 2>/dev/null || true)"
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= expected )); then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_metric_at_least() {
  local expected="$1"
  local value
  for _ in $(seq 1 90); do
    value="$(query_value 2>/dev/null || true)"
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= expected )); then
      return 0
    fi
    sleep 1
  done
  return 1
}

assert_led
CURRENT_STAGE="compose-up"
"${COMPOSE[@]}" up -d source victoria-metrics prometheus
SOURCE_PORT="$(mapped_port source 9100)"
VM_PORT="$(mapped_port victoria-metrics 8428)"
PROM_PORT="$(mapped_port prometheus 9090)"
SOURCE_ENDPOINT="http://127.0.0.1:${SOURCE_PORT}"
VM_ENDPOINT="http://127.0.0.1:${VM_PORT}"
PROM_ENDPOINT="http://127.0.0.1:${PROM_PORT}"
wait_http "$SOURCE_ENDPOINT/health"
wait_http "$VM_ENDPOINT/health"
wait_http "$PROM_ENDPOINT/-/ready"

CURRENT_STAGE="initial-remote-write"
wait_metric_at_least 1
INITIAL_VALUE="$(query_value)"

CURRENT_STAGE="victoria-metrics-outage"
"${COMPOSE[@]}" stop victoria-metrics >/dev/null
wait_http_closed "$VM_ENDPOINT/health"
OUTAGE_START_VALUE="$(source_value)"
wait_source_at_least "$((OUTAGE_START_VALUE + 12))"
OUTAGE_END_VALUE="$(source_value)"
wait_http "$PROM_ENDPOINT/-/ready"

CURRENT_STAGE="wal-recovery"
"${COMPOSE[@]}" start victoria-metrics >/dev/null
VM_PORT="$(mapped_port victoria-metrics 8428)"
VM_ENDPOINT="http://127.0.0.1:${VM_PORT}"
wait_http "$VM_ENDPOINT/health"
wait_metric_at_least "$OUTAGE_START_VALUE"
RECOVERED_VALUE="$(query_value)"

CURRENT_STAGE="backup"
BACKUP_FLOOR_VALUE="$(query_value)"
"${COMPOSE[@]}" --profile tools run --rm --no-deps backup
BACKUP_FILE_COUNT="$(find "$RUNTIME_DIR/backup" -type f | wc -l | tr -d ' ')"
if (( BACKUP_FILE_COUNT < 1 )); then
  echo "vmbackup produced no files" >&2
  exit 4
fi

CURRENT_STAGE="prepare-restore"
"${COMPOSE[@]}" stop prometheus >/dev/null
"${COMPOSE[@]}" stop victoria-metrics >/dev/null
if [[ "$RUNTIME_DIR" != /tmp/ivekit_vm_accept_* ]]; then
  echo "unsafe runtime directory" >&2
  exit 5
fi
find "$RUNTIME_DIR/data" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

CURRENT_STAGE="restore"
"${COMPOSE[@]}" --profile tools run --rm --no-deps restore
"${COMPOSE[@]}" start victoria-metrics >/dev/null
VM_PORT="$(mapped_port victoria-metrics 8428)"
VM_ENDPOINT="http://127.0.0.1:${VM_PORT}"
wait_http "$VM_ENDPOINT/health"
wait_metric_at_least "$BACKUP_FLOOR_VALUE"
RESTORED_VALUE="$(query_value)"

VM_IMAGE_ID="$(docker image inspect victoriametrics/victoria-metrics@sha256:407013e902f9a0ba1d4b2d4c077c47bbaf917c893c52ff39b19efe83a654afda --format '{{.Id}}')"
PROM_IMAGE_ID="$(docker image inspect prom/prometheus@sha256:69f5241418838263316593f7274a304b095c40bcf22e57272865da91bd60a8ac --format '{{.Id}}')"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null
CLEANED=1
CURRENT_STAGE="led-invariant"
assert_led

INITIAL_VALUE="$INITIAL_VALUE" OUTAGE_START_VALUE="$OUTAGE_START_VALUE" \
OUTAGE_END_VALUE="$OUTAGE_END_VALUE" RECOVERED_VALUE="$RECOVERED_VALUE" \
BACKUP_FLOOR_VALUE="$BACKUP_FLOOR_VALUE" RESTORED_VALUE="$RESTORED_VALUE" \
BACKUP_FILE_COUNT="$BACKUP_FILE_COUNT" VM_IMAGE_ID="$VM_IMAGE_ID" \
PROM_IMAGE_ID="$PROM_IMAGE_ID" EVIDENCE_FILE="$EVIDENCE_FILE" \
"$NODE" --input-type=module - <<'NODE'
import { writeFileSync } from 'node:fs';

const evidence = {
  schema_version: '1.0.0',
  status: 'passed_controlled_server',
  server: '64.225.122.227',
  victoria_metrics_version: 'v1.148.0',
  victoria_metrics_image_id: process.env.VM_IMAGE_ID,
  prometheus_version: 'v3.12.0',
  prometheus_image_id: process.env.PROM_IMAGE_ID,
  initial_remote_write_value: Number(process.env.INITIAL_VALUE),
  outage_source_start_value: Number(process.env.OUTAGE_START_VALUE),
  outage_source_end_value: Number(process.env.OUTAGE_END_VALUE),
  wal_recovered_value: Number(process.env.RECOVERED_VALUE),
  backup_floor_value: Number(process.env.BACKUP_FLOOR_VALUE),
  backup_file_count: Number(process.env.BACKUP_FILE_COUNT),
  restored_value: Number(process.env.RESTORED_VALUE),
  communication_hot_path_dependency: false,
  led_container_invariant: 'passed',
  production_object_store: 'not_run',
  target_kubernetes: 'not_run',
  dual_zone: 'not_run',
  capacity_and_soak: 'not_run'
};
writeFileSync(process.env.EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
NODE
