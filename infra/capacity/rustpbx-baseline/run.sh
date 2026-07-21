#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BENCHMARK_ROOT="${IVEKIT_CAPACITY_ROOT:-/opt/ivekit-capacity-benchmark}"
RUNTIME_DIR="${IVEKIT_RUSTPBX_RUNTIME_DIR:-$BENCHMARK_ROOT/runtime/rustpbx-baseline}"
RESULT_ROOT="${IVEKIT_CAPACITY_RESULT_ROOT:-$BENCHMARK_ROOT/results}"
SIPP_BINARY="${IVEKIT_SIPP_BINARY:-$BENCHMARK_ROOT/bin/sipp-3.7.7}"
ALPINE_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SCENARIO_FILE="$REPOSITORY_ROOT/services/ivekit-service/acceptance/sipp/inbound-reject-486-uac.xml"

RATE="${1:-}"
DURATION_SECONDS="${2:-30}"
case "$RATE:$DURATION_SECONDS" in
  *[!0-9:]*|:*)
    echo "usage: $0 TARGET_CPS [DURATION_SECONDS]" >&2
    exit 64
    ;;
esac
if (( RATE < 1 || DURATION_SECONDS < 1 )); then
  echo "TARGET_CPS and DURATION_SECONDS must be positive" >&2
  exit 64
fi

TOTAL_CALLS=$((RATE * DURATION_SECONDS))
MAX_CONCURRENT_CALLS="${MAX_CONCURRENT_CALLS:-$((RATE * 10))}"
WALL_TIMEOUT_SECONDS="${WALL_TIMEOUT_SECONDS:-$((DURATION_SECONDS + 60))}"
CDR_DRAIN_SECONDS="${CDR_DRAIN_SECONDS:-30}"
RUN_ID="rustpbx-q${RATE}-$(date -u +%Y%m%dT%H%M%SZ)"
RESULT_DIR="$RESULT_ROOT/$RUN_ID"
SIPP_CONTAINER="ivekit-sipp-${RUN_ID}"
ROUTER_CONTAINER="ivekit-rustpbx-baseline-router-1"
RUSTPBX_CONTAINER="ivekit-rustpbx-baseline-rustpbx-1"
POSTGRES_CONTAINER="ivekit-rustpbx-baseline-postgres-1"

for path in "$RUNTIME_DIR/.env" "$SIPP_BINARY" "$SCENARIO_FILE"; do
  [[ -f "$path" ]] || { echo "required file is missing: $path" >&2; exit 66; }
done
mkdir -p "$RESULT_DIR"

stats_pid=""
vmstat_pid=""
watchdog_pid=""
cleanup() {
  for pid in "$stats_pid" "$vmstat_pid" "$watchdog_pid"; do
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

evidence() {
  docker exec "$ROUTER_CONTAINER" node -e \
    "fetch('http://127.0.0.1:8081/evidence',{headers:{'x-pbx-key':process.env.RUSTPBX_WEBHOOK_TOKEN}}).then(async r=>{if(!r.ok)throw new Error(String(r.status));process.stdout.write(JSON.stringify(await r.json()))}).catch(e=>{console.error(e);process.exit(1)})"
}

old_containers="$(docker ps -aq --filter label=io.ivekit.capacity.baseline=true)"
if [[ -n "$old_containers" ]]; then
  docker rm -f $old_containers >/dev/null
fi
docker compose --env-file "$RUNTIME_DIR/.env" -f "$COMPOSE_FILE" down --remove-orphans >/dev/null
docker compose --env-file "$RUNTIME_DIR/.env" -f "$COMPOSE_FILE" \
  up -d --wait postgres router rustpbx >/dev/null
docker compose --env-file "$RUNTIME_DIR/.env" -f "$COMPOSE_FILE" \
  run --rm bootstrap > "$RESULT_DIR/bootstrap.json"

evidence > "$RESULT_DIR/router-evidence-before.json"
before_cdr="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cdr_requests"])' \
  "$RESULT_DIR/router-evidence-before.json")"
start_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$start_utc" > "$RESULT_DIR/start-utc.txt"
docker inspect "$RUSTPBX_CONTAINER" --format '{{json .State.Health}}' \
  > "$RESULT_DIR/rustpbx-health-before.json"

docker create --name "$SIPP_CONTAINER" \
  --label io.ivekit.capacity.baseline=true \
  --network ivekit-rustpbx-baseline --ip 172.30.44.20 \
  --ulimit nofile=65536:65536 \
  -v "$SIPP_BINARY:/usr/local/bin/sipp:ro" \
  -v "$SCENARIO_FILE:/scenario.xml:ro" \
  -v "$RESULT_DIR:/results" \
  "$ALPINE_IMAGE" \
  /usr/local/bin/sipp 172.30.44.10:5060 \
  -sf /scenario.xml -s 18005559999 \
  -i 172.30.44.20 -p 5060 \
  -r "$RATE" -rp 1000 -m "$TOTAL_CALLS" -l "$MAX_CONCURRENT_CALLS" \
  -timeout "$WALL_TIMEOUT_SECONDS" -nostdin \
  -trace_stat -stf /results/statistics.csv -fd 1s \
  -trace_err -error_file /results/errors.log >/dev/null

