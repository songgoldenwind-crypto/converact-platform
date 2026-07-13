#!/bin/sh
set -eu

find_pg_tool() {
  tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
    return
  fi
  if command -v pg_config >/dev/null 2>&1; then
    candidate="$(pg_config --bindir)/$tool"
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  fi
  for directory in \
    /opt/homebrew/opt/postgresql@17/bin \
    /opt/homebrew/opt/postgresql@16/bin \
    /opt/homebrew/opt/postgresql@15/bin \
    /usr/local/opt/postgresql@17/bin \
    /usr/local/opt/postgresql@16/bin \
    /usr/local/opt/postgresql@15/bin
  do
    if [ -x "$directory/$tool" ]; then
      printf '%s\n' "$directory/$tool"
      return
    fi
  done
  printf 'PostgreSQL tool not found: %s\n' "$tool" >&2
  exit 1
}

INITDB="$(find_pg_tool initdb)"
PG_CTL="$(find_pg_tool pg_ctl)"
CREATEDB="$(find_pg_tool createdb)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ivekit-postgres.XXXXXX")"
MARKER="$ROOT/.ivekit-postgres-harness"
DATA="$ROOT/data"
SOCKET="$ROOT/socket"
LOG="$ROOT/postgres.log"
PORT=$((55000 + ($$ % 1000)))
RUNTIME_PASSWORD='ivekit-runtime-integration-password'

printf 'ivekit-postgres-harness-v1\n' > "$MARKER"
mkdir -p "$SOCKET"

cleanup() {
  status=$?
  if [ -f "$DATA/postmaster.pid" ]; then
    "$PG_CTL" -D "$DATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$LOG" ]; then
    tail -n 160 "$LOG"
  fi
  if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = 'ivekit-postgres-harness-v1' ]; then
    rm -rf "$ROOT"
  fi
  exit "$status"
}
trap cleanup INT TERM HUP EXIT

"$INITDB" -D "$DATA" -U opc_admin --auth=trust --no-locale >/dev/null
"$PG_CTL" -D "$DATA" -l "$LOG" -o "-F -k $SOCKET -p $PORT" -w start >/dev/null
"$CREATEDB" -h 127.0.0.1 -p "$PORT" -U opc_admin ivekit_fresh
"$CREATEDB" -h 127.0.0.1 -p "$PORT" -U opc_admin ivekit_upgrade

export OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL="postgresql://opc_admin@127.0.0.1:$PORT/ivekit_fresh?sslmode=disable"
export OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL="postgresql://opc_runtime:$RUNTIME_PASSWORD@127.0.0.1:$PORT/ivekit_fresh?sslmode=disable"
export OPC_IVEKIT_UPGRADE_TEST_DATABASE_URL="postgresql://opc_admin@127.0.0.1:$PORT/ivekit_upgrade?sslmode=disable"
export OPC_IVEKIT_UPGRADE_TEST_RUNTIME_DATABASE_URL="postgresql://opc_runtime:$RUNTIME_PASSWORD@127.0.0.1:$PORT/ivekit_upgrade?sslmode=disable"
export OPC_IVEKIT_STANDALONE_TEST_RUNTIME_PASSWORD="$RUNTIME_PASSWORD"

node --import tsx --test test/ivekit-standalone-postgres.test.ts

trap - INT TERM HUP EXIT
"$PG_CTL" -D "$DATA" -m fast -w stop >/dev/null
rm -rf "$ROOT"
