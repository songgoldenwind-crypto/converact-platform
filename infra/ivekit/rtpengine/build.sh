#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_PATH="$SCRIPT_DIR/toolchain-lock.json"
ACTION="${1:-all}"

case "$(uname -m)" in
  x86_64) NATIVE_ARCH=amd64 ;;
  arm64|aarch64) NATIVE_ARCH=arm64 ;;
  *)
    echo "unsupported RTPengine build architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TARGETARCH="${TARGETARCH:-$NATIVE_ARCH}"
if [[ "$TARGETARCH" != "$NATIVE_ARCH" ]]; then
  echo "cross compilation is not supported; run on a native $TARGETARCH builder" >&2
  exit 1
fi

case "$ACTION" in
  toolchain|userspace|recording|kernel|all) ;;
  *)
    echo "usage: $0 [toolchain|userspace|recording|kernel|all]" >&2
    exit 64
    ;;
esac

command -v docker >/dev/null || {
  echo "docker is required" >&2
  exit 1
}

lock_value() {
  local key="$1"
  sed -n "s/^[[:space:]]*\"${key}\":[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" \
    "$LOCK_PATH"
}

TOOLCHAIN_TAG="$(lock_value "toolchain_${NATIVE_ARCH}_tag")"
LOCKED_TOOLCHAIN_ID="$(lock_value "toolchain_${NATIVE_ARCH}_image_id")"
DEBIAN_SNAPSHOT="$(lock_value debian_snapshot)"

if [[ "$ACTION" == toolchain ]]; then
  docker build \
    --pull=false \
    --target toolchain \
    --build-arg "DEBIAN_SNAPSHOT=$DEBIAN_SNAPSHOT" \
    -f "$SCRIPT_DIR/Dockerfile.toolchain" \
    -t "$TOOLCHAIN_TAG" \
    "$SCRIPT_DIR"
  ACTUAL_TOOLCHAIN_ID="$(docker image inspect "$TOOLCHAIN_TAG" --format '{{.Id}}')"
  TOOLCHAIN_ID_MATCHES_LOCK=false
  if [[ "$ACTUAL_TOOLCHAIN_ID" == "$LOCKED_TOOLCHAIN_ID" ]]; then
    TOOLCHAIN_ID_MATCHES_LOCK=true
  fi
  printf '%s\n' \
    "toolchain_image_tag=$TOOLCHAIN_TAG" \
    "toolchain_image_id=$ACTUAL_TOOLCHAIN_ID" \
    "toolchain_image_id_matches_lock=$TOOLCHAIN_ID_MATCHES_LOCK" \
    "native_architecture=$NATIVE_ARCH"
  exit 0
fi

TOOLCHAIN_REF="${IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE:-$LOCKED_TOOLCHAIN_ID}"
if [[ -z "${IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE:-}" ]] \
    && { [[ ! "$LOCKED_TOOLCHAIN_ID" =~ ^sha256:[a-f0-9]{64}$ ]] \
      || [[ "$LOCKED_TOOLCHAIN_ID" == sha256:0000000000000000000000000000000000000000000000000000000000000000 ]]; }; then
  echo "toolchain image ID must be pinned as sha256: in toolchain-lock.json" >&2
  exit 78
fi
if [[ ! "$TOOLCHAIN_REF" =~ ^sha256:[a-f0-9]{64}$ ]] \
    && [[ ! "$TOOLCHAIN_REF" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]]; then
  echo "toolchain image must be an immutable image ID or repository@sha256 reference" >&2
  exit 78
fi
if ! docker image inspect "$TOOLCHAIN_REF" >/dev/null 2>&1; then
  if [[ "$TOOLCHAIN_REF" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]]; then
    docker pull "$TOOLCHAIN_REF"
  else
    echo "toolchain image is unavailable; build it locally or provide an immutable repository@sha256 reference" >&2
    exit 78
  fi
fi
ACTUAL_TOOLCHAIN_ID="$(
  docker image inspect "$TOOLCHAIN_REF" --format '{{.Id}}'
)"
ACTUAL_TOOLCHAIN_ARCH="$(
  docker image inspect "$ACTUAL_TOOLCHAIN_ID" --format '{{.Architecture}}'
)"
if [[ "$ACTUAL_TOOLCHAIN_ARCH" != "$TARGETARCH" ]]; then
  echo "toolchain architecture mismatch: expected $TARGETARCH, got $ACTUAL_TOOLCHAIN_ARCH" >&2
  exit 78
