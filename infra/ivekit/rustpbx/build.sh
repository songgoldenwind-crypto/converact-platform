#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$SCRIPT_DIR/patches"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK_DIR="$SOURCE_ROOT/integrations/component-hook-rs"
if [[ ! -d "$HOOK_DIR" && -d "$BUNDLE_ROOT/fork-hooks/rust" ]]; then
  HOOK_DIR="$BUNDLE_ROOT/fork-hooks/rust"
fi
RUSTPBX_COMMIT="6c49ee76baa54fdbf8f98020cc9bee158c7c15de"
RSIPSTACK_COMMIT="8318e97b1170de4e5245b120afec1cdf53e3d716"
RUST_BUILDER_IMAGE="rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55"
PATCHSET="ivekit.12"
IMAGE="${IVEKIT_RUSTPBX_IMAGE:-ivekit/rustpbx:0.4.11-${PATCHSET}-6c49ee76}"

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
[[ -f "$HOOK_DIR/Cargo.toml" && -f "$HOOK_DIR/src/lib.rs" ]] || {
  echo "iveKit Rust component hook is required" >&2
  exit 1
}

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ivekit-rustpbx-build.XXXXXX")"
cleanup() { rm -rf "$BUILD_ROOT"; }
trap cleanup EXIT

git clone --filter=blob:none --no-checkout https://github.com/restsend/rustpbx.git "$BUILD_ROOT/rustpbx"
git -C "$BUILD_ROOT/rustpbx" checkout --detach "$RUSTPBX_COMMIT"
git clone --filter=blob:none --no-checkout https://github.com/restsend/rsipstack.git "$BUILD_ROOT/rsipstack"
git -C "$BUILD_ROOT/rsipstack" checkout --detach "$RSIPSTACK_COMMIT"

git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-capacity.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-capacity.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-retransmission-atomicity.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-retransmission-atomicity.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-ami-dialogs.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-ami-dialogs.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-rwi-originate-hangup.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-rwi-originate-hangup.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-route-snapshot.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-route-snapshot.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-inbound-admission.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-inbound-admission.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-owner-epoch.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-owner-epoch.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-recording-spool.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-recording-spool.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-local-rsipstack.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-local-rsipstack.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-sip-capacity.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-sip-capacity.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-media-hot-path.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-media-hot-path.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-session-cleanup-isolation.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-session-cleanup-isolation.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-webphone-registry.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-webphone-registry.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-callrecord-capacity.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-callrecord-capacity.patch"

mkdir -p "$BUILD_ROOT/rustpbx/vendor/ivekit-component-hook"
cp -R "$HOOK_DIR/." \
  "$BUILD_ROOT/rustpbx/vendor/ivekit-component-hook/"
cp "$SCRIPT_DIR/Cargo.lock" "$BUILD_ROOT/rustpbx/Cargo.lock"
cp "$SCRIPT_DIR/Dockerfile.runtime" "$BUILD_ROOT/rustpbx/Dockerfile.ivekit"
cp "$SCRIPT_DIR/entrypoint.sh" "$BUILD_ROOT/rustpbx/entrypoint.ivekit.sh"

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
  --build-arg "IVEKIT_PATCHSET=$PATCHSET" \
  -t "$IMAGE" \
  "$BUILD_ROOT/rustpbx"

docker image inspect "$IMAGE" --format '{{.Id}}'
