#!/usr/bin/env bash
set -euo pipefail

image="${CONVERACT_FABRIC_KAMAILIO_IMAGE:?CONVERACT_FABRIC_KAMAILIO_IMAGE is required}"
platforms="${CONVERACT_FABRIC_KAMAILIO_PLATFORMS:-linux/amd64,linux/arm64}"
push="${CONVERACT_FABRIC_KAMAILIO_PUSH:-false}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

args=(
  docker buildx build
  --file "${root}/infra/converact/kamailio/Dockerfile"
  --platform "${platforms}"
  --tag "${image}"
  --provenance=mode=max
  --sbom=true
)

if [[ "${push}" == "true" ]]; then
  args+=(--push)
elif [[ "${platforms}" == *,* ]]; then
  printf '%s\n' 'CONVERACT_FABRIC_KAMAILIO_PUSH=true is required for a multi-platform build' >&2
  exit 1
else
  args+=(--load)
fi

args+=("${root}")
"${args[@]}"
