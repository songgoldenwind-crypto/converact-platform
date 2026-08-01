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
root_access_key=${MINIO_ROOT_ACCESS_KEY:-$access_key}
root_secret_key=${MINIO_ROOT_SECRET_KEY:-$secret_key}
max_attempts=${MINIO_INIT_MAX_ATTEMPTS:-30}
retry_seconds=${MINIO_INIT_RETRY_SECONDS:-2}

[ -n "$endpoint" ] || fail 'MINIO_ENDPOINT is required'
[ -n "$access_key" ] || fail 'MINIO_ACCESS_KEY is required'
[ -n "$secret_key" ] || fail 'MINIO_SECRET_KEY is required'
[ -n "$root_access_key" ] || fail 'MINIO_ROOT_ACCESS_KEY is required'
[ -n "$root_secret_key" ] || fail 'MINIO_ROOT_SECRET_KEY is required'
if [ -n "${MINIO_ROOT_ACCESS_KEY:-}" ] || [ -n "${MINIO_ROOT_SECRET_KEY:-}" ]; then
  [ "$root_access_key" != "$access_key" ] || fail 'root and service access keys must differ'
  [ "$root_secret_key" != "$secret_key" ] || fail 'root and service secret keys must differ'
fi
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
while ! mc alias set converact "$endpoint" "$root_access_key" "$root_secret_key" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    fail "endpoint not ready after $max_attempts attempts"
  fi
  printf 'minio bootstrap: waiting for endpoint (attempt %s/%s)\n' "$attempt" "$max_attempts" >&2
  attempt=$((attempt + 1))
  sleep "$retry_seconds"
done

mc mb --ignore-existing "converact/$bucket" >/dev/null
mc anonymous set none "converact/$bucket" >/dev/null

if [ "$access_key" != "$root_access_key" ]; then
  policy_file=/tmp/converact-recordings-policy.json
  cat >"$policy_file" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$bucket"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$bucket/*"]
    }
  ]
}
EOF
  mc admin user add converact "$access_key" "$secret_key" >/dev/null
  mc admin policy create converact converact-recordings "$policy_file" >/dev/null
  mc admin policy attach converact converact-recordings --user "$access_key" >/dev/null
  rm -f "$policy_file"
  mc admin user info converact "$access_key" >/dev/null || fail 'service account verification failed'
fi

privacy=$(mc anonymous get "converact/$bucket")
case "$privacy" in
  *private*) ;;
  *) fail "bucket privacy verification failed: $bucket" ;;
esac
mc stat "converact/$bucket" >/dev/null || fail "bucket verification failed: $bucket"
printf 'minio bootstrap: %s ready and private\n' "$bucket"
