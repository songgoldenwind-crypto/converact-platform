#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUSTPBX_COMMIT="6c49ee76baa54fdbf8f98020cc9bee158c7c15de"
RSIPSTACK_COMMIT="8318e97b1170de4e5245b120afec1cdf53e3d716"
RUST_BUILDER_IMAGE="rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55"
IMAGE="${IVEKIT_RUSTPBX_IMAGE:-ivekit/rustpbx:0.4.11-tcp-reconnect-6c49ee76}"

case "$(uname -m)" in
  x86_64) NATIVE_ARCH="amd64" ;;
  arm64|aarch64) NATIVE_ARCH="arm64" ;;
  *) echo "unsupported RustPBX build architecture: $(uname -m)" >&2; exit 1 ;;
esac
TARGETARCH="${TARGETARCH:-$NATIVE_ARCH}"
if [[ "$TARGETARCH" != "$NATIVE_ARCH" ]]; then
  echo "cross compilation is not supported by this script; run it on a native $TARGETARCH builder" >&2
  exit 1
fi

for command in docker git; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ivekit-rustpbx-build.XXXXXX")"
cleanup() { rm -rf "$BUILD_ROOT"; }
trap cleanup EXIT

git clone --filter=blob:none --no-checkout https://github.com/restsend/rustpbx.git "$BUILD_ROOT/rustpbx"
git -C "$BUILD_ROOT/rustpbx" checkout --detach "$RUSTPBX_COMMIT"
git clone --filter=blob:none --no-checkout https://github.com/restsend/rsipstack.git "$BUILD_ROOT/rsipstack"
git -C "$BUILD_ROOT/rsipstack" checkout --detach "$RSIPSTACK_COMMIT"

git -C "$BUILD_ROOT/rsipstack" apply --check "$ROOT_DIR/infra/ivekit/rustpbx/patches/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$ROOT_DIR/infra/ivekit/rustpbx/patches/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$ROOT_DIR/infra/ivekit/rustpbx/patches/rustpbx-local-rsipstack.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$ROOT_DIR/infra/ivekit/rustpbx/patches/rustpbx-local-rsipstack.patch"

cp "$ROOT_DIR/infra/ivekit/rustpbx/Cargo.lock" "$BUILD_ROOT/rustpbx/Cargo.lock"
cp "$ROOT_DIR/infra/ivekit/rustpbx/Dockerfile.runtime" "$BUILD_ROOT/rustpbx/Dockerfile.ivekit"

docker run --rm \
  -v "$BUILD_ROOT:/build" \
  -w /build/rustpbx \
  "$RUST_BUILDER_IMAGE" \
  cargo build --locked --release --features cross --bin rustpbx --bin sipflow

mkdir -p "$BUILD_ROOT/rustpbx/bin/$TARGETARCH"
cp "$BUILD_ROOT/rustpbx/target/release/rustpbx" "$BUILD_ROOT/rustpbx/bin/$TARGETARCH/rustpbx"
cp "$BUILD_ROOT/rustpbx/target/release/sipflow" "$BUILD_ROOT/rustpbx/bin/$TARGETARCH/sipflow"

docker build \
  -f "$BUILD_ROOT/rustpbx/Dockerfile.ivekit" \
  --build-arg "TARGETARCH=$TARGETARCH" \
  --build-arg "RUSTPBX_COMMIT=$RUSTPBX_COMMIT" \
  --build-arg "RSIPSTACK_COMMIT=$RSIPSTACK_COMMIT" \
  -t "$IMAGE" \
  "$BUILD_ROOT/rustpbx"

docker image inspect "$IMAGE" --format '{{.Id}}'
