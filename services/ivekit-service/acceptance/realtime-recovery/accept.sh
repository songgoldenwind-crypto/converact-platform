#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
ACCEPTANCE_DIR="$ROOT_DIR/services/ivekit-service/acceptance/realtime-recovery"
COMPOSE_FILE="$ACCEPTANCE_DIR/docker-compose.yml"
PROBE="$ACCEPTANCE_DIR/probe.ts"
GATEWAY_CHILD="$ACCEPTANCE_DIR/gateway-child.ts"
TRANSPORT_SOURCE="$ROOT_DIR/services/ai-agent-py/livekit_audio_tap_transport.py"
NODE_BIN=${NODE_BIN:-node}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20}
AI_AGENT_IMAGE=${AI_AGENT_IMAGE:-opc-validation/ai-agent:provider-fallback@sha256:0f83a1c0814365dddff5d3d917751a9f6928e8a06c359f39d50b122664c8a74b}
PYTHON_TEST_DEPS=${PYTHON_TEST_DEPS:-/opt/opc-wave123-validation-20260722/cache/python-test-deps}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT:-}
GATEWAY_PORT=${GATEWAY_PORT:-0}
AUTHORIZATION_PORT=${AUTHORIZATION_PORT:-0}
MAX_PORT_BIND_ATTEMPTS=3
PROJECT="ivekit-realtime-recovery-$(date -u +%Y%m%d%H%M%S)-$$"
RUN_ID="$PROJECT"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ivekit-realtime-recovery.XXXXXX")
HOST_STATE_DIR="$WORK_DIR/host-state"
TRANSPORT_STATE_DIR="$WORK_DIR/transport-state"
GATEWAY_SHARED_DIR="$WORK_DIR/gateway-shared"
CONTROL_DIR="$WORK_DIR/control"
LOG_DIR="$WORK_DIR/logs"
POSTGRES_READY_MARKER="$HOST_STATE_DIR/postgres-probe-ready"
POSTGRES_OUTAGE_MARKER="$HOST_STATE_DIR/postgres-outage"
POSTGRES_RETRY_MARKER="$HOST_STATE_DIR/postgres-retry-observed"
POSTGRES_RESULT="$HOST_STATE_DIR/postgres-result.json"
GATEWAY_OUTAGE_MARKER="$CONTROL_DIR/gateway-outage"
GATEWAY_RETRY_MARKER="$TRANSPORT_STATE_DIR/gateway-retry-observed"
GATEWAY_RESULT="$TRANSPORT_STATE_DIR/gateway-result.json"
GATEWAY_EVENTS_FILE="$GATEWAY_SHARED_DIR/gateway-events.jsonl"
GATEWAY_READY_FILE="$LOG_DIR/gateway-ready.json"
ENVIRONMENT_RESULT="$HOST_STATE_DIR/environment-result.json"
LED_BEFORE="$LOG_DIR/led-before.tsv"
LED_AFTER="$LOG_DIR/led-after.tsv"
VALIDATION_RESOURCES_REPORT="$LOG_DIR/validation-resources.txt"
NETWORK_POLICY_RESULT="$HOST_STATE_DIR/transport-network-policy.txt"
EVIDENCE_FILE=${REALTIME_RECOVERY_EVIDENCE_FILE:-"$ROOT_DIR/.runtime/realtime-recovery-evidence.json"}
TRANSPORT_CONTAINER="${PROJECT}-transport"
VALIDATION_NETWORK="${PROJECT}-transport-network"
POSTGRES_PASSWORD=
GATEWAY_SECRET_B64=
DATABASE_URL=
POSTGRES_PUBLISHED_PORT=
TRANSPORT_SOURCE_SHA256=
GATEWAY_BIND_HOST=
GATEWAY_PID=
POSTGRES_PROBE_PID=
TRANSPORT_PID=
AUTO_POSTGRES_HOST_PORT=0
COMPOSE_ACTIVE=0
VALIDATION_NETWORK_ACTIVE=0

