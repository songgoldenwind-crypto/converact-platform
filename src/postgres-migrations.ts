import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationQueryable {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface PostgresMigration {
  file: string;
  version: string;
  checksum: string;
  sql: string;
}

const VOICE_CDR_MIGRATION = '103_ivekit_voice_cdr_convergence';
const VOICE_EVENT_UNIQUE_INDEX = 'uq_ivekit_tenant_events_tenant_id';
const SIP_EFFECT_STALE_NONTERMINAL_MIGRATION =
  '115_converact_sip_effect_stale_nonterminal_recovery';
const SIP_EFFECT_STALE_NONTERMINAL_INDEX =
  'idx_ivekit_sip_effect_stale_nonterminal';

export function isPostgresMigrationFile(file: string): boolean {
  return /^\d{3}_[a-z0-9_]+\.sql$/.test(file);
}

export function readPostgresMigrationPlan(directory: string): PostgresMigration[] {
  return readdirSync(directory)
    .filter(isPostgresMigrationFile)
    .sort()
    .map((file) => {
      const sql = readFileSync(join(directory, file), 'utf8');
      return {
        file,
        version: file.replace(/\.sql$/, ''),
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql
      };
    });
}

export async function runPostgresMigrationsOnClient(
  pg: MigrationQueryable,
  plan: PostgresMigration[]
): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pg.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum TEXT NOT NULL DEFAULT ''
  `);

  for (const migration of plan) {
    const existing = await pg.query(
      'SELECT version, checksum FROM schema_migrations WHERE version = $1',
      [migration.version]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const recorded = String(existing.rows[0]?.checksum || '');
      if (!recorded) {
        await pg.query(
          'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum = $3',
          [migration.checksum, migration.version, '']
        );
        continue;
      }
      if (recorded !== migration.checksum) {
        throw new Error(
          `PostgreSQL migration checksum mismatch for ${migration.version}: ` +
          `recorded ${recorded}, current ${migration.checksum}`
        );
      }
      continue;
    }

    if (migration.version === VOICE_CDR_MIGRATION) {
      await prepareVoiceCdrConcurrentIndex(pg);
    }
    if (migration.version === SIP_EFFECT_STALE_NONTERMINAL_MIGRATION) {
      await prepareSipEffectStaleNonterminalIndex(pg);
    }
    await pg.query('BEGIN');
    try {
      if (migration.version === VOICE_CDR_MIGRATION) {
        await pg.query("SET LOCAL lock_timeout = '5s'");
      }
      await pg.query(migration.sql);
      await pg.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum]
      );
      await pg.query('COMMIT');
    } catch (error) {
      await pg.query('ROLLBACK');
      throw error;
    }
  }
}

export async function prepareVoiceCdrConcurrentIndex(
  pg: MigrationQueryable
): Promise<void> {
  const constraint = await pg.query(`
    SELECT
      constraint_meta.contype AS constraint_type,
      index_meta.indisunique,
      index_meta.indisvalid,
      index_meta.indisready,
      index_meta.indpred IS NULL AS no_predicate,
      index_meta.indexprs IS NULL AS no_expressions,
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
      ) AS key_columns
    FROM pg_constraint constraint_meta
    LEFT JOIN pg_index index_meta
      ON index_meta.indexrelid = constraint_meta.conindid
    WHERE constraint_meta.conrelid = 'public.ivekit_tenant_events'::regclass
      AND constraint_meta.conname = '${VOICE_EVENT_UNIQUE_INDEX}'
  `);
  if (constraint.rowCount && constraint.rowCount > 0) {
    if (constraint.rows[0]?.constraint_type === 'u' &&
        isValidVoiceEventUniqueIndex(constraint.rows[0])) {
      return;
    }
    throw new Error(
      `PostgreSQL named unique constraint is invalid: ${VOICE_EVENT_UNIQUE_INDEX}`
    );
  }

  const index = await pg.query(`
    SELECT
      index_meta.indisunique,
      index_meta.indisvalid,
      index_meta.indisready,
      index_meta.indpred IS NULL AS no_predicate,
      index_meta.indexprs IS NULL AS no_expressions,
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
      ) AS key_columns
    FROM pg_index index_meta
    JOIN pg_class index_relation
      ON index_relation.oid = index_meta.indexrelid
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = '${VOICE_EVENT_UNIQUE_INDEX}'
      AND index_meta.indrelid = 'public.ivekit_tenant_events'::regclass
  `);
  if (isValidVoiceEventUniqueIndex(index.rows[0])) return;

  if (index.rowCount && index.rowCount > 0) {
    await pg.query(
      `DROP INDEX CONCURRENTLY public.${VOICE_EVENT_UNIQUE_INDEX}`
    );
  }
  await pg.query(`
    CREATE UNIQUE INDEX CONCURRENTLY ${VOICE_EVENT_UNIQUE_INDEX}
      ON public.ivekit_tenant_events (tenant_id, id)
  `);
}

export async function prepareSipEffectStaleNonterminalIndex(
  pg: MigrationQueryable
): Promise<void> {
  const index = await pg.query(`
    SELECT
      index_meta.indisunique,
      index_meta.indisvalid,
      index_meta.indisready,
      index_meta.indexprs IS NULL AS no_expressions,
      index_meta.indnkeyatts,
      index_meta.indnatts,
      pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate,
      ARRAY(
        SELECT attribute.attname::text
        FROM unnest(index_meta.indkey::smallint[]) WITH ORDINALITY
          AS key_column(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = index_meta.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.position <= index_meta.indnkeyatts
        ORDER BY key_column.position
      ) AS key_columns
    FROM pg_index index_meta
    JOIN pg_class index_relation
      ON index_relation.oid = index_meta.indexrelid
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = '${SIP_EFFECT_STALE_NONTERMINAL_INDEX}'
      AND index_meta.indrelid = 'public.ivekit_sip_protocol_effects'::regclass
  `);
  if (isValidSipEffectStaleNonterminalIndex(index.rows[0])) return;

  if (index.rowCount && index.rowCount > 0) {
    await pg.query(
      `DROP INDEX CONCURRENTLY public.${SIP_EFFECT_STALE_NONTERMINAL_INDEX}`
    );
  }
  await pg.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${SIP_EFFECT_STALE_NONTERMINAL_INDEX}
      ON public.ivekit_sip_protocol_effects (
        tenant_id,
        protocol_session_id,
        protocol_session_generation,
        updated_at,
        protocol_effect_id
      )
      WHERE state IN ('send_attempted', 'transport_accepted')
  `);
}

