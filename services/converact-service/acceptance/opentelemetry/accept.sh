#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SERVER_IP="64.225.122.227"
if [[ "${CONVERACT_FABRIC_VALIDATION_SERVER_IP:-}" != "$EXPECTED_SERVER_IP" ]]; then
  echo "CONVERACT_FABRIC_VALIDATION_SERVER_IP must identify the controlled validation server" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PACKAGE_DIR="$ROOT/services/converact-service/acceptance/opentelemetry"
PROJECT="converact_otel_accept_${$}_${RANDOM}"
RUNTIME_DIR="/tmp/$PROJECT"
EVIDENCE_FILE="${CONVERACT_FABRIC_OTEL_EVIDENCE_FILE:-$ROOT/docs/evidence/wave2-opentelemetry-runtime-2026-07-22.json}"
NODE="${CONVERACT_FABRIC_NODE_BIN:-/opt/converact-wave123-validation-20260722/cache/toolchain/bin/node}"
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
STRICT_ONE=""
FAIL_OPEN=""
STRICT_TWO=""

mkdir -p "$RUNTIME_DIR" "$(dirname "$EVIDENCE_FILE")"
export OTEL_ACCEPT_EVIDENCE_DIR="$RUNTIME_DIR"

cleanup() {
  local status=$?
  if [[ "$status" != "0" && "$CLEANED" != "1" ]]; then
    echo "OpenTelemetry acceptance failed during stage: $CURRENT_STAGE" >&2
    [[ -n "$STRICT_ONE" ]] && printf 'strict_one=%s\n' "$STRICT_ONE" >&2
    [[ -n "$FAIL_OPEN" ]] && printf 'fail_open=%s\n' "$FAIL_OPEN" >&2
    [[ -n "$STRICT_TWO" ]] && printf 'strict_two=%s\n' "$STRICT_TWO" >&2
    echo "Container state follows" >&2
    "${COMPOSE[@]}" ps >&2 || true
    "${COMPOSE[@]}" logs --no-color --tail 100 >&2 || true
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

wait_for_port() {
  local endpoint="$1"
  for _ in $(seq 1 30); do
    if curl --silent --show-error --max-time 1 "$endpoint" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_port_closed() {
  local endpoint="$1"
  for _ in $(seq 1 30); do
    if ! curl --silent --show-error --max-time 1 "$endpoint" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_count() {
  local expected="$1"
  for _ in $(seq 1 30); do
    if [[ -f "$RUNTIME_DIR/count" ]] && (( $(<"$RUNTIME_DIR/count") >= expected )); then
      return 0
    fi
    sleep 1
  done
  return 1
}

assert_led
CURRENT_STAGE="compose-up"
"${COMPOSE[@]}" up -d --wait
PORT_LINE="$("${COMPOSE[@]}" port collector 4318)"
PORT="${PORT_LINE##*:}"
ENDPOINT="http://127.0.0.1:${PORT}/v1/traces"
wait_for_port "http://127.0.0.1:${PORT}/"

CURRENT_STAGE="initial-probe"
STRICT_ONE="$($NODE --import tsx "$PACKAGE_DIR/probe.ts" --endpoint "$ENDPOINT" --mode strict)"
CURRENT_STAGE="initial-delivery"
wait_for_count 1

CURRENT_STAGE="collector-stop"
"${COMPOSE[@]}" stop collector >/dev/null
wait_for_port_closed "http://127.0.0.1:${PORT}/"
CURRENT_STAGE="outage-probe"
FAIL_OPEN="$($NODE --import tsx "$PACKAGE_DIR/probe.ts" --endpoint "$ENDPOINT" --mode fail-open)"

CURRENT_STAGE="collector-restart"
"${COMPOSE[@]}" start collector >/dev/null
PORT_LINE="$("${COMPOSE[@]}" port collector 4318)"
PORT="${PORT_LINE##*:}"
ENDPOINT="http://127.0.0.1:${PORT}/v1/traces"
wait_for_port "http://127.0.0.1:${PORT}/"
CURRENT_STAGE="recovered-probe"
STRICT_TWO="$($NODE --import tsx "$PACKAGE_DIR/probe.ts" --endpoint "$ENDPOINT" --mode strict)"
CURRENT_STAGE="recovered-delivery"
wait_for_count 2
DELIVERIES="$(<"$RUNTIME_DIR/count")"

COLLECTOR_IMAGE="$(docker image inspect otel/opentelemetry-collector-contrib@sha256:93aad750175cbf1a973ae1c5886c3371f4d800f61be25cdd26870b8441ffe9fa --format '{{.Id}}')"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null
CLEANED=1
CURRENT_STAGE="led-invariant"
assert_led

STRICT_ONE="$STRICT_ONE" FAIL_OPEN="$FAIL_OPEN" STRICT_TWO="$STRICT_TWO" \
DELIVERIES="$DELIVERIES" COLLECTOR_IMAGE="$COLLECTOR_IMAGE" EVIDENCE_FILE="$EVIDENCE_FILE" \
"$NODE" --input-type=module - <<'NODE'
import { writeFileSync } from 'node:fs';

const evidence = {
  schema_version: '1.0.0',
  status: 'passed_controlled_server',
  server: '64.225.122.227',
  collector_version: '0.153.0',
  collector_image_id: process.env.COLLECTOR_IMAGE,
  initial_delivery: JSON.parse(process.env.STRICT_ONE),
  collector_outage: JSON.parse(process.env.FAIL_OPEN),
  recovered_delivery: JSON.parse(process.env.STRICT_TWO),
  backend_delivery_count: Number(process.env.DELIVERIES),
  communication_hot_path_dependency: false,
  led_container_invariant: 'passed',
  target_kubernetes: 'not_run',
  dual_zone: 'not_run',
  capacity_and_soak: 'not_run'
};
writeFileSync(process.env.EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
NODE
