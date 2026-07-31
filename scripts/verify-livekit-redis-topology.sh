#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHART_DIR="$ROOT_DIR/infra/k8s"
VALUES_FILE=$(mktemp "${TMPDIR:-/tmp}/ivekit-livekit-redis-values.XXXXXX")
DIRECT_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-livekit-redis-direct.XXXXXX")
SENTINEL_RENDER=$(mktemp "${TMPDIR:-/tmp}/ivekit-livekit-redis-sentinel.XXXXXX")

cleanup() {
  rm -f "$VALUES_FILE" "$DIRECT_RENDER" "$SENTINEL_RENDER"
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
  egress:
    enabled: true
    image:
      repository: ivekit/livekit-egress
      allowedRegistries: [docker.io]
      digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
  ingress:
    enabled: true
    image:
      repository: ivekit/livekit-ingress
      digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  sip:
    enabled: true
    image:
      repository: livekit/sip
      digest: sha256:5555555555555555555555555555555555555555555555555555555555555555
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

assert_count() {
  expected=$1
  pattern=$2
  file=$3
  label=$4
  actual=$(grep -c "$pattern" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

helm lint "$CHART_DIR" --values "$VALUES_FILE"
render >"$DIRECT_RENDER"

assert_count 5 'address: "opc-redis:6379"' "$DIRECT_RENDER" 'direct Redis blocks'
assert_count 0 'sentinel_master_name:' "$DIRECT_RENDER" 'direct Sentinel fields'
assert_count 0 'mountPath: /etc/livekit-redis-tls' "$DIRECT_RENDER" 'direct TLS volume mounts'
assert_count 1 'mountPath: /sip/config.yaml' "$DIRECT_RENDER" 'direct SIP config mounts'

helm lint "$CHART_DIR" --values "$VALUES_FILE" \
  --set-string livekit.redis.mode=sentinel \
  --set-string livekit.redis.sentinelMasterName=livekit \
  --set-string 'livekit.redis.sentinelAddresses[0]=valkey-sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=valkey-sentinel-1:26379' \
  --set-string 'livekit.redis.sentinelAddresses[2]=valkey-sentinel-2:26379' \
  --set-string livekit.redis.username=livekit-data \
  --set-string livekit.redis.password=data-secret \
  --set-string livekit.redis.sentinelUsername=livekit-sentinel \
  --set-string livekit.redis.sentinelPassword=sentinel-secret \
  --set livekit.redis.tls.enabled=true \
  --set-string livekit.redis.tls.secretName=livekit-redis-tls \
  --set-string livekit.redis.tls.serverName=valkey.internal

render \
  --set-string livekit.redis.mode=sentinel \
  --set-string livekit.redis.sentinelMasterName=livekit \
  --set-string 'livekit.redis.sentinelAddresses[0]=valkey-sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=valkey-sentinel-1:26379' \
  --set-string 'livekit.redis.sentinelAddresses[2]=valkey-sentinel-2:26379' \
  --set-string livekit.redis.username=livekit-data \
  --set-string livekit.redis.password=data-secret \
  --set-string livekit.redis.sentinelUsername=livekit-sentinel \
  --set-string livekit.redis.sentinelPassword=sentinel-secret \
  --set livekit.redis.tls.enabled=true \
  --set-string livekit.redis.tls.secretName=livekit-redis-tls \
  --set-string livekit.redis.tls.serverName=valkey.internal \
  >"$SENTINEL_RENDER"

assert_count 5 'sentinel_master_name: "livekit"' "$SENTINEL_RENDER" 'Sentinel Redis blocks'
assert_count 6 'mountPath: /etc/livekit-redis-tls' "$SENTINEL_RENDER" 'TLS volume mounts'
assert_count 6 'secretName: "livekit-redis-tls"' "$SENTINEL_RENDER" 'TLS Secret volumes'
assert_count 5 'ca_cert_file: /etc/livekit-redis-tls/ca.crt' "$SENTINEL_RENDER" 'TLS CA paths'
assert_count 5 'insecure: false' "$SENTINEL_RENDER" 'verified TLS blocks'
assert_count 1 'mountPath: /sip/config.yaml' "$SENTINEL_RENDER" 'Sentinel SIP config mounts'

expect_failure invalid-mode \
  --set-string livekit.redis.mode=cluster

expect_failure mixed-direct-and-sentinel \
  --set-string livekit.redis.mode=sentinel \
  --set-string livekit.redis.address=valkey:6379 \
  --set-string livekit.redis.sentinelMasterName=livekit \
  --set-string 'livekit.redis.sentinelAddresses[0]=sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=sentinel-1:26379' \
  --set-string 'livekit.redis.sentinelAddresses[2]=sentinel-2:26379'

expect_failure two-sentinel-voters \
  --set-string livekit.redis.mode=sentinel \
  --set-string livekit.redis.sentinelMasterName=livekit \
  --set-string 'livekit.redis.sentinelAddresses[0]=sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=sentinel-1:26379'

expect_failure duplicate-sentinel-voters \
  --set-string livekit.redis.mode=sentinel \
  --set-string livekit.redis.sentinelMasterName=livekit \
  --set-string 'livekit.redis.sentinelAddresses[0]=sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[2]=sentinel-2:26379'

expect_failure missing-sentinel-master \
  --set-string livekit.redis.mode=sentinel \
  --set-string 'livekit.redis.sentinelAddresses[0]=sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=sentinel-1:26379' \
  --set-string 'livekit.redis.sentinelAddresses[2]=sentinel-2:26379'

expect_failure incomplete-data-acl \
  --set-string livekit.redis.username=livekit-data

expect_failure incomplete-sentinel-acl \
  --set-string livekit.redis.mode=sentinel \
  --set-string livekit.redis.sentinelMasterName=livekit \
  --set-string 'livekit.redis.sentinelAddresses[0]=sentinel-0:26379' \
  --set-string 'livekit.redis.sentinelAddresses[1]=sentinel-1:26379' \
  --set-string 'livekit.redis.sentinelAddresses[2]=sentinel-2:26379' \
  --set-string livekit.redis.sentinelUsername=livekit-sentinel

expect_failure missing-tls-secret \
  --set livekit.redis.tls.enabled=true \
  --set-string livekit.redis.tls.serverName=valkey.internal

expect_failure missing-tls-server-name \
  --set livekit.redis.tls.enabled=true \
  --set-string livekit.redis.tls.secretName=livekit-redis-tls

expect_failure incomplete-mtls-pair \
  --set livekit.redis.tls.enabled=true \
  --set-string livekit.redis.tls.secretName=livekit-redis-tls \
  --set-string livekit.redis.tls.serverName=valkey.internal \
  --set-string livekit.redis.tls.clientCertKey=tls.crt

printf '%s\n' 'LiveKit Redis topology Helm acceptance passed'
