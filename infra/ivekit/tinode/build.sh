#!/usr/bin/env bash
set -euo pipefail

: "${TINODE_SOURCE_DIR:?TINODE_SOURCE_DIR is required}"
: "${IVEKIT_TINODE_IMAGE:?IVEKIT_TINODE_IMAGE is required}"
: "${IVEKIT_TINODE_BUILDER_IMAGE:?IVEKIT_TINODE_BUILDER_IMAGE is required}"
: "${IVEKIT_TINODE_RUNTIME_IMAGE:?IVEKIT_TINODE_RUNTIME_IMAGE is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TINODE_UPSTREAM_COMMIT="22a7c18e9cd695e9a061bf1b8c84175196ef5a15"

require_immutable_image() {
  local label="$1"
  local image="$2"
  if [[ ! "${image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
    printf '%s must end with @sha256:<64 lowercase hex>\n' "${label}" >&2
    exit 1
  fi
}

require_immutable_image IVEKIT_TINODE_BUILDER_IMAGE "${IVEKIT_TINODE_BUILDER_IMAGE}"
require_immutable_image IVEKIT_TINODE_RUNTIME_IMAGE "${IVEKIT_TINODE_RUNTIME_IMAGE}"

requested_arch="${IVEKIT_TINODE_TARGETARCH:-$(docker info --format '{{.Architecture}}')}"
case "${requested_arch}" in
  aarch64|arm64) target_arch="arm64" ;;
  x86_64|amd64) target_arch="amd64" ;;
  *)
    printf 'Unsupported Tinode target architecture: %s\n' "${requested_arch}" >&2
    exit 1
    ;;
esac

actual_commit="$(git -C "${TINODE_SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${TINODE_UPSTREAM_COMMIT}" ]]; then
  printf 'Tinode commit mismatch: expected %s, got %s\n' \
    "${TINODE_UPSTREAM_COMMIT}" "${actual_commit}" >&2
  exit 1
fi

if [[ "${TINODE_TARGET_DB:-postgres}" != "postgres" ]]; then
  printf 'The iveKit Tinode fork supports only the PostgreSQL adapter\n' >&2
  exit 1
fi

node "${SCRIPT_DIR}/apply-overlay.mjs" "${TINODE_SOURCE_DIR}"
go -C "${TINODE_SOURCE_DIR}" mod vendor

TINODE_GO_CACHE="${GOCACHE:-/tmp/ivekit-tinode-go-cache}"
GOCACHE="${TINODE_GO_CACHE}" GOFLAGS=-mod=vendor \
  go test -C "${TINODE_SOURCE_DIR}" -tags postgres \
    ./server ./server/db/postgres
GOCACHE="${TINODE_GO_CACHE}" \
  go test -C "${TINODE_SOURCE_DIR}/ivekit/component-hook-go" ./...
GOCACHE="${TINODE_GO_CACHE}" \
  go test -C "${TINODE_SOURCE_DIR}/ivekit/tinode-owner" ./...

docker build \
  --network=none \
  --file "${TINODE_SOURCE_DIR}/docker/tinode/Dockerfile" \
  --platform "linux/${target_arch}" \
  --build-arg "IVEKIT_TINODE_BUILDER_IMAGE=${IVEKIT_TINODE_BUILDER_IMAGE}" \
  --build-arg "IVEKIT_TINODE_RUNTIME_IMAGE=${IVEKIT_TINODE_RUNTIME_IMAGE}" \
  --build-arg "TARGET_DB=${TINODE_TARGET_DB:-postgres}" \
  --label "org.opencontainers.image.version=v0.25.3-ivekit.3" \
  --label "org.opencontainers.image.revision=${TINODE_UPSTREAM_COMMIT}" \
  --label "io.ivekit.component=tinode-server" \
  --label "io.ivekit.owner-contract=component-node-v1" \
  --tag "${IVEKIT_TINODE_IMAGE}" \
  "${TINODE_SOURCE_DIR}"

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    printf '%s mismatch: expected %s, got %s\n' "${label}" "${expected}" "${actual}" >&2
    exit 1
  fi
}

image_arch="$(docker image inspect "${IVEKIT_TINODE_IMAGE}" --format '{{.Architecture}}')"
image_user="$(docker image inspect "${IVEKIT_TINODE_IMAGE}" --format '{{.Config.User}}')"
image_revision="$(docker image inspect "${IVEKIT_TINODE_IMAGE}" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
image_component="$(docker image inspect "${IVEKIT_TINODE_IMAGE}" --format '{{ index .Config.Labels "io.ivekit.component" }}')"
image_contract="$(docker image inspect "${IVEKIT_TINODE_IMAGE}" --format '{{ index .Config.Labels "io.ivekit.owner-contract" }}')"
assert_equal 'image architecture' "${target_arch}" "${image_arch}"
assert_equal 'image user' 'tinode' "${image_user}"
assert_equal 'image revision' "${TINODE_UPSTREAM_COMMIT}" "${image_revision}"
assert_equal 'image component' 'tinode-server' "${image_component}"
assert_equal 'image owner contract' 'component-node-v1' "${image_contract}"
docker run --rm --network=none --entrypoint /bin/bash "${IVEKIT_TINODE_IMAGE}" -lc \
  'test "$(id -u)" = 10001 && test "$(id -g)" = 10001 && grep -a -q IVEKIT_COMPONENT_NODE_ID /opt/tinode/tinode && grep -q TINODE_RUNTIME_DIR /opt/tinode/entrypoint.sh && grep -q FS_UPLOAD_DIR /opt/tinode/entrypoint.sh && grep -q TINODE_INIT_ONLY /opt/tinode/entrypoint.sh && grep -q TINODE_CLUSTER_NODE_2_ADDR /opt/tinode/config.template && grep -q FS_UPLOAD_DIR /opt/tinode/config.template && grep -q AWS_FORCE_PATH_STYLE /opt/tinode/config.template'

printf '%s\n' "${IVEKIT_TINODE_IMAGE}"
