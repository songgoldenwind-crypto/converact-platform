#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
. "$ROOT_DIR/scripts/lib/converact-validation-server.sh"
COMPOSE_FILE="$ROOT_DIR/services/converact-service/acceptance/valkey-sentinel/docker-compose.yml"
EXPECTED_SERVER_IP="$CONVERACT_VALIDATION_SERVER_IP"
VALKEY_ACCEPTANCE_IMAGE=${VALKEY_ACCEPTANCE_IMAGE:-valkey/valkey@sha256:1da6597cc08f09748b05f7a845492581c9442ea240be8e7bbfeb5f83ad1bcec8}
VALKEY_ACCEPTANCE_NODE_IMAGE=${VALKEY_ACCEPTANCE_NODE_IMAGE:-node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d}
PROJECT=${VALKEY_ACCEPTANCE_PROJECT:-converact-valkey-sentinel-$(date +%s)-$$}
VALKEY_ACCEPTANCE_RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/converact-valkey-sentinel.XXXXXX")
EVIDENCE_FILE=${VALKEY_ACCEPTANCE_EVIDENCE_FILE:-$ROOT_DIR/docs/evidence/wave2-valkey-sentinel-runtime-$(date -u +%Y%m%dT%H%M%SZ).json}
NETWORK_NAME="${PROJECT}_valkey_acceptance"
CLEANED=0

if [ "${CONVERACT_FABRIC_VALIDATION_SERVER_IP:-}" != "$EXPECTED_SERVER_IP" ]; then
  printf 'Valkey failover acceptance is restricted to validation server %s\n' "$EXPECTED_SERVER_IP" >&2
  exit 1
fi
case "$PROJECT" in
  converact-valkey-sentinel-[A-Za-z0-9-]*) ;;
  *)
    printf '%s\n' 'refusing shared or unsafe Compose project name' >&2
    exit 1
    ;;
esac

for command_name in docker timeout od tr awk grep sed wc date sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done
if docker compose version >/dev/null 2>&1; then
  COMPOSE_STYLE=plugin
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE_STYLE=standalone
else
  printf '%s\n' 'docker compose or docker-compose is required' >&2
  exit 1
fi
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]; then
  printf '%s\n' 'refusing shared or unsafe Compose project name' >&2
  exit 1
fi

export VALKEY_ACCEPTANCE_IMAGE VALKEY_ACCEPTANCE_RUNTIME_DIR
umask 077

