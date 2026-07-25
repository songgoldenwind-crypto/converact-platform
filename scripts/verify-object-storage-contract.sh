#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHART_DIR="$ROOT_DIR/infra/k8s"
VALUES_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-object-storage-values.XXXXXX")
EXTERNAL_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-object-storage-external.XXXXXX")
IDENTITY_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-object-storage-identity.XXXXXX")
LEGACY_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-object-storage-legacy.XXXXXX")

cleanup() {
  rm -f "$VALUES_FILE" "$EXTERNAL_RENDER" "$IDENTITY_RENDER" "$LEGACY_RENDER"
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
  objectStorage:
    mode: external
    authMode: secret
    endpoint: https://s3.example.invalid
    bucket: ivekit-recordings
    region: eu-west-1
    forcePathStyle: false
    existingSecret: opc-object-storage-runtime
    accessKeyIdKey: access-key-id
    secretAccessKeyKey: secret-access-key
  minio:
    enabled: false
  egress:
    enabled: true
    image:
      repository: ivekit/livekit-egress
      allowedRegistries: [docker.io]
      digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
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

grep -q 'name: opc-object-storage-runtime' "$EXTERNAL_RENDER" || {
  printf '%s\n' 'external S3 Secret env is missing' >&2
  exit 1
}
grep -q 'name: S3_FORCE_PATH_STYLE' "$EXTERNAL_RENDER" || {
  printf '%s\n' 'external S3 path-style env is missing' >&2
  exit 1
}
grep -q 'access_key: ""' "$EXTERNAL_RENDER" || {
  printf '%s\n' 'Egress config must not contain an access key' >&2
  exit 1
}
grep -q 'force_path_style: false' "$EXTERNAL_RENDER" || {
  printf '%s\n' 'external S3 force_path_style was not rendered' >&2
  exit 1
}

render --set-string media.objectStorage.authMode=workload-identity >"$IDENTITY_RENDER"
if grep -q 'name: AWS_ACCESS_KEY_ID' "$IDENTITY_RENDER"; then
  printf '%s\n' 'workload identity omits static credentials' >&2
  exit 1
fi

render \
  --set-string media.objectStorage.mode=legacy-minio \
  --set media.minio.enabled=true \
  >"$LEGACY_RENDER"
grep -q 'name: opc-minio' "$LEGACY_RENDER" || {
  printf '%s\n' 'legacy MinIO rollback deployment is missing' >&2
  exit 1
}
grep -q 'value: "http://opc-minio:9000"' "$LEGACY_RENDER" || {
  printf '%s\n' 'legacy MinIO rollback endpoint is missing' >&2
  exit 1
}
grep -q 'name: opc-minio-legacy' "$LEGACY_RENDER" || {
  printf '%s\n' 'legacy MinIO rollback Secret reference is missing' >&2
  exit 1
}

expect_failure missing-object-storage-bucket \
  --set-string media.objectStorage.bucket=

expect_failure missing-object-storage-secret \
  --set-string media.objectStorage.existingSecret=

expect_failure invalid-object-storage-mode \
  --set-string media.objectStorage.mode=brand-specific

expect_failure minio-with-external-mode \
  --set media.minio.enabled=true

printf '%s\n' 'Object storage Helm contract acceptance passed'