fi
ACTUAL_SNAPSHOT="$(
  docker image inspect "$ACTUAL_TOOLCHAIN_ID" \
    --format '{{index .Config.Labels "io.ivekit.toolchain.snapshot"}}'
)"
if [[ "$ACTUAL_SNAPSHOT" != "$DEBIAN_SNAPSHOT" ]]; then
  echo "toolchain snapshot identity mismatch" >&2
  exit 78
fi

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ivekit-rtpengine-build.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT

CONTEXT_DIR="$BUILD_ROOT/context"
SOURCE_DIR="$CONTEXT_DIR/source"
mkdir -p "$SOURCE_DIR" "$CONTEXT_DIR/kernel-headers"
cp "$SCRIPT_DIR/entrypoint.sh" "$CONTEXT_DIR/entrypoint.sh"
cp "$SCRIPT_DIR/rtpengine.conf.template" "$CONTEXT_DIR/rtpengine.conf.template"
chmod 0755 "$CONTEXT_DIR/entrypoint.sh"

SOURCE_RUN_ARGS=(
  --rm
  --user 0:0
  -v "$BUILD_ROOT:/build"
  -v "$SCRIPT_DIR:/overlay:ro"
)
if [[ -n "${IVEKIT_RTPENGINE_ARCHIVE_FILE:-}" ]]; then
  SOURCE_RUN_ARGS+=(
    --network=none
  )
  ARCHIVE_FILE="$(cd "$(dirname "$IVEKIT_RTPENGINE_ARCHIVE_FILE")" && pwd)/$(basename "$IVEKIT_RTPENGINE_ARCHIVE_FILE")"
  SOURCE_RUN_ARGS+=(
    -v "$ARCHIVE_FILE:/input/rtpengine.tar.gz:ro"
    -e IVEKIT_RTPENGINE_ARCHIVE_FILE=/input/rtpengine.tar.gz
  )
fi

