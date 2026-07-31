#!/usr/bin/env bash
set -euo pipefail

OUTPUT_FILE="${OUTPUT_FILE:?OUTPUT_FILE is required}"
ARTIFACT_ROOT="${ARTIFACT_ROOT:?ARTIFACT_ROOT is required}"
KAMAILIO_CONFIG_PATH="${KAMAILIO_CONFIG_PATH:?KAMAILIO_CONFIG_PATH is required}"
KAMAILIO_ENABLED_CONFIG="${KAMAILIO_ENABLED_CONFIG:?KAMAILIO_ENABLED_CONFIG is required}"
KAMAILIO_DISABLED_CONFIG="${KAMAILIO_DISABLED_CONFIG:?KAMAILIO_DISABLED_CONFIG is required}"
SIPP_BINARY="${SIPP_BINARY:?SIPP_BINARY is required}"
SIPP_SCENARIO="${SIPP_SCENARIO:?SIPP_SCENARIO is required}"

KAMAILIO_CONTAINER="${KAMAILIO_CONTAINER:-ivekit-homer-acceptance-kamailio}"
KAMAILIO_CONFIG_UID="${KAMAILIO_CONFIG_UID:-10001}"
KAMAILIO_CONFIG_GID="${KAMAILIO_CONFIG_GID:-10001}"
BASELINE_KAMAILIO_CONTAINER="${BASELINE_KAMAILIO_CONTAINER:-ivekit-rustpbx-baseline-kamailio-1}"
RUSTPBX_CONTAINER="${RUSTPBX_CONTAINER:-ivekit-rustpbx-baseline-rustpbx-1}"
ROUTER_CONTAINER="${ROUTER_CONTAINER:-ivekit-rustpbx-baseline-router-1}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-ivekit-rustpbx-baseline-postgres-1}"
HOMER_CONTAINER="${HOMER_CONTAINER:-ivekit-homer-acceptance}"
HOMER_POSTGRES_CONTAINER="${HOMER_POSTGRES_CONTAINER:-ivekit-homer-acceptance-postgres}"
DOCKER_NETWORK="${DOCKER_NETWORK:-ivekit-rustpbx-baseline}"
SIPP_IP="${SIPP_IP:-172.30.44.20}"
SIP_TARGET_IP="${SIP_TARGET_IP:-172.30.44.19}"
POINTS="${POINTS:-400,700,900}"
DURATION_SECONDS="${DURATION_SECONDS:-20}"
REPETITIONS="${REPETITIONS:-2}"
HEP_MODES="${HEP_MODES:-disabled,enabled}"
WARMUP_SECONDS="${WARMUP_SECONDS:-3}"
HEP_FLUSH_TIMEOUT_SECONDS="${HEP_FLUSH_TIMEOUT_SECONDS:-45}"
HOMER_COOLDOWN_CPU_PERCENT="${HOMER_COOLDOWN_CPU_PERCENT:-5}"
HOMER_COOLDOWN_STABLE_SAMPLES="${HOMER_COOLDOWN_STABLE_SAMPLES:-5}"
HOMER_COOLDOWN_TIMEOUT_SECONDS="${HOMER_COOLDOWN_TIMEOUT_SECONDS:-180}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}"
CAMPAIGN_ID="${CAMPAIGN_ID:-hep-ab-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"

ACTIVE_SIPP_CONTAINER=""
SIPP_WAIT_PID=""
STATS_PID=""
VMSTAT_PID=""
CLEANED=0

require_file() {
  [[ -f "$1" ]] || { printf 'required file is missing: %s\n' "$1" >&2; exit 66; }
}

bounded_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  [[ "$value" =~ ^[0-9]+$ ]] || { printf '%s must be an integer\n' "$name" >&2; exit 64; }
  (( value >= minimum && value <= maximum )) || {
    printf '%s must be between %s and %s\n' "$name" "$minimum" "$maximum" >&2
    exit 64
  }
}

container_state() {
  docker inspect "$1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
}

wait_ready() {
  local container="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if [[ "$(container_state "$container" 2>/dev/null || true)" =~ ^(healthy|running)$ ]]; then
      return 0
    fi
    sleep 1
  done
  printf 'container did not become ready: %s\n' "$container" >&2
  return 1
}

