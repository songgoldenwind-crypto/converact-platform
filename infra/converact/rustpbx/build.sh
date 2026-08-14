#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/../../../scripts/converact-env-compat.sh"
converact_env_install_aliases
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
PATCHSET="ivekit.81"
IMAGE="${CONVERACT_FABRIC_RUSTPBX_IMAGE:-converact/rustpbx:0.4.11-${PATCHSET}-6c49ee76}"

if command -v sha256sum >/dev/null; then
  SHA256_COMMAND=(sha256sum)
elif command -v shasum >/dev/null; then
  SHA256_COMMAND=(shasum -a 256)
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi

PATCH_SET_SHA256="$(
  (
    cd "$PATCH_DIR"
    while IFS= read -r patch; do
      printf '%s\0' "${patch#./}"
      cat "$patch"
      printf '\0'
    done < <(find . -type f -name '*.patch' -print | LC_ALL=C sort)
  ) | "${SHA256_COMMAND[@]}" | awk '{ print $1 }'
)"
[[ "$PATCH_SET_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
  echo "RustPBX patch-set SHA-256 is invalid" >&2
  exit 1
}

if git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  RELEVANT_STATUS="$(
    git -C "$SOURCE_ROOT" status --porcelain -- \
      infra/converact/rustpbx integrations/component-hook-rs
  )"
  [[ -z "$RELEVANT_STATUS" ]] || {
    echo "RustPBX build inputs contain uncommitted changes" >&2
    exit 1
  }
  CONVERACT_SOURCE_COMMIT="$(
    git -C "$SOURCE_ROOT" rev-parse HEAD
  )"
else
  CONVERACT_SOURCE_COMMIT="${CONVERACT_SOURCE_COMMIT:-}"
fi
[[ "$CONVERACT_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || {
  echo "exact Converact Platform source commit is required" >&2
  exit 1
}

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
  echo "Converact Fabric Rust component hook is required" >&2
  exit 1
}

RUSTPBX_SOURCE_DIR="${CONVERACT_FABRIC_RUSTPBX_SOURCE_DIR:-}"
RSIPSTACK_SOURCE_DIR="${CONVERACT_FABRIC_RSIPSTACK_SOURCE_DIR:-}"
RUSTRTC_SOURCE_DIR="${CONVERACT_FABRIC_RUSTRTC_SOURCE_DIR:-}"
SOURCE_OVERRIDE_COUNT=0
for source_dir in "$RUSTPBX_SOURCE_DIR" "$RSIPSTACK_SOURCE_DIR" "$RUSTRTC_SOURCE_DIR"; do
  if [[ -n "$source_dir" ]]; then
    ((SOURCE_OVERRIDE_COUNT += 1))
  fi
done
if ((SOURCE_OVERRIDE_COUNT != 0 && SOURCE_OVERRIDE_COUNT != 3)); then
  echo "all three Rust source overrides must be provided together" >&2
  exit 1
fi

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/converact-rustpbx-build.XXXXXX")"
ROOT_OWNED_BUILD_OUTPUT=0
cleanup() {
  local status="$?"
  trap - EXIT
  if [[ "$ROOT_OWNED_BUILD_OUTPUT" == 1 ]]; then
    docker run --rm \
      -v "$BUILD_ROOT:/build" \
      "$RUST_BUILDER_IMAGE" \
      chown -R "$HOST_UID:$HOST_GID" /build \
      >/dev/null 2>&1 || true
  fi
  rm -rf "$BUILD_ROOT" || true
  exit "$status"
}
trap cleanup EXIT

clone_pinned_source() {
  local component="$1"
  local expected_commit="$2"
  local remote_url="$3"
  local source_dir="$4"
  local destination="$5"

  if [[ -n "$source_dir" ]]; then
    source_dir="$(cd "$source_dir" && pwd -P)"
    git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
      echo "$component source override is not a Git worktree" >&2
      exit 1
    }
    [[ -z "$(git -C "$source_dir" status --porcelain --untracked-files=all)" ]] || {
      echo "$component source override is not clean" >&2
      exit 1
    }
    local actual_commit
    actual_commit="$(git -C "$source_dir" rev-parse HEAD)"
    [[ "$actual_commit" == "$expected_commit" ]] || {
      echo "$component source override does not match $expected_commit" >&2
      exit 1
    }
    git clone --no-local --no-checkout "$source_dir" "$destination"
  else
    git clone --filter=blob:none --no-checkout "$remote_url" "$destination"
  fi

  git -C "$destination" checkout --detach "$expected_commit"
  [[ "$(git -C "$destination" rev-parse HEAD)" == "$expected_commit" ]] || {
    echo "$component checkout does not match $expected_commit" >&2
    exit 1
  }
}

