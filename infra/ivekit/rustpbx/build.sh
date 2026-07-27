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
RUSTRTC_COMMIT="166c6d22984429eb6b509920c14fcd69f974f0b3"
RUST_BUILDER_IMAGE="rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55"
PATCHSET="ivekit.28"
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
git clone --filter=blob:none --no-checkout https://github.com/restsend/rustrtc.git "$BUILD_ROOT/rustrtc"
git -C "$BUILD_ROOT/rustrtc" checkout --detach "$RUSTRTC_COMMIT"

git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-capacity.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-capacity.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-retransmission-atomicity.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-retransmission-atomicity.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-dialog-recovery.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-dialog-recovery.patch"
git -C "$BUILD_ROOT/rustrtc" apply --check "$PATCH_DIR/rustrtc-ivekit-udp-socket-capacity.patch"
git -C "$BUILD_ROOT/rustrtc" apply "$PATCH_DIR/rustrtc-ivekit-udp-socket-capacity.patch"
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
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-local-rustrtc.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-local-rustrtc.patch"
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
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-callrecord-database-policy.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-callrecord-database-policy.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-callrecord-runtime-isolation.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-callrecord-runtime-isolation.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-callrecord-failure-telemetry.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-callrecord-failure-telemetry.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-webphone-edge-auth.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-webphone-edge-auth.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-realtime-audio-tap.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-realtime-audio-tap.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-http-client-capacity.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-http-client-capacity.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-media-control-client.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-media-control-client.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-media-lifecycle.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-media-lifecycle.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-dialog-shadow.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-dialog-shadow.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-dialog-recovery.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-dialog-recovery.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-dual-leg-cdr.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-dual-leg-cdr.patch"

mkdir -p "$BUILD_ROOT/rustpbx/vendor/ivekit-component-hook"
cp -R "$HOOK_DIR/." \
  "$BUILD_ROOT/rustpbx/vendor/ivekit-component-hook/"
cp "$SCRIPT_DIR/Cargo.lock" "$BUILD_ROOT/rustpbx/Cargo.lock"
cp "$SCRIPT_DIR/Dockerfile.runtime" "$BUILD_ROOT/rustpbx/Dockerfile.ivekit"
cp "$SCRIPT_DIR/entrypoint.sh" "$BUILD_ROOT/rustpbx/entrypoint.ivekit.sh"

DOCKER_RUN_ARGS=(--rm)
if [[ -n "${IVEKIT_RUSTPBX_BUILD_CPUS:-}" ]]; then
  DOCKER_RUN_ARGS+=(--cpus "$IVEKIT_RUSTPBX_BUILD_CPUS")
fi
if [[ -n "${IVEKIT_RUSTPBX_BUILD_MEMORY:-}" ]]; then
  DOCKER_RUN_ARGS+=(--memory "$IVEKIT_RUSTPBX_BUILD_MEMORY")
fi
if [[ -n "${IVEKIT_RUSTPBX_BUILD_JOBS:-}" ]]; then
  [[ "$IVEKIT_RUSTPBX_BUILD_JOBS" =~ ^[1-9][0-9]*$ ]] || {
    echo "IVEKIT_RUSTPBX_BUILD_JOBS must be a positive integer" >&2
    exit 1
  }
  DOCKER_RUN_ARGS+=(-e "CARGO_BUILD_JOBS=$IVEKIT_RUSTPBX_BUILD_JOBS")
fi
if [[ -n "${IVEKIT_RUSTPBX_CARGO_HOME:-}" ]]; then
  mkdir -p "$IVEKIT_RUSTPBX_CARGO_HOME"
  CARGO_HOME_DIR="$(cd "$IVEKIT_RUSTPBX_CARGO_HOME" && pwd)"
  DOCKER_RUN_ARGS+=(-v "$CARGO_HOME_DIR:/cargo-home" -e CARGO_HOME=/cargo-home)
fi

if [[ "${IVEKIT_RUSTPBX_VERIFY_ONLY:-0}" == "1" ]]; then
  mapfile -t IVEKIT_RUSTPBX_FORMAT_FILES < <(
    git -C "$BUILD_ROOT/rustpbx" apply --numstat \
      "$PATCH_DIR/rustpbx-ivekit-dual-leg-cdr.patch" |
      awk '$3 ~ /\.rs$/ { print $3 }'
  )
  ((${#IVEKIT_RUSTPBX_FORMAT_FILES[@]} > 0)) || {
    echo "iveKit RustPBX format scope is empty" >&2
    exit 1
  }
  docker run "${DOCKER_RUN_ARGS[@]}" \
    -v "$BUILD_ROOT:/build" \
    -w /build/rustpbx \
    "$RUST_BUILDER_IMAGE" \
    bash -euo pipefail -c '
      rustup component add rustfmt clippy
      rustfmt --edition 2024 --check --config skip_children=true "$@"
      cargo fmt --manifest-path vendor/ivekit-component-hook/Cargo.toml -- --check
      cargo check --locked --features cross --bin rustpbx --bin sipflow
      cargo clippy --locked --lib --features cross --no-deps
      cargo test --locked --lib ivekit_
      cargo test --locked --lib missing_callee_terminal_data_stays_independent_from_the_caller
      cargo test --locked --test ivekit_dialog_shadow_contract_test
    ' bash "${IVEKIT_RUSTPBX_FORMAT_FILES[@]}"
  exit 0
fi

if [[ -n "${IVEKIT_RUSTPBX_LOCKFILE_OUTPUT:-}" ]]; then
  docker run "${DOCKER_RUN_ARGS[@]}" \
    -v "$BUILD_ROOT:/build" \
    -w /build/rustpbx \
    "$RUST_BUILDER_IMAGE" \
    cargo metadata --format-version 1 >/dev/null
  LOCKFILE_OUTPUT_DIR="$(dirname "$IVEKIT_RUSTPBX_LOCKFILE_OUTPUT")"
  mkdir -p "$LOCKFILE_OUTPUT_DIR"
  cp "$BUILD_ROOT/rustpbx/Cargo.lock" "$IVEKIT_RUSTPBX_LOCKFILE_OUTPUT"
  printf '%s\n' "$IVEKIT_RUSTPBX_LOCKFILE_OUTPUT"
  exit 0
fi

docker run "${DOCKER_RUN_ARGS[@]}" \
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
  --build-arg "RUSTRTC_COMMIT=$RUSTRTC_COMMIT" \
  --build-arg "IVEKIT_PATCHSET=$PATCHSET" \
  -t "$IMAGE" \
  "$BUILD_ROOT/rustpbx"

docker image inspect "$IMAGE" --format '{{.Id}}'
