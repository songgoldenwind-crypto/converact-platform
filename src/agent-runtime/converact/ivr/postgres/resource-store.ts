import type { PgQueryable } from '../../../../db-pg.js';
import type {
  IvrAudioAsset,
  IvrPublishedResourceReference,
  IvrRegionGroup,
  IvrResource,
  IvrResourceKind,
  IvrResourceRepository,
  IvrRingGroup,
  IvrSettings,
  IvrTimeGroup
} from '../resource-types.js';
import { jsonRecord, numberValue, requiredRow, timestamp, type IvrPgRow } from './row-utils.js';

interface ResourceDefinition {
  table: string;
  dependencyKey: string;
  columns: readonly string[];
  jsonColumns: ReadonlySet<string>;
}

const DEFINITIONS: Record<IvrResourceKind, ResourceDefinition> = {
  audio_asset: {
    table: 'ivekit_ivr_audio_assets', dependencyKey: 'audio_assets',
    columns: [
      'id', 'tenant_id', 'name', 'source_kind', 'object_ref', 'tts_text', 'tts_profile_id',
      'variable_name', 'language', 'content_type', 'checksum', 'duration_ms', 'visibility',
      'status', 'metadata', 'revision', 'created_by', 'updated_by', 'created_at', 'updated_at'
    ],
    jsonColumns: new Set(['metadata'])
  },
  time_group: {
    table: 'ivekit_ivr_time_groups', dependencyKey: 'time_groups',
    columns: [
      'id', 'tenant_id', 'name', 'timezone', 'schedule', 'holidays', 'status', 'revision',
      'created_at', 'updated_at'
    ],
    jsonColumns: new Set(['schedule', 'holidays'])
  },
  region_group: {
    table: 'ivekit_ivr_region_groups', dependencyKey: 'region_groups',
    columns: [
      'id', 'tenant_id', 'name', 'regions', 'match_mode', 'status', 'revision',
      'created_at', 'updated_at'
    ],
    jsonColumns: new Set(['regions'])
  },
  ring_group: {
    table: 'ivekit_ivr_ring_groups', dependencyKey: 'ring_groups',
    columns: [
      'id', 'tenant_id', 'name', 'member_identities', 'strategy', 'ring_timeout_seconds',
      'max_rounds', 'status', 'revision', 'created_at', 'updated_at'
    ],
    jsonColumns: new Set(['member_identities'])
  }
};

const IMMUTABLE_COLUMNS = new Set(['id', 'tenant_id', 'revision', 'created_at']);

export class PostgresIvrResourceStore implements IvrResourceRepository {
  constructor(private readonly pg: PgQueryable) {}

  async list<K extends IvrResourceKind>(
    tenantId: string,
    kind: K
  ): Promise<Array<Extract<IvrResource, { kind: K }>>> {
    const definition = DEFINITIONS[kind];
    const result = await this.pg.query<IvrPgRow>(
      `SELECT * FROM ${definition.table}
       WHERE tenant_id = $1 ORDER BY updated_at DESC, id DESC`,
      [tenantId]
    );
    return result.rows.map((row) => decodeResource(kind, row)) as never;
  }

  async get<K extends IvrResourceKind>(
    tenantId: string,
    kind: K,
    id: string,
    options: { for_update?: boolean } = {}
  ): Promise<Extract<IvrResource, { kind: K }> | null> {
    const result = await this.pg.query<IvrPgRow>(
      `SELECT * FROM ${DEFINITIONS[kind].table}
       WHERE tenant_id = $1 AND id = $2${options.for_update ? ' FOR UPDATE' : ''}`,
      [tenantId, id]
    );
    return result.rows[0] ? decodeResource(kind, result.rows[0]) as never : null;
  }

  async insert<K extends IvrResourceKind>(
    resource: Extract<IvrResource, { kind: K }>
  ): Promise<Extract<IvrResource, { kind: K }>> {
    const definition = DEFINITIONS[resource.kind];
    const values = definition.columns.map((column) => encodeColumn(resource, column, definition));
    const placeholders = definition.columns.map((_, index) => `$${index + 1}`).join(', ');
    const result = await this.pg.query<IvrPgRow>(
      `INSERT INTO ${definition.table} (${definition.columns.join(', ')})
       VALUES (${placeholders}) RETURNING *`,
      values
    );
    return decodeResource(resource.kind, requiredRow(result.rows[0], 'not_found')) as never;
  }

  async update<K extends IvrResourceKind>(
    resource: Extract<IvrResource, { kind: K }>,
    expectedRevision: number
  ): Promise<Extract<IvrResource, { kind: K }>> {
    const definition = DEFINITIONS[resource.kind];
    const columns = definition.columns.filter((column) => !IMMUTABLE_COLUMNS.has(column));
    const assignments = columns.map((column, index) =>
      column === 'updated_at'
        ? `${column} = $${index + 3}`
        : `${column} = $${index + 3}`
    );
    assignments.push('revision = revision + 1');
    const values = columns.map((column) => encodeColumn(resource, column, definition));
    const result = await this.pg.query<IvrPgRow>(
      `UPDATE ${definition.table}
       SET ${assignments.join(', ')}
       WHERE tenant_id = $1 AND id = $2 AND revision = $${columns.length + 3}
       RETURNING *`,
      [resource.tenant_id, resource.id, ...values, expectedRevision]
    );
    return decodeResource(resource.kind, requiredRow(result.rows[0], 'revision_conflict')) as never;
  }