clone_pinned_source \
  rustpbx \
  "$RUSTPBX_COMMIT" \
  https://github.com/restsend/rustpbx.git \
  "$RUSTPBX_SOURCE_DIR" \
  "$BUILD_ROOT/rustpbx"
clone_pinned_source \
  rsipstack \
  "$RSIPSTACK_COMMIT" \
  https://github.com/restsend/rsipstack.git \
  "$RSIPSTACK_SOURCE_DIR" \
  "$BUILD_ROOT/rsipstack"
clone_pinned_source \
  rustrtc \
  "$RUSTRTC_COMMIT" \
  https://github.com/restsend/rustrtc.git \
  "$RUSTRTC_SOURCE_DIR" \
  "$BUILD_ROOT/rustrtc"

git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-tcp-reconnect.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-capacity.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-capacity.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-retransmission-atomicity.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-retransmission-atomicity.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-dialog-recovery.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-dialog-recovery.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-prepared-invite.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-prepared-invite.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-rejection-headers.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-rejection-headers.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-single-trying.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-single-trying.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-server-invite-lifecycle.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-server-invite-lifecycle.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-wire-guard.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-wire-guard.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-ivekit-bounded-protocol-mailboxes.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-ivekit-bounded-protocol-mailboxes.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-durable-egress-effect-gate.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-durable-egress-effect-gate.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-canonical-wire-freeze.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-canonical-wire-freeze.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-protocol-observation.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-protocol-observation.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-derived-non-2xx-ack.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-derived-non-2xx-ack.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-peer-ingress-proof.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-peer-ingress-proof.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-peer-derived-cancel-response.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-peer-derived-cancel-response.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-uas-2xx-owner.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-uas-2xx-owner.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-uas-2xx-owner-retention.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-uas-2xx-owner-retention.patch"
git -C "$BUILD_ROOT/rsipstack" apply --check "$PATCH_DIR/rsipstack-converact-transaction-local-matched-cancel-pair.patch"
git -C "$BUILD_ROOT/rsipstack" apply "$PATCH_DIR/rsipstack-converact-transaction-local-matched-cancel-pair.patch"
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
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-cdr-mtls-noop.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-cdr-mtls-noop.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-media-tracing.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-media-tracing.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-inbound-admission-response-contract.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-inbound-admission-response-contract.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-session-media-profile.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-session-media-profile.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-recording-lifecycle-reservation.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-recording-lifecycle-reservation.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-processing-terminal-events.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-processing-terminal-events.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-processing-ivr-execution.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-processing-ivr-execution.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-server-invite-owner.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-server-invite-owner.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-inbound-refer-wire.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-inbound-refer-wire.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-ivekit-bounded-call-mailboxes.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-ivekit-bounded-call-mailboxes.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-identity.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-identity.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-registry.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-registry.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-outbound-call-admission.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-outbound-call-admission.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-leg-model.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-leg-model.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-runtime-composition.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-runtime-composition.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-directional-native-call-lifecycle.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-directional-native-call-lifecycle.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-durable-sip-effect-domain.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-durable-sip-effect-domain.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-store.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-store.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-transitions.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-transitions.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-reconciliation.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-reconciliation.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-repair-batch.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-repair-batch.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-live-authority.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-live-authority.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-rsipstack-sip-effect-gate.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-rsipstack-sip-effect-gate.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-protocol-observation.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-protocol-observation.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-derived-non-2xx-ack.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-derived-non-2xx-ack.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-peer-derived-cancel-response.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-peer-derived-cancel-response.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-uas-2xx-owner.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-uas-2xx-owner.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-uas-2xx-owner-retention.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-uas-2xx-owner-retention.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-recovery-identity.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-recovery-identity.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-test-fixture.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-test-fixture.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-role-scoped-fixture.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-role-scoped-fixture.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-db-clock-fixture.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-db-clock-fixture.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-returning-alias.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-returning-alias.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-sip-effect-observer-supervisor.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-sip-effect-observer-supervisor.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-sip-effect-reconciler-supervisor.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-sip-effect-reconciler-supervisor.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-matched-cancel-capabilities.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-matched-cancel-capabilities.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-response-capabilities.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-response-capabilities.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-cleanup-fence.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-cleanup-fence.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-native-call-capability-recovery.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-native-call-capability-recovery.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-capability-recovery-oracle.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-capability-recovery-oracle.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-durable-sip-runtime-composition.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-durable-sip-runtime-composition.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-recovered-call-admission.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-recovered-call-admission.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-trusted-recovery-proof.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-trusted-recovery-proof.patch"
git -C "$BUILD_ROOT/rustpbx" apply --check "$PATCH_DIR/rustpbx-converact-recovered-active-call.patch"
git -C "$BUILD_ROOT/rustpbx" apply "$PATCH_DIR/rustpbx-converact-recovered-active-call.patch"

