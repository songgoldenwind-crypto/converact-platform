#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHART_DIR="$ROOT_DIR/infra/k8s"
VALUES_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-postgres-values.XXXXXX")
EXTERNAL_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-postgres-external.XXXXXX")
BUNDLED_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-postgres-bundled.XXXXXX")

cleanup() {
  rm -f "$VALUES_FILE" "$EXTERNAL_RENDER" "$BUNDLED_RENDER"
}
trap cleanup EXIT HUP INT TERM

if ! command -v helm >/dev/null 2>&1; then
  printf '%s\n' 'required command is unavailable: helm' >&2
  exit 1
fi

cat >"$VALUES_FILE" <<'EOF'
opc:
  image:
    repository: registry.example.invalid/opc/platform
    digest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
aiAgent:
  image:
    repository: registry.example.invalid/opc/ai-agent
    digest: sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
frontend:
  image:
    repository: registry.example.invalid/opc/frontend
    digest: sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
postgres:
  mode: external
  external:
    existingSecret: opc-database-runtime
    secretKey: database-url
  image:
    repository: postgres
    digest: sha256:1111111111111111111111111111111111111111111111111111111111111111
redis:
  image:
    repository: redis
    digest: sha256:2222222222222222222222222222222222222222222222222222222222222222
nats:
  image:
    repository: nats
    digest: sha256:3333333333333333333333333333333333333333333333333333333333333333
  auth:
    existingSecret: nats-auth
  tls:
    secretName: nats-tls
livekit:
  enabled: true
  deploymentMode: bundled-dev
  publicUrl: ws://livekit.example.invalid:7880
  apiKey: render-only-key
  apiSecret: render-only-secret
  image:
    repository: livekit/livekit-server
    digest: sha256:4444444444444444444444444444444444444444444444444444444444444444
media:
  minio:
    enabled: false
rustdesk:
  image:
    repository: rustdesk/rustdesk-server
    digest: sha256:6666666666666666666666666666666666666666666666666666666666666666
EOF

render() {
  helm template opc "$CHART_DIR" --values "$VALUES_FILE" "$@"
}

expect_failure() {
  label=$1
  shift
  if render "$@" >/dev/null 2>&1; then
    printf 'expected Helm failure did not occur: %s\n' "$label" >&2
    exit 1
  fi
}

helm lint "$CHART_DIR" --values "$VALUES_FILE"
render >"$EXTERNAL_RENDER"

grep -q 'name: opc-database-runtime' "$EXTERNAL_RENDER" || {
  printf '%s\n' 'external database Secret reference is missing' >&2
  exit 1
}
if grep -q 'kind: StatefulSet' "$EXTERNAL_RENDER" && grep -q 'name: opc-postgres' "$EXTERNAL_RENDER"; then
  printf '%s\n' 'external mode rendered bundled-dev PostgreSQL' >&2
  exit 1
fi
if grep -q 'database-url: postgresql://' "$EXTERNAL_RENDER"; then
  printf '%s\n' 'external mode copied a database URL into the release Secret' >&2
  exit 1
fi

render --set-string postgres.mode=bundled-dev >"$BUNDLED_RENDER"
grep -q 'opc.ivekit.io/deployment-profile: bundled-dev' "$BUNDLED_RENDER" || {
  printf '%s\n' 'bundled-dev PostgreSQL marker is missing' >&2
  exit 1
}
grep -q 'kind: StatefulSet' "$BUNDLED_RENDER" || {
  printf '%s\n' 'bundled-dev PostgreSQL StatefulSet is missing' >&2
  exit 1
}
grep -q 'database-url: "postgresql://' "$BUNDLED_RENDER" || {
  printf '%s\n' 'bundled-dev database URL is missing' >&2
  exit 1
}

expect_failure missing-external-secret \
  --set-string postgres.mode=external \
  --set-string postgres.external.existingSecret=

expect_failure missing-external-secret-key \
  --set-string postgres.mode=external \
  --set-string postgres.external.secretKey=

expect_failure invalid-postgres-mode \
  --set-string postgres.mode=ha-magic

printf '%s\n' 'PostgreSQL deployment contract Helm acceptance passed'
