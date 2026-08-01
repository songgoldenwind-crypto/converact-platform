#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
source "$ROOT/scripts/lib/converact-validation-server.sh"
EXPECTED_SERVER_IP="$CONVERACT_VALIDATION_SERVER_IP"
if [[ "${CONVERACT_FABRIC_VALIDATION_SERVER_IP:-}" != "$EXPECTED_SERVER_IP" ]]; then
  echo "CONVERACT_FABRIC_VALIDATION_SERVER_IP must identify the controlled validation server" >&2
  exit 2
fi

PACKAGE_DIR="$ROOT/services/converact-service/acceptance/opentelemetry"
PROJECT="converact_otel_accept_${$}_${RANDOM}"
RUNTIME_DIR="/tmp/$PROJECT"
EVIDENCE_FILE="${CONVERACT_FABRIC_OTEL_EVIDENCE_FILE:-$ROOT/docs/evidence/wave2-opentelemetry-runtime-$(date -u +%Y%m%dT%H%M%SZ).json}"
NODE="${CONVERACT_FABRIC_NODE_BIN:-node}"
if docker compose version >/dev/null 2>&1; then
  COMPOSE_COMMAND=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE_COMMAND=(docker-compose)
else
  echo "docker compose or docker-compose is required" >&2
  exit 2
fi
COMPOSE=("${COMPOSE_COMMAND[@]}" -p "$PROJECT" -f "$PACKAGE_DIR/docker-compose.yml")
mapfile -t BASELINE_CONTAINERS < <(docker ps --format '{{.Names}}' | sort)
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

assert_container_baseline() {
  local -a actual=()
  mapfile -t actual < <(docker ps --format '{{.Names}}' | sort)
  if [[ "${actual[*]}" != "${BASELINE_CONTAINERS[*]}" ]]; then
    echo "running-container baseline changed" >&2
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

assert_container_baseline
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
CURRENT_STAGE="container-baseline"
assert_container_baseline

STRICT_ONE="$STRICT_ONE" FAIL_OPEN="$FAIL_OPEN" STRICT_TWO="$STRICT_TWO" \
DELIVERIES="$DELIVERIES" COLLECTOR_IMAGE="$COLLECTOR_IMAGE" EVIDENCE_FILE="$EVIDENCE_FILE" \
VALIDATION_SERVER_IP="$EXPECTED_SERVER_IP" BASELINE_CONTAINER_COUNT="${#BASELINE_CONTAINERS[@]}" \
"$NODE" --input-type=module - <<'NODE'
import { writeFileSync } from 'node:fs';

const evidence = {
  schema_version: '1.0.0',
  status: 'passed_controlled_server',
  server: process.env.VALIDATION_SERVER_IP,
  collector_version: '0.153.0',
  collector_image_id: process.env.COLLECTOR_IMAGE,
  initial_delivery: JSON.parse(process.env.STRICT_ONE),
  collector_outage: JSON.parse(process.env.FAIL_OPEN),
  recovered_delivery: JSON.parse(process.env.STRICT_TWO),
  backend_delivery_count: Number(process.env.DELIVERIES),
  communication_hot_path_dependency: false,
  preexisting_running_containers: Number(process.env.BASELINE_CONTAINER_COUNT),
  container_baseline_invariant: 'passed',
  target_kubernetes: 'not_run',
  dual_zone: 'not_run',
  capacity_and_soak: 'not_run'
};
writeFileSync(process.env.EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
NODE
