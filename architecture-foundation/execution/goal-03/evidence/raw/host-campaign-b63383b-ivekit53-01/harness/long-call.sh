#!/usr/bin/env bash
set -euo pipefail

BASE=/home/ubuntu/converact-validation/g03-ivekit53-campaign-b63383b
SOURCE="$BASE/source"
RUNTIME="$BASE/runtime/normal-b63383b-v1"
RESULT="$BASE/results/host-campaign-b63383b-ivekit53-01/long-call-2h-b63383b-v1"
NODE=/home/ubuntu/converact-validation/node24-b22dcf2/bin/node
LOADER=/home/ubuntu/converact-validation/g03-a5d2c97/node-runtime-24-bookworm-225b328/node_modules/tsx/dist/loader.mjs
SIPP=/home/ubuntu/converact-validation/g03-a5d2c97/bin/sipp-3.7.7
NETWORK=converact-rustpbx-baseline
ROUTER=converact-g03-53-router-b63383b
RUSTPBX=converact-g03-53-rustpbx-b63383b
IMAGE=converact/rustpbx:0.4.11-ivekit.53-6c49ee76-g03-b63383b
stats_pid=
vmstat_pid=

cleanup_monitors() {
  local pid
  for pid in "$stats_pid" "$vmstat_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup_monitors EXIT

for name in "$ROUTER" "$RUSTPBX"; do
  if [[ $(docker container inspect "$name" --format '{{.State.Running}}' 2>/dev/null || true) != true ]]; then
    printf 'required campaign container is not running: %s\n' "$name" >&2
    exit 69
  fi
done
if docker ps -a --format '{{.Names}}' | grep -E '^converact-sipp-(uac|uas)-.*-long-call-2h$' > /dev/null; then
  printf 'refusing to overlap an existing long-call SIPp container\n' >&2
  exit 73
fi
[[ -f "$RUNTIME/.env" ]]
[[ $(sha256sum "$SIPP" | awk '{print $1}') == 8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef ]]

rm -rf "$RESULT"
mkdir -p "$RESULT"
chmod 700 "$RESULT"

set -a
# shellcheck disable=SC1090
source "$RUNTIME/.env"
set +a

{
  printf 'captured_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  printf 'source_commit=%s\n' "$(git -C "$SOURCE" rev-parse HEAD)"
  printf 'sipp_sha256=%s\n' "$(sha256sum "$SIPP" | awk '{print $1}')"
  uname -a
  lscpu
  nproc
  free -b
  printf 'ulimit_nofile=%s\n' "$(ulimit -n)"
  docker version --format 'docker_server={{.Server.Version}} {{.Server.Os}} {{.Server.Arch}}'
  docker image inspect "$IMAGE" --format 'rustpbx_image={{.Id}} source={{index .Config.Labels "org.opencontainers.image.revision"}} patchset={{index .Config.Labels "io.ivekit.rustpbx.patchset"}} patch_sha={{index .Config.Labels "io.ivekit.rustpbx.patch-set-sha256"}}'
} > "$RESULT/host-fingerprint.txt"
docker container inspect "$RUSTPBX" --format '{{.Id}}\t{{.Config.Image}}\t{{.State.Status}}\t{{.RestartCount}}' > "$RESULT/rustpbx-before.txt"
docker container inspect "$ROUTER" --format '{{.Id}}\t{{.Config.Image}}\t{{.State.Status}}\t{{.RestartCount}}' > "$RESULT/router-before.txt"
start_utc=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
printf '%s\n' "$start_utc" > "$RESULT/start-utc.txt"

(
  printf 'timestamp,name,cpu_percent,mem_usage,mem_percent,pids\n'
  while :; do
    docker stats --no-stream \
      --format "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ),{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.PIDs}}" \
      "$RUSTPBX" "$ROUTER" || true
    sleep 60
  done
) > "$RESULT/docker-stats-60s.csv" 2> "$RESULT/docker-stats.stderr.log" &
stats_pid=$!
vmstat 60 122 > "$RESULT/host-vmstat-60s.log" 2>&1 &
vmstat_pid=$!

export CONVERACT_FABRIC_SIPP_BINARY="$SIPP"
export CONVERACT_FABRIC_RUSTPBX_ACCEPTANCE_NETWORK="$NETWORK"
export CONVERACT_FABRIC_RUSTPBX_ACCEPTANCE_IP=172.30.44.10
export CONVERACT_FABRIC_RUSTPBX_ACCEPTANCE_UAC_IP=172.30.44.20
export CONVERACT_FABRIC_RUSTPBX_EXTENSION_PASSWORD="$RUSTPBX_TRUNK_CREDENTIAL"
export CONVERACT_FABRIC_RUSTPBX_SIPP_SCENARIO_DIR="$SOURCE/services/converact-service/acceptance/sipp"
export CONVERACT_FABRIC_RUSTPBX_SIPP_RESULT_DIR="$RESULT"
export CONVERACT_FABRIC_RUSTPBX_ROUTER_CONTAINER="$ROUTER"
export CONVERACT_FABRIC_RUSTPBX_ACCEPTANCE_SCENARIOS=long-call-2h

set +e
"$NODE" --import "$LOADER" "$SOURCE/scripts/converact-rustpbx-sipp-acceptance.ts" \
  > "$RESULT/runner.stdout.log" 2> "$RESULT/runner.stderr.log"
runner_status=$?
set -e
printf '%s\n' "$runner_status" > "$RESULT/runner.exit-code"

cleanup_monitors
stats_pid=
vmstat_pid=
docker logs --since "$start_utc" "$RUSTPBX" > "$RESULT/rustpbx.log" 2>&1 || true
docker container inspect "$RUSTPBX" --format '{{.Id}}\t{{.Config.Image}}\t{{.State.Status}}\t{{.RestartCount}}' > "$RESULT/rustpbx-after.txt"
docker container inspect "$ROUTER" --format '{{.Id}}\t{{.Config.Image}}\t{{.State.Status}}\t{{.RestartCount}}' > "$RESULT/router-after.txt"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" > "$RESULT/end-utc.txt"
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E '^converact-sipp-(uac|uas)-.*-long-call-2h' > "$RESULT/residual-long-call-containers.txt" || true

set +e
python3 - "$RESULT" <<'PY'
import json
import pathlib
import sys

directory = pathlib.Path(sys.argv[1])
runner_status = int((directory / 'runner.exit-code').read_text().strip())
report_path = directory / 'report.json'
report = json.loads(report_path.read_text()) if report_path.exists() else None

def restart_count(path):
    return int(path.read_text().strip().replace('\\t', '\t').split('\t')[-1])

scenario = report['scenarios'][0] if report and report.get('scenarios') else None
summary = {
    'schema_id': 'converact-g03-long-call-evidence-v1',
    'schema_version': '1.0.0',
    'source_commit': 'b63383bda16bcd9d311c9ce5e0761877d474797b',
    'patchset': 'ivekit.53',
    'runner_exit_code': runner_status,
    'suite_status': report.get('status') if report else None,
    'duration_ms': scenario.get('duration_ms') if scenario else None,
    'uac': scenario.get('uac') if scenario else None,
    'uas': scenario.get('uas') if scenario else None,
    'router_request_delta': report.get('evidence', {}).get('router_request_delta') if report else None,
    'cdr_request_delta': report.get('evidence', {}).get('cdr_request_delta') if report else None,
    'rustpbx_restart_delta': restart_count(directory / 'rustpbx-after.txt') - restart_count(directory / 'rustpbx-before.txt'),
    'router_restart_delta': restart_count(directory / 'router-after.txt') - restart_count(directory / 'router-before.txt'),
    'residual_long_call_containers': [line for line in (directory / 'residual-long-call-containers.txt').read_text().splitlines() if line],
}
expected = {
    'runner_exit_code': 0,
    'suite_status': 'passed',
    'router_request_delta': 1,
    'cdr_request_delta': 1,
    'rustpbx_restart_delta': 0,
    'router_restart_delta': 0,
    'residual_long_call_containers': [],
}
failures = [name for name, value in expected.items() if summary.get(name) != value]
if scenario is None or scenario.get('duration_ms', 0) < 7_200_000:
    failures.append('duration_ms')
for side in ('uac', 'uas'):
    stats = summary.get(side) or {}
    if stats.get('successful_calls') != 1 or stats.get('failed_calls') != 0 or stats.get('retransmissions') != 0:
        failures.append(side)
summary['checks'] = expected
summary['failed_checks'] = sorted(set(failures))
summary['status'] = 'passed' if not failures else 'failed'
(directory / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
raise SystemExit(0 if not failures else 1)
PY
summary_status=$?
set -e

secret_found=0
for value in "$RUSTPBX_DB_PASSWORD" "$RUSTPBX_MANAGEMENT_TOKEN" "$RUSTPBX_TRUNK_CREDENTIAL" "$RUSTPBX_WEBHOOK_TOKEN"; do
  if grep -R -F -q --exclude=secret-scan-status.txt --exclude=SHA256SUMS "$value" "$RESULT"; then
    secret_found=1
  fi
done
if [[ "$secret_found" == 1 ]]; then
  printf 'failed: generated secret detected; evidence must not be retained\n' > "$RESULT/secret-scan-status.txt"
  exit 78
fi
printf 'passed: generated runtime secrets absent\n' > "$RESULT/secret-scan-status.txt"

(
  cd "$RESULT"
  find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$RESULT/SHA256SUMS"

trap - EXIT
exit "$summary_status"