compose() {
  timeout -k 5 45 docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

docker_bounded() {
  timeout -k 5 20 docker "$@"
}

node_bounded() {
  timeout -k 2 40 "$NODE_BIN" "$@"
}

reserve_loopback_port() {
  node_bounded -e \
    "const net = require('node:net'); const server = net.createServer(); server.on('error', () => process.exit(1)); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { const address = server.address(); if (!address || typeof address === 'string') process.exit(1); server.close((error) => { if (error) process.exit(1); process.stdout.write(String(address.port)); }); });"
}

configure_postgres_host_port() {
  if [ "$AUTO_POSTGRES_HOST_PORT" -eq 1 ]; then
    POSTGRES_HOST_PORT=$(reserve_loopback_port)
  fi
  case "$POSTGRES_HOST_PORT" in
    ''|*[!0-9]*) printf '%s\n' 'POSTGRES_HOST_PORT must be a valid TCP port' >&2; return 1 ;;
  esac
  if [ "$POSTGRES_HOST_PORT" -lt 1 ] || [ "$POSTGRES_HOST_PORT" -gt 65535 ]; then
    printf '%s\n' 'POSTGRES_HOST_PORT must be a valid TCP port' >&2
    return 1
  fi
  export COMPOSE_PROJECT_NAME="$PROJECT" POSTGRES_IMAGE POSTGRES_HOST_PORT POSTGRES_PASSWORD
}

start_isolated_postgres() {
  port_attempt=1
  while [ "$port_attempt" -le "$MAX_PORT_BIND_ATTEMPTS" ]; do
    configure_postgres_host_port
    compose config >/dev/null
    COMPOSE_ACTIVE=1
    if compose up --detach postgres >/dev/null; then
      return 0
    fi
    if ! compose down --volumes --remove-orphans >/dev/null 2>&1; then
      return 1
    fi
    COMPOSE_ACTIVE=0
    if [ "$AUTO_POSTGRES_HOST_PORT" -ne 1 ]; then
      return 1
    fi
    port_attempt=$((port_attempt + 1))
  done
  printf '%s\n' 'PostgreSQL loopback port could not be bound after bounded retries' >&2
  return 1
}

wait_pid_bounded() {
  pid=$1
  seconds=$2
  label=$3
  status=0
  if timeout -k 1 "$seconds" tail --pid="$pid" -f /dev/null; then
    wait "$pid" || status=$?
    return "$status"
  fi
  printf 'process timeout, sending TERM: %s\n' "$label" >&2
  kill -TERM "$pid" >/dev/null 2>&1 || true
  if ! timeout -k 1 2 tail --pid="$pid" -f /dev/null; then
    printf 'process timeout, sending KILL: %s\n' "$label" >&2
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" || status=$?
  return "$status"
}

kill_gateway() {
  if [ -n "${GATEWAY_PID:-}" ] && kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
    kill -TERM "$GATEWAY_PID" >/dev/null 2>&1 || true
    wait_pid_bounded "$GATEWAY_PID" 5 gateway-shutdown >/dev/null 2>&1 || true
  fi
  GATEWAY_PID=
}

