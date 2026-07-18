#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHART_DIR="$ROOT_DIR/services/ivekit-service/helm/ivekit"
PLATFORM_CHART_DIR="$ROOT_DIR/infra/k8s"
COMPOSE_FILE="$ROOT_DIR/services/ivekit-service/docker-compose.yml"
COMPOSE_ENV="$ROOT_DIR/services/ivekit-service/env.example"
RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-stage2-helm.XXXXXX.yaml")
EGRESS_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-stage2-egress.XXXXXX.yaml")
FOUNDATION_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-stage2-foundation.XXXXXX.yaml")
PLATFORM_IMAGE_VALUES_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-stage2-platform-images.XXXXXX.yaml")

cleanup() {
  rm -f "$RENDERED_FILE" "$EGRESS_RENDERED_FILE" "$FOUNDATION_RENDERED_FILE" "$PLATFORM_IMAGE_VALUES_FILE"
}
trap cleanup EXIT HUP INT TERM

for command_name in docker helm node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s\n' "required command is unavailable: $command_name" >&2
    exit 1
  fi
done

cd "$ROOT_DIR"

docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" config --quiet

cat >"$PLATFORM_IMAGE_VALUES_FILE" <<'EOF'
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
livekit:
  image:
    repository: livekit/livekit-server
    digest: sha256:4444444444444444444444444444444444444444444444444444444444444444
media:
  sip:
    image:
      repository: livekit/sip
      digest: sha256:5555555555555555555555555555555555555555555555555555555555555555
rustdesk:
  image:
    repository: rustdesk/rustdesk-server
    digest: sha256:6666666666666666666666666666666666666666666666666666666666666666
EOF

helm lint "$CHART_DIR" \
  --set-string image.repository=registry.example.invalid/ivekit/service \
  --set-string image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set-string clamav.image.repository=clamav/clamav \
  --set-string clamav.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --set-string secrets.existingSecret=ivekit-runtime

helm template ivekit "$CHART_DIR" \
  --set-string image.repository=registry.example.invalid/ivekit/service \
  --set-string image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set-string clamav.image.repository=clamav/clamav \
  --set-string clamav.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --set-string secrets.existingSecret=ivekit-runtime \
  >"$RENDERED_FILE"

test -s "$RENDERED_FILE"
grep -q 'registry.example.invalid/ivekit/service@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$RENDERED_FILE"
grep -q 'clamav/clamav@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$RENDERED_FILE"
grep -q 'app.kubernetes.io/component: api' "$RENDERED_FILE"
grep -q 'app.kubernetes.io/component: clamav' "$RENDERED_FILE"
grep -q 'kind: PersistentVolumeClaim' "$RENDERED_FILE"
grep -q 'type: ClusterIP' "$RENDERED_FILE"

EGRESS_DIGEST=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc

if helm template opc-platform "$PLATFORM_CHART_DIR" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  >/dev/null 2>&1; then
  printf '%s\n' 'platform unexpectedly rendered without immutable application image digests' >&2
  exit 1
fi

for component_path in postgres redis nats rustdesk; do
  if helm template opc-platform "$PLATFORM_CHART_DIR" \
    --values "$PLATFORM_IMAGE_VALUES_FILE" \
    --set-string "$component_path.image.digest=" \
    --set livekit.enabled=false \
    --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
    --set-string livekit.publicUrl=wss://media.example.invalid \
    --set-string livekit.apiKey=render-only-key \
    --set-string livekit.apiSecret=render-only-secret-value \
    >/dev/null 2>&1; then
    printf '%s\n' "bundled infrastructure unexpectedly rendered without immutable digest: $component_path" >&2
    exit 1
  fi
done

if helm template opc-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=true \
  --set-string livekit.deploymentMode=bundled-dev \
  --set-string livekit.image.digest= \
  --set-string livekit.publicUrl=ws://livekit.example.invalid:7880 \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  >/dev/null 2>&1; then
  printf '%s\n' 'bundled infrastructure unexpectedly rendered without immutable digest: livekit' >&2
  exit 1
fi

if helm template opc-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set media.sip.enabled=true \
  --set-string media.sip.image.digest= \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  >/dev/null 2>&1; then
  printf '%s\n' 'bundled infrastructure unexpectedly rendered without immutable digest: livekit-sip' >&2
  exit 1
fi

helm template opc-foundation "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=true \
  --set-string livekit.deploymentMode=bundled-dev \
  --set-string livekit.publicUrl=ws://livekit.example.invalid:7880 \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set media.sip.enabled=true \
  >"$FOUNDATION_RENDERED_FILE"

