#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
COMPOSE_FILE="$ROOT_DIR/services/converact-service/acceptance/platform-fault-matrix/docker-compose.yml"
CONFIRMATION=${CONVERACT_G02_FAULT_CONFIRM:-}
RUN_ID=${CONVERACT_G02_FAULT_RUN_ID:-}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT:-}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}

if [[ "$CONFIRMATION" != "G02_PLATFORM_FAULT_MATRIX" ]]; then
  printf '%s\n' 'CONVERACT_G02_FAULT_CONFIRM must equal G02_PLATFORM_FAULT_MATRIX' >&2
  exit 2
fi
if [[ ! "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  printf '%s\n' 'CONVERACT_G02_FAULT_RUN_ID is invalid' >&2
  exit 2
fi
if [[ ! "$POSTGRES_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'POSTGRES_IMAGE must be an immutable digest reference' >&2
  exit 2
fi
if [[ ! "$POSTGRES_HOST_PORT" =~ ^[0-9]+$ ]] || (( POSTGRES_HOST_PORT < 1024 || POSTGRES_HOST_PORT > 65535 )); then
  printf '%s\n' 'POSTGRES_HOST_PORT must be an unprivileged TCP port' >&2
  exit 2
fi
if [[ ${#POSTGRES_PASSWORD} -lt 24 ]]; then
  printf '%s\n' 'POSTGRES_PASSWORD must contain at least 24 characters' >&2
  exit 2
fi

PROJECT="converact-g02-$RUN_ID"
compose() {
  timeout -k 5 60 docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

export POSTGRES_IMAGE POSTGRES_HOST_PORT POSTGRES_PASSWORD
compose config --quiet

case "${1:-}" in
  plan)
    printf '{"status":"validated","project":"%s","production_eligible":false}\n' "$PROJECT"
    ;;
  *)
    printf '%s\n' 'usage: accept.sh plan' >&2
    exit 2
    ;;
esac
