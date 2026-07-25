#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_SIP_SOURCE_DIR:?LIVEKIT_SIP_SOURCE_DIR is required}"
: "${IVEKIT_LIVEKIT_SIP_IMAGE:?IVEKIT_LIVEKIT_SIP_IMAGE is required}"
: "${LIVEKIT_SIP_BUILDER_IMAGE:?LIVEKIT_SIP_BUILDER_IMAGE immutable digest reference is required}"
: "${LIVEKIT_SIP_RUNTIME_IMAGE:?LIVEKIT_SIP_RUNTIME_IMAGE immutable digest reference is required}"

readonly EXPECTED_COMMIT="d5d1e09bbe826baaae9c335d8f42523192c7ce29"
readonly EXPECTED_VERSION="v1.7.0"
readonly DOCKER_COMMAND="${DOCKER_COMMAND:-docker}"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for image in "${LIVEKIT_SIP_BUILDER_IMAGE}" "${LIVEKIT_SIP_RUNTIME_IMAGE}"; do
  if [[ ! "${image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
    printf 'LiveKit SIP base image must be an immutable digest reference: %s\n' "${image}" >&2
    exit 1
  fi
done

actual_commit="$(git -C "${LIVEKIT_SIP_SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${EXPECTED_COMMIT}" ]]; then
  printf 'LiveKit SIP source mismatch: expected %s, got %s\n' \
    "${EXPECTED_COMMIT}" "${actual_commit}" >&2
  exit 1
fi

build_args=(
  build
  --file "${SCRIPT_DIR}/Dockerfile"
  --build-arg "LIVEKIT_SIP_BUILDER_IMAGE=${LIVEKIT_SIP_BUILDER_IMAGE}"
  --build-arg "LIVEKIT_SIP_RUNTIME_IMAGE=${LIVEKIT_SIP_RUNTIME_IMAGE}"
  --build-arg "LIVEKIT_SIP_VERSION=${EXPECTED_VERSION}"
  --label "org.opencontainers.image.revision=${EXPECTED_COMMIT}"
  --label "org.opencontainers.image.version=${EXPECTED_VERSION}"
  --label "org.opencontainers.image.source=https://github.com/livekit/sip"
  --label "io.ivekit.component=livekit-sip"
  --label "io.ivekit.build-contract=livekit-sip-v1"
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