cleanup() {
  kill_gateway
  if [ -n "${POSTGRES_PROBE_PID:-}" ]; then
    kill -TERM "$POSTGRES_PROBE_PID" >/dev/null 2>&1 || true
    wait_pid_bounded "$POSTGRES_PROBE_PID" 3 postgres-probe-cleanup >/dev/null 2>&1 || true
  fi
  if [ -n "${TRANSPORT_PID:-}" ]; then
    docker_bounded rm --force "$TRANSPORT_CONTAINER" >/dev/null 2>&1 || true
    wait_pid_bounded "$TRANSPORT_PID" 5 transport-cleanup >/dev/null 2>&1 || true
  fi
  if [ "$VALIDATION_NETWORK_ACTIVE" -eq 1 ]; then
    docker_bounded network rm "$VALIDATION_NETWORK" >/dev/null 2>&1 || true
  fi
  if [ "$COMPOSE_ACTIVE" -eq 1 ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

wait_file_or_process() {
  path=$1
  pid=$2
  log=$3
  limit=${4:-300}
  attempt=0
  while [ ! -f "$path" ]; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait_pid_bounded "$pid" 1 "$(basename "$path")" >/dev/null 2>&1 || true
      sed -n '1,160p' "$log" >&2 || true
      printf 'process exited before marker: %s\n' "$(basename "$path")" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$limit" ]; then
      sed -n '1,160p' "$log" >&2 || true
      printf 'timed out waiting for marker: %s\n' "$(basename "$path")" >&2
      return 1
    fi
    sleep 0.1
  done
}

wait_postgres() {
  attempt=0
  while ! compose exec --no-TTY postgres pg_isready -U opc -d opc >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      compose logs --no-color --tail 80 postgres >&2
      return 1
    fi
    sleep 0.5
  done
  wait_postgres_host
}

wait_postgres_host() {
  attempt=0
  while ! (
    cd "$ROOT_DIR"
    DATABASE_URL="$DATABASE_URL" timeout -k 1 2 "$NODE_BIN" --input-type=module -e \
      "import { Pool } from 'pg'; const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 500 }); pool.on('error', () => undefined); try { await pool.query('SELECT 1'); await pool.end(); } catch { await pool.end().catch(() => undefined); process.exit(1); }" \
      >/dev/null 2>&1
  ); do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      compose logs --no-color --tail 80 postgres >&2
      printf '%s\n' 'PostgreSQL published endpoint did not become ready' >&2
      return 1
    fi
    sleep 0.25
  done
}

capture_postgres_published_port() {
  current_postgres_port=$(compose port postgres 5432 | tail -n 1 | awk -F: '{print $NF}')
  case "$current_postgres_port" in
    ''|*[!0-9]*) printf '%s\n' 'PostgreSQL published port is invalid' >&2; return 1 ;;
  esac
  if [ -n "$POSTGRES_PUBLISHED_PORT" ] &&
     [ "$current_postgres_port" != "$POSTGRES_PUBLISHED_PORT" ]; then
    printf '%s\n' 'PostgreSQL published port changed across restart' >&2
    return 1
  fi
  POSTGRES_PUBLISHED_PORT=$current_postgres_port
}

capture_validation_network_gateway() {
  network_internal=$(docker_bounded network inspect \
    --format '{{.Internal}}' "$VALIDATION_NETWORK")
  if [ "$network_internal" != 'true' ]; then
    printf '%s\n' 'validation transport network is not internal' >&2
    return 1
  fi
  GATEWAY_BIND_HOST=$(docker_bounded network inspect \
    --format '{{(index .IPAM.Config 0).Gateway}}' "$VALIDATION_NETWORK")
  case "$GATEWAY_BIND_HOST" in
    ''|*[!0-9.]*) printf '%s\n' 'validation network gateway is invalid' >&2; return 1 ;;
  esac
  printf '%s\n' 'internal' >"$NETWORK_POLICY_RESULT"
  chmod 0600 "$NETWORK_POLICY_RESULT"
}

wait_gateway() {
  attempt=0
  while ! timeout -k 1 2 "$NODE_BIN" -e \
    "fetch(process.argv[1], { signal: AbortSignal.timeout(750) }).then(async response => { const value = await response.json(); process.exit(response.ok && value.run_id === process.argv[2] && Number(value.pid) === Number(process.argv[3]) ? 0 : 1); }).catch(() => process.exit(1))" \
    "http://${GATEWAY_BIND_HOST}:${AUTHORIZATION_PORT}/ready" "$RUN_ID" "$GATEWAY_PID" \
    >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 40 ]; then
      sed -n '1,160p' "$LOG_DIR/gateway.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
}

