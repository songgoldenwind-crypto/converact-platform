-- The migration runner builds the existing-table index concurrently before
-- entering this validation transaction. NULL legacy positions remain valid;
-- every target append receives one database-owned position.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index AS index_meta
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_meta.indexrelid
    JOIN pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'uq_ivekit_audit_events_append_position'
      AND index_meta.indrelid = 'public.ivekit_audit_events'::regclass
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indexprs IS NULL
      AND pg_get_expr(index_meta.indpred, index_meta.indrelid) =
        '(append_position IS NOT NULL)'
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(index_meta.indkey::smallint[]) WITH ORDINALITY
          AS key_column(attnum, position)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = index_meta.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.position <= index_meta.indnkeyatts
        ORDER BY key_column.position
      ) = ARRAY['tenant_id', 'append_position']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'audit append-position index is absent or invalid'
      USING ERRCODE = '55000';
  END IF;
END
$$;

COMMENT ON INDEX uq_ivekit_audit_events_append_position IS
  'Unique per-tenant monotonic Audit append order for target-provenance rows.';
