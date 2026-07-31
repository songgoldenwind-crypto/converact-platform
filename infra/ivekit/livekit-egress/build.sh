#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_EGRESS_SOURCE_DIR:?LIVEKIT_EGRESS_SOURCE_DIR is required}"
: "${IVEKIT_LIVEKIT_EGRESS_IMAGE:?IVEKIT_LIVEKIT_EGRESS_IMAGE is required}"
: "${IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE:?IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE is required}"
: "${IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE:?IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE is required}"
: "${IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE:?IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE is required}"

LIVEKIT_EGRESS_UPSTREAM_COMMIT="7d3572a0bf1959cbbc452f5ba390b6a90b7dc249"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}"
GOSUMDB="${GOSUMDB:-sum.golang.org}"

require_immutable_image() {
  local label="$1"
  local image="$2"
  if [[ ! "${image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
    printf '%s must end with @sha256:<64 lowercase hex>\n' "${label}" >&2
    exit 1
  fi
}

require_immutable_image IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE "${IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE}"
require_immutable_image IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE "${IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE}"
require_immutable_image IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE "${IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE}"

requested_arch="${IVEKIT_LIVEKIT_EGRESS_TARGETARCH:-$(docker info --format '{{.Architecture}}')}"
case "${requested_arch}" in
  aarch64|arm64)
    target_arch="arm64"
    GO_TOOLCHAIN_SUM="h1:825B2ojAZW7usy4LtVvkxKs89EwlM1mqV0OvDbIA5Ak="
    ;;
  x86_64|amd64)
    target_arch="amd64"
    GO_TOOLCHAIN_SUM="h1:mCBp0gCL9gQVqXpC60jQ7R46JDxL73qeF8hv6SnV2ss="
    ;;
  *)
    printf 'Unsupported LiveKit Egress target architecture: %s\n' "${requested_arch}" >&2
    exit 1
    ;;
esac
GO_TOOLCHAIN_MODULE="golang.org/toolchain@v0.0.1-go1.26.2.linux-${target_arch}"

actual_commit="$(git -C "${LIVEKIT_EGRESS_SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" ]]; then
  printf 'LiveKit Egress commit mismatch: expected %s, got %s\n' \
    "${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" "${actual_commit}" >&2
  exit 1
fi

node "${SCRIPT_DIR}/apply-overlay.mjs" "${LIVEKIT_EGRESS_SOURCE_DIR}"
toolchain_target="${LIVEKIT_EGRESS_SOURCE_DIR}/ivekit/toolchain/go"
if [[ -d "${toolchain_target}" ]]; then
  chmod -R u+w "${toolchain_target}"
fi
rm -rf "${toolchain_target}"
go -C "${LIVEKIT_EGRESS_SOURCE_DIR}" mod vendor

toolchain_json="$(
  GOPROXY="${GOPROXY}" GOSUMDB="${GOSUMDB}" GOTOOLCHAIN=local \
    go mod download -json "${GO_TOOLCHAIN_MODULE}"
)"
toolchain_sum="$(printf '%s' "${toolchain_json}" | jq -er '.Sum')"
toolchain_dir="$(printf '%s' "${toolchain_json}" | jq -er '.Dir')"
if [[ "${toolchain_sum}" != "${GO_TOOLCHAIN_SUM}" ]]; then
  printf 'Go toolchain checksum mismatch: expected %s, got %s\n' \
    "${GO_TOOLCHAIN_SUM}" "${toolchain_sum}" >&2
  exit 1
fi
if [[ "$(head -n 1 "${toolchain_dir}/VERSION")" != "go1.26.2" ]]; then
  printf 'Go toolchain version mismatch in %s\n' "${toolchain_dir}" >&2
  exit 1
fi

mkdir -p "${toolchain_target}"
cp -R "${toolchain_dir}/." "${toolchain_target}/"
chmod 0555 "${toolchain_target}/bin/go" "${toolchain_target}/bin/gofmt"
find "${toolchain_target}/pkg/tool/linux_${target_arch}" -type f -exec chmod 0555 {} +

GOCACHE="${GOCACHE:-/tmp/ivekit-livekit-egress-go-cache}" \
  go test -C "${LIVEKIT_EGRESS_SOURCE_DIR}/ivekit/egress-pool" ./...

docker build \
  --network=none \
  --file "${LIVEKIT_EGRESS_SOURCE_DIR}/build/egress/Dockerfile" \
  --platform "linux/${target_arch}" \
  --build-arg "IVEKIT_EGRESS_TEMPLATE_IMAGE=${IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE}" \
  --build-arg "IVEKIT_EGRESS_BUILDER_IMAGE=${IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE}" \
  --build-arg "IVEKIT_EGRESS_RUNTIME_IMAGE=${IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE}" \
  --label "org.opencontainers.image.revision=${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" \
  --label "io.ivekit.component=livekit-egress" \
  --label "io.ivekit.egress-pool-contract=ivekit-egress-pool-v1" \
  --tag "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" \
  "${LIVEKIT_EGRESS_SOURCE_DIR}"

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    printf '%s mismatch: expected %s, got %s\n' "${label}" "${expected}" "${actual}" >&2
    exit 1
  fi
}

image_arch="$(docker image inspect "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" --format '{{.Architecture}}')"
image_user="$(docker image inspect "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" --format '{{.Config.User}}')"
image_revision="$(docker image inspect "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
image_component="$(docker image inspect "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" --format '{{ index .Config.Labels "io.ivekit.component" }}')"
image_contract="$(docker image inspect "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" --format '{{ index .Config.Labels "io.ivekit.egress-pool-contract" }}')"
image_version="$(docker run --rm --entrypoint /bin/egress "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" --version)"
assert_equal 'image architecture' "${target_arch}" "${image_arch}"
assert_equal 'image user' 'egress' "${image_user}"
assert_equal 'image revision' "${LIVEKIT_EGRESS_UPSTREAM_COMMIT}" "${image_revision}"
assert_equal 'image component' 'livekit-egress' "${image_component}"
assert_equal 'image pool contract' 'ivekit-egress-pool-v1' "${image_contract}"
if [[ "${image_version}" != *'1.13.0'* ]]; then
  printf 'LiveKit Egress version mismatch: %s\n' "${image_version}" >&2
  exit 1
fi
docker run --rm --entrypoint /bin/bash "${IVEKIT_LIVEKIT_EGRESS_IMAGE}" -lc \
  "grep -a -q 'IVEKIT_EGRESS_POOL_NAME' /bin/egress && grep -a -q 'ivekit_livekit_egress_policy_rejections_total' /bin/egress"

printf '%s\n' "${IVEKIT_LIVEKIT_EGRESS_IMAGE}"
