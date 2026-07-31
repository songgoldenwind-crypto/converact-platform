#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_INGRESS_SOURCE_DIR:?LIVEKIT_INGRESS_SOURCE_DIR is required}"
: "${IVEKIT_LIVEKIT_INGRESS_IMAGE:?IVEKIT_LIVEKIT_INGRESS_IMAGE is required}"
: "${IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE:?IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE is required}"
: "${IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE:?IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE is required}"

LIVEKIT_INGRESS_UPSTREAM_COMMIT="363f6090d572db8eef5b60c273c0970826fb7ca6"
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

require_immutable_image IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE "${IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE}"
require_immutable_image IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE "${IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE}"

requested_arch="${IVEKIT_LIVEKIT_INGRESS_TARGETARCH:-$(docker info --format '{{.Architecture}}')}"
case "${requested_arch}" in
  aarch64|arm64)
    target_arch="arm64"
    GO_TOOLCHAIN_SUM="h1:hHtJUQup8RrD0u1JkoREqx9fkdEMQQUusYS1dYLIUpk="
    ;;
  x86_64|amd64)
    target_arch="amd64"
    GO_TOOLCHAIN_SUM="h1:wVC9wx2XOcP5gHiN8ZzfyTfjlrDLSS7Hu1wjI01n68U="
    ;;
  *)
    printf 'Unsupported LiveKit Ingress target architecture: %s\n' "${requested_arch}" >&2
    exit 1
    ;;
esac
GO_TOOLCHAIN_MODULE="golang.org/toolchain@v0.0.1-go1.25.0.linux-${target_arch}"

actual_commit="$(git -C "${LIVEKIT_INGRESS_SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${LIVEKIT_INGRESS_UPSTREAM_COMMIT}" ]]; then
  printf 'LiveKit Ingress commit mismatch: expected %s, got %s\n' \
    "${LIVEKIT_INGRESS_UPSTREAM_COMMIT}" "${actual_commit}" >&2
  exit 1
fi

node "${SCRIPT_DIR}/apply-overlay.mjs" "${LIVEKIT_INGRESS_SOURCE_DIR}"
toolchain_target="${LIVEKIT_INGRESS_SOURCE_DIR}/ivekit/toolchain/go"
if [[ -d "${toolchain_target}" ]]; then
  chmod -R u+w "${toolchain_target}"
fi
rm -rf "${toolchain_target}"
go -C "${LIVEKIT_INGRESS_SOURCE_DIR}" mod vendor

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
if [[ "$(head -n 1 "${toolchain_dir}/VERSION")" != "go1.25.0" ]]; then
  printf 'Go toolchain version mismatch in %s\n' "${toolchain_dir}" >&2
  exit 1
fi

mkdir -p "${toolchain_target}"
cp -R "${toolchain_dir}/." "${toolchain_target}/"
chmod 0555 "${toolchain_target}/bin/go" "${toolchain_target}/bin/gofmt"
find "${toolchain_target}/pkg/tool/linux_${target_arch}" -type f -exec chmod 0555 {} +

docker build \
  --network=none \
  --file "${LIVEKIT_INGRESS_SOURCE_DIR}/build/ingress/Dockerfile" \
  --platform "linux/${target_arch}" \
  --build-arg "IVEKIT_INGRESS_BUILDER_IMAGE=${IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE}" \
  --build-arg "IVEKIT_INGRESS_RUNTIME_IMAGE=${IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE}" \
  --label "org.opencontainers.image.revision=${LIVEKIT_INGRESS_UPSTREAM_COMMIT}" \
  --label "io.ivekit.component=livekit-ingress" \
  --tag "${IVEKIT_LIVEKIT_INGRESS_IMAGE}" \
  "${LIVEKIT_INGRESS_SOURCE_DIR}"

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    printf '%s mismatch: expected %s, got %s\n' "${label}" "${expected}" "${actual}" >&2
    exit 1
  fi
}

image_arch="$(docker image inspect "${IVEKIT_LIVEKIT_INGRESS_IMAGE}" --format '{{.Architecture}}')"
image_user="$(docker image inspect "${IVEKIT_LIVEKIT_INGRESS_IMAGE}" --format '{{.Config.User}}')"
image_revision="$(docker image inspect "${IVEKIT_LIVEKIT_INGRESS_IMAGE}" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
image_component="$(docker image inspect "${IVEKIT_LIVEKIT_INGRESS_IMAGE}" --format '{{ index .Config.Labels "io.ivekit.component" }}')"
image_version="$(docker run --rm --entrypoint /bin/ingress "${IVEKIT_LIVEKIT_INGRESS_IMAGE}" --version)"
assert_equal 'image architecture' "${target_arch}" "${image_arch}"
assert_equal 'image user' '10001:10001' "${image_user}"
assert_equal 'image revision' "${LIVEKIT_INGRESS_UPSTREAM_COMMIT}" "${image_revision}"
assert_equal 'image component' 'livekit-ingress' "${image_component}"
if [[ "${image_version}" != *'1.5.0'* ]]; then
  printf 'LiveKit Ingress version mismatch: %s\n' "${image_version}" >&2
  exit 1
fi

printf '%s\n' "${IVEKIT_LIVEKIT_INGRESS_IMAGE}"
