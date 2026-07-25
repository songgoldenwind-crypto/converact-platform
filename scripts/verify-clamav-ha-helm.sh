#!/bin/sh
set -eu

CHART_DIR=${1:-services/ivekit-service/helm/ivekit}
HELM_BIN=${HELM_BIN:-helm}
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

RENDERED_FILE="$TMP_DIR/clamav.yaml"
INVALID_STDOUT="$TMP_DIR/invalid.yaml"
INVALID_STDERR="$TMP_DIR/invalid.stderr"
APP_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CLAMAV_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

"$HELM_BIN" lint "$CHART_DIR" \
  --set-string image.repository=registry.example.invalid/ivekit/service \
  --set-string image.digest="$APP_DIGEST" \
  --set-string secrets.existingSecret=ivekit-runtime \
  --set clamav.enabled=true \
  --set-string clamav.image.repository=clamav/clamav:1.5.2_base \
  --set-string clamav.image.digest="$CLAMAV_DIGEST"

"$HELM_BIN" template ivekit-clamav "$CHART_DIR" \
  --namespace ivekit \
  --set-string image.repository=registry.example.invalid/ivekit/service \
  --set-string image.digest="$APP_DIGEST" \
  --set-string secrets.existingSecret=ivekit-runtime \
  --set clamav.enabled=true \
  --set-string clamav.image.repository=clamav/clamav:1.5.2_base \
  --set-string clamav.image.digest="$CLAMAV_DIGEST" \
  >"$RENDERED_FILE"

for pattern in \
  'kind: StatefulSet' \
  'replicas: 2' \
  'podManagementPolicy: Parallel' \
  'volumeClaimTemplates:' \
  'accessModes:.*ReadWriteOnce' \
  'kind: PodDisruptionBudget' \
  'kind: NetworkPolicy' \
  'clusterIP: None' \
  'find /var/lib/clamav' \
  'clamav/clamav:1.5.2_base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
do
  if ! grep -Eq "$pattern" "$RENDERED_FILE"; then
    printf 'rendered ClamAV HA contract missing: %s\n' "$pattern" >&2
    exit 1
  fi
done

if "$HELM_BIN" template ivekit-clamav-invalid "$CHART_DIR" \
  --set-string image.repository=registry.example.invalid/ivekit/service \
  --set-string image.digest="$APP_DIGEST" \
  --set-string secrets.existingSecret=ivekit-runtime \
  --set clamav.enabled=true \
  --set clamav.replicaCount=1 \
  --set-string clamav.image.repository=clamav/clamav:1.5.2_base \
  --set-string clamav.image.digest="$CLAMAV_DIGEST" \
  >"$INVALID_STDOUT" 2>"$INVALID_STDERR"
then
  printf '%s\n' 'ClamAV HA chart accepted a single scanner replica' >&2
  exit 1
fi

grep -q 'clamav.replicaCount must be at least 2' "$INVALID_STDERR"
printf '%s\n' 'ClamAV Helm HA contract passed'
