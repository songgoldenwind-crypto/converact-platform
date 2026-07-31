#!/bin/sh
set -eu

if [ -r /bootstrap/converact-env-compat.sh ]; then
  . /bootstrap/converact-env-compat.sh
else
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  . "$script_dir/../../scripts/converact-env-compat.sh"
fi
converact_env_install_aliases

fail() {
  printf 'postgres bootstrap: %s\n' "$1" >&2
  exit 1
}

databases=${CONVERACT_POSTGRES_BOOTSTRAP_DATABASES:-}
host=${POSTGRES_HOST:-postgres}
port=${POSTGRES_PORT:-5432}
user=${POSTGRES_USER:-opc}
password=${POSTGRES_PASSWORD:-}
maintenance_database=${POSTGRES_MAINTENANCE_DATABASE:-postgres}

[ -n "$databases" ] || fail 'CONVERACT_POSTGRES_BOOTSTRAP_DATABASES is required'
[ -n "$password" ] || fail 'POSTGRES_PASSWORD is required'
[ "$user" = 'opc' ] || fail 'POSTGRES_USER must be opc'
case "$databases" in
  ,*|*,|*,,*) fail 'database list contains an empty name' ;;
esac

old_ifs=$IFS
IFS=,
for database in $databases; do
  case "$database" in
    opc|keycloak|tinode|chatwoot|rustpbx) ;;
    *) fail "unsupported database: $database" ;;
  esac
done
IFS=$old_ifs

PGPASSWORD=$password
export PGPASSWORD
IFS=,
for database in $databases; do
  expected_owner=$user
  if [ "$database" = 'rustpbx' ]; then
    [ -n "${RUSTPBX_DB_PASSWORD:-}" ] || fail 'RUSTPBX_DB_PASSWORD is required for rustpbx'
    export RUSTPBX_DB_PASSWORD
    psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
      -v ON_ERROR_STOP=1 <<'SQL'
\getenv rustpbx_password RUSTPBX_DB_PASSWORD
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rustpbx_app') THEN
    CREATE ROLE rustpbx_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
SELECT format('ALTER ROLE rustpbx_app PASSWORD %L', :'rustpbx_password') \gexec
SQL
    expected_owner=rustpbx_app
  fi

  existing=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
  if [ "$existing" != '1' ]; then
    psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
      -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database\" OWNER \"$expected_owner\""
  fi
  psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$database\" OWNER TO \"$expected_owner\""
  if [ "$database" = 'rustpbx' ]; then
    psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
      -v ON_ERROR_STOP=1 -c 'REVOKE CONNECT ON DATABASE rustpbx FROM PUBLIC; GRANT CONNECT ON DATABASE rustpbx TO rustpbx_app'
    psql -X -h "$host" -p "$port" -U "$user" -d rustpbx \
      -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO rustpbx_app; GRANT USAGE, CREATE ON SCHEMA public TO rustpbx_app'
  fi

  verified=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
  [ "$verified" = '1' ] || fail "database verification failed: $database"

  actual_owner=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = '$database'")
  [ "$actual_owner" = "$expected_owner" ] || fail "database owner verification failed: $database"
  printf 'postgres bootstrap: %s ready\n' "$database"
done
IFS=$old_ifs
unset RUSTPBX_DB_PASSWORD
unset PGPASSWORD
