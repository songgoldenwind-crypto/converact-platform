#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_EGRESS_SOURCE_DIR:?LIVEKIT_EGRESS_SOURCE_DIR is required}"
: "${IVEKIT_LIVEKIT_EGRESS_IMAGE:?IVEKIT_LIVEKIT_EGRESS_IMAGE is required}"

LIVEKIT_EGRESS_UPSTREAM_COMMIT="7d3572a0bf1959cbbc452f5ba390b6a90b7dc249"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

actual_commit="$(git -C "${LIVEKIT_EGRESS_SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" ]]; then
  printf 'LiveKit Egress commit mismatch: expected %s, got %s\n' \
    "${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" "${actual_commit}" >&2
  exit 1
fi

node "${SCRIPT_DIR}/apply-overlay.mjs" "${LIVEKIT_EGRESS_SOURCE_DIR}"

GOCACHE="${GOCACHE:-/tmp/ivekit-livekit-egress-go-cache}" \
  go test -C "${LIVEKIT_EGRESS_SOURCE_DIR}" ./pkg/stats ./ivekit/...

docker build \
  --label "org.opencontainers.image.revision=${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" \
  --label "io.ivekit.component=livekit-egress" \
  --label "io.ivekit.egress-pool-contract=ivekit-egress-pool-v1" \
  --tag "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" \
  "${LIVEKIT_EGRESS_SOURCE_DIR}"

printf '%s\n' "${IVEKIT_LIVEKIT_EGRESS_IMAGE}"
