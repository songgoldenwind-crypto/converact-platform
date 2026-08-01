#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_COMPAT_HELPER="$SCRIPT_DIR/../../../scripts/converact-env-compat.sh"
if [[ ! -r "$ENV_COMPAT_HELPER" ]]; then
  ENV_COMPAT_HELPER="$SCRIPT_DIR/converact-env-compat.sh"
fi
if [[ ! -r "$ENV_COMPAT_HELPER" ]]; then
  printf '%s\n' 'Converact environment compatibility helper is required' >&2
  exit 66
fi
# shellcheck disable=SC1090
source "$ENV_COMPAT_HELPER"

for suffix in \
  TINODE_IMAGE \
  TINODE_BUILDER_IMAGE \
  TINODE_RUNTIME_IMAGE \
  TINODE_TARGETARCH; do
  converact_env_resolve_fabric "$suffix"
done

export IVEKIT_TINODE_IMAGE="${CONVERACT_FABRIC_TINODE_IMAGE:?CONVERACT_FABRIC_TINODE_IMAGE is required}"
export IVEKIT_TINODE_BUILDER_IMAGE="${CONVERACT_FABRIC_TINODE_BUILDER_IMAGE:?CONVERACT_FABRIC_TINODE_BUILDER_IMAGE is required}"
export IVEKIT_TINODE_RUNTIME_IMAGE="${CONVERACT_FABRIC_TINODE_RUNTIME_IMAGE:?CONVERACT_FABRIC_TINODE_RUNTIME_IMAGE is required}"
if [[ -n "${CONVERACT_FABRIC_TINODE_TARGETARCH:-}" ]]; then
  export IVEKIT_TINODE_TARGETARCH="$CONVERACT_FABRIC_TINODE_TARGETARCH"
fi

exec "$SCRIPT_DIR/build.sh"