mkdir -p "$BUILD_ROOT/rustpbx/vendor/converact-component-hook"
cp -R "$HOOK_DIR/." \
  "$BUILD_ROOT/rustpbx/vendor/converact-component-hook/"
cp "$SCRIPT_DIR/Cargo.lock" "$BUILD_ROOT/rustpbx/Cargo.lock"
cp "$SCRIPT_DIR/rsipstack.Cargo.lock" "$BUILD_ROOT/rsipstack/Cargo.lock"
cp "$SCRIPT_DIR/Dockerfile.runtime" "$BUILD_ROOT/rustpbx/Dockerfile.converact"
cp "$SCRIPT_DIR/entrypoint.sh" "$BUILD_ROOT/rustpbx/entrypoint.converact.sh"

DOCKER_RUN_ARGS=(--rm)
if [[ -n "${CONVERACT_FABRIC_RUSTPBX_BUILD_CPUS:-}" ]]; then
  DOCKER_RUN_ARGS+=(--cpus "$CONVERACT_FABRIC_RUSTPBX_BUILD_CPUS")
fi
if [[ -n "${CONVERACT_FABRIC_RUSTPBX_BUILD_MEMORY:-}" ]]; then
  DOCKER_RUN_ARGS+=(--memory "$CONVERACT_FABRIC_RUSTPBX_BUILD_MEMORY")
fi
if [[ -n "${CONVERACT_FABRIC_RUSTPBX_BUILD_JOBS:-}" ]]; then
  [[ "$CONVERACT_FABRIC_RUSTPBX_BUILD_JOBS" =~ ^[1-9][0-9]*$ ]] || {
    echo "CONVERACT_FABRIC_RUSTPBX_BUILD_JOBS must be a positive integer" >&2
    exit 1
  }
  DOCKER_RUN_ARGS+=(-e "CARGO_BUILD_JOBS=$CONVERACT_FABRIC_RUSTPBX_BUILD_JOBS")
fi
if [[ -n "${CONVERACT_FABRIC_RUSTPBX_CARGO_HOME:-}" ]]; then
  mkdir -p "$CONVERACT_FABRIC_RUSTPBX_CARGO_HOME"
  CARGO_HOME_DIR="$(cd "$CONVERACT_FABRIC_RUSTPBX_CARGO_HOME" && pwd)"
  DOCKER_RUN_ARGS+=(-v "$CARGO_HOME_DIR:/cargo-home" -e CARGO_HOME=/cargo-home)
fi

