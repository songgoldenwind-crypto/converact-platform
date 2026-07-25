#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BENCHMARK_ROOT="${IVEKIT_CAPACITY_ROOT:-/opt/ivekit-capacity-benchmark}"
RUNTIME_DIR="${IVEKIT_RUSTPBX_RUNTIME_DIR:-$BENCHMARK_ROOT/runtime/rustpbx-baseline}"
RESULT_ROOT="${IVEKIT_CAPACITY_RESULT_ROOT:-$BENCHMARK_ROOT/results}"
SIPP_BINARY="${IVEKIT_SIPP_BINARY:-$BENCHMARK_ROOT/bin/sipp-3.7.7}"
NODE_COMMAND="${IVEKIT_NODE_COMMAND:-node}"
OPENSSL_COMMAND="${IVEKIT_OPENSSL_COMMAND:-openssl}"
ALPINE_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SCENARIO_FILE="$REPOSITORY_ROOT/services/ivekit-service/acceptance/sipp/inbound-reject-486-uac.xml"
INCLUDE_KAMAILIO="${IVEKIT_CAPACITY_INCLUDE_KAMAILIO:-1}"
case "$INCLUDE_KAMAILIO" in
  0) DEFAULT_SIP_TARGET_IP="172.30.44.10" ;;
  1) DEFAULT_SIP_TARGET_IP="172.30.44.9" ;;
  *)
    echo "IVEKIT_CAPACITY_INCLUDE_KAMAILIO must be 0 or 1" >&2
    exit 64
    ;;
esac
SIP_TARGET_IP="${IVEKIT_SIP_TARGET_IP:-$DEFAULT_SIP_TARGET_IP}"

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
MAX_SIP_ROUTE_P95_MS="${MAX_SIP_ROUTE_P95_MS:-150}"
MAX_SIP_ROUTE_P99_MS="${MAX_SIP_ROUTE_P99_MS:-250}"
RATE_TOLERANCE_RATIO="${RATE_TOLERANCE_RATIO:-0.03}"
RUN_ID="${IVEKIT_CAPACITY_RUN_ID:-rustpbx-q${RATE}-$(date -u +%Y%m%dT%H%M%SZ)}"
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]]; then
  echo "IVEKIT_CAPACITY_RUN_ID is invalid" >&2
  exit 64
fi
RESULT_DIR="$RESULT_ROOT/$RUN_ID"
SIPP_CONTAINER="ivekit-sipp-${RUN_ID}"
ROUTER_CONTAINER="ivekit-rustpbx-baseline-router-1"
RUSTPBX_CONTAINER="ivekit-rustpbx-baseline-rustpbx-1"
POSTGRES_CONTAINER="ivekit-rustpbx-baseline-postgres-1"
KAMAILIO_CONTAINER="ivekit-rustpbx-baseline-kamailio-1"

for path in "$RUNTIME_DIR/.env" "$SIPP_BINARY" "$SCENARIO_FILE"; do
  [[ -f "$path" ]] || { echo "required file is missing: $path" >&2; exit 66; }
done
mkdir -p "$RESULT_DIR"

set -a
# shellcheck disable=SC1090
source "$RUNTIME_DIR/.env"
set +a

if [[ "$INCLUDE_KAMAILIO" == 1 ]]; then
  (
    cd "$REPOSITORY_ROOT"
    "$NODE_COMMAND" --import tsx src/ivekit-kamailio-compose-config.ts
    "$NODE_COMMAND" --import tsx scripts/render-kamailio-config.ts
  )
  printf '%s\n' \
    '100 sip:172.30.44.10:5060 9 10 duid=rustpbx-a;rweight=100;pinset=10000;node=rustpbx-a;ivekit_retain_state=1' \
    '10000 sip:172.30.44.10:5060 8 10 duid=rustpbx-a-pin;pinset=10000;node=rustpbx-a' \
    > "$KAMAILIO_DISPATCHER_FILE"
  "$OPENSSL_COMMAND" req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KAMAILIO_TLS_KEY_FILE" \
    -out "$KAMAILIO_TLS_CERT_FILE" \
    -days 1 \
    -subj "/CN=kamailio.capacity.invalid" \
    -addext "subjectAltName=IP:172.30.44.9" \
    >/dev/null 2>&1
  cp "$KAMAILIO_TLS_CERT_FILE" "$KAMAILIO_TLS_CA_FILE"
  chmod 0444 \
    "$KAMAILIO_CONFIG_FILE" \
    "$KAMAILIO_TLS_CONFIG_FILE" \
    "$KAMAILIO_DISPATCHER_FILE" \
    "$KAMAILIO_TLS_KEY_FILE" \
    "$KAMAILIO_TLS_CERT_FILE" \
    "$KAMAILIO_TLS_CA_FILE" \
    "$KAMAILIO_WEBPHONE_JWT_SECRET_FILE"
