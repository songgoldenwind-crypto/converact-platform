#!/usr/bin/env bash
set -euo pipefail

BASE=/home/ubuntu/converact-validation/g03-ivekit53-campaign-b63383b
NETWORK=converact-rustpbx-baseline
IMAGE=converact/rustpbx:0.4.11-ivekit.53-6c49ee76-g03-b63383b
PG=converact-g03-53-pg-b63383b
ROUTER=converact-g03-53-router-b63383b
RUSTPBX=converact-g03-53-rustpbx-b63383b
BOOTSTRAP=converact-g03-53-bootstrap-b63383b
LABEL=io.converact.g03.campaign=b63383b
ACTION=${1:-}
MODE=${2:-normal-b63383b-v1}
EVIDENCE="$BASE/host-evidence"

mkdir -p "$EVIDENCE"

campaign_names() {
  printf '%s\n' "$PG" "$ROUTER" "$RUSTPBX" "$BOOTSTRAP"
}

container_state_manifest() {
  local id
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    docker container inspect "$id" --format '{{.Id}}\t{{.Name}}\t{{.State.Status}}\t{{.RestartCount}}'
  done < <(docker ps -aq --no-trunc | sort)
}

remove_campaign_containers() {
  local name
  while IFS= read -r name; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      docker container rm -f "$name" >/dev/null
    fi
  done < <(campaign_names)
}

assert_network_available() {
  local occupied
  occupied=$(docker network inspect "$NETWORK" --format '{{range $id, $v := .Containers}}{{$v.Name}} {{end}}')
  if [[ -n "$occupied" ]]; then
    printf 'refusing to use occupied network %s: %s\n' "$NETWORK" "$occupied" >&2
    exit 73
  fi
}

