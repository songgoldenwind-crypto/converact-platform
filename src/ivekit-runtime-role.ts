export interface IveKitRuntimeRoleQueryable {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export async function initializeIveKitRuntimeRole(
  pg: IveKitRuntimeRoleQueryable,
  password: string
): Promise<void> {
  if (!password) throw new Error('OPC_RUNTIME_DB_PASSWORD is required');

  const identity = await pg.query('SELECT current_user AS current_user');
  if (String(identity.rows[0]?.current_user || '') !== 'opc_admin') {
    throw new Error('iveKit runtime-role initialization must run as opc_admin');
  }

  await pg.query('BEGIN');
  try {
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
          CREATE ROLE opc_runtime
            LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pg.query(`
      ALTER ROLE opc_runtime
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS
    `);

    const quoted = await pg.query(
      "SELECT format('ALTER ROLE opc_runtime PASSWORD %L', $1::text) AS statement",
      [password]
    );
    const alterPassword = String(quoted.rows[0]?.statement || '');
    if (!alterPassword) throw new Error('PostgreSQL did not quote the opc_runtime password');
    await pg.query(alterPassword);

    await pg.query(`
      DO $$
      BEGIN
        EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO opc_runtime', current_database());
      END
      $$
    `);
    await pg.query('GRANT USAGE ON SCHEMA public TO opc_runtime');
    await pg.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await pg.query('REVOKE CREATE ON SCHEMA public FROM opc_runtime');
    await pg.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opc_runtime');
    await pg.query('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO opc_runtime');
    await pg.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opc_runtime
    `);
    await pg.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO opc_runtime
    `);
    await pg.query(`
      DO $$
      BEGIN
        IF to_regclass('public.schema_migrations') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_rustdesk_session_by_external_id(text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_rustdesk_session_by_external_id(TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_worker_tenant_ids(text,timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
      END
      $$
    `);
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}
