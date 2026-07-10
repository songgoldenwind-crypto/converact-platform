#!/bin/sh
set -eu

fail() {
  printf 'postgres bootstrap: %s\n' "$1" >&2
  exit 1
}

databases=${OPC_POSTGRES_BOOTSTRAP_DATABASES:-}
host=${POSTGRES_HOST:-postgres}
port=${POSTGRES_PORT:-5432}
user=${POSTGRES_USER:-opc}
password=${POSTGRES_PASSWORD:-}
maintenance_database=${POSTGRES_MAINTENANCE_DATABASE:-postgres}

[ -n "$databases" ] || fail 'OPC_POSTGRES_BOOTSTRAP_DATABASES is required'
[ -n "$password" ] || fail 'POSTGRES_PASSWORD is required'
[ "$user" = 'opc' ] || fail 'POSTGRES_USER must be opc'
case "$databases" in
  ,*|*,|*,,*) fail 'database list contains an empty name' ;;
esac

old_ifs=$IFS
IFS=,
for database in $databases; do
  case "$database" in
    opc|keycloak|tinode|chatwoot) ;;
    *) fail "unsupported database: $database" ;;
  esac
done
IFS=$old_ifs

PGPASSWORD=$password
export PGPASSWORD
IFS=,
for database in $databases; do
  existing=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
  if [ "$existing" != '1' ]; then
    psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
      -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database\" OWNER \"opc\""
  fi

  verified=$(psql -X -h "$host" -p "$port" -U "$user" -d "$maintenance_database" \
    -v ON_ERROR_STOP=1 -At -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
  [ "$verified" = '1' ] || fail "database verification failed: $database"
  printf 'postgres bootstrap: %s ready\n' "$database"
done
IFS=$old_ifs
unset PGPASSWORD