if [[ "${CONVERACT_FABRIC_RUSTPBX_VERIFY_ONLY:-0}" == "1" ]]; then
  mapfile -t RUSTPBX_FORMAT_FILES < <(
    git -C "$BUILD_ROOT/rustpbx" apply --numstat \
      "$PATCH_DIR/rustpbx-ivekit-media-tracing.patch" \
      "$PATCH_DIR/rustpbx-ivekit-inbound-admission-response-contract.patch" \
      "$PATCH_DIR/rustpbx-ivekit-session-media-profile.patch" \
      "$PATCH_DIR/rustpbx-ivekit-recording-lifecycle-reservation.patch" \
      "$PATCH_DIR/rustpbx-ivekit-processing-terminal-events.patch" \
      "$PATCH_DIR/rustpbx-ivekit-processing-ivr-execution.patch" \
      "$PATCH_DIR/rustpbx-ivekit-server-invite-owner.patch" \
      "$PATCH_DIR/rustpbx-ivekit-inbound-refer-wire.patch" \
      "$PATCH_DIR/rustpbx-ivekit-bounded-call-mailboxes.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-identity.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-registry.patch" \
      "$PATCH_DIR/rustpbx-converact-outbound-call-admission.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-leg-model.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-runtime-composition.patch" \
      "$PATCH_DIR/rustpbx-converact-directional-native-call-lifecycle.patch" \
      "$PATCH_DIR/rustpbx-converact-durable-sip-effect-domain.patch" \
      "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-store.patch" \
      "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-transitions.patch" \
      "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-reconciliation.patch" \
      "$PATCH_DIR/rustpbx-converact-postgres-sip-effect-repair-batch.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-live-authority.patch" \
      "$PATCH_DIR/rustpbx-converact-rsipstack-sip-effect-gate.patch" \
      "$PATCH_DIR/rustpbx-converact-protocol-observation.patch" \
      "$PATCH_DIR/rustpbx-converact-derived-non-2xx-ack.patch" \
      "$PATCH_DIR/rustpbx-converact-peer-derived-cancel-response.patch" \
      "$PATCH_DIR/rustpbx-converact-uas-2xx-owner.patch" \
      "$PATCH_DIR/rustpbx-converact-uas-2xx-owner-retention.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-recovery-identity.patch" \
      "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery.patch" \
      "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-test-fixture.patch" \
      "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-role-scoped-fixture.patch" \
      "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-db-clock-fixture.patch" \
      "$PATCH_DIR/rustpbx-converact-stale-nonterminal-recovery-returning-alias.patch" \
      "$PATCH_DIR/rustpbx-converact-sip-effect-observer-supervisor.patch" \
      "$PATCH_DIR/rustpbx-converact-sip-effect-reconciler-supervisor.patch" \
      "$PATCH_DIR/rustpbx-converact-native-matched-cancel-capabilities.patch" \
      "$PATCH_DIR/rustpbx-converact-native-response-capabilities.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-cleanup-fence.patch" \
      "$PATCH_DIR/rustpbx-converact-native-call-capability-recovery.patch" \
      "$PATCH_DIR/rustpbx-converact-capability-recovery-oracle.patch" \
      "$PATCH_DIR/rustpbx-converact-durable-sip-runtime-composition.patch" \
      "$PATCH_DIR/rustpbx-converact-recovered-call-admission.patch" \
      "$PATCH_DIR/rustpbx-converact-trusted-recovery-proof.patch" \
      "$PATCH_DIR/rustpbx-converact-recovered-active-call.patch" |
      # The .73 patch adds one already-formatted constructor field to this
      # upstream test, whose unrelated baseline still has rustfmt drift.
      # Compile and full-library tests cover it without broadening this patch.
      awk '$3 ~ /\.rs$/ && $3 != "src/proxy/tests/test_auth.rs" { print $3 }'
  )
  ((${#RUSTPBX_FORMAT_FILES[@]} > 0)) || {
    echo "Converact Fabric RustPBX format scope is empty" >&2
    exit 1
  }
  mapfile -t RSIPSTACK_FORMAT_FILES < <(
    {
      printf '%s\n' \
        /build/rsipstack/src/sip/message.rs \
        /build/rsipstack/src/sip/parser.rs \
        /build/rsipstack/src/transaction/endpoint.rs \
        /build/rsipstack/src/transaction/mod.rs \
        /build/rsipstack/src/transaction/timer.rs \
        /build/rsipstack/src/transaction/transaction.rs \
        /build/rsipstack/src/transaction/tests/test_server.rs
      git -C "$BUILD_ROOT/rsipstack" apply --numstat \
        "$PATCH_DIR/rsipstack-ivekit-bounded-protocol-mailboxes.patch" \
        "$PATCH_DIR/rsipstack-converact-durable-egress-effect-gate.patch" \
        "$PATCH_DIR/rsipstack-converact-canonical-wire-freeze.patch" \
        "$PATCH_DIR/rsipstack-converact-protocol-observation.patch" \
        "$PATCH_DIR/rsipstack-converact-derived-non-2xx-ack.patch" \
        "$PATCH_DIR/rsipstack-converact-peer-ingress-proof.patch" \
        "$PATCH_DIR/rsipstack-converact-peer-derived-cancel-response.patch" \
        "$PATCH_DIR/rsipstack-converact-uas-2xx-owner.patch" \
        "$PATCH_DIR/rsipstack-converact-uas-2xx-owner-retention.patch" \
        "$PATCH_DIR/rsipstack-converact-transaction-local-matched-cancel-pair.patch" |
        awk '$3 ~ /\.rs$/ { print "/build/rsipstack/" $3 }'
    } | LC_ALL=C sort -u
  )
  ((${#RSIPSTACK_FORMAT_FILES[@]} > 0)) || {
    echo "Converact Fabric rsipstack format scope is empty" >&2
    exit 1
  }
  ROOT_OWNED_BUILD_OUTPUT=1
  docker run "${DOCKER_RUN_ARGS[@]}" \
    -v "$BUILD_ROOT:/build" \
    -w /build/rustpbx \
    "$RUST_BUILDER_IMAGE" \
    bash -euo pipefail -c '
      rustup component add rustfmt clippy
      rustpbx_format_count="$1"
      shift
      rustfmt --edition 2024 --check --config skip_children=true \
        "${@:1:rustpbx_format_count}"
      shift "$rustpbx_format_count"
      rustfmt --edition 2021 --check --config skip_children=true "$@"
      cargo fmt --manifest-path vendor/converact-component-hook/Cargo.toml -- --check
      cargo check --locked --features cross --bin rustpbx --bin sipflow
      privacy_spec_log="$(mktemp)"
      if cargo rustc --locked --lib --features cross -- \
        --cfg sip_effect_reconciler_privacy_ui \
        --check-cfg "cfg(sip_effect_reconciler_privacy_ui)" \
        >"$privacy_spec_log" 2>&1; then
        echo "SIP effect repair target/spec privacy probe unexpectedly compiled" >&2
        exit 1
      fi
      privacy_spec_code_count="$(
        awk "/^error\\[E0603\\]/{ count++ } END { print count + 0 }" \
          "$privacy_spec_log"
      )"
      privacy_spec_other_code_count="$(
        awk "/^error\\[E[0-9]+\\]/{ if (index(\$0, \"E0603\") == 0) count++ } \
          END { print count + 0 }" "$privacy_spec_log"
      )"
      [[ "$privacy_spec_code_count" == "2" ]]
      [[ "$privacy_spec_other_code_count" == "0" ]]
      grep -Eq "^error\\[E0603\\]: struct .SipEffectRepairTarget. is private$" \
        "$privacy_spec_log"
      grep -Eq "^error\\[E0603\\]: struct .SipEffectRepairGrantSpec. is private$" \
        "$privacy_spec_log"
      sed -n "1,160p" "$privacy_spec_log"

      privacy_direct_log="$(mktemp)"
      if cargo rustc --locked --lib --features cross -- \
        --cfg sip_effect_reconciler_privacy_direct_ui \
        --check-cfg "cfg(sip_effect_reconciler_privacy_direct_ui)" \
        >"$privacy_direct_log" 2>&1; then
        echo "SIP effect repair grant direct-construction probe unexpectedly compiled" >&2
        exit 1
      fi
      privacy_direct_code_count="$(
        awk "/^error\\[E0451\\]/{ count++ } END { print count + 0 }" \
          "$privacy_direct_log"
      )"
      privacy_direct_other_code_count="$(
        awk "/^error\\[E[0-9]+\\]/{ if (index(\$0, \"E0451\") == 0) count++ } \
          END { print count + 0 }" "$privacy_direct_log"
      )"
      [[ "$privacy_direct_code_count" == "1" ]]
      [[ "$privacy_direct_other_code_count" == "0" ]]
      grep -Eq "^error\\[E0451\\]: fields .* of struct .SipEffectRepairGrant. are private$" \
        "$privacy_direct_log"
      sed -n "1,160p" "$privacy_direct_log"

      cargo clippy --locked --lib --features cross --no-deps
      cargo test --locked --lib
      cargo test --locked --lib test_recording_double_start_fails
      cargo test --locked --lib test_recording_pending_start_rejects_duplicate
      cargo test --locked --lib missing_callee_terminal_data_stays_independent_from_the_caller
      cargo test --locked --test ivekit_dialog_shadow_contract_test
      cargo clean --manifest-path /build/rustpbx/Cargo.toml
      cargo fetch --manifest-path /build/rsipstack/Cargo.toml --locked
      cargo test --manifest-path /build/rsipstack/Cargo.toml --offline
    ' bash "${#RUSTPBX_FORMAT_FILES[@]}" \
      "${RUSTPBX_FORMAT_FILES[@]}" \
      "${RSIPSTACK_FORMAT_FILES[@]}"
  exit 0
