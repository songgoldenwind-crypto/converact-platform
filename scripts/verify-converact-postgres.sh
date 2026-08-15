#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/converact-env-compat.sh"
converact_env_install_aliases

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
PSQL="$(find_pg_tool psql)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/converact-postgres.XXXXXX")"
MARKER="$ROOT/.converact-postgres-harness"
DATA="$ROOT/data"
SOCKET="$ROOT/socket"
LOG="$ROOT/postgres.log"
PORT=$((55000 + ($$ % 1000)))
RUNTIME_PASSWORD='converact-runtime-integration-password'

printf 'converact-postgres-harness-v1\n' > "$MARKER"
mkdir -p "$SOCKET"

cleanup() {
  status=$?
  if [ -f "$DATA/postmaster.pid" ]; then
    "$PG_CTL" -D "$DATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$LOG" ]; then
    tail -n 160 "$LOG"
  fi
  if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = 'converact-postgres-harness-v1' ]; then
    rm -rf "$ROOT"
  fi
  exit "$status"
}
trap cleanup INT TERM HUP EXIT

"$INITDB" -D "$DATA" -U opc_admin --auth=trust --no-locale >/dev/null
"$PG_CTL" -D "$DATA" -l "$LOG" -o "-F -k $SOCKET -p $PORT" -w start >/dev/null
"$CREATEDB" -h 127.0.0.1 -p "$PORT" -U opc_admin converact_fresh
"$CREATEDB" -h 127.0.0.1 -p "$PORT" -U opc_admin converact_upgrade
"$PSQL" -h 127.0.0.1 -p "$PORT" -U opc_admin -d postgres \
  -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE converact_event_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS" \
  >/dev/null

export CONVERACT_FABRIC_STANDALONE_TEST_DATABASE_URL="postgresql://opc_admin@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
export CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_DATABASE_URL="postgresql://opc_runtime:$RUNTIME_PASSWORD@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
export CONVERACT_FABRIC_UPGRADE_TEST_DATABASE_URL="postgresql://opc_admin@127.0.0.1:$PORT/converact_upgrade?sslmode=disable"
export CONVERACT_FABRIC_UPGRADE_TEST_RUNTIME_DATABASE_URL="postgresql://opc_runtime:$RUNTIME_PASSWORD@127.0.0.1:$PORT/converact_upgrade?sslmode=disable"
export CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_PASSWORD="$RUNTIME_PASSWORD"

node --import tsx --test test/converact-standalone-postgres.test.ts
node --import tsx --test test/converact-sip-effect-postgres.test.ts
node --import tsx --test test/tinode-inbound-store.test.ts
node --import tsx --test test/tinode-inbound-projector.test.ts
node --import tsx --test test/converact-ivr-postgres.test.ts
node --import tsx --test test/converact-voice-controlled-postgres.test.ts
node --import tsx --test test/converact-dialog-terminal-repair-postgres.test.ts

export CONVERACT_TEST_POSTGRES_URL="postgresql://converact_event_runtime@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
export CONVERACT_TEST_POSTGRES_ADMIN_URL="postgresql://opc_admin@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
cargo test --manifest-path server-rs/Cargo.toml -p converact-postgres-store \
  platform_outbox::physical_tests::writer_fenced_event_and_outbox_lifecycle_is_physically_idempotent \
  -- --ignored --exact

trap - INT TERM HUP EXIT
"$PG_CTL" -D "$DATA" -m fast -w stop >/dev/null
rm -rf "$ROOT"
