#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${RUSTPBX_DB_PASSWORD:?RUSTPBX_DB_PASSWORD is required}"

export PGPASSWORD="$POSTGRES_PASSWORD"
export RUSTPBX_DB_PASSWORD
psql -X -h postgres -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
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
SELECT 'CREATE DATABASE rustpbx OWNER rustpbx_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'rustpbx') \gexec
ALTER DATABASE rustpbx OWNER TO rustpbx_app;
REVOKE CONNECT ON DATABASE rustpbx FROM PUBLIC;
REVOKE CONNECT ON DATABASE rustpbx FROM opc_runtime;
GRANT CONNECT ON DATABASE rustpbx TO rustpbx_app;

\connect rustpbx
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO rustpbx_app;
ALTER SCHEMA public OWNER TO rustpbx_app;
SQL
unset RUSTPBX_DB_PASSWORD PGPASSWORD