copy_config_in_place() {
  local source="$1"
  python3 - "$source" "$KAMAILIO_CONFIG_PATH" \
    "$KAMAILIO_CONFIG_UID" "$KAMAILIO_CONFIG_GID" <<'PY'
from pathlib import Path
import os
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
uid = int(sys.argv[3])
gid = int(sys.argv[4])
with source.open("rb") as reader, target.open("wb") as writer:
    writer.write(reader.read())
    writer.flush()
    os.fsync(writer.fileno())
os.chown(target, uid, gid)
target.chmod(0o600)
PY
}

switch_mode() {
  local mode="$1"
  local source
  case "$mode" in
    enabled) source="$KAMAILIO_ENABLED_CONFIG" ;;
    disabled) source="$KAMAILIO_DISABLED_CONFIG" ;;
    *) printf 'unsupported HEP mode: %s\n' "$mode" >&2; return 64 ;;
  esac
  copy_config_in_place "$source"
  docker exec "$KAMAILIO_CONTAINER" kamailio -c -f /etc/kamailio/kamailio.cfg >/dev/null
  docker restart "$KAMAILIO_CONTAINER" >/dev/null
  wait_ready "$KAMAILIO_CONTAINER"
  local expected actual
  expected="$(sha256sum "$source" | awk '{print $1}')"
  actual="$(docker exec "$KAMAILIO_CONTAINER" sha256sum /etc/kamailio/kamailio.cfg | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || {
    printf 'Kamailio active config hash does not match %s mode\n' "$mode" >&2
    return 1
  }
  sleep "$WARMUP_SECONDS"
}

restore_enabled_config() {
  if [[ -f "$KAMAILIO_ENABLED_CONFIG" && -f "$KAMAILIO_CONFIG_PATH" ]] &&
      docker inspect "$KAMAILIO_CONTAINER" >/dev/null 2>&1; then
    copy_config_in_place "$KAMAILIO_ENABLED_CONFIG"
    docker restart "$KAMAILIO_CONTAINER" >/dev/null 2>&1 || true
    wait_ready "$KAMAILIO_CONTAINER" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( CLEANED == 0 )); then
    CLEANED=1
    [[ -z "$SIPP_WAIT_PID" ]] || kill "$SIPP_WAIT_PID" >/dev/null 2>&1 || true
    [[ -z "$STATS_PID" ]] || kill "$STATS_PID" >/dev/null 2>&1 || true
    [[ -z "$VMSTAT_PID" ]] || kill "$VMSTAT_PID" >/dev/null 2>&1 || true
    [[ -z "$ACTIVE_SIPP_CONTAINER" ]] || docker rm -f "$ACTIVE_SIPP_CONTAINER" >/dev/null 2>&1 || true
    restore_enabled_config
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

router_evidence() {
  docker exec "$ROUTER_CONTAINER" node -e '
fetch("http://127.0.0.1:8081/evidence", {
  headers: {"x-pbx-key": process.env.RUSTPBX_WEBHOOK_TOKEN}
}).then(async response => {
  if (!response.ok) throw new Error(String(response.status));
  process.stdout.write(JSON.stringify(await response.json()));
}).catch(error => {
  console.error(error);
  process.exit(1);
})'
}

hep_rows() {
  local run_id="$1"
  [[ "$run_id" =~ ^hep-ab-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}-r[1-5]-(enabled|disabled)-q[0-9]+$ ]] || {
    printf 'invalid HEP run id\n' >&2
    return 64
  }
  docker exec "$HOMER_CONTAINER" /usr/local/bin/homer cli \
    --config-path /etc/homer \
    --query "SELECT count(*) AS rows FROM hep_proto_1_call WHERE session_id LIKE '${run_id}-%'" \
    2>/dev/null |
    awk -F'|' '/^\|[[:space:]]*[0-9]+[[:space:]]*\|/ {
      value=$2; gsub(/[[:space:]]/, "", value); print value; exit
    }'
}

wait_hep_stable() {
  local run_id="$1"
  local expected_delta="$2"
  local deadline=$((SECONDS + HEP_FLUSH_TIMEOUT_SECONDS))
  local minimum_observation=$((SECONDS + 8))
  local stable=0
  local previous=-1
  local current=0
  while (( SECONDS < deadline )); do
    sleep 2
    current="$(hep_rows "$run_id")"
    if [[ "$current" == "$previous" ]]; then
      stable=$((stable + 1))
    else
      stable=0
      previous="$current"
    fi
    if (( SECONDS >= minimum_observation && stable >= 3 )) &&
        (( expected_delta == 0 || current >= expected_delta )); then
      break
    fi
    if (( SECONDS >= minimum_observation + 10 && stable >= 5 )); then
      break
    fi
  done
  printf '%s\n' "$current"
}

