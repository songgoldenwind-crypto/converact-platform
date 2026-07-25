#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_SOURCE_DIR:?LIVEKIT_SOURCE_DIR is required}"
: "${IVEKIT_LIVEKIT_IMAGE:?IVEKIT_LIVEKIT_IMAGE is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

node "${SCRIPT_DIR}/apply-overlay.mjs" "${LIVEKIT_SOURCE_DIR}"

LIVEKIT_GO_CACHE="${GOCACHE:-/tmp/ivekit-livekit-go-cache}"
GOCACHE="${LIVEKIT_GO_CACHE}" \
  go test -C "${LIVEKIT_SOURCE_DIR}" ./cmd/server ./pkg/sfu ./pkg/sfu/utils
GOCACHE="${LIVEKIT_GO_CACHE}" \
  go test -C "${LIVEKIT_SOURCE_DIR}/ivekit/component-hook-go" ./...
GOCACHE="${LIVEKIT_GO_CACHE}" \
  go test -C "${LIVEKIT_SOURCE_DIR}/ivekit/livekit-owner" ./...
go -C "${LIVEKIT_SOURCE_DIR}" mod vendor

docker build \
  --label "org.opencontainers.image.version=v1.13.4-ivekit.1" \
  --label "org.opencontainers.image.revision=0b3fd288e3ef3263ec475ba0d78cf3ad77459981" \
  --label "io.ivekit.component=livekit-server" \
  --label "io.ivekit.owner-contract=component-node-v1" \
  --tag "${IVEKIT_LIVEKIT_IMAGE}" \
  "${LIVEKIT_SOURCE_DIR}"

printf '%s\n' "${IVEKIT_LIVEKIT_IMAGE}"
