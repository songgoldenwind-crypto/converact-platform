#!/usr/bin/env sh
set -eu

RUSTDESK_SERVER_SOURCE_DIR=${RUSTDESK_SERVER_SOURCE_DIR:?set RUSTDESK_SERVER_SOURCE_DIR}
RUSTDESK_SERVER_IMAGE=${RUSTDESK_SERVER_IMAGE:-converact/rustdesk-server:1.1.16-ivekit.1-73523b31}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

git -C "$RUSTDESK_SERVER_SOURCE_DIR" submodule update --init --recursive
node "$SCRIPT_DIR/apply-overlay.mjs" "$RUSTDESK_SERVER_SOURCE_DIR"
docker build \
  --file "$SCRIPT_DIR/Dockerfile" \
  --label "org.opencontainers.image.source=https://github.com/rustdesk/rustdesk-server" \
  --label "org.opencontainers.image.version=1.1.16-ivekit.1" \
  --label "org.opencontainers.image.revision=73523b31cfd25d77dee862e6fc9f5e1fb5e485ef" \
  --label "io.converact.component=rustdesk-server" \
  --label "io.ivekit.owner-contract=component-node-v1" \
  --label "io.ivekit.build-contract=rustdesk-server-1.1.16-ivekit.1" \
  --tag "$RUSTDESK_SERVER_IMAGE" \
  "$RUSTDESK_SERVER_SOURCE_DIR"