wait_homer_cooldown() {
  local output="$1"
  local deadline=$((SECONDS + HOMER_COOLDOWN_TIMEOUT_SECONDS))
  local stable=0
  printf 'timestamp,homer_cpu_percent,postgres_cpu_percent\n' > "$output"
  while (( SECONDS < deadline )); do
    local homer_cpu postgres_cpu
    homer_cpu="$(
      docker stats --no-stream --format '{{.CPUPerc}}' "$HOMER_CONTAINER" |
        tr -d '%'
    )"
    postgres_cpu="$(
      docker stats --no-stream --format '{{.CPUPerc}}' "$HOMER_POSTGRES_CONTAINER" |
        tr -d '%'
    )"
    printf '%s,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$homer_cpu" "$postgres_cpu" >> "$output"
    if awk -v homer="$homer_cpu" -v postgres="$postgres_cpu" \
      -v maximum="$HOMER_COOLDOWN_CPU_PERCENT" \
      'BEGIN { exit !((homer + 0) <= maximum && (postgres + 0) <= maximum) }'; then
      stable=$((stable + 1))
      (( stable >= HOMER_COOLDOWN_STABLE_SAMPLES )) && return 0
    else
      stable=0
    fi
    sleep 1
  done
  printf 'HOMER did not cool down before the next A/B sample\n' >&2
  return 1
}

sample_resources() {
  local output="$1"
  local sipp_container="$2"
  local containers=(
    "$KAMAILIO_CONTAINER"
    "$BASELINE_KAMAILIO_CONTAINER"
    "$RUSTPBX_CONTAINER"
    "$ROUTER_CONTAINER"
    "$POSTGRES_CONTAINER"
    "$HOMER_CONTAINER"
    "$HOMER_POSTGRES_CONTAINER"
    "$sipp_container"
  )
  printf 'timestamp,name,cpu,mem,net_io,block_io,pids\n' > "$output"
  while [[ "$(docker inspect "$sipp_container" --format '{{.State.Status}}' 2>/dev/null || true)" == "running" ]]; do
    docker stats --no-stream \
      --format "$(date -u +%Y-%m-%dT%H:%M:%SZ),{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" \
      "${containers[@]}" >> "$output" 2>/dev/null || true
    sleep 1
  done
}

