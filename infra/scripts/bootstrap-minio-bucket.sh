#!/bin/sh
set -eu

fail() {
  printf 'minio bootstrap: %s\n' "$1" >&2
  exit 1
}

endpoint=${MINIO_ENDPOINT:-}
bucket=${MINIO_BUCKET:-}
access_key=${MINIO_ACCESS_KEY:-}
secret_key=${MINIO_SECRET_KEY:-}
max_attempts=${MINIO_INIT_MAX_ATTEMPTS:-30}
retry_seconds=${MINIO_INIT_RETRY_SECONDS:-2}

[ -n "$endpoint" ] || fail 'MINIO_ENDPOINT is required'
[ -n "$access_key" ] || fail 'MINIO_ACCESS_KEY is required'
[ -n "$secret_key" ] || fail 'MINIO_SECRET_KEY is required'
case "$max_attempts" in
  ''|*[!0-9]*|0) fail 'MINIO_INIT_MAX_ATTEMPTS must be a positive integer' ;;
esac
case "$retry_seconds" in
  ''|*[!0-9]*) fail 'MINIO_INIT_RETRY_SECONDS must be a non-negative integer' ;;
esac
case "$bucket" in
  ''|*[!a-z0-9.-]*|.*|*.) fail 'MINIO_BUCKET is invalid' ;;
esac
[ "${#bucket}" -ge 3 ] && [ "${#bucket}" -le 63 ] || fail 'MINIO_BUCKET length must be 3..63'

attempt=1
while ! mc alias set opc "$endpoint" "$access_key" "$secret_key" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    fail "endpoint not ready after $max_attempts attempts"
  fi
  printf 'minio bootstrap: waiting for endpoint (attempt %s/%s)\n' "$attempt" "$max_attempts" >&2
  attempt=$((attempt + 1))
  sleep "$retry_seconds"
done

mc mb --ignore-existing "opc/$bucket" >/dev/null
mc anonymous set none "opc/$bucket" >/dev/null
privacy=$(mc anonymous get "opc/$bucket")
case "$privacy" in
  *private*) ;;
  *) fail "bucket privacy verification failed: $bucket" ;;
esac
mc stat "opc/$bucket" >/dev/null || fail "bucket verification failed: $bucket"
printf 'minio bootstrap: %s ready and private\n' "$bucket"