start_gateway() {
  rm -f "$GATEWAY_READY_FILE"
  GATEWAY_PORT="$GATEWAY_PORT" \
  AUTHORIZATION_PORT="$AUTHORIZATION_PORT" \
  GATEWAY_EVENTS_FILE="$GATEWAY_EVENTS_FILE" \
  GATEWAY_READY_FILE="$GATEWAY_READY_FILE" \
  GATEWAY_SECRET_B64="$GATEWAY_SECRET_B64" \
  GATEWAY_HOST="$GATEWAY_BIND_HOST" \
  RUN_ID="$RUN_ID" \
    "$NODE_BIN" --import tsx "$GATEWAY_CHILD" \
    >>"$LOG_DIR/gateway.log" 2>&1 &
  GATEWAY_PID=$!
  wait_file_or_process \
    "$GATEWAY_READY_FILE" "$GATEWAY_PID" "$LOG_DIR/gateway.log" 100
  ports=$(node_bounded -e \
    "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (value.run_id !== process.argv[2] || Number(value.pid) !== Number(process.argv[3]) || !Number.isInteger(value.gateway_port) || value.gateway_port < 1 || value.gateway_port > 65535 || !Number.isInteger(value.authorization_port) || value.authorization_port < 1 || value.authorization_port > 65535) process.exit(1); process.stdout.write(value.gateway_port + ' ' + value.authorization_port);" \
    "$GATEWAY_READY_FILE" "$RUN_ID" "$GATEWAY_PID")
  GATEWAY_PORT=${ports%% *}
  AUTHORIZATION_PORT=${ports#* }
  wait_gateway
}

snapshot_led() {
  output=$1
  temporary="${output}.tmp"
  raw_names="${output}.names"
  sorted_names="${output}.names.sorted"
  : >"$temporary"
  if ! docker_bounded ps --format '{{.Names}}' --filter name=led-platform- >"$raw_names"; then
    printf '%s\n' 'failed to enumerate LED containers' >&2
    return 1
  fi
  sort "$raw_names" >"$sorted_names"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! details=$(docker_bounded inspect --format \
      '{{.Id}}	{{.State.StartedAt}}	{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$name"); then
      printf 'failed to inspect LED container: %s\n' "$name" >&2
      return 1
    fi
    status=${details##*	}
    case "$status" in
      healthy|running) normalized=$status ;;
      *) normalized=unhealthy ;;
    esac
    prefix=${details%	*}
    printf '%s\t%s\t%s\n' "$name" "$prefix" "$normalized" >>"$temporary"
  done <"$sorted_names"
  rm -f "$raw_names" "$sorted_names"
  if [ ! -s "$temporary" ]; then
    printf '%s\n' 'LED container baseline is empty' >&2
    return 1
  fi
  mv "$temporary" "$output"
}

verify_validation_resources_removed() {
  container_names="${VALIDATION_RESOURCES_REPORT}.containers"
  network_names="${VALIDATION_RESOURCES_REPORT}.networks"
  volume_names="${VALIDATION_RESOURCES_REPORT}.volumes"
  : >"$VALIDATION_RESOURCES_REPORT"
  if ! docker_bounded ps --all --format '{{.Names}}' >"$container_names"; then
    printf '%s\n' 'failed to enumerate validation containers' >&2
    return 1
  fi
  if ! docker_bounded network ls --format '{{.Name}}' >"$network_names"; then
    printf '%s\n' 'failed to enumerate validation networks' >&2
    return 1
  fi
  if ! docker_bounded volume ls --format '{{.Name}}' >"$volume_names"; then
    printf '%s\n' 'failed to enumerate validation volumes' >&2
    return 1
  fi
  awk -v prefix="${PROJECT}-" \
    'index($0, prefix) == 1 { print "container\t" $0 }' \
    "$container_names" >>"$VALIDATION_RESOURCES_REPORT"
  awk -v prefix="${PROJECT}-" \
    'index($0, prefix) == 1 { print "network\t" $0 }' \
    "$network_names" >>"$VALIDATION_RESOURCES_REPORT"
  awk -v prefix="${PROJECT}-" \
    'index($0, prefix) == 1 { print "volume\t" $0 }' \
    "$volume_names" >>"$VALIDATION_RESOURCES_REPORT"
  rm -f "$container_names" "$network_names" "$volume_names"
  if [ -s "$VALIDATION_RESOURCES_REPORT" ]; then
    printf '%s\n' 'realtime recovery validation resources were not cleaned up' >&2
    return 1
  fi
}

case "$POSTGRES_IMAGE" in
  *@sha256:[a-f0-9][a-f0-9]*) ;;
  *) printf '%s\n' 'POSTGRES_IMAGE must be pinned by sha256 digest' >&2; exit 1 ;;
