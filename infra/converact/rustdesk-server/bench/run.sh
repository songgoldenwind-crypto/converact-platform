#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${TMPDIR:-/tmp}/converact-rustdesk-relay-hot-path-bench"

rustc --edition 2021 -C opt-level=3 "$SCRIPT_DIR/relay-hot-path.rs" -o "$OUTPUT"
"$OUTPUT" "${1:-2000000}" "${2:-20000}"
