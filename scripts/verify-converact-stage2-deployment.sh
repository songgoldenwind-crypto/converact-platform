#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHART_DIR="$ROOT_DIR/services/converact-service/helm/converact"
PLATFORM_CHART_DIR="$ROOT_DIR/infra/k8s"
COMPOSE_FILE="$ROOT_DIR/services/converact-service/docker-compose.yml"
COMPOSE_ENV="$ROOT_DIR/services/converact-service/env.example"
KAMAILIO_VALUES_FILE="$ROOT_DIR/test/fixtures/converact-kamailio-values.yaml"
RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/converact-stage2-helm.XXXXXX.yaml")
CLAMAV_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/converact-stage2-clamav.XXXXXX.yaml")
KAMAILIO_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/converact-stage2-kamailio.XXXXXX.yaml")
EGRESS_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/converact-stage2-egress.XXXXXX.yaml")
FOUNDATION_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/converact-stage2-foundation.XXXXXX.yaml")
PLATFORM_IMAGE_VALUES_FILE=$(mktemp "${TMPDIR:-/tmp}/converact-stage2-platform-images.XXXXXX.yaml")

cleanup() {
  rm -f "$RENDERED_FILE" "$CLAMAV_RENDERED_FILE" "$KAMAILIO_RENDERED_FILE" "$EGRESS_RENDERED_FILE" "$FOUNDATION_RENDERED_FILE" "$PLATFORM_IMAGE_VALUES_FILE"
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
converact:
  image:
    repository: registry.example.invalid/converact/platform
    digest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
aiAgent:
  image:
    repository: registry.example.invalid/converact/ai-agent
    digest: sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
frontend:
  image:
    repository: registry.example.invalid/converact/frontend
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
  --set-string image.repository=registry.example.invalid/converact/service \
  --set-string image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set-string secrets.existingSecret=converact-runtime

helm template converact "$CHART_DIR" \
  --set-string image.repository=registry.example.invalid/converact/service \
  --set-string image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set-string secrets.existingSecret=converact-runtime \
  >"$RENDERED_FILE"

test -s "$RENDERED_FILE"
grep -q 'registry.example.invalid/converact/service@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$RENDERED_FILE"
grep -q 'app.kubernetes.io/component: api' "$RENDERED_FILE"
grep -q 'type: ClusterIP' "$RENDERED_FILE"
if grep -q 'app.kubernetes.io/component: clamav' "$RENDERED_FILE"; then
  printf '%s\n' 'minimal core unexpectedly rendered ClamAV' >&2
  exit 1
fi

helm template converact-clamav "$CHART_DIR" \
  --set-string image.repository=registry.example.invalid/converact/service \
  --set-string image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set clamav.enabled=true \
  --set-string clamav.image.repository=clamav/clamav \
  --set-string clamav.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --set-string secrets.existingSecret=converact-runtime \
  >"$CLAMAV_RENDERED_FILE"

grep -q 'clamav/clamav@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$CLAMAV_RENDERED_FILE"
grep -q 'app.kubernetes.io/component: clamav' "$CLAMAV_RENDERED_FILE"
grep -q 'kind: StatefulSet' "$CLAMAV_RENDERED_FILE"
grep -q 'podManagementPolicy: Parallel' "$CLAMAV_RENDERED_FILE"
grep -q 'volumeClaimTemplates:' "$CLAMAV_RENDERED_FILE"
grep -q 'kind: PodDisruptionBudget' "$CLAMAV_RENDERED_FILE"
grep -q 'kind: NetworkPolicy' "$CLAMAV_RENDERED_FILE"
grep -q 'clusterIP: None' "$CLAMAV_RENDERED_FILE"
grep -q 'signatureMaxAgeMinutes must be at least 60' "$CHART_DIR/templates/clamav.yaml"

helm lint "$CHART_DIR" --values "$KAMAILIO_VALUES_FILE"
helm template converact-kamailio "$CHART_DIR" \
  --namespace converact \
  --values "$KAMAILIO_VALUES_FILE" \
  >"$KAMAILIO_RENDERED_FILE"

test -s "$KAMAILIO_RENDERED_FILE"
grep -q 'app.kubernetes.io/component: kamailio' "$KAMAILIO_RENDERED_FILE"
grep -q 'kind: StatefulSet' "$KAMAILIO_RENDERED_FILE"
grep -q 'rustpbx-headless' "$KAMAILIO_RENDERED_FILE"
grep -q 'kamailio-topology.json' "$KAMAILIO_RENDERED_FILE"
grep -q 'registry.example.com/converact/kamailio@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' "$KAMAILIO_RENDERED_FILE"
grep -q 'externalTrafficPolicy: Local' "$KAMAILIO_RENDERED_FILE"
grep -q 'sessionAffinity: ClientIP' "$KAMAILIO_RENDERED_FILE"

node --input-type=module - "$KAMAILIO_RENDERED_FILE" <<'NODE'
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

const documents = parseAllDocuments(readFileSync(process.argv[2], 'utf8'));
for (const document of documents) {
  if (document.errors.length > 0) throw document.errors[0];
  const value = document.toJS();
  if (value?.kind === 'ConfigMap' && value.metadata?.name?.endsWith('-kamailio-config')) {
    JSON.parse(value.data['kamailio-runtime.json']);
    JSON.parse(value.data['kamailio-topology.json']);
  }
}
NODE

if helm template converact-kamailio "$CHART_DIR" \
  --namespace converact \
  --values "$KAMAILIO_VALUES_FILE" \
  --set-string voice.kamailio.image.digest= \
  >/dev/null 2>&1; then
  printf '%s\n' 'Kamailio unexpectedly rendered without an immutable image digest' >&2
  exit 1
fi

EGRESS_DIGEST=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc

if helm template converact-platform "$PLATFORM_CHART_DIR" \
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
  if helm template converact-platform "$PLATFORM_CHART_DIR" \
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

if helm template converact-platform "$PLATFORM_CHART_DIR" \
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

if helm template converact-platform "$PLATFORM_CHART_DIR" \
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

helm template converact-foundation "$PLATFORM_CHART_DIR" \
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

if helm template converact-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set-string livekit.redis.address=redis.shared.example.invalid:6379 \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=converact/livekit-egress \
  >/dev/null 2>&1; then
  printf '%s\n' 'external Egress unexpectedly rendered without a custom image digest' >&2
  exit 1
fi

if helm template converact-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=converact/livekit-egress \
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
  untrusted.example.invalid/converact/livekit-egress; do
  if helm template converact-platform "$PLATFORM_CHART_DIR" \
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
  --set-string media.egress.image.repository=registry.example.invalid/converact/livekit-egress \
  --set-string 'media.egress.image.allowedRegistries[0]=registry.example.invalid' \
  --set-string media.egress.image.digest="$EGRESS_DIGEST"

helm template converact-platform "$PLATFORM_CHART_DIR" \
  --values "$PLATFORM_IMAGE_VALUES_FILE" \
  --set livekit.enabled=false \
  --set-string livekit.url=ws://livekit.external.example.invalid:7880 \
  --set-string livekit.publicUrl=wss://media.example.invalid \
  --set-string livekit.apiKey=render-only-key \
  --set-string livekit.apiSecret=render-only-secret-value \
  --set-string livekit.redis.address=redis.shared.example.invalid:6379 \
  --set media.egress.enabled=true \
  --set-string media.egress.image.repository=registry.example.invalid/converact/livekit-egress \
  --set-string 'media.egress.image.allowedRegistries[0]=registry.example.invalid' \
  --set-string media.egress.image.digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  >"$EGRESS_RENDERED_FILE"

test -s "$EGRESS_RENDERED_FILE"
grep -q 'registry.example.invalid/converact/platform@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' "$EGRESS_RENDERED_FILE"
grep -q 'registry.example.invalid/converact/ai-agent@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' "$EGRESS_RENDERED_FILE"
grep -q 'registry.example.invalid/converact/frontend@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' "$EGRESS_RENDERED_FILE"
grep -q 'redis.shared.example.invalid:6379' "$EGRESS_RENDERED_FILE"
grep -q "registry.example.invalid/converact/livekit-egress@$EGRESS_DIGEST" "$EGRESS_RENDERED_FILE"
grep -q 'CONVERACT_FABRIC_EGRESS_POOL_NAME' "$EGRESS_RENDERED_FILE"
grep -q 'converact.io/egress-image-contract: "ivekit-egress-pool-v1"' "$EGRESS_RENDERED_FILE"
grep -q 'converact-platform-livekit-egress-track' "$EGRESS_RENDERED_FILE"
grep -q 'converact-platform-livekit-egress-composite' "$EGRESS_RENDERED_FILE"

sh scripts/verify-livekit-redis-topology.sh

node --import tsx --test \
  test/livekit-deployment-preflight.test.ts \
  test/converact-stage2-release-evidence.test.ts \
  test/converact-release-operations.test.ts \
  test/converact-stage2-deployment-gate.test.ts

printf '%s\n' 'Converact Fabric Stage 2 deployment gate passed'