fi

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

kamailio_metrics() {
  if [[ "$INCLUDE_KAMAILIO" == 1 ]]; then
    docker run --rm \
      --network "container:$KAMAILIO_CONTAINER" \
      "$ALPINE_IMAGE" \
      wget -qO- http://127.0.0.1:5065/metrics
  fi
}

wait_for_sip_route() {
  [[ "$INCLUDE_KAMAILIO" == 1 ]] || return 0
  local preflight_name="ivekit-sipp-preflight-$RUN_ID"
  local accepted=0
  local attempt
  for attempt in $(seq 1 30); do
    if docker run --rm \
      --name "$preflight_name" \
      --network ivekit-rustpbx-baseline \
      --ip 172.30.44.20 \
      --ulimit nofile=65536:65536 \
      -v "$SIPP_BINARY:/usr/local/bin/sipp:ro" \
      -v "$SCENARIO_FILE:/scenario.xml:ro" \
      "$ALPINE_IMAGE" \
      /usr/local/bin/sipp "$SIP_TARGET_IP:5060" \
      -sf /scenario.xml \
      -s 18005559999 \
      -i 172.30.44.20 \
      -p 5060 \
      -cid_str "$RUN_ID-preflight-%u@172.30.44.20" \
      -m 1 \
      -timeout 5 \
      -nostdin \
      >/dev/null 2>&1; then
      accepted=1
      break
    fi
    sleep 0.5
  done
  printf '%s\n' "$attempt" > "$RESULT_DIR/route-preflight-attempts.txt"
  if [[ "$accepted" != 1 ]]; then
    echo "Kamailio route did not become ready within the preflight window" >&2
    return 1
  fi

  local payload
  local router_requests
  local cdr_requests
  for attempt in $(seq 1 30); do
    payload="$(evidence)"
    router_requests="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["router_requests"])' <<<"$payload")"
    cdr_requests="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["cdr_requests"])' <<<"$payload")"
    if [[ "$router_requests" == "$cdr_requests" ]]; then
      printf '%s\n' "$payload" > "$RESULT_DIR/route-preflight-evidence.json"
      return 0
    fi
    sleep 0.5
  done
  echo "Kamailio route preflight CDR did not drain" >&2
  return 1
}

old_containers="$(docker ps -aq --filter label=io.ivekit.capacity.baseline=true)"
if [[ -n "$old_containers" ]]; then
  docker rm -f $old_containers >/dev/null
fi
docker compose --env-file "$RUNTIME_DIR/.env" -f "$COMPOSE_FILE" down --remove-orphans >/dev/null
compose_services=(postgres router rustpbx)
if [[ "$INCLUDE_KAMAILIO" == 1 ]]; then
  compose_services+=(kamailio)
fi
docker compose --env-file "$RUNTIME_DIR/.env" -f "$COMPOSE_FILE" \
  up -d --wait "${compose_services[@]}" >/dev/null
docker compose --env-file "$RUNTIME_DIR/.env" -f "$COMPOSE_FILE" \
  run --rm bootstrap > "$RESULT_DIR/bootstrap.json"
wait_for_sip_route

evidence > "$RESULT_DIR/router-evidence-before.json"
kamailio_metrics > "$RESULT_DIR/kamailio-metrics-before.txt"
before_cdr="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cdr_requests"])' \
  "$RESULT_DIR/router-evidence-before.json")"
