#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"
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
RUST_TOOLCHAIN=$(sed -n 's/^channel = "\([^"]*\)"/\1/p' server-rs/rust-toolchain.toml)
if [ -z "$RUST_TOOLCHAIN" ] || ! command -v rustup >/dev/null 2>&1; then
  printf 'Pinned Rust toolchain or rustup is unavailable\n' >&2
  exit 1
fi
RUSTUP="$(command -v rustup)"
RUST_CARGO="$("$RUSTUP" which --toolchain "$RUST_TOOLCHAIN" cargo)"
RUST_RUSTC="$("$RUSTUP" which --toolchain "$RUST_TOOLCHAIN" rustc)"
RUST_RUSTDOC="$("$RUSTUP" which --toolchain "$RUST_TOOLCHAIN" rustdoc)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/converact-postgres.XXXXXX")"
MARKER="$ROOT/.converact-postgres-harness"
DATA="$ROOT/data"
SOCKET="$ROOT/socket"
LOG="$ROOT/postgres.log"
PORT=$((55000 + ($$ % 1000)))
RUNTIME_PASSWORD='converact-runtime-integration-password'
EVENT_RUNTIME_PASSWORD='converact-event-runtime-integration-password'

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
  "REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC" \
  >/dev/null
"$PSQL" -h 127.0.0.1 -p "$PORT" -U opc_admin -d postgres \
  -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE converact_event_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS; CREATE ROLE converact_event_store_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS" \
  >/dev/null

export CONVERACT_FABRIC_STANDALONE_TEST_DATABASE_URL="postgresql://opc_admin@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
export CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_DATABASE_URL="postgresql://opc_runtime:$RUNTIME_PASSWORD@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
export CONVERACT_FABRIC_UPGRADE_TEST_DATABASE_URL="postgresql://opc_admin@127.0.0.1:$PORT/converact_upgrade?sslmode=disable"
export CONVERACT_FABRIC_UPGRADE_TEST_RUNTIME_DATABASE_URL="postgresql://opc_runtime:$RUNTIME_PASSWORD@127.0.0.1:$PORT/converact_upgrade?sslmode=disable"
export CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_PASSWORD="$RUNTIME_PASSWORD"

if [ "${CONVERACT_POSTGRES_EVENT_ROLE_ONLY:-0}" = '1' ]; then
  node --import tsx --test test/converact-platform-event-runtime-role-postgres.test.ts
else
  node --import tsx --test test/converact-standalone-postgres.test.ts
  node --import tsx --test test/converact-sip-effect-postgres.test.ts
  node --import tsx --test test/tinode-inbound-store.test.ts
  node --import tsx --test test/tinode-inbound-projector.test.ts
  node --import tsx --test test/converact-ivr-postgres.test.ts
  node --import tsx --test test/converact-voice-controlled-postgres.test.ts
  node --import tsx --test test/converact-dialog-terminal-repair-postgres.test.ts
fi

"$PSQL" -h 127.0.0.1 -p "$PORT" -U opc_admin -d postgres \
  -v ON_ERROR_STOP=1 -c "DROP DATABASE converact_upgrade" >/dev/null

PGHOST=127.0.0.1 PGPORT="$PORT" PGDATABASE=converact_fresh PGUSER=opc_admin \
  CONVERACT_RUNTIME_DB_PASSWORD="$RUNTIME_PASSWORD" \
  node --import tsx src/converact-init-runtime-role.ts

PGHOST=127.0.0.1 PGPORT="$PORT" PGDATABASE=converact_fresh PGUSER=opc_admin \
  CONVERACT_EVENT_RUNTIME_DB_PASSWORD="$EVENT_RUNTIME_PASSWORD" \
  node --import tsx src/converact-init-event-runtime-role.ts

export CONVERACT_TEST_POSTGRES_URL="postgresql://converact_event_runtime@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
export CONVERACT_TEST_POSTGRES_ADMIN_URL="postgresql://opc_admin@127.0.0.1:$PORT/converact_fresh?sslmode=disable"
RUSTC="$RUST_RUSTC" RUSTDOC="$RUST_RUSTDOC" "$RUST_CARGO" test \
  --locked --manifest-path server-rs/Cargo.toml -p converact-postgres-store \
  platform_outbox::physical_tests::writer_fenced_event_and_outbox_lifecycle_is_physically_idempotent \
  -- --ignored --exact

trap - INT TERM HUP EXIT
"$PG_CTL" -D "$DATA" -m fast -w stop >/dev/null
rm -rf "$ROOT"
