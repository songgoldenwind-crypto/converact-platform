-- The canonical migration runner creates this partial index concurrently
-- before opening the migration transaction. The fallback DDL keeps direct SQL
-- application idempotent; the catalog check below rejects a same-name drifted
-- index instead of silently accepting it.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_stale_nonterminal
  ON ivekit_sip_protocol_effects(
    tenant_id,
    protocol_session_id,
    protocol_session_generation,
    updated_at,
    protocol_effect_id
  )
  WHERE state IN ('send_attempted', 'transport_accepted');

DO $$
DECLARE
  index_is_unique BOOLEAN;
  index_is_valid BOOLEAN;
  index_is_ready BOOLEAN;
  index_has_expressions BOOLEAN;
  index_key_count INTEGER;
  index_attribute_count INTEGER;
  index_columns TEXT[];
  normalized_predicate TEXT;
BEGIN
  SELECT
    index_meta.indisunique,
    index_meta.indisvalid,
    index_meta.indisready,
    index_meta.indexprs IS NOT NULL,
    index_meta.indnkeyatts,
    index_meta.indnatts,
    ARRAY(
      SELECT attribute.attname::text
      FROM unnest(index_meta.indkey::smallint[]) WITH ORDINALITY
        AS key_column(attnum, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = index_meta.indrelid
       AND attribute.attnum = key_column.attnum
      WHERE key_column.position <= index_meta.indnkeyatts
      ORDER BY key_column.position
    ),
    regexp_replace(
      replace(pg_get_expr(index_meta.indpred, index_meta.indrelid), '::text', ''),
      '\s+',
      '',
      'g'
    )
  INTO
    index_is_unique,
    index_is_valid,
    index_is_ready,
    index_has_expressions,
    index_key_count,
    index_attribute_count,
    index_columns,
    normalized_predicate
  FROM pg_index index_meta
  JOIN pg_class index_relation
    ON index_relation.oid = index_meta.indexrelid
  JOIN pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  WHERE index_namespace.nspname = 'public'
    AND index_relation.relname = 'idx_ivekit_sip_effect_stale_nonterminal'
    AND index_meta.indrelid = 'public.ivekit_sip_protocol_effects'::regclass;

  IF NOT FOUND
     OR index_is_unique
     OR NOT index_is_valid
     OR NOT index_is_ready
     OR index_has_expressions
     OR index_key_count <> 5
     OR index_attribute_count <> 5
     OR index_columns <> ARRAY[
       'tenant_id',
       'protocol_session_id',
       'protocol_session_generation',
       'updated_at',
       'protocol_effect_id'
     ]::text[]
     OR normalized_predicate NOT IN (
       '(state=ANY(ARRAY[''send_attempted'',''transport_accepted'']))',
       'state=ANY(ARRAY[''send_attempted'',''transport_accepted''])'
     )
  THEN
    RAISE EXCEPTION 'SIP stale-nonterminal recovery index is incompatible'
      USING ERRCODE = '23514';
  END IF;
END
$$;