fi

if [[ -n "${CONVERACT_FABRIC_RUSTPBX_LOCKFILE_OUTPUT:-}" ]]; then
  ROOT_OWNED_BUILD_OUTPUT=1
  docker run "${DOCKER_RUN_ARGS[@]}" \
    -v "$BUILD_ROOT:/build" \
    -w /build/rustpbx \
    "$RUST_BUILDER_IMAGE" \
    cargo metadata --format-version 1 >/dev/null
  LOCKFILE_OUTPUT_DIR="$(dirname "$CONVERACT_FABRIC_RUSTPBX_LOCKFILE_OUTPUT")"
  mkdir -p "$LOCKFILE_OUTPUT_DIR"
  cp "$BUILD_ROOT/rustpbx/Cargo.lock" "$CONVERACT_FABRIC_RUSTPBX_LOCKFILE_OUTPUT"
  printf '%s\n' "$CONVERACT_FABRIC_RUSTPBX_LOCKFILE_OUTPUT"
  exit 0
fi

ROOT_OWNED_BUILD_OUTPUT=1
docker run "${DOCKER_RUN_ARGS[@]}" \
  -v "$BUILD_ROOT:/build" \
  -w /build/rustpbx \
  "$RUST_BUILDER_IMAGE" \
  cargo build --locked --release --features cross --bin rustpbx --bin sipflow