(
  seen=0
  printf 'timestamp,name,cpu,mem,net_io,block_io,pids\n'
  while :; do
    state="$(docker inspect "$SIPP_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)"
    if [[ "$state" == running ]]; then
      seen=1
      docker stats --no-stream \
        --format "$(date -u +%Y-%m-%dT%H:%M:%SZ),{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" \
        "$RUSTPBX_CONTAINER" "$ROUTER_CONTAINER" "$POSTGRES_CONTAINER" "$SIPP_CONTAINER" || true
    elif (( seen == 1 )); then
      break
    fi
    sleep 1
  done
) > "$RESULT_DIR/docker-stats.csv" 2>&1 &
stats_pid=$!
vmstat 1 "$((WALL_TIMEOUT_SECONDS + 10))" > "$RESULT_DIR/host-vmstat.log" 2>&1 &
vmstat_pid=$!
printf '0\n' > "$RESULT_DIR/wall-timeout.txt"
(
  sleep "$WALL_TIMEOUT_SECONDS"
  if [[ "$(docker inspect "$SIPP_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)" == running ]]; then
    printf '1\n' > "$RESULT_DIR/wall-timeout.txt"
    docker kill --signal=INT "$SIPP_CONTAINER" >/dev/null 2>&1 || true
  fi
) &
watchdog_pid=$!

docker start "$SIPP_CONTAINER" >/dev/null
docker wait "$SIPP_CONTAINER" > "$RESULT_DIR/container-exit-code.txt"
kill "$watchdog_pid" >/dev/null 2>&1 || true
wait "$watchdog_pid" >/dev/null 2>&1 || true
watchdog_pid=""
wait "$stats_pid" || true
stats_pid=""
kill "$vmstat_pid" >/dev/null 2>&1 || true
wait "$vmstat_pid" >/dev/null 2>&1 || true
vmstat_pid=""
docker logs "$SIPP_CONTAINER" > "$RESULT_DIR/sipp.log" 2>&1 || true

successful="$(python3 - "$RESULT_DIR/statistics.csv" <<'PY'
import csv, sys
with open(sys.argv[1], newline="") as source:
    rows = list(csv.DictReader(source, delimiter=";"))
print(int(rows[-1]["SuccessfulCall(C)"]))
PY
)"
target_cdr=$((before_cdr + successful))
cdr_drained=0
for ((attempt = 0; attempt < CDR_DRAIN_SECONDS; attempt += 1)); do
  evidence > "$RESULT_DIR/router-evidence-current.json"
  current_cdr="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cdr_requests"])' \
    "$RESULT_DIR/router-evidence-current.json")"
  if (( current_cdr >= target_cdr )); then
    cdr_drained=1
    break
  fi
  sleep 1
done
mv "$RESULT_DIR/router-evidence-current.json" "$RESULT_DIR/router-evidence-after.json"
printf '%s\n' "$cdr_drained" > "$RESULT_DIR/cdr-drained.txt"
docker inspect "$RUSTPBX_CONTAINER" --format '{{json .State.Health}}' \
  > "$RESULT_DIR/rustpbx-health-after.json"
docker logs --since "$start_utc" "$RUSTPBX_CONTAINER" > "$RESULT_DIR/rustpbx.log" 2>&1 || true
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT_DIR/end-utc.txt"
docker inspect "$SIPP_CONTAINER" --format '{{json .State}}' > "$RESULT_DIR/sipp-container-state.json"

python3 - "$RESULT_DIR" "$TOTAL_CALLS" <<'PY'
import csv, json, pathlib, re, sys

directory = pathlib.Path(sys.argv[1])
expected = int(sys.argv[2])
before = json.loads((directory / "router-evidence-before.json").read_text())
after = json.loads((directory / "router-evidence-after.json").read_text())
rustpbx_log = (directory / "rustpbx.log").read_text(errors="replace")
with (directory / "statistics.csv").open(newline="") as source:
    row = list(csv.DictReader(source, delimiter=";"))[-1]

result = {
    "container_exit_code": int((directory / "container-exit-code.txt").read_text().strip()),
    "wall_timeout": (directory / "wall-timeout.txt").read_text().strip() == "1",
    "calls_created": int(row["TotalCallCreated"]),
    "successful_calls": int(row["SuccessfulCall(C)"]),
    "failed_calls": int(row["FailedCall(C)"]),
    "current_calls": int(row["CurrentCall"]),
    "retransmissions": int(row["Retransmissions(C)"]),
    "actual_cumulative_cps": float(row["CallRate(C)"]),
    "router_delta": after["router_requests"] - before["router_requests"],
    "cdr_delta": after["cdr_requests"] - before["cdr_requests"],
    "cdr_drained": (directory / "cdr-drained.txt").read_text().strip() == "1",
    "rustpbx_log_lines": len(rustpbx_log.splitlines()),
    "queue_drop_log_lines": len(re.findall(
        r"call record channel full|call record queue.*dropp", rustpbx_log, re.I
    )),
}
checks = {
    "container_exit_code": 0,
    "wall_timeout": False,
    "calls_created": expected,
    "successful_calls": expected,
    "failed_calls": 0,
    "current_calls": 0,
    "router_delta": expected,
    "cdr_delta": expected,
    "cdr_drained": True,
    "queue_drop_log_lines": 0,
}


def mismatched(result, expected):
    return result != expected


failures = [name for name, expected in checks.items() if mismatched(result[name], expected)]
result["status"] = "passed" if not failures else "failed"
result["failed_checks"] = failures
(directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
raise SystemExit(0 if not failures else 1)
PY