run_point() {
  local mode="$1"
  local repetition="$2"
  local target_cps="$3"
  local run_id="${CAMPAIGN_ID}-r${repetition}-${mode}-q${target_cps}"
  local directory="$ARTIFACT_ROOT/$run_id"
  local total_calls=$((target_cps * DURATION_SECONDS))
  local wall_timeout=$((DURATION_SECONDS * 4 + 120))
  local config_file
  [[ "$mode" == "enabled" ]] && config_file="$KAMAILIO_ENABLED_CONFIG" || config_file="$KAMAILIO_DISABLED_CONFIG"

  mkdir -p "$directory"
  switch_mode "$mode"
  wait_homer_cooldown "$directory/homer-cooldown-before.csv"
  router_evidence > "$directory/router-before.json"
  printf '0\n' > "$directory/hep-rows-before.txt"
  local started_at
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$started_at" > "$directory/start-utc.txt"

  ACTIVE_SIPP_CONTAINER="ivekit-sipp-$run_id"
  docker rm -f "$ACTIVE_SIPP_CONTAINER" >/dev/null 2>&1 || true
  docker create --name "$ACTIVE_SIPP_CONTAINER" \
    --network "$DOCKER_NETWORK" --ip "$SIPP_IP" \
    --ulimit nofile=65536:65536 \
    -v "$SIPP_BINARY:/usr/local/bin/sipp:ro" \
    -v "$SIPP_SCENARIO:/scenario.xml:ro" \
    -v "$directory:/results" \
    -w /results \
    "$ALPINE_IMAGE" \
    /usr/local/bin/sipp "$SIP_TARGET_IP:5060" \
    -sf /scenario.xml -s 18005559999 \
    -i "$SIPP_IP" -p 5060 \
    -cid_str "$run_id-%u@${SIPP_IP}" \
    -r "$target_cps" -rp 1000 -m "$total_calls" -l "$total_calls" \
    -timeout "$wall_timeout" -nostdin \
    -trace_stat -stf /results/statistics.csv -fd 1s \
    -trace_rtt -rtt_freq 1 \
    -trace_err -error_file /results/errors.log >/dev/null

  docker start "$ACTIVE_SIPP_CONTAINER" >/dev/null
  sample_resources "$directory/docker-stats.csv" "$ACTIVE_SIPP_CONTAINER" &
  STATS_PID=$!
  vmstat 1 "$((wall_timeout + 10))" > "$directory/host-vmstat.log" 2>&1 &
  VMSTAT_PID=$!
  docker wait "$ACTIVE_SIPP_CONTAINER" > "$directory/container-exit-code.txt" &
  SIPP_WAIT_PID=$!
  wait "$SIPP_WAIT_PID"
  SIPP_WAIT_PID=""
  wait "$STATS_PID" || true
  STATS_PID=""
  kill "$VMSTAT_PID" >/dev/null 2>&1 || true
  wait "$VMSTAT_PID" >/dev/null 2>&1 || true
  VMSTAT_PID=""
  docker logs "$ACTIVE_SIPP_CONTAINER" > "$directory/sipp.log" 2>&1 || true
  docker inspect "$ACTIVE_SIPP_CONTAINER" --format '{{json .State}}' > "$directory/sipp-state.json"
  docker rm "$ACTIVE_SIPP_CONTAINER" >/dev/null
  ACTIVE_SIPP_CONTAINER=""

  router_evidence > "$directory/router-after.json"
  local hep_after
  local expected_hep_rows=0
  [[ "$mode" == "enabled" ]] && expected_hep_rows=$((total_calls * 8))
  hep_after="$(wait_hep_stable "$run_id" "$expected_hep_rows")"
  printf '%s\n' "$hep_after" > "$directory/hep-rows-after.txt"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$directory/end-utc.txt"
  docker logs --since "$started_at" "$KAMAILIO_CONTAINER" > "$directory/kamailio-edge.log" 2>&1 || true
  docker logs --since "$started_at" "$HOMER_CONTAINER" > "$directory/homer.log" 2>&1 || true

  python3 - "$directory" "$mode" "$repetition" "$target_cps" "$DURATION_SECONDS" \
    "$total_calls" "$config_file" <<'PY'
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import sys

directory = Path(sys.argv[1])
mode = sys.argv[2]
repetition = int(sys.argv[3])
target_cps = int(sys.argv[4])
duration_seconds = int(sys.argv[5])
expected_calls = int(sys.argv[6])
config_file = Path(sys.argv[7])

with (directory / "statistics.csv").open(newline="") as source:
    statistics = list(csv.DictReader(source, delimiter=";"))[-1]

samples = []
for path in directory.glob("*_rtt.csv"):
    with path.open(newline="") as source:
        for sample in csv.DictReader(source, delimiter=";"):
            if sample.get("rtd_no") == "sip_route":
                samples.append(float(sample["response_time_ms"]))

def quantile(values, ratio):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * ratio) - 1)]

def bytes_value(text):
    value = text.strip().split()[0]
    match = re.fullmatch(r"([0-9.]+)([KMGT]?i?B)", value)
    if not match:
        return 0
    amount = float(match.group(1))
    units = {
        "B": 1, "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4,
        "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4,
    }
    return int(amount * units[match.group(2)])

resources = {}
with (directory / "docker-stats.csv").open(newline="") as source:
    for row in csv.DictReader(source):
        name = row["name"]
        summary = resources.setdefault(name, {
            "sample_count": 0,
            "cpu_max_percent": 0.0,
            "memory_max_bytes": 0,
        })
        summary["sample_count"] += 1
        summary["cpu_max_percent"] = max(
            summary["cpu_max_percent"],
            float(row["cpu"].rstrip("%") or 0),
        )
        summary["memory_max_bytes"] = max(
            summary["memory_max_bytes"],
            bytes_value(row["mem"]),
        )