mkdir -p "$BUILD_ROOT/rustpbx/bin/$TARGETARCH"
cp "$BUILD_ROOT/rustpbx/target/release/rustpbx" "$BUILD_ROOT/rustpbx/bin/$TARGETARCH/rustpbx"
cp "$BUILD_ROOT/rustpbx/target/release/sipflow" "$BUILD_ROOT/rustpbx/bin/$TARGETARCH/sipflow"

docker build \
  -f "$BUILD_ROOT/rustpbx/Dockerfile.converact" \
  --build-arg "TARGETARCH=$TARGETARCH" \
  --build-arg "RUSTPBX_COMMIT=$RUSTPBX_COMMIT" \
  --build-arg "RSIPSTACK_COMMIT=$RSIPSTACK_COMMIT" \
  --build-arg "RUSTRTC_COMMIT=$RUSTRTC_COMMIT" \
  --build-arg "CONVERACT_SOURCE_COMMIT=$CONVERACT_SOURCE_COMMIT" \
  --build-arg "IVEKIT_PATCHSET=$PATCHSET" \
  --build-arg "IVEKIT_PATCH_SET_SHA256=$PATCH_SET_SHA256" \
  -t "$IMAGE" \
  "$BUILD_ROOT/rustpbx"

test "$(
  docker image inspect "$IMAGE" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
)" = "$CONVERACT_SOURCE_COMMIT"
test "$(
  docker image inspect "$IMAGE" \
    --format '{{ index .Config.Labels "io.ivekit.rustpbx.patch-set-sha256" }}'
)" = "$PATCH_SET_SHA256"
docker image inspect "$IMAGE" --format '{{.Id}}'