compose() {
  if [ "$COMPOSE_STYLE" = plugin ]; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

compose_timeout() {
  duration=$1
  shift
  if [ "$COMPOSE_STYLE" = plugin ]; then
    timeout "$duration" docker compose "$@"
  else
    timeout "$duration" docker-compose "$@"
  fi
}

cleanup() {
  if [ "$CLEANED" -eq 1 ]; then return; fi
  compose_timeout 20 -p "$PROJECT" -f "$COMPOSE_FILE" unpause >/dev/null 2>&1 || true
  compose_timeout 60 -p "$PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$VALKEY_ACCEPTANCE_RUNTIME_DIR"
  CLEANED=1
}

failure_diagnostics() {
  printf '%s\n' '--- redacted Valkey acceptance diagnostics ---' >&2
  compose_timeout 20 -p "$PROJECT" -f "$COMPOSE_FILE" ps -a >&2 || true
  compose_timeout 20 -p "$PROJECT" -f "$COMPOSE_FILE" logs --no-color --tail 100 2>&1 \
    | sed -E 's/[[:xdigit:]]{48}/[REDACTED]/g' >&2 || true
}

on_exit() {
  status=$?
  trap '' EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then failure_diagnostics; fi
  cleanup
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

random_secret() {
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

APP_PASSWORD=$(random_secret)
REPLICATION_PASSWORD=$(random_secret)
SENTINEL_CONTROL_PASSWORD=$(random_secret)
SENTINEL_CLIENT_PASSWORD=$(random_secret)
SENTINEL_PEER_PASSWORD=$(random_secret)

cat >"$VALKEY_ACCEPTANCE_RUNTIME_DIR/data-users.acl" <<EOF
user default off
user app on >$APP_PASSWORD ~converact:acceptance:* &converact:acceptance:* +@all
user replication on >$REPLICATION_PASSWORD ~* &* +@all
user sentinel-control on >$SENTINEL_CONTROL_PASSWORD ~* &* +@all
EOF

cat >"$VALKEY_ACCEPTANCE_RUNTIME_DIR/sentinel-users.acl" <<EOF
user default off
user sentinel-client on >$SENTINEL_CLIENT_PASSWORD ~* &* +@all
user sentinel-peer on >$SENTINEL_PEER_PASSWORD ~* &* +@all
EOF

write_data_config() {
  node=$1
  primary=${2:-}
  cat >"$VALKEY_ACCEPTANCE_RUNTIME_DIR/$node.conf" <<EOF
port 6379
bind 0.0.0.0
protected-mode no
dir /data
appendonly yes
appendfsync everysec
save ""
aclfile /etc/valkey/users.acl
masteruser replication
masterauth $REPLICATION_PASSWORD
replica-read-only yes
EOF
  if [ -n "$primary" ]; then
    printf 'replicaof %s 6379\n' "$primary" >>"$VALKEY_ACCEPTANCE_RUNTIME_DIR/$node.conf"
  fi
}

write_sentinel_config() {
  node=$1
  cat >"$VALKEY_ACCEPTANCE_RUNTIME_DIR/$node.conf" <<EOF
port 26379
bind 0.0.0.0
protected-mode no
dir /tmp
aclfile /etc/valkey/sentinel-users.acl
sentinel monitor converact valkey-1 6379 2
sentinel auth-user converact sentinel-control
sentinel auth-pass converact $SENTINEL_CONTROL_PASSWORD
sentinel sentinel-user sentinel-peer
sentinel sentinel-pass $SENTINEL_PEER_PASSWORD
sentinel resolve-hostnames yes
sentinel announce-hostnames yes
sentinel down-after-milliseconds converact 3000
sentinel failover-timeout converact 15000
sentinel parallel-syncs converact 1
EOF
}

write_data_config valkey-1
write_data_config valkey-2 valkey-1
write_data_config valkey-3 valkey-1
write_sentinel_config sentinel-1
write_sentinel_config sentinel-2
write_sentinel_config sentinel-3
chmod 0644 "$VALKEY_ACCEPTANCE_RUNTIME_DIR"/*.conf "$VALKEY_ACCEPTANCE_RUNTIME_DIR"/*.acl

BASELINE_CONTAINERS=''
BASELINE_CONTAINER_COUNT=0

capture_container_baseline() {
  BASELINE_CONTAINERS=$(docker ps --format '{{.Names}}' | sort)
  if [ -n "$BASELINE_CONTAINERS" ]; then
    BASELINE_CONTAINER_COUNT=$(printf '%s\n' "$BASELINE_CONTAINERS" | wc -l | tr -d ' ')
  fi
}

assert_container_baseline() {
  actual_containers=$(docker ps --format '{{.Names}}' | sort)
  if [ "$actual_containers" != "$BASELINE_CONTAINERS" ]; then
    printf '%s\n' 'running-container baseline changed' >&2
    exit 1
  fi
}

data_cli() {
  service=$1
  shift
  compose_timeout 10 -p "$PROJECT" -f "$COMPOSE_FILE" exec -T "$service" \
    valkey-cli --raw --user app --pass "$APP_PASSWORD" --no-auth-warning "$@"
}

sentinel_cli() {
  service=$1
  shift
  compose_timeout 10 -p "$PROJECT" -f "$COMPOSE_FILE" exec -T "$service" \
    valkey-cli --raw -p 26379 --user sentinel-client --pass "$SENTINEL_CLIENT_PASSWORD" --no-auth-warning "$@"
}

wait_for_ping() {
  kind=$1
  service=$2
  deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$kind" = data ]; then
      output=$(data_cli "$service" PING 2>/dev/null || true)
    else
      output=$(sentinel_cli "$service" PING 2>/dev/null || true)
    fi
    if [ "$output" = PONG ]; then return 0; fi
    sleep 1
  done
  printf 'timed out waiting for %s %s\n' "$kind" "$service" >&2
  return 1
}

sentinel_object_count() {
  printf '%s\n' "$1" | tr -d '\r' | awk '$0 == "name" { count++ } END { print count + 0 }'
}

sentinel_healthy_replica_count() {
  printf '%s\n' "$1" | tr -d '\r' \
    | awk 'previous == "master-link-status" && $0 == "ok" { count++ } { previous = $0 } END { print count + 0 }'
}

wait_for_sentinel_topology() {
  deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    ready=0
    for sentinel in sentinel-1 sentinel-2 sentinel-3; do
      replicas=$(sentinel_cli "$sentinel" SENTINEL replicas converact 2>/dev/null || true)
      peers=$(sentinel_cli "$sentinel" SENTINEL sentinels converact 2>/dev/null || true)
      quorum=$(sentinel_cli "$sentinel" SENTINEL ckquorum converact 2>/dev/null || true)
      replica_count=$(sentinel_object_count "$replicas")
      healthy_replica_count=$(sentinel_healthy_replica_count "$replicas")
      peer_count=$(sentinel_object_count "$peers")
      if [ "$replica_count" -ge 2 ] && [ "$healthy_replica_count" -ge 2 ] \
        && [ "$peer_count" -ge 2 ] && printf '%s\n' "$quorum" | grep -q '^OK'; then
        ready=$((ready + 1))
      fi
    done
    if [ "$ready" -eq 3 ]; then return 0; fi
    sleep 1
  done
  printf '%s\n' 'timed out waiting for converged Sentinel topology' >&2
  return 1
}

primary_service() {
  for service in valkey-1 valkey-2 valkey-3; do
    role=$(data_cli "$service" ROLE 2>/dev/null | sed -n '1p' || true)
    if [ "$role" = master ]; then
      printf '%s\n' "$service"
      return 0
    fi
  done
  return 1
}

sentinel_endpoint() {
  service=$1
  output=$(sentinel_cli "$service" SENTINEL get-master-addr-by-name converact)
  host=$(printf '%s\n' "$output" | sed -n '1p')
  port=$(printf '%s\n' "$output" | sed -n '2p')
  [ -n "$host" ] && [ "$port" = 6379 ] || return 1
  printf '%s:%s\n' "$host" "$port"
}

service_ip() {
  container_id=$(compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q "$1")
  docker inspect "$container_id" --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}"
}

sentinel_agreement_count() {
  service=$1
  ip=$2
  count=0
  for sentinel in sentinel-1 sentinel-2 sentinel-3; do
    endpoint=$(sentinel_endpoint "$sentinel" 2>/dev/null || true)
    case "$endpoint" in
      "$service:6379"|"$ip:6379") count=$((count + 1)) ;;
    esac
  done
  printf '%s\n' "$count"
}

wait_for_new_primary() {
  old_primary=$1
  deadline=$(( $(date +%s) + 45 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    candidate=$(primary_service 2>/dev/null || true)
    if [ -n "$candidate" ] && [ "$candidate" != "$old_primary" ]; then
      candidate_ip=$(service_ip "$candidate")
      agreement=$(sentinel_agreement_count "$candidate" "$candidate_ip")
      if [ "$agreement" -ge 2 ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
    sleep 1
  done
  printf '%s\n' 'timed out waiting for a different Sentinel primary' >&2
  return 1
}

wait_for_value_copies() {
  key=$1
  expected=$2
  required_copies=$3
  deadline=$(( $(date +%s) + 20 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    copies=0
    for service in valkey-1 valkey-2 valkey-3; do
      value=$(data_cli "$service" GET "$key" 2>/dev/null || true)
      if [ "$value" = "$expected" ]; then copies=$((copies + 1)); fi
    done
    if [ "$copies" -ge "$required_copies" ]; then return 0; fi
    sleep 1
  done
  printf 'timed out waiting for %s replicated copies\n' "$required_copies" >&2
  return 1
}

role_snapshot() {
  snapshot=''
  for service in valkey-1 valkey-2 valkey-3; do
    info=$(data_cli "$service" INFO replication 2>/dev/null || true)
    role=$(printf '%s\n' "$info" | sed -n 's/^role://p' | tr -d '\r')
    offset=$(printf '%s\n' "$info" | sed -n 's/^master_repl_offset://p' | tr -d '\r')
    if [ -n "$role" ]; then
      entry="$service:$role:${offset:-0}"
      snapshot=${snapshot:+$snapshot,}$entry
    fi
  done
  printf '%s\n' "$snapshot"
}

run_probe() {
  phase=$1
  output_file=$2
  channel="converact:acceptance:pubsub:$phase"
  message="message-$phase-$(date +%s)"
  timeout 30 docker run --rm \
    --network "$NETWORK_NAME" \
    -v "$ROOT_DIR:/workspace:ro" \
    -w /workspace \
    -e REDIS_TOPOLOGY=sentinel \
    -e REDIS_SENTINEL_MASTER_NAME=converact \
    -e REDIS_SENTINEL_ADDRESSES=sentinel-1:26379,sentinel-2:26379,sentinel-3:26379 \
    -e REDIS_USERNAME=app \
    -e REDIS_PASSWORD="$APP_PASSWORD" \
    -e REDIS_SENTINEL_USERNAME=sentinel-client \
    -e REDIS_SENTINEL_PASSWORD="$SENTINEL_CLIENT_PASSWORD" \
    -e REDIS_CONNECT_TIMEOUT_MS=3000 \
    -e REDIS_RECONNECT_WAIT_MS=250 \
    -e REDIS_MAX_RECONNECT_ATTEMPTS=5 \
    -e VALKEY_ACCEPTANCE_PHASE="$phase" \
    -e VALKEY_ACCEPTANCE_CHANNEL="$channel" \
    -e VALKEY_ACCEPTANCE_MESSAGE="$message" \
    -e VALKEY_ACCEPTANCE_PRE_KEY="$PRE_KEY" \
    -e VALKEY_ACCEPTANCE_PRE_VALUE="$PRE_VALUE" \
    -e VALKEY_ACCEPTANCE_POST_KEY="$POST_KEY" \
    -e VALKEY_ACCEPTANCE_POST_VALUE="$POST_VALUE" \
    "$VALKEY_ACCEPTANCE_NODE_IMAGE" \
    node --import tsx services/converact-service/acceptance/valkey-sentinel/probe.ts \
    >"$output_file"
}

now_ms() {
  date +%s%3N
}

capture_container_baseline
assert_container_baseline
timeout 180 docker pull "$VALKEY_ACCEPTANCE_IMAGE" >/dev/null
timeout 180 docker pull "$VALKEY_ACCEPTANCE_NODE_IMAGE" >/dev/null
image_arch=$(docker image inspect "$VALKEY_ACCEPTANCE_IMAGE" --format '{{.Architecture}}')
[ "$image_arch" = amd64 ] || { printf 'unexpected Valkey image architecture: %s\n' "$image_arch" >&2; exit 1; }
version_output=$(timeout 20 docker run --rm "$VALKEY_ACCEPTANCE_IMAGE" valkey-server --version)
printf '%s\n' "$version_output" | grep -q 'v=9\.1\.0'

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_timeout 120 -p "$PROJECT" -f "$COMPOSE_FILE" up -d >/dev/null
for service in valkey-1 valkey-2 valkey-3; do wait_for_ping data "$service"; done
for service in sentinel-1 sentinel-2 sentinel-3; do wait_for_ping sentinel "$service"; done

old_primary=$(primary_service)
before_endpoint=$(sentinel_endpoint sentinel-1)
before_roles=$(role_snapshot)
PRE_KEY="converact:acceptance:pre:$PROJECT"
PRE_VALUE="pre-$(date +%s)-$$"
POST_KEY="converact:acceptance:post:$PROJECT"
POST_VALUE="post-$(date +%s)-$$"
export PRE_KEY PRE_VALUE POST_KEY POST_VALUE

run_probe before "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-before.json"
grep -q '"pre_failover_canary_survived":true' "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-before.json"
grep -q '"pubsub_verified":true' "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-before.json"
wait_for_value_copies "$PRE_KEY" "$PRE_VALUE" 3
wait_for_sentinel_topology

failover_started_ms=$(now_ms)
compose -p "$PROJECT" -f "$COMPOSE_FILE" pause "$old_primary" >/dev/null
new_primary=$(wait_for_new_primary "$old_primary")
primary_elected_ms=$(now_ms)
after_endpoint=$(sentinel_endpoint sentinel-1)
after_roles=$(role_snapshot)

run_probe after "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-after.json"
probe_reconnected_ms=$(now_ms)
grep -q '"pre_failover_canary_survived":true' "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-after.json"
grep -q '"post_failover_write_read":true' "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-after.json"
grep -q '"pubsub_verified":true' "$VALKEY_ACCEPTANCE_RUNTIME_DIR/probe-after.json"
wait_for_value_copies "$POST_KEY" "$POST_VALUE" 2

failover_ms=$((primary_elected_ms - failover_started_ms))
reconnect_ms=$((probe_reconnected_ms - failover_started_ms))
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_commit=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf unknown)
acceptance_source_sha256=$(
  cd "$ROOT_DIR"
  sha256sum \
    services/converact-service/acceptance/valkey-sentinel/accept.sh \
    services/converact-service/acceptance/valkey-sentinel/docker-compose.yml \
    services/converact-service/acceptance/valkey-sentinel/probe.ts \
    scripts/lib/converact-validation-server.sh \
    src/infra/redis-connection-options.ts \
    package-lock.json \
    | sha256sum | awk '{ print $1 }'
)
mkdir -p "$(dirname "$EVIDENCE_FILE")"
cat >"$EVIDENCE_FILE" <<EOF
{
  "schema_version": "1.0.0",
  "evidence_id": "wave2-valkey-sentinel-controlled-runtime",
  "result": "passed_controlled_server",
  "server_ip": "$EXPECTED_SERVER_IP",
  "source_commit": "$source_commit",
  "acceptance_source_sha256": "$acceptance_source_sha256",
  "started_at": "$started_at",
  "completed_at": "$completed_at",
  "valkey_image": "$VALKEY_ACCEPTANCE_IMAGE",
  "valkey_version": "9.1.0",
  "node_probe_image": "$VALKEY_ACCEPTANCE_NODE_IMAGE",
  "topology": {"data_nodes": 3, "sentinel_voters": 3, "quorum": 2},
  "fault_injection": "primary_process_pause_with_stable_network_identity",
  "old_primary": "$old_primary",
  "new_primary": "$new_primary",
  "sentinel_endpoint_before": "$before_endpoint",
  "sentinel_endpoint_after": "$after_endpoint",
  "role_offsets_before": "$before_roles",
  "role_offsets_after": "$after_roles",
  "failover_ms": $failover_ms,
  "reconnect_ms": $reconnect_ms,
  "pre_failover_canary_survived": true,
  "post_failover_write_read": true,
  "pubsub_before_failover": true,
  "pubsub_after_failover": true,
  "credentials_recorded": false,
  "preexisting_running_containers": $BASELINE_CONTAINER_COUNT,
  "container_baseline_invariant": "passed",
  "scope": "isolated single-host three-data-node and three-Sentinel controlled failover",
  "not_proven": ["cross-Zone partition", "target Kubernetes", "LiveKit real-room continuity", "soak", "throughput", "MIX-100K capacity"]
}
EOF
chmod 0644 "$EVIDENCE_FILE"

cleanup
trap '' EXIT HUP INT TERM
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]; then
  printf '%s\n' 'Valkey acceptance project cleanup left containers behind' >&2
  exit 1
fi
assert_container_baseline
printf 'Valkey Sentinel controlled acceptance passed; evidence=%s\n' "$EVIDENCE_FILE"