before = json.loads((directory / "router-before.json").read_text())
after = json.loads((directory / "router-after.json").read_text())
successful = int(statistics["SuccessfulCall(C)"])
failed = int(statistics["FailedCall(C)"])
remaining = int(statistics["CurrentCall"])
retransmissions = int(statistics["Retransmissions(C)"])
hep_before = int((directory / "hep-rows-before.txt").read_text().strip())
hep_after = int((directory / "hep-rows-after.txt").read_text().strip())
hep_actual_rows = hep_after - hep_before
hep_expected_rows = successful * 8 if mode == "enabled" else 0
router_delta = int(after["router_requests"]) - int(before["router_requests"])
cdr_delta = int(after["cdr_requests"]) - int(before["cdr_requests"])
exit_code = int((directory / "container-exit-code.txt").read_text().strip())
checks = {
    "container_exit_code": exit_code == 0,
    "successful_calls": successful == expected_calls,
    "failed_calls": failed == 0,
    "remaining_calls": remaining == 0,
    "retransmissions": retransmissions == 0,
    "router_delta": router_delta == expected_calls,
    "cdr_delta": cdr_delta == expected_calls,
    "route_samples": len(samples) == expected_calls,
    "hep_rows": hep_actual_rows == hep_expected_rows,
}
result = {
    "schema_version": "1.0.0",
    "run_id": directory.name,
    "mode": mode,
    "repetition": repetition,
    "target_cps": target_cps,
    "duration_seconds": duration_seconds,
    "expected_calls": expected_calls,
    "status": "controlled_pass" if all(checks.values()) else "controlled_failed",
    "capacity_claim": "none",
    "scope": "controlled_server_same_host",
    "config_sha256": hashlib.sha256(config_file.read_bytes()).hexdigest(),
    "container_exit_code": exit_code,
    "successful_calls": successful,
    "failed_calls": failed,
    "remaining_calls": remaining,
    "retransmissions": retransmissions,
    "actual_cumulative_cps": float(statistics["CallRate(C)"]),
    "router_delta": router_delta,
    "cdr_delta": cdr_delta,
    "sip_route_sample_count": len(samples),
    "sip_route_p95_ms": quantile(samples, 0.95),
    "sip_route_p99_ms": quantile(samples, 0.99),
    "hep_expected_rows": hep_expected_rows,
    "hep_actual_rows": hep_actual_rows,
    "hep_loss_rows": max(0, hep_expected_rows - hep_actual_rows),
    "hep_extra_rows": max(0, hep_actual_rows - hep_expected_rows),
    "resources": resources,
    "checks": checks,
    "artifact_sha256": {},
}
for artifact in sorted(directory.iterdir()):
    if artifact.is_file() and artifact.name != "summary.json":
        result["artifact_sha256"][artifact.name] = hashlib.sha256(artifact.read_bytes()).hexdigest()
(directory / "summary.json").write_text(
    json.dumps(result, indent=2, sort_keys=True) + "\n"
)
print(json.dumps({
    "mode": mode,
    "repetition": repetition,
    "target_cps": target_cps,
    "status": result["status"],
    "sip_route_p95_ms": result["sip_route_p95_ms"],
    "sip_route_p99_ms": result["sip_route_p99_ms"],
    "hep_expected_rows": hep_expected_rows,
    "hep_actual_rows": hep_actual_rows,
}))
PY
}

require_file "$SIPP_BINARY"
require_file "$SIPP_SCENARIO"
require_file "$KAMAILIO_ENABLED_CONFIG"
require_file "$KAMAILIO_DISABLED_CONFIG"
require_file "$KAMAILIO_CONFIG_PATH"
bounded_integer DURATION_SECONDS "$DURATION_SECONDS" 5 120
bounded_integer REPETITIONS "$REPETITIONS" 1 5
bounded_integer WARMUP_SECONDS "$WARMUP_SECONDS" 0 30
bounded_integer HEP_FLUSH_TIMEOUT_SECONDS "$HEP_FLUSH_TIMEOUT_SECONDS" 5 180
bounded_integer HOMER_COOLDOWN_CPU_PERCENT "$HOMER_COOLDOWN_CPU_PERCENT" 1 100
bounded_integer HOMER_COOLDOWN_STABLE_SAMPLES "$HOMER_COOLDOWN_STABLE_SAMPLES" 2 30
bounded_integer HOMER_COOLDOWN_TIMEOUT_SECONDS "$HOMER_COOLDOWN_TIMEOUT_SECONDS" 10 600
bounded_integer KAMAILIO_CONFIG_UID "$KAMAILIO_CONFIG_UID" 1 60000
bounded_integer KAMAILIO_CONFIG_GID "$KAMAILIO_CONFIG_GID" 1 60000