function isValidSipEffectStaleNonterminalIndex(
  row: Record<string, unknown> | undefined
): boolean {
  if (!row) return false;
  const columns = row.key_columns;
  const expectedPredicate =
    "state=ANY(ARRAY['send_attempted','transport_accepted'])";
  const predicate = String(row.predicate || '')
    .replace(/::text/g, '')
    .replace(/\s+/g, '')
    .replace(/^\((.*)\)$/, '$1');
  return row.indisunique === false &&
    row.indisvalid === true &&
    row.indisready === true &&
    row.no_expressions === true &&
    Number(row.indnkeyatts) === 5 &&
    Number(row.indnatts) === 5 &&
    Array.isArray(columns) &&
    columns.length === 5 &&
    columns[0] === 'tenant_id' &&
    columns[1] === 'protocol_session_id' &&
    columns[2] === 'protocol_session_generation' &&
    columns[3] === 'updated_at' &&
    columns[4] === 'protocol_effect_id' &&
    predicate === expectedPredicate;
}

function isValidVoiceEventUniqueIndex(
  row: Record<string, unknown> | undefined
): boolean {
  if (!row) return false;
  const columns = row.key_columns;
  return row.indisunique === true &&
    row.indisvalid === true &&
    row.indisready === true &&
    row.no_predicate === true &&
    row.no_expressions === true &&
    Number(row.indnkeyatts) === 2 &&
    Number(row.indnatts) === 2 &&
    Array.isArray(columns) &&
    columns.length === 2 &&
    columns[0] === 'tenant_id' &&
    columns[1] === 'id';
}