wait_running() {
  local name=$1
  local attempts=${2:-60}
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if [[ $(docker container inspect "$name" --format '{{.State.Running}}' 2>/dev/null || true) == true ]]; then
      printf '%s\n' "$attempt"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_postgres() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$PG" pg_isready -U rustpbx_app -d rustpbx >/dev/null 2>&1; then
      printf '%s\n' "$attempt"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_router() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$ROUTER" node -e "fetch('http://127.0.0.1:8081/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      printf '%s\n' "$attempt"
      return 0
    fi
    sleep 1
  done
  return 1
}

start_stack() {
  local runtime="$BASE/runtime/$MODE"
  [[ -f "$runtime/.env" ]] || { printf 'missing runtime: %s\n' "$runtime" >&2; exit 66; }
  [[ -f "$runtime/rustpbx.toml" ]] || { printf 'missing config: %s\n' "$runtime/rustpbx.toml" >&2; exit 66; }
  docker image inspect "$IMAGE" >/dev/null

  remove_campaign_containers
  assert_network_available

  container_state_manifest | sort > "$EVIDENCE/preexisting-containers-before.txt"
  docker network inspect "$NETWORK" > "$EVIDENCE/network-before.json"

  set -a
  # shellcheck disable=SC1090
  source "$runtime/.env"
  set +a

  docker run -d \
    --name "$PG" \
    --label "$LABEL" \
    --network "$NETWORK" --ip 172.30.44.11 --network-alias postgres \
    --env POSTGRES_USER=rustpbx_app \
    --env "POSTGRES_PASSWORD=$RUSTPBX_DB_PASSWORD" \
    --env POSTGRES_DB=rustpbx \
    --tmpfs /var/lib/postgresql/data:rw,size=536870912,mode=0700 \
    --security-opt no-new-privileges:true \
    "$POSTGRES_IMAGE" > "$EVIDENCE/postgres-container-id.txt"
  wait_running "$PG" > "$EVIDENCE/postgres-running-attempt.txt"
  wait_postgres > "$EVIDENCE/postgres-ready-attempt.txt"

  docker run -d \
    --name "$ROUTER" \
    --label "$LABEL" \
    --network "$NETWORK" --ip 172.30.44.12 --network-alias router \
    --env "RUSTPBX_WEBHOOK_TOKEN=$RUSTPBX_WEBHOOK_TOKEN" \
    --env IVEKIT_CAPACITY_ROUTER_HOST=0.0.0.0 \
    --env IVEKIT_CAPACITY_ROUTER_PORT=8081 \
    --security-opt no-new-privileges:true \
    "$CAPACITY_TOOLS_IMAGE" \
    node --import tsx scripts/capacity/fixtures/rustpbx-router.ts \
    > "$EVIDENCE/router-container-id.txt"
  wait_running "$ROUTER" > "$EVIDENCE/router-running-attempt.txt"
  wait_router > "$EVIDENCE/router-ready-attempt.txt"

  docker run -d \
    --name "$RUSTPBX" \
    --label "$LABEL" \
    --network "$NETWORK" --ip 172.30.44.10 --network-alias rustpbx \
    --env "RUSTRTC_UDP_RECEIVE_BUFFER_BYTES=$RUSTRTC_UDP_RECEIVE_BUFFER_BYTES" \
    --env "RUSTRTC_UDP_SEND_BUFFER_BYTES=$RUSTRTC_UDP_SEND_BUFFER_BYTES" \
    --init \
    --ulimit nofile=262144:262144 \
    --mount "type=bind,src=$runtime/rustpbx.toml,dst=/app/config/rustpbx.toml,readonly" \
    --tmpfs /app/generated:rw,size=16777216,mode=0750 \
    --tmpfs /app/storage:rw,size=268435456,mode=0750 \
    --security-opt no-new-privileges:true \
    "$IMAGE" --conf /app/config/rustpbx.toml \
    > "$EVIDENCE/rustpbx-container-id.txt"
  wait_running "$RUSTPBX" > "$EVIDENCE/rustpbx-running-attempt.txt"

  docker run --rm \
    --name "$BOOTSTRAP" \
    --label "$LABEL" \
    --network "$NETWORK" \
    --env RUSTPBX_BASE_URL=http://rustpbx:8080 \
    --env "RUSTPBX_MANAGEMENT_TOKEN=$RUSTPBX_MANAGEMENT_TOKEN" \
    --env "RUSTPBX_TRUNK_CREDENTIAL=$RUSTPBX_TRUNK_CREDENTIAL" \
    --env RUSTPBX_ACCEPTANCE_UAC_IP=172.30.44.20 \
    --mount "type=bind,src=$BASE/source/infra/capacity/rustpbx-baseline/bootstrap-inbound-trunk.py,dst=/bootstrap/bootstrap-inbound-trunk.py,readonly" \
    --security-opt no-new-privileges:true \
    "$PYTHON_IMAGE" python /bootstrap/bootstrap-inbound-trunk.py \
    > "$EVIDENCE/bootstrap-$MODE.json"

  docker ps --filter "label=$LABEL" --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}' | sort > "$EVIDENCE/campaign-running-$MODE.txt"
  docker network inspect "$NETWORK" > "$EVIDENCE/network-running-$MODE.json"
  printf 'started\t%s\n' "$MODE"
}

stop_stack() {
  remove_campaign_containers
  container_state_manifest | sort > "$EVIDENCE/preexisting-containers-after.txt"
  if ! cmp -s "$EVIDENCE/preexisting-containers-before.txt" "$EVIDENCE/preexisting-containers-after.txt"; then
    diff -u "$EVIDENCE/preexisting-containers-before.txt" "$EVIDENCE/preexisting-containers-after.txt" > "$EVIDENCE/preexisting-container-drift.diff" || true
    printf 'pre-existing container state drift detected\n' >&2
    exit 74
  fi
  rm -f "$EVIDENCE/preexisting-container-drift.diff"
  docker network inspect "$NETWORK" > "$EVIDENCE/network-after.json"
  printf 'stopped\n'
}

case "$ACTION" in
  start)
    start_stack
    ;;
  stop)
    stop_stack
    ;;
  status)
    docker ps -a --filter "label=$LABEL" --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}' | sort
    ;;
  *)
    printf 'usage: %s start [normal-b63383b-v1|overload-b63383b-v1] | stop | status\n' "$0" >&2
    exit 64
    ;;
esac