  async currentPublishedReferences(
    tenantId: string,
    kind: IvrResourceKind,
    id: string
  ): Promise<IvrPublishedResourceReference[]> {
    const result = await this.pg.query<IvrPgRow>(
      `SELECT flow.id AS flow_id, version.version
       FROM ivekit_ivr_flows flow
       JOIN ivekit_ivr_flow_versions version
         ON version.tenant_id = flow.tenant_id
        AND version.flow_id = flow.id
       WHERE flow.tenant_id = $1
         AND COALESCE(version.dependencies -> $2, '[]'::jsonb) ? $3
       ORDER BY flow.id, version.version
       FOR SHARE OF flow`,
      [tenantId, DEFINITIONS[kind].dependencyKey, id]
    );
    return result.rows.map((row) => ({
      flow_id: String(row.flow_id),
      version: numberValue(row.version)
    }));
  }

  async getSettings(
    tenantId: string,
    options: { for_update?: boolean } = {}
  ): Promise<IvrSettings | null> {
    const result = await this.pg.query<IvrPgRow>(
      `SELECT * FROM ivekit_ivr_settings
       WHERE tenant_id = $1 ORDER BY created_at, id LIMIT 1${options.for_update ? ' FOR UPDATE' : ''}`,
      [tenantId]
    );
    return result.rows[0] ? decodeSettings(result.rows[0]) : null;
  }

  async insertSettings(settings: IvrSettings): Promise<IvrSettings> {
    const result = await this.pg.query<IvrPgRow>(
      `INSERT INTO ivekit_ivr_settings
        (id, tenant_id, default_language, max_steps, max_subflow_depth,
         external_action_timeout_ms, validation_mode, allowed_webhook_refs,
         execution_policy, revision, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
       RETURNING *`,
      settingsParams(settings)
    );
    return decodeSettings(requiredRow(result.rows[0], 'not_found'));
  }

  async updateSettings(settings: IvrSettings, expectedRevision: number): Promise<IvrSettings> {
    const result = await this.pg.query<IvrPgRow>(
      `UPDATE ivekit_ivr_settings
       SET default_language = $3, max_steps = $4, max_subflow_depth = $5,
           external_action_timeout_ms = $6, validation_mode = $7,
           allowed_webhook_refs = $8::jsonb, execution_policy = $9::jsonb,
           revision = revision + 1, updated_by = $10, updated_at = $11
       WHERE tenant_id = $1 AND id = $2 AND revision = $12
       RETURNING *`,
      [
        settings.tenant_id, settings.id, settings.default_language, settings.max_steps,
        settings.max_subflow_depth, settings.external_action_timeout_ms, settings.validation_mode,
        JSON.stringify(settings.allowed_webhook_refs), JSON.stringify(settings.execution_policy),
        settings.updated_by, settings.updated_at, expectedRevision
      ]
    );
    return decodeSettings(requiredRow(result.rows[0], 'revision_conflict'));
  }
}

function encodeColumn(
  resource: IvrResource,
  column: string,
  definition: ResourceDefinition
): unknown {
  const value = (resource as unknown as Record<string, unknown>)[column];
  return definition.jsonColumns.has(column) ? JSON.stringify(value) : value;
}

function decodeResource(kind: IvrResourceKind, row: IvrPgRow): IvrResource {
  const base = {
    id: String(row.id), tenant_id: String(row.tenant_id), kind, name: String(row.name),
    revision: numberValue(row.revision), created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
  if (kind === 'audio_asset') return {
    ...base, kind,
    source_kind: row.source_kind as IvrAudioAsset['source_kind'],
    object_ref: String(row.object_ref), tts_text: String(row.tts_text),
    tts_profile_id: String(row.tts_profile_id), variable_name: String(row.variable_name),
    language: String(row.language), content_type: String(row.content_type),
    checksum: String(row.checksum), duration_ms: nullableNumber(row.duration_ms),
    visibility: row.visibility as IvrAudioAsset['visibility'],
    status: row.status as IvrAudioAsset['status'], metadata: jsonRecord(row.metadata),
    created_by: String(row.created_by), updated_by: String(row.updated_by)
  };
  if (kind === 'time_group') return {
    ...base, kind, timezone: String(row.timezone), schedule: jsonRecord(row.schedule),
    holidays: jsonArray(row.holidays), status: row.status as IvrTimeGroup['status']
  };
  if (kind === 'region_group') return {
    ...base, kind, regions: stringArray(row.regions),
    match_mode: row.match_mode as IvrRegionGroup['match_mode'],
    status: row.status as IvrRegionGroup['status']
  };
  return {
    ...base, kind, member_identities: stringArray(row.member_identities),
    strategy: row.strategy as IvrRingGroup['strategy'],
    ring_timeout_seconds: numberValue(row.ring_timeout_seconds),
    max_rounds: numberValue(row.max_rounds), status: row.status as IvrRingGroup['status']
  };
}

function decodeSettings(row: IvrPgRow): IvrSettings {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id),
    default_language: String(row.default_language), max_steps: numberValue(row.max_steps),
    max_subflow_depth: numberValue(row.max_subflow_depth),
    external_action_timeout_ms: numberValue(row.external_action_timeout_ms),
    validation_mode: row.validation_mode as IvrSettings['validation_mode'],
    allowed_webhook_refs: stringArray(row.allowed_webhook_refs),
    execution_policy: jsonRecord(row.execution_policy), revision: numberValue(row.revision),
    updated_by: String(row.updated_by), created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function settingsParams(settings: IvrSettings): unknown[] {
  return [
    settings.id, settings.tenant_id, settings.default_language, settings.max_steps,
    settings.max_subflow_depth, settings.external_action_timeout_ms, settings.validation_mode,
    JSON.stringify(settings.allowed_webhook_refs), JSON.stringify(settings.execution_policy),
    settings.revision, settings.updated_by, settings.created_at, settings.updated_at
  ];
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function stringArray(value: unknown): string[] {
  return jsonArray(value).map(String);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch {
    throw new Error('invalid PostgreSQL JSON payload');
  }
}