start_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$start_utc" > "$RESULT_DIR/start-utc.txt"
docker inspect "$RUSTPBX_CONTAINER" --format '{{json .State.Health}}' \
  > "$RESULT_DIR/rustpbx-health-before.json"
if [[ "$INCLUDE_KAMAILIO" == 1 ]]; then
  docker inspect "$KAMAILIO_CONTAINER" --format '{{json .State.Health}}' \
    > "$RESULT_DIR/kamailio-health-before.json"
fi

docker create --name "$SIPP_CONTAINER" \
  --label io.ivekit.capacity.baseline=true \
  --network ivekit-rustpbx-baseline --ip 172.30.44.20 \
  --ulimit nofile=65536:65536 \
  -v "$SIPP_BINARY:/usr/local/bin/sipp:ro" \
  -v "$SCENARIO_FILE:/scenario.xml:ro" \
  -v "$RESULT_DIR:/results" \
  -w /results \
  "$ALPINE_IMAGE" \
  /usr/local/bin/sipp "$SIP_TARGET_IP:5060" \
  -sf /scenario.xml -s 18005559999 \
  -i 172.30.44.20 -p 5060 \
  -cid_str "$RUN_ID-main-%u@172.30.44.20" \
  -r "$RATE" -rp 1000 -m "$TOTAL_CALLS" -l "$MAX_CONCURRENT_CALLS" \
  -timeout "$WALL_TIMEOUT_SECONDS" -nostdin \
  -trace_stat -stf /results/statistics.csv -fd 1s \
  -trace_rtt -rtt_freq 1 \
  -trace_err -error_file /results/errors.log >/dev/null

(
  seen=0
  printf 'timestamp,name,cpu,mem,net_io,block_io,pids\n'
  while :; do
    state="$(docker inspect "$SIPP_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)"
    if [[ "$state" == running ]]; then
      seen=1
      stat_containers=(
        "$RUSTPBX_CONTAINER"
        "$ROUTER_CONTAINER"
        "$POSTGRES_CONTAINER"
        "$SIPP_CONTAINER"
      )
      if [[ "$INCLUDE_KAMAILIO" == 1 ]]; then
        stat_containers+=("$KAMAILIO_CONTAINER")
      fi
      docker stats --no-stream \
        --format "$(date -u +%Y-%m-%dT%H:%M:%SZ),{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" \
        "${stat_containers[@]}" || true
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
kamailio_metrics > "$RESULT_DIR/kamailio-metrics-after.txt"
printf '%s\n' "$cdr_drained" > "$RESULT_DIR/cdr-drained.txt"
docker inspect "$RUSTPBX_CONTAINER" --format '{{json .State.Health}}' \
  > "$RESULT_DIR/rustpbx-health-after.json"
docker logs --since "$start_utc" "$RUSTPBX_CONTAINER" > "$RESULT_DIR/rustpbx.log" 2>&1 || true
if [[ "$INCLUDE_KAMAILIO" == 1 ]]; then
  docker inspect "$KAMAILIO_CONTAINER" --format '{{json .State.Health}}' \
    > "$RESULT_DIR/kamailio-health-after.json"
  docker logs --since "$start_utc" "$KAMAILIO_CONTAINER" > "$RESULT_DIR/kamailio.log" 2>&1 || true
fi
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT_DIR/end-utc.txt"
docker inspect "$SIPP_CONTAINER" --format '{{json .State}}' > "$RESULT_DIR/sipp-container-state.json"

python3 - \
  "$RESULT_DIR" \
  "$TOTAL_CALLS" \
  "$RATE" \
  "$RATE_TOLERANCE_RATIO" \
  "$MAX_SIP_ROUTE_P95_MS" \
  "$MAX_SIP_ROUTE_P99_MS" \
  "$INCLUDE_KAMAILIO" <<'PY'
import csv, json, pathlib, re, sys

directory = pathlib.Path(sys.argv[1])
expected = int(sys.argv[2])
target_cps = int(sys.argv[3])
rate_tolerance = float(sys.argv[4])
maximum_route_p95 = float(sys.argv[5])
maximum_route_p99 = float(sys.argv[6])
include_kamailio = sys.argv[7] == "1"
before = json.loads((directory / "router-evidence-before.json").read_text())
after = json.loads((directory / "router-evidence-after.json").read_text())
rustpbx_log = (directory / "rustpbx.log").read_text(errors="replace")
with (directory / "statistics.csv").open(newline="") as source:
    row = list(csv.DictReader(source, delimiter=";"))[-1]


