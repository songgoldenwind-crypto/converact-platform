#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
ACCEPTANCE_DIR="$ROOT_DIR/services/converact-service/acceptance/platform-fault-matrix"
DRAIN_PROBE="$ACCEPTANCE_DIR/drain-probe.ts"
IDENTITY_PROBE="$ACCEPTANCE_DIR/identity-probe.mjs"
SECRET_SCANNER="$ACCEPTANCE_DIR/evidence-secret-scan.mjs"
NODE_BIN=${NODE_BIN:-node}
NODE_IMAGE=${CONVERACT_G02_NODE_IMAGE:-}
CONFIRMATION=${CONVERACT_G02_DRAIN_CONFIRM:-}
RUN_ID=${CONVERACT_G02_FAULT_RUN_ID:-}
SOURCE_COMMIT=${CONVERACT_G02_SOURCE_COMMIT:-}

if [[ "$CONFIRMATION" != "G02_PLATFORM_DRAIN_EVIDENCE" ]]; then
  printf '%s\n' 'CONVERACT_G02_DRAIN_CONFIRM must equal G02_PLATFORM_DRAIN_EVIDENCE' >&2
  exit 2
fi
if [[ ! "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_FAULT_RUN_ID is invalid' >&2
  exit 2
fi
if [[ ! "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_SOURCE_COMMIT must be an exact commit' >&2
  exit 2
fi
if [[ ! "$NODE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_NODE_IMAGE must be an immutable digest reference' >&2
  exit 2
fi
NODE_BIN_PATH=$(command -v "$NODE_BIN" || true)
if [[ -z "$NODE_BIN_PATH" || ! -x "$NODE_BIN_PATH" ]]; then
  printf '%s\n' 'NODE_BIN must resolve to an executable' >&2
  exit 2
fi
NODE_VERSION=$("$NODE_BIN_PATH" --version)
if [[ ! "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' 'drain campaign requires Node v24' >&2
  exit 2
fi
ACTUAL_SOURCE_COMMIT=$(git -C "$ROOT_DIR" rev-parse HEAD)
if [[ "$ACTUAL_SOURCE_COMMIT" != "$SOURCE_COMMIT" ]]; then
  printf '%s\n' 'campaign source commit does not match Git HEAD' >&2
  exit 2
fi
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' 'campaign source worktree must be clean' >&2
  exit 2
fi
if [[ -n "$(timeout -k 2 15 docker ps -q)" ]]; then
  printf '%s\n' 'drain validation requires every pre-existing container to remain stopped' >&2
  exit 2
fi

EVIDENCE_ROOT="$ROOT_DIR/.runtime/platform-fault-matrix"
EVIDENCE_DIR="$EVIDENCE_ROOT/$RUN_ID"
if [[ -e "$EVIDENCE_DIR" ]]; then
  printf '%s\n' 'campaign evidence directory already exists' >&2
  exit 2
fi
mkdir -p -m 0700 "$EVIDENCE_ROOT"
mkdir -m 0700 "$EVIDENCE_DIR"

snapshot_containers() {
  timeout -k 2 15 docker ps -a \
    --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.CreatedAt}}' \
    | LC_ALL=C sort
}

BEFORE_CONTAINERS="$EVIDENCE_DIR/unrelated-containers-before.tsv"
AFTER_CONTAINERS="$EVIDENCE_DIR/unrelated-containers-after.tsv"
DRAIN_RESULT="$EVIDENCE_DIR/drain-result.json"
RECEIPTS_RESULT="$EVIDENCE_DIR/active-zero-receipts.json"
PUBLIC_KEYS_RESULT="$EVIDENCE_DIR/drain-public-keys.json"
IDENTITY_RESULT="$EVIDENCE_DIR/evidence-identity.json"
FINAL_RESULT="$EVIDENCE_DIR/drain-controlled-evidence.json"
RAW_MANIFEST="$EVIDENCE_DIR/raw-output.sha256"
SUPPLEMENTAL_MANIFEST="$EVIDENCE_DIR/supplemental-manifest.sha256"

CONVERACT_G02_STARTED_AT=$("$NODE_BIN_PATH" -e 'process.stdout.write(new Date().toISOString())')
snapshot_containers >"$BEFORE_CONTAINERS"
BEFORE_CONTAINERS_SHA256=$(sha256sum "$BEFORE_CONTAINERS" | awk '{print $1}')
timeout -k 5 60 "$NODE_BIN_PATH" --import tsx "$DRAIN_PROBE" run \
  "$DRAIN_RESULT" "$RECEIPTS_RESULT" "$PUBLIC_KEYS_RESULT" "$RUN_ID" \
  "$BEFORE_CONTAINERS_SHA256" >"$EVIDENCE_DIR/drain-run.log" 2>&1
snapshot_containers >"$AFTER_CONTAINERS"
if ! cmp -s "$BEFORE_CONTAINERS" "$AFTER_CONTAINERS"; then
  printf '%s\n' 'unrelated container state changed during drain campaign' >&2
  exit 1
fi
if [[ -n "$(timeout -k 2 15 docker ps -q)" ]]; then
  printf '%s\n' 'a container became running during drain campaign' >&2
  exit 1
fi

CONFIG_SHA256=$(
  cd "$ROOT_DIR"
  sha256sum \
    src/agent-runtime/converact/platform-foundation/clock.ts \
    src/agent-runtime/converact/platform-foundation/drain.ts \
    src/agent-runtime/converact/platform-foundation/event-envelope.ts \
    src/agent-runtime/converact/placement/admission.ts \
    src/agent-runtime/converact/placement/component-node-admission.ts \
    services/converact-service/acceptance/platform-fault-matrix/campaign-evidence.mjs \
    services/converact-service/acceptance/platform-fault-matrix/drain-node.ts \
    services/converact-service/acceptance/platform-fault-matrix/drain-probe.ts \
    services/converact-service/acceptance/platform-fault-matrix/drain-accept.sh \
    services/converact-service/acceptance/platform-fault-matrix/evidence-contract.mjs \
    services/converact-service/acceptance/platform-fault-matrix/evidence-secret-scan.mjs \
    services/converact-service/acceptance/platform-fault-matrix/identity-probe.mjs \
    | sha256sum | awk '{print $1}'
)
mapfile -d '' -t RAW_ARTIFACTS < <(
  find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$RAW_MANIFEST")" -print0 \
    | LC_ALL=C sort -z
)
"$NODE_BIN_PATH" "$SECRET_SCANNER" "$RAW_MANIFEST" "${RAW_ARTIFACTS[@]}"

export CONVERACT_G02_SOURCE_COMMIT="$SOURCE_COMMIT"
export CONVERACT_G02_CONFIG_SHA256="$CONFIG_SHA256"
export CONVERACT_G02_RAW_OUTPUT_SHA256
CONVERACT_G02_RAW_OUTPUT_SHA256=$(sha256sum "$RAW_MANIFEST" | awk '{print $1}')
export CONVERACT_G02_IMAGE_DIGESTS_JSON="[\"$NODE_IMAGE\"]"
export CONVERACT_G02_NODE_BINARY_SHA256
CONVERACT_G02_NODE_BINARY_SHA256=$(sha256sum "$NODE_BIN_PATH" | awk '{print $1}')
export CONVERACT_G02_NODE_VERSION="$NODE_VERSION"
export CONVERACT_G02_HOST
CONVERACT_G02_HOST=$(hostname)
export CONVERACT_G02_HARDWARE
CONVERACT_G02_HARDWARE="$(uname -srmo); $(nproc) vCPU; $(awk '/MemTotal/ {printf \"%.1f GiB RAM\", $2/1024/1024}' /proc/meminfo); Node $NODE_VERSION"
export CONVERACT_G02_CLOCK="UTC wall clock for receipt audit; Node monotonic performance clock for drain deadline; $(cat /sys/devices/system/clocksource/clocksource0/current_clocksource 2>/dev/null || printf unknown) kernel clocksource"
export CONVERACT_G02_WORKLOAD="production Cell and component admission controllers; production signed active-zero coordinator; four child roles; actual SIGKILL; event N/N-1 and replay decisions; no media and no container actions"
export CONVERACT_G02_SEED="$RUN_ID"
export CONVERACT_G02_STARTED_AT

"$NODE_BIN_PATH" "$IDENTITY_PROBE" "$IDENTITY_RESULT"
"$NODE_BIN_PATH" --import tsx "$DRAIN_PROBE" finalize \
  "$IDENTITY_RESULT" "$DRAIN_RESULT" "$FINAL_RESULT" \
  >"$EVIDENCE_DIR/drain-finalize.log" 2>&1

mapfile -d '' -t FINAL_ARTIFACTS < <(
  find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$SUPPLEMENTAL_MANIFEST")" -print0 \
    | LC_ALL=C sort -z
)
"$NODE_BIN_PATH" "$SECRET_SCANNER" "$SUPPLEMENTAL_MANIFEST" "${FINAL_ARTIFACTS[@]}"
"$NODE_BIN_PATH" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "verified_controlled" || value.production_eligible !== false) process.exit(1);
' "$FINAL_RESULT"
printf '{"status":"verified_controlled","production_eligible":false,"evidence_directory":"%s"}\n' "$EVIDENCE_DIR"
