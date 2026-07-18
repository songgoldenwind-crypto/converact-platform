#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_SIP_SOURCE_DIR:?LIVEKIT_SIP_SOURCE_DIR is required}"
: "${IVEKIT_LIVEKIT_SIP_IMAGE:?IVEKIT_LIVEKIT_SIP_IMAGE is required}"

readonly EXPECTED_COMMIT="02179d2eebe1493ad8c6a7961ceee84c34f8aca3"
readonly EXPECTED_VERSION="v1.6.0"
readonly DOCKER_COMMAND="${DOCKER_COMMAND:-docker}"

actual_commit="$(git -C "${LIVEKIT_SIP_SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${EXPECTED_COMMIT}" ]]; then
  printf 'LiveKit SIP source mismatch: expected %s, got %s\n' \
    "${EXPECTED_COMMIT}" "${actual_commit}" >&2
  exit 1
fi

build_args=(
  build
  --file "${LIVEKIT_SIP_SOURCE_DIR}/build/sip/Dockerfile"
  --build-arg "GOVERSION=${LIVEKIT_SIP_GO_VERSION:-1.26}"
  --build-arg "VERSION=${EXPECTED_VERSION}"
  --label "org.opencontainers.image.revision=${EXPECTED_COMMIT}"
  --label "io.ivekit.component=livekit-sip"
  --tag "${IVEKIT_LIVEKIT_SIP_IMAGE}"
)
if [[ -n "${IVEKIT_LIVEKIT_SIP_PLATFORM:-}" ]]; then
  build_args+=(--platform "${IVEKIT_LIVEKIT_SIP_PLATFORM}")
fi
build_args+=("${LIVEKIT_SIP_SOURCE_DIR}")

"${DOCKER_COMMAND}" "${build_args[@]}"

image_revision="$(
  "${DOCKER_COMMAND}" image inspect "${IVEKIT_LIVEKIT_SIP_IMAGE}" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
)"
if [[ "${image_revision}" != "${EXPECTED_COMMIT}" ]]; then
  printf 'LiveKit SIP image revision mismatch: expected %s, got %s\n' \
    "${EXPECTED_COMMIT}" "${image_revision}" >&2
  exit 1
fi

runtime_version="$(
  "${DOCKER_COMMAND}" run --rm "${IVEKIT_LIVEKIT_SIP_IMAGE}" --version
)"
if [[ "${runtime_version}" != "SIP version ${EXPECTED_VERSION}" ]]; then
  printf 'LiveKit SIP runtime version mismatch: expected %s, got %s\n' \
    "SIP version ${EXPECTED_VERSION}" "${runtime_version}" >&2
  exit 1
fi

printf '%s\n' "${IVEKIT_LIVEKIT_SIP_IMAGE}"
