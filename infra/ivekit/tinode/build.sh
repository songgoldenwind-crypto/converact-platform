#!/usr/bin/env bash
set -euo pipefail

: "${TINODE_SOURCE_DIR:?TINODE_SOURCE_DIR is required}"
: "${IVEKIT_TINODE_IMAGE:?IVEKIT_TINODE_IMAGE is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "${SCRIPT_DIR}/apply-overlay.mjs" "${TINODE_SOURCE_DIR}"

TINODE_GO_CACHE="${GOCACHE:-/tmp/ivekit-tinode-go-cache}"
GOCACHE="${TINODE_GO_CACHE}" \
  go test -C "${TINODE_SOURCE_DIR}" ./server
GOCACHE="${TINODE_GO_CACHE}" \
  go test -C "${TINODE_SOURCE_DIR}/ivekit/component-hook-go" ./...
GOCACHE="${TINODE_GO_CACHE}" \
  go test -C "${TINODE_SOURCE_DIR}/ivekit/tinode-owner" ./...

docker build \
  --file "${TINODE_SOURCE_DIR}/docker/tinode/Dockerfile" \
  --build-arg "TARGET_DB=${TINODE_TARGET_DB:-postgres}" \
  --label "org.opencontainers.image.revision=22a7c18e9cd695e9a061bf1b8c84175196ef5a15" \
  --label "io.ivekit.component=tinode-server" \
  --label "io.ivekit.owner-contract=component-node-v1" \
  --tag "${IVEKIT_TINODE_IMAGE}" \
  "${TINODE_SOURCE_DIR}"

printf '%s\n' "${IVEKIT_TINODE_IMAGE}"
