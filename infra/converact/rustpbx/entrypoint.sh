#!/bin/sh
set -eu

requested="${RUSTPBX_NOFILE_LIMIT:-262144}"
case "$requested" in
  ''|*[!0-9]*)
    echo "RUSTPBX_NOFILE_LIMIT must be a positive integer" >&2
    exit 78
    ;;
esac
if [ "$requested" -lt 1024 ]; then
  echo "RUSTPBX_NOFILE_LIMIT must be at least 1024" >&2
  exit 78
fi

hard="$(ulimit -Hn)"
if [ "$hard" != unlimited ] && [ "$hard" -lt "$requested" ]; then
  echo "RustPBX hard nofile limit $hard is below requested $requested" >&2
  exit 78
fi
ulimit -Sn "$requested"

exec /app/rustpbx "$@"