docker run "${SOURCE_RUN_ARGS[@]}" "$ACTUAL_TOOLCHAIN_ID" bash -lc '
  set -euo pipefail
  /overlay/fetch-source.sh /build/context/source
  node /overlay/apply-overlay.mjs /build/context/source
  node -e "
    const fs = require(\"fs\");
    const source = JSON.parse(fs.readFileSync(
      \"/build/context/source/ivekit-source-identity.json\", \"utf8\"
    ));
    const patch = JSON.parse(fs.readFileSync(
      \"/build/context/source/ivekit-patch-set-identity.json\", \"utf8\"
    ));
    for (const [key, value] of Object.entries({
      IVEKIT_RTPENGINE_SOURCE_COMMIT: source.commit,
      IVEKIT_RTPENGINE_ARCHIVE_SHA256: source.archive_sha256,
      IVEKIT_RTPENGINE_PATCH_SET_SHA256: patch.patch_set_sha256
    })) {
      if (!/^[a-f0-9]{40,64}$/.test(String(value))) process.exit(65);
      process.stdout.write(key + \"=\" + value + \"\\n\");
    }
  " > /build/context/identity.env
'

# shellcheck disable=SC1091
source "$CONTEXT_DIR/identity.env"

BUILD_JOBS="${IVEKIT_RTPENGINE_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN)}"
if [[ ! "$BUILD_JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "IVEKIT_RTPENGINE_BUILD_JOBS must be a positive integer" >&2
  exit 64
fi

IMAGE_PREFIX="${IVEKIT_RTPENGINE_IMAGE_PREFIX:-ivekit/rtpengine}"
IMAGE_VERSION="${IVEKIT_RTPENGINE_IMAGE_VERSION:-mr26.0.1.13-ivekit.1}"
COMMON_BUILD_ARGS=(
  --network=none
  --pull=false
  -f "$SCRIPT_DIR/Dockerfile.runtime"
  --build-arg "IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE=$ACTUAL_TOOLCHAIN_ID"
  --build-arg "IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE_ID=$ACTUAL_TOOLCHAIN_ID"
  --build-arg "IVEKIT_RTPENGINE_SOURCE_COMMIT=$IVEKIT_RTPENGINE_SOURCE_COMMIT"
  --build-arg "IVEKIT_RTPENGINE_ARCHIVE_SHA256=$IVEKIT_RTPENGINE_ARCHIVE_SHA256"
  --build-arg "IVEKIT_RTPENGINE_PATCH_SET_SHA256=$IVEKIT_RTPENGINE_PATCH_SET_SHA256"
  --build-arg "IVEKIT_BUILD_JOBS=$BUILD_JOBS"
  --build-arg "TARGETARCH=$TARGETARCH"
)

if [[ "$ACTION" == userspace || "$ACTION" == all ]]; then
  docker build "${COMMON_BUILD_ARGS[@]}" \
    --target userspace \
    -t "${IMAGE_PREFIX}:${IMAGE_VERSION}-${TARGETARCH}-userspace" \
    "$CONTEXT_DIR"
fi

if [[ "$ACTION" == recording || "$ACTION" == all ]]; then
  docker build "${COMMON_BUILD_ARGS[@]}" \
    --target recording \
    -t "${IMAGE_PREFIX}:${IMAGE_VERSION}-${TARGETARCH}-recording" \
    "$CONTEXT_DIR"
fi

KERNEL_STATUS=not_run
KERNEL_REASON=kernel_headers_not_provided
if [[ "$ACTION" == kernel || "$ACTION" == all ]]; then
  if [[ -n "${IVEKIT_RTPENGINE_KERNEL_HEADERS_DIR:-}" ]]; then
    KERNEL_HEADERS_DIR="$(
      cd "$IVEKIT_RTPENGINE_KERNEL_HEADERS_DIR" && pwd
    )"
    if [[ ! -f "$KERNEL_HEADERS_DIR/Makefile" ]]; then
      echo "IVEKIT_RTPENGINE_KERNEL_HEADERS_DIR has no kernel Makefile" >&2
      exit 66
    fi
    cp -a "$KERNEL_HEADERS_DIR/." "$CONTEXT_DIR/kernel-headers/"
    KERNEL_RELEASE="${IVEKIT_RTPENGINE_KERNEL_RELEASE:-$(uname -r)}"
    KERNEL_ARTIFACT_IMAGE="${IMAGE_PREFIX}:${IMAGE_VERSION}-${TARGETARCH}-kernel-${KERNEL_RELEASE}-artifact"
    KERNEL_RUNTIME_IMAGE="${IMAGE_PREFIX}:${IMAGE_VERSION}-${TARGETARCH}-kernel-${KERNEL_RELEASE}-runtime"
    docker build "${COMMON_BUILD_ARGS[@]}" \
      --target kernel-artifact \
      --build-arg "IVEKIT_KERNEL_RELEASE=$KERNEL_RELEASE" \
      -t "$KERNEL_ARTIFACT_IMAGE" \
      "$CONTEXT_DIR"
    KERNEL_CONTAINER="$(docker create "$KERNEL_ARTIFACT_IMAGE")"
    docker cp "$KERNEL_CONTAINER:/module-srcversion" \
      "$CONTEXT_DIR/module-srcversion"
    docker rm "$KERNEL_CONTAINER" >/dev/null
    KERNEL_SRCVERSION="$(
      tr -d '\r\n' < "$CONTEXT_DIR/module-srcversion"
    )"
    if [[ ! "$KERNEL_SRCVERSION" =~ ^[A-Fa-f0-9]+$ ]]; then
      echo "kernel artifact has an invalid module srcversion" >&2
      exit 78
    fi
    docker build "${COMMON_BUILD_ARGS[@]}" \
      --target kernel-runtime \
      --build-arg "IVEKIT_KERNEL_RELEASE=$KERNEL_RELEASE" \
      --build-arg "IVEKIT_KERNEL_SRCVERSION=$KERNEL_SRCVERSION" \
      -t "$KERNEL_RUNTIME_IMAGE" \
      "$CONTEXT_DIR"
    KERNEL_STATUS=pass
    KERNEL_REASON=
  elif [[ "$ACTION" == kernel ]]; then
    echo "IVEKIT_RTPENGINE_KERNEL_HEADERS_DIR is required for kernel builds" >&2
    exit 66
  fi
fi

OTHER_ARCH=arm64
if [[ "$NATIVE_ARCH" == arm64 ]]; then
  OTHER_ARCH=amd64
fi
printf '%s\n' \
  "native_architecture=$NATIVE_ARCH" \
  "architecture.${NATIVE_ARCH}=pass" \
  "architecture.${OTHER_ARCH}=not_run" \
  "kernel.status=$KERNEL_STATUS" \
  "kernel.reason=$KERNEL_REASON"
