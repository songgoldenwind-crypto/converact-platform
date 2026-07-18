#!/usr/bin/env sh
set -eu

RUSTDESK_SERVER_SOURCE_DIR=${RUSTDESK_SERVER_SOURCE_DIR:?set RUSTDESK_SERVER_SOURCE_DIR}
RUSTDESK_SERVER_IMAGE=${RUSTDESK_SERVER_IMAGE:-ivekit/rustdesk-server:1.1.15-owner-candidate}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

git -C "$RUSTDESK_SERVER_SOURCE_DIR" submodule update --init --recursive
node "$SCRIPT_DIR/apply-overlay.mjs" "$RUSTDESK_SERVER_SOURCE_DIR"
cargo test --locked --manifest-path "$RUSTDESK_SERVER_SOURCE_DIR/Cargo.toml"
docker build \
  --file "$SCRIPT_DIR/Dockerfile" \
  --label "org.opencontainers.image.revision=9bae9f2f39d92c4b4ba2e28e089da5071897b22e" \
  --label "io.ivekit.component=rustdesk-server" \
  --label "io.ivekit.owner-contract=component-node-v1" \
  --tag "$RUSTDESK_SERVER_IMAGE" \
  "$RUSTDESK_SERVER_SOURCE_DIR"
