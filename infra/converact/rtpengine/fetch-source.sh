#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_COMPAT_HELPER=/converact-env-compat.sh
if [[ ! -r "$ENV_COMPAT_HELPER" ]]; then
  ENV_COMPAT_HELPER="$SCRIPT_DIR/../../../scripts/converact-env-compat.sh"
fi
if [[ ! -r "$ENV_COMPAT_HELPER" ]]; then
  ENV_COMPAT_HELPER="$SCRIPT_DIR/converact-env-compat.sh"
fi
if [[ ! -r "$ENV_COMPAT_HELPER" ]]; then
  printf 'Converact environment compatibility helper is required\n' >&2
  exit 66
fi
# shellcheck disable=SC1090
source "$ENV_COMPAT_HELPER"
converact_env_resolve_fabric RTPENGINE_ARCHIVE_FILE

VERSION="mr26.0.1.13"
COMMIT="506cfa74386a5373e40fca139a932917f22f0524"
ARCHIVE_URL="https://codeload.github.com/sipwise/rtpengine/tar.gz/refs/tags/${VERSION}"
ARCHIVE_SHA256="a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143"
ARCHIVE_SIZE="6987926"

OUTPUT_DIR="${1:-}"
if [[ -z "$OUTPUT_DIR" ]]; then
  printf 'usage: %s NEW_EMPTY_OUTPUT_DIRECTORY\n' "$0" >&2
  exit 64
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
if find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  printf 'RTPengine output directory must be empty: %s\n' "$OUTPUT_DIR" >&2
  exit 64
fi

for command in git tar; do
  command -v "$command" >/dev/null || {
    printf '%s is required\n' "$command" >&2
    exit 69
  }
done
if [[ -z "${CONVERACT_FABRIC_RTPENGINE_ARCHIVE_FILE:-}" ]]; then
  command -v curl >/dev/null || {
    printf 'curl is required\n' >&2
    exit 69
  }
fi

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/converact-rtpengine-source.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT

ARCHIVE_FILE="${CONVERACT_FABRIC_RTPENGINE_ARCHIVE_FILE:-$BUILD_ROOT/rtpengine.tar.gz}"
if [[ -z "${CONVERACT_FABRIC_RTPENGINE_ARCHIVE_FILE:-}" ]]; then
  curl \
    --fail \
    --location \
    --retry 2 \
    --connect-timeout 10 \
    --output "$ARCHIVE_FILE" \
    "$ARCHIVE_URL"
  RESOLVED_COMMIT="$(
    git ls-remote \
      https://github.com/sipwise/rtpengine.git \
      "refs/tags/${VERSION}" |
      awk 'NR == 1 { print $1 }'
  )"
  if [[ "$RESOLVED_COMMIT" != "$COMMIT" ]]; then
    printf 'RTPengine release tag commit mismatch\n' >&2
    exit 65
  fi
fi

ACTUAL_SIZE="$(wc -c < "$ARCHIVE_FILE" | tr -d '[:space:]')"
if [[ "$ACTUAL_SIZE" != "$ARCHIVE_SIZE" ]]; then
  printf 'RTPengine archive size mismatch: expected %s, got %s\n' \
    "$ARCHIVE_SIZE" "$ACTUAL_SIZE" >&2
  exit 65
fi

if command -v sha256sum >/dev/null; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE_FILE" | awk '{print $1}')"
else
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_FILE" | awk '{print $1}')"
fi
if [[ "$ACTUAL_SHA256" != "$ARCHIVE_SHA256" ]]; then
  printf 'RTPengine archive SHA-256 mismatch\n' >&2
  exit 65
fi

STAGING_DIR="$BUILD_ROOT/source"
mkdir -p "$STAGING_DIR"
tar -xzf "$ARCHIVE_FILE" -C "$STAGING_DIR" --strip-components=1
for required in \
  README.md \
  daemon/control_ng.c \
  docs/ng_control_protocol.md \
  kernel-module/Makefile; do
  [[ -f "$STAGING_DIR/$required" ]] || {
    printf 'RTPengine archive is missing %s\n' "$required" >&2
    exit 65
  }
done

printf '%s\n' \
  '{' \
  '  "schema_version": "1.0.0",' \
  '  "component_id": "rtpengine",' \
  "  \"version\": \"$VERSION\"," \
  "  \"release_ref\": \"$VERSION\"," \
  "  \"commit\": \"$COMMIT\"," \
  "  \"archive_sha256\": \"$ARCHIVE_SHA256\"," \
  "  \"archive_size_bytes\": $ARCHIVE_SIZE" \
  '}' > "$STAGING_DIR/converact-source-identity.json"

git -C "$STAGING_DIR" init -q
git -C "$STAGING_DIR" add .
GIT_AUTHOR_NAME="converact-source-import" \
GIT_AUTHOR_EMAIL="converact-source-import@localhost" \
GIT_AUTHOR_DATE="2026-05-27T16:28:00Z" \
GIT_COMMITTER_NAME="converact-source-import" \
GIT_COMMITTER_EMAIL="converact-source-import@localhost" \
GIT_COMMITTER_DATE="2026-05-27T16:28:00Z" \
  git -C "$STAGING_DIR" commit -qm "Import RTPengine ${VERSION}"

cp -R "$STAGING_DIR/." "$OUTPUT_DIR/"
printf '%s\n' "$OUTPUT_DIR"