esac
case "$AI_AGENT_IMAGE" in
  *@sha256:[a-f0-9][a-f0-9]*) ;;
  *) printf '%s\n' 'AI_AGENT_IMAGE must be pinned by sha256 digest' >&2; exit 1 ;;
esac
for command in docker od timeout tail sha256sum chown sort awk "$NODE_BIN"; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'required command is unavailable: %s\n' "$command" >&2
    exit 1
  fi
done
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'realtime recovery acceptance requires root for fixed non-root bind-mount ownership' >&2
  exit 1
fi
if [ ! -d "$PYTHON_TEST_DEPS" ]; then
  printf '%s\n' 'PYTHON_TEST_DEPS is unavailable' >&2
  exit 1
fi
case "$POSTGRES_HOST_PORT" in
  ''|0) AUTO_POSTGRES_HOST_PORT=1 ;;
  *[!0-9]*) printf '%s\n' 'POSTGRES_HOST_PORT must be a valid TCP port' >&2; exit 1 ;;
esac
if [ "$AUTO_POSTGRES_HOST_PORT" -eq 0 ] &&
   { [ "$POSTGRES_HOST_PORT" -lt 1 ] || [ "$POSTGRES_HOST_PORT" -gt 65535 ]; }; then
  printf '%s\n' 'POSTGRES_HOST_PORT must be a valid TCP port' >&2
  exit 1
fi
POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
GATEWAY_SECRET_B64=$(node_bounded -e \
  "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")

chmod 0711 "$WORK_DIR"
mkdir -m 0700 "$HOST_STATE_DIR" "$TRANSPORT_STATE_DIR" "$GATEWAY_SHARED_DIR" "$LOG_DIR"
mkdir -m 0755 "$CONTROL_DIR"
chown 10001:10001 "$TRANSPORT_STATE_DIR" "$GATEWAY_SHARED_DIR"
: >"$GATEWAY_EVENTS_FILE"
chown 10001:10001 "$GATEWAY_EVENTS_FILE"
chmod 0600 "$GATEWAY_EVENTS_FILE"
TRANSPORT_SOURCE_SHA256=$(sha256sum "$TRANSPORT_SOURCE" | awk '{print $1}')
mkdir -p "$(dirname "$EVIDENCE_FILE")"
snapshot_led "$LED_BEFORE"

printf '%s\n' 'Realtime recovery phase: starting isolated PostgreSQL'
start_isolated_postgres
capture_postgres_published_port
docker_bounded network create --internal "$VALIDATION_NETWORK" >/dev/null
VALIDATION_NETWORK_ACTIVE=1
capture_validation_network_gateway
DATABASE_URL="postgresql://opc:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PUBLISHED_PORT}/opc?sslmode=disable"
wait_postgres
if [ "${REALTIME_RECOVERY_INJECT_FAILURE_AFTER_POSTGRES_START:-0}" = '1' ]; then
  printf '%s\n' 'injected failure after PostgreSQL start' >&2
  exit 97
fi
DATABASE_URL="$DATABASE_URL" node_bounded --import tsx "$PROBE" prepare >/dev/null