IFS=',' read -r -a point_values <<< "$POINTS"
(( ${#point_values[@]} > 0 )) || { printf 'POINTS must not be empty\n' >&2; exit 64; }
previous=0
for point in "${point_values[@]}"; do
  bounded_integer POINTS "$point" 1 100000
  (( point > previous )) || { printf 'POINTS must be strictly ascending\n' >&2; exit 64; }
  previous="$point"
done
[[ "$HEP_MODES" == "disabled,enabled" || "$HEP_MODES" == "enabled,disabled" ]] || {
  printf 'HEP_MODES must contain enabled and disabled exactly once\n' >&2
  exit 64
}
[[ "$CAMPAIGN_ID" =~ ^hep-ab-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || {
  printf 'CAMPAIGN_ID has an invalid format\n' >&2
  exit 64
}

for container in \
  "$KAMAILIO_CONTAINER" "$BASELINE_KAMAILIO_CONTAINER" "$RUSTPBX_CONTAINER" \
  "$ROUTER_CONTAINER" "$POSTGRES_CONTAINER" "$HOMER_CONTAINER" "$HOMER_POSTGRES_CONTAINER"; do
  wait_ready "$container"
done

mkdir -p "$ARTIFACT_ROOT" "$(dirname "$OUTPUT_FILE")"
run_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for repetition in $(seq 1 "$REPETITIONS"); do
  if (( repetition % 2 == 1 )); then
    mode_order=(disabled enabled)
  else
    mode_order=(enabled disabled)
  fi
  for point in "${point_values[@]}"; do
    for mode in "${mode_order[@]}"; do
      run_point "$mode" "$repetition" "$point"
    done
  done
done

python3 - "$ARTIFACT_ROOT" "$OUTPUT_FILE" "$run_started_at" "$CAMPAIGN_ID" "$POINTS" \
  "$DURATION_SECONDS" "$REPETITIONS" "$KAMAILIO_ENABLED_CONFIG" \
  "$KAMAILIO_DISABLED_CONFIG" "$SIPP_BINARY" "$SIPP_SCENARIO" "$0" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

artifact_root = Path(sys.argv[1])
output_file = Path(sys.argv[2])
started_at = sys.argv[3]
campaign_id = sys.argv[4]
points = [int(value) for value in sys.argv[5].split(",")]
duration_seconds = int(sys.argv[6])
repetitions = int(sys.argv[7])
enabled_config = Path(sys.argv[8])
disabled_config = Path(sys.argv[9])
sipp_binary = Path(sys.argv[10])
sipp_scenario = Path(sys.argv[11])
runner = Path(sys.argv[12]).resolve()
runs = [
    json.loads(path.read_text())
    for path in sorted(artifact_root.glob("hep-ab-*/summary.json"))
]

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

containers = {}
for name in (
    "ivekit-homer-acceptance-kamailio",
    "ivekit-rustpbx-baseline-kamailio-1",
    "ivekit-rustpbx-baseline-rustpbx-1",
    "ivekit-rustpbx-baseline-router-1",
    "ivekit-rustpbx-baseline-postgres-1",
    "ivekit-homer-acceptance",
    "ivekit-homer-acceptance-postgres",
):
    raw = subprocess.check_output(
        ["docker", "inspect", name, "--format", "{{json .}}"],
        text=True,
    )
    value = json.loads(raw)
    containers[name] = {
        "image_id": value["Image"],
        "state": value["State"]["Status"],
        "health": (value["State"].get("Health") or {}).get("Status"),
        "restart_count": value["RestartCount"],
    }

expected_run_count = len(points) * repetitions * 2
result = {
    "schema_version": "1.0.0",
    "suite": "iveKit HOMER HEP enabled/disabled A/B",
    "campaign_id": campaign_id,
    "status": (
        "controlled_pass"
        if len(runs) == expected_run_count and
        all(run["status"] == "controlled_pass" for run in runs)
        else "controlled_failed"
    ),
    "capacity_claim": "none",
    "scope": "controlled_server_same_host",
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "started_at": started_at,
    "configuration": {
        "points": points,
        "duration_seconds": duration_seconds,
        "repetitions": repetitions,
        "balanced_order": True,
        "expected_hep_rows_per_successful_call": 8,
    },
    "source": {
        "runner_sha256": sha256(runner),
        "enabled_config_sha256": sha256(enabled_config),
        "disabled_config_sha256": sha256(disabled_config),
        "sipp_binary_sha256": sha256(sipp_binary),
        "sipp_scenario_sha256": sha256(sipp_scenario),
    },
    "containers": containers,
    "runs": runs,
    "sensitive_inputs_removed": True,
    "production_capacity_evidence": False,
}
output_file.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
print(json.dumps({
    "status": result["status"],
    "run_count": len(runs),
    "output_file": str(output_file),
}))
PY

restore_enabled_config
CLEANED=1