def quantile(samples, value):
    if not samples:
        return None
    ordered = sorted(samples)
    index = max(0, int(__import__("math").ceil(value * len(ordered))) - 1)
    return ordered[index]


rtt_files = list(directory.glob("*_rtt.csv"))
route_samples = []
if len(rtt_files) == 1:
    with rtt_files[0].open(newline="") as source:
        for sample in csv.DictReader(source, delimiter=";"):
            if sample.get("rtd_no") == "sip_route":
                route_samples.append(float(sample["response_time_ms"]))


def metric(path, name):
    if not path.exists():
        return None
    pattern = re.compile(
        rf"^{re.escape(name)}(?:\{{[^}}]*\}})?\s+([0-9.eE+-]+)(?:\s+[0-9.eE+-]+)?$"
    )
    for line in path.read_text(errors="replace").splitlines():
        match = pattern.match(line.strip())
        if match:
            return float(match.group(1))
    return None


kamailio_metric = "kamailio_script_ivekit_new_invites"
kamailio_before = metric(directory / "kamailio-metrics-before.txt", kamailio_metric)
kamailio_after = metric(directory / "kamailio-metrics-after.txt", kamailio_metric)
kamailio_delta = (
    None
    if kamailio_before is None or kamailio_after is None
    else int(kamailio_after - kamailio_before)
)
actual_cps = float(row["CallRate(C)"])
rate_conformant = abs(actual_cps - target_cps) <= target_cps * rate_tolerance
route_p95 = quantile(route_samples, 0.95)
route_p99 = quantile(route_samples, 0.99)
kamailio_log = (
    (directory / "kamailio.log").read_text(errors="replace")
    if (directory / "kamailio.log").exists()
    else ""
)
kamailio_error_lines = len(re.findall(r"\b(?:ERROR|CRITICAL):", kamailio_log))
result = {
    "container_exit_code": int((directory / "container-exit-code.txt").read_text().strip()),
    "wall_timeout": (directory / "wall-timeout.txt").read_text().strip() == "1",
    "calls_created": int(row["TotalCallCreated"]),
    "successful_calls": int(row["SuccessfulCall(C)"]),
    "failed_calls": int(row["FailedCall(C)"]),
    "current_calls": int(row["CurrentCall"]),
    "retransmissions": int(row["Retransmissions(C)"]),
    "target_cps": target_cps,
    "actual_cumulative_cps": actual_cps,
    "rate_tolerance_ratio": rate_tolerance,
    "rate_conformant": rate_conformant,
    "router_delta": after["router_requests"] - before["router_requests"],
    "cdr_delta": after["cdr_requests"] - before["cdr_requests"],
    "kamailio_new_invites_delta": kamailio_delta,
    "sip_route_sample_count": len(route_samples),
    "sip_route_p95_ms": route_p95,
    "sip_route_p99_ms": route_p99,
    "kamailio_error_log_lines": kamailio_error_lines,
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
    "rate_conformant": True,
    "router_delta": expected,
    "cdr_delta": expected,
    "sip_route_sample_count": expected,
    "cdr_drained": True,
    "queue_drop_log_lines": 0,
}
if include_kamailio:
    checks["kamailio_new_invites_delta"] = expected
    checks["kamailio_error_log_lines"] = 0
if route_p95 is None or route_p95 > maximum_route_p95:
    checks["sip_route_p95_ms"] = f"<= {maximum_route_p95}"
if route_p99 is None or route_p99 > maximum_route_p99:
    checks["sip_route_p99_ms"] = f"<= {maximum_route_p99}"


def mismatched(name, expected_value):
    if isinstance(expected_value, str) and expected_value.startswith("<= "):
        return True
    return result.get(name) != expected_value


failures = [name for name, expected_value in checks.items() if mismatched(name, expected_value)]
result["status"] = "passed" if not failures else "failed"
result["failed_checks"] = failures
(directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
raise SystemExit(0 if not failures else 1)
PY
