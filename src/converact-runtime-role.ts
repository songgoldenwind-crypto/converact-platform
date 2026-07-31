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
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'opc_sip_effect_executor'
        ) THEN
          CREATE ROLE opc_sip_effect_executor
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOINHERIT NOBYPASSRLS;
        END IF;
        ALTER ROLE opc_sip_effect_executor
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOINHERIT NOBYPASSRLS;
        GRANT opc_sip_effect_executor TO opc_runtime;
        REVOKE ADMIN OPTION FOR opc_sip_effect_executor FROM opc_runtime;
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
      GRANT USAGE ON SCHEMA public TO opc_sip_effect_executor;
      DO $$
      DECLARE
        feature_table TEXT;
      BEGIN
        FOREACH feature_table IN ARRAY ARRAY[
          'ivekit_sip_effect_schema_registry',
          'ivekit_sip_effect_writer_registry',
          'ivekit_sip_protocol_effects',
          'ivekit_sip_effect_receipts',
          'ivekit_sip_durable_boundaries',
          'ivekit_sip_durable_boundary_facts'
        ] LOOP
          IF to_regclass('public.' || feature_table) IS NOT NULL THEN
            EXECUTE format(
              'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, opc_runtime, opc_sip_effect_executor',
              feature_table
            );
            EXECUTE format(
              'GRANT SELECT ON TABLE public.%I TO opc_sip_effect_executor',
              feature_table
            );
          END IF;
        END LOOP;
        IF to_regclass('public.ivekit_sip_protocol_effects') IS NOT NULL THEN
          GRANT INSERT ON TABLE public.ivekit_sip_protocol_effects
            TO opc_sip_effect_executor;
          GRANT UPDATE (
            state,
            revision,
            unknown_count,
            last_receipt_id,
            last_receipt_hash,
            last_receipt_repair_delay_ms,
            failure_code,
            repair_due_at,
            repair_owner_id,
            repair_owner_epoch,
            repair_epoch_high_watermark,
            repair_claim_token,
            repair_claim_revision,
            repair_lease_until,
            repair_attempts,
            repair_exhausted_at,
            repair_exhaustion_receipt_hash,
            operator_attention_required,
            repair_compacted_at,
            canonical_wire_bytes,
            payload_retained,
            terminal_tombstone_id,
            terminal_tombstone_hash,
            terminal_at,
            updated_at
          ) ON TABLE public.ivekit_sip_protocol_effects
            TO opc_sip_effect_executor;
        END IF;
        IF to_regclass('public.ivekit_sip_effect_receipts') IS NOT NULL THEN
          GRANT INSERT ON TABLE public.ivekit_sip_effect_receipts
            TO opc_sip_effect_executor;
        END IF;
        IF to_regprocedure(
          'public.ivekit_assert_sip_effect_writer(text,text,integer,text)'
        ) IS NOT NULL THEN
          REVOKE ALL ON FUNCTION public.ivekit_assert_sip_effect_writer(
            TEXT, TEXT, INTEGER, TEXT
          ) FROM PUBLIC, opc_runtime;
          GRANT EXECUTE ON FUNCTION public.ivekit_assert_sip_effect_writer(
            TEXT, TEXT, INTEGER, TEXT
          ) TO opc_sip_effect_executor;
        END IF;
      END
      $$
    `);
    await pg.query(`
      DO $$
      BEGIN
        IF to_regclass('public.schema_migrations') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_calls') IS NOT NULL THEN
          REVOKE DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_calls
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_legs') IS NOT NULL THEN
          REVOKE DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_legs
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_submissions') IS NOT NULL THEN
          REVOKE UPDATE, DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_submissions
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_receipts') IS NOT NULL THEN
          REVOKE UPDATE, DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_receipts
            FROM opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_rustdesk_session_by_external_id(text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_rustdesk_session_by_external_id(TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_worker_tenant_ids(text,timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_tinode_inbound_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_event_retention_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_cc_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_cc_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_status_transition_allowed(text,text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_status_transition_allowed(TEXT, TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_derivative_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_derivative_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_cleanup_worker_tenant_ids(timestamp with time zone,timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_cleanup_worker_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_voice_profile_context(text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_voice_profile_context(TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_recording_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_recording_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_applied_migration_versions(text[])') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_applied_migration_versions(TEXT[]) TO opc_runtime;
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
