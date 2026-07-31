#!/usr/bin/env bash
set -euo pipefail

image="${IVEKIT_KAMAILIO_IMAGE:?IVEKIT_KAMAILIO_IMAGE is required}"
platforms="${IVEKIT_KAMAILIO_PLATFORMS:-linux/amd64,linux/arm64}"
push="${IVEKIT_KAMAILIO_PUSH:-false}"
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
  printf '%s\n' 'IVEKIT_KAMAILIO_PUSH=true is required for a multi-platform build' >&2
  exit 1
else
  args+=(--load)
fi

args+=("${root}")
"${args[@]}"
