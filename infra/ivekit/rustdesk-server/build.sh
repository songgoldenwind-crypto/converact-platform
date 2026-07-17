#!/usr/bin/env sh
set -eu

RUSTDESK_SERVER_SOURCE_DIR=${RUSTDESK_SERVER_SOURCE_DIR:?set RUSTDESK_SERVER_SOURCE_DIR}
RUSTDESK_SERVER_IMAGE=${RUSTDESK_SERVER_IMAGE:-ivekit/rustdesk-server:1.1.15-owner-candidate}

git -C "$RUSTDESK_SERVER_SOURCE_DIR" submodule update --init --recursive
node infra/ivekit/rustdesk-server/apply-overlay.mjs "$RUSTDESK_SERVER_SOURCE_DIR"
cargo test --locked --manifest-path "$RUSTDESK_SERVER_SOURCE_DIR/Cargo.toml"
docker build -t "$RUSTDESK_SERVER_IMAGE" "$RUSTDESK_SERVER_SOURCE_DIR"
