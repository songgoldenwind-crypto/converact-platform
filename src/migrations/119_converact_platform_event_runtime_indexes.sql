-- Large existing-table indexes are built by the migration runner with
-- CREATE INDEX CONCURRENTLY before this transactional validation checkpoint.
-- Keeping validation separate makes an interrupted build safely resumable.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  required_index TEXT;
BEGIN
  FOREACH required_index IN ARRAY ARRAY[
    'converact_authority_generation_owner_identity',
    'idx_converact_platform_outbox_route_pending',
    'idx_converact_platform_outbox_route_expired',
    'idx_converact_platform_outbox_route_exhausted'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index index_meta
      JOIN pg_class index_relation
        ON index_relation.oid = index_meta.indexrelid
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      WHERE index_namespace.nspname = 'public'
        AND index_relation.relname = required_index
        AND index_meta.indisvalid
        AND index_meta.indisready
    ) THEN
      RAISE EXCEPTION 'platform event runtime index is absent or invalid: %',
        required_index USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$$;

COMMENT ON INDEX converact_authority_generation_owner_identity IS
  'Concurrent unique identity used by rolling route-provenance foreign keys.';
COMMENT ON INDEX idx_converact_platform_outbox_route_pending IS
  'Bounded due-pending claim path for one exact route generation owner.';
COMMENT ON INDEX idx_converact_platform_outbox_route_expired IS
  'Bounded expired-claim recovery path below max attempts.';
COMMENT ON INDEX idx_converact_platform_outbox_route_exhausted IS
  'Bounded expired-claim terminalization path at max attempts.';