test -s "$FOUNDATION_RENDERED_FILE"
grep -q 'postgres@sha256:1111111111111111111111111111111111111111111111111111111111111111' "$FOUNDATION_RENDERED_FILE"
grep -q 'redis@sha256:2222222222222222222222222222222222222222222222222222222222222222' "$FOUNDATION_RENDERED_FILE"
grep -q 'nats@sha256:3333333333333333333333333333333333333333333333333333333333333333' "$FOUNDATION_RENDERED_FILE"
grep -q 'livekit/livekit-server@sha256:4444444444444444444444444444444444444444444444444444444444444444' "$FOUNDATION_RENDERED_FILE"
grep -q 'livekit/sip@sha256:5555555555555555555555555555555555555555555555555555555555555555' "$FOUNDATION_RENDERED_FILE"
grep -q 'rustdesk/rustdesk-server@sha256:6666666666666666666666666666666666666666666666666666666666666666' "$FOUNDATION_RENDERED_FILE"

if helm template opc-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set-string livekit.redis.address=redis.shared.example.invalid:6379 \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=ivekit/livekit-egress \
  >/dev/null 2>&1; then
  printf '%s\n' 'external Egress unexpectedly rendered without a custom image digest' >&2
  exit 1
fi

if helm template opc-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=ivekit/livekit-egress \
  --set-string media.egress.image.digest="$EGRESS_DIGEST" \
  >/dev/null 2>&1; then
  printf '%s\n' 'external Egress unexpectedly rendered without shared Redis' >&2
  exit 1
fi

for unapproved_egress_repository in \
  livekit/egress \
  docker.io/livekit/egress \
  registry-1.docker.io/livekit/egress \
  registry.example.invalid/arbitrary/livekit-egress \
  untrusted.example.invalid/ivekit/livekit-egress; do
  if helm template opc-platform "$PLATFORM_CHART_DIR" \
    --values "$PLATFORM_IMAGE_VALUES_FILE" \
    --set livekit.enabled=false \
    --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
    --set-string livekit.publicUrl=wss://media.example.invalid \
    --set-string livekit.apiKey=render-only-key \
    --set-string livekit.apiSecret=render-only-secret-value \
    --set-string livekit.redis.address=redis.shared.example.invalid:6379 \
    --set media.egress.enabled=true \
    --set-string media.egress.image.repository="$unapproved_egress_repository" \
    --set-string media.egress.image.digest="$EGRESS_DIGEST" \
    >/dev/null 2>&1; then
    printf '%s\n' "unapproved Egress image repository unexpectedly rendered: $unapproved_egress_repository" >&2
    exit 1
  fi
done

helm lint "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set-string livekit.redis.address=redis.shared.example.invalid:6379 \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=registry.example.invalid/ivekit/livekit-egress \
  --set-string 'media.egress.image.allowedRegistries[0]=registry.example.invalid' \
  --set-string media.egress.image.digest="$EGRESS_DIGEST"

helm template opc-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set-string livekit.redis.address=redis.shared.example.invalid:6379 \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=registry.example.invalid/ivekit/livekit-egress \
  --set-string 'media.egress.image.allowedRegistries[0]=registry.example.invalid' \
  --set-string media.egress.image.digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  >"$EGRESS_RENDERED_FILE"

test -s "$EGRESS_RENDERED_FILE"
grep -q 'registry.example.invalid/opc/platform@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' "$EGRESS_RENDERED_FILE"
grep -q 'registry.example.invalid/opc/ai-agent@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' "$EGRESS_RENDERED_FILE"
grep -q 'registry.example.invalid/opc/frontend@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' "$EGRESS_RENDERED_FILE"
grep -q 'redis.shared.example.invalid:6379' "$EGRESS_RENDERED_FILE"
grep -q "registry.example.invalid/ivekit/livekit-egress@$EGRESS_DIGEST" "$EGRESS_RENDERED_FILE"
grep -q 'IVEKIT_EGRESS_POOL_NAME' "$EGRESS_RENDERED_FILE"
grep -q 'ivekit.io/egress-image-contract: "ivekit-egress-pool-v1"' "$EGRESS_RENDERED_FILE"
grep -q 'opc-platform-livekit-egress-track' "$EGRESS_RENDERED_FILE"
grep -q 'opc-platform-livekit-egress-composite' "$EGRESS_RENDERED_FILE"

node --import tsx --test \
  test/livekit-deployment-preflight.test.ts \
  test/ivekit-stage2-release-evidence.test.ts \
  test/ivekit-release-operations.test.ts \
  test/ivekit-stage2-deployment-gate.test.ts

printf '%s\n' 'iveKit Stage 2 deployment gate passed'
