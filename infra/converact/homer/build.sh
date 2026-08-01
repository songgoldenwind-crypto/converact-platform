#!/usr/bin/env bash
set -euo pipefail

: "${HOMER_SOURCE_DIR:?HOMER_SOURCE_DIR is required}"
: "${CONVERACT_FABRIC_HOMER_IMAGE:?CONVERACT_FABRIC_HOMER_IMAGE is required}"
: "${HOMER_BUILDER_IMAGE:?HOMER_BUILDER_IMAGE immutable digest reference is required}"
: "${HOMER_NODE_IMAGE:?HOMER_NODE_IMAGE immutable digest reference is required}"
: "${HOMER_RUNTIME_IMAGE:?HOMER_RUNTIME_IMAGE immutable digest reference is required}"
: "${HOMER_TARGETARCH:?HOMER_TARGETARCH is required}"

EXPECTED_COMMIT="ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b"

for value in "${HOMER_BUILDER_IMAGE}" "${HOMER_NODE_IMAGE}" "${HOMER_RUNTIME_IMAGE}"; do
  if [[ ! "${value}" =~ @sha256:[a-f0-9]{64}$ ]]; then
    printf 'base image must be an immutable digest reference: %s\n' "${value}" >&2
    exit 1
  fi
done

case "${HOMER_TARGETARCH}" in
  amd64|arm64) ;;
  *)
    printf 'HOMER_TARGETARCH must be amd64 or arm64: %s\n' "${HOMER_TARGETARCH}" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "${SCRIPT_DIR}/apply-overlay.mjs" "${HOMER_SOURCE_DIR}"

docker build \
  --build-arg "HOMER_BUILDER_IMAGE=${HOMER_BUILDER_IMAGE}" \
  --build-arg "HOMER_NODE_IMAGE=${HOMER_NODE_IMAGE}" \
  --build-arg "HOMER_RUNTIME_IMAGE=${HOMER_RUNTIME_IMAGE}" \
  --build-arg "HOMER_GIT_COMMIT=${EXPECTED_COMMIT}" \
  --build-arg "TARGETARCH=${HOMER_TARGETARCH}" \
  --label "org.opencontainers.image.revision=${EXPECTED_COMMIT}" \
  --label "org.opencontainers.image.version=11.0.297-ivekit.2" \
  --label "io.converact.component=homer" \
  --tag "${CONVERACT_FABRIC_HOMER_IMAGE}" \
  "${HOMER_SOURCE_DIR}"

VERSION_OUTPUT="$(
  docker run --rm --entrypoint /usr/local/bin/homer "${CONVERACT_FABRIC_HOMER_IMAGE}" version
)"
if [[ "${VERSION_OUTPUT}" != *"commit ${EXPECTED_COMMIT:0:8}"* ]]; then
  printf 'HOMER binary revision mismatch: expected commit %s\n%s\n' \
    "${EXPECTED_COMMIT:0:8}" "${VERSION_OUTPUT}" >&2
  exit 1
fi

printf '%s\n' "${CONVERACT_FABRIC_HOMER_IMAGE}"