printf '%s\n' 'Realtime recovery phase: interrupting established PostgreSQL connection'
DATABASE_URL="$DATABASE_URL" "$NODE_BIN" --import tsx "$PROBE" postgres-recovery \
  "$POSTGRES_READY_MARKER" "$POSTGRES_OUTAGE_MARKER" \
  "$POSTGRES_RETRY_MARKER" "$POSTGRES_RESULT" \
  >"$LOG_DIR/postgres-probe.log" 2>&1 &
POSTGRES_PROBE_PID=$!
wait_file_or_process \
  "$POSTGRES_READY_MARKER" "$POSTGRES_PROBE_PID" "$LOG_DIR/postgres-probe.log"
compose stop postgres >/dev/null
mkdir "$POSTGRES_OUTAGE_MARKER"
wait_file_or_process \
  "$POSTGRES_RETRY_MARKER" "$POSTGRES_PROBE_PID" "$LOG_DIR/postgres-probe.log"
compose start postgres >/dev/null
capture_postgres_published_port
wait_postgres
wait_pid_bounded "$POSTGRES_PROBE_PID" 40 postgres-probe
POSTGRES_PROBE_PID=

printf '%s\n' 'Realtime recovery phase: restarting actual LiveKit gateway process'
start_gateway
docker run --rm \
  --name "$TRANSPORT_CONTAINER" \
  --network "$VALIDATION_NETWORK" \
  --workdir /workspace \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --user 10001:10001 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  -e PYTHONPATH=/workspace:/test-deps \
  -e EXPECTED_TRANSPORT_SHA256="$TRANSPORT_SOURCE_SHA256" \
  -e AUTHORIZATION_URL="http://${GATEWAY_BIND_HOST}:${AUTHORIZATION_PORT}/authorize" \
  -e STATE_DIR=/state \
  -e EVENTS_FILE=/gateway-evidence/gateway-events.jsonl \
  -e OUTAGE_MARKER=/control/gateway-outage \
  -v "$PYTHON_TEST_DEPS:/test-deps:ro" \
  -v "$ROOT_DIR/services/ai-agent-py:/workspace:ro" \
  -v "$ACCEPTANCE_DIR:/acceptance:ro" \
  -v "$TRANSPORT_STATE_DIR:/state:rw" \
  -v "$GATEWAY_SHARED_DIR:/gateway-evidence:ro" \
  -v "$CONTROL_DIR:/control:ro" \
  "$AI_AGENT_IMAGE" \
  python /acceptance/transport_probe.py \
  >"$LOG_DIR/transport.log" 2>&1 &
TRANSPORT_PID=$!
wait_file_or_process \
  "$TRANSPORT_STATE_DIR/gateway-transport-ready" "$TRANSPORT_PID" "$LOG_DIR/transport.log"
kill_gateway
mkdir "$GATEWAY_OUTAGE_MARKER"
wait_file_or_process \
  "$GATEWAY_RETRY_MARKER" "$TRANSPORT_PID" "$LOG_DIR/transport.log"
start_gateway
wait_pid_bounded "$TRANSPORT_PID" 40 transport-probe
TRANSPORT_PID=
kill_gateway

docker_bounded network rm "$VALIDATION_NETWORK" >/dev/null
VALIDATION_NETWORK_ACTIVE=0
compose down --volumes --remove-orphans >/dev/null
COMPOSE_ACTIVE=0
verify_validation_resources_removed
snapshot_led "$LED_AFTER"
node_bounded --import tsx "$PROBE" environment \
  "$LED_BEFORE" "$LED_AFTER" "$VALIDATION_RESOURCES_REPORT" \
  "$NETWORK_POLICY_RESULT" "$ENVIRONMENT_RESULT"
node_bounded --import tsx "$PROBE" finalize \
  "$POSTGRES_RESULT" "$GATEWAY_RESULT" "$ENVIRONMENT_RESULT" "$EVIDENCE_FILE" \
  >"$LOG_DIR/final-report.json"

printf 'verification_scope=controlled_server_process_recovery evidence=%s\n' "$EVIDENCE_FILE"
