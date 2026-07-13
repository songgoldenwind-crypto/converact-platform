import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type { IvrFlowRepository } from '../ports.js';
import type { IvrDependencyManifest } from '../dependencies.js';
import type { IvrFlowGraph } from '../graph-types.js';
import type { IvrFlow, IvrFlowVersion } from '../types.js';
import {
  jsonRecord,
  nullableNumber,
  numberValue,
  requiredRow,
  timestamp,
  type IvrPgRow
} from './row-utils.js';

const FLOW_COLUMNS = `
  flow.id, flow.tenant_id, flow.name, flow.status, flow.draft_graph,
  flow.draft_revision, flow.current_published_version, flow.metadata,
  flow.created_by, flow.updated_by, flow.created_at, flow.updated_at`;

const VERSION_COLUMNS = `
  version.id, version.tenant_id, version.flow_id, version.version,
  version.schema_version, version.graph, version.graph_hash, version.dependencies,
  version.release_kind, version.source_version, version.publication_key,
  version.publication_payload_hash, version.release_metadata,
  version.published_by, version.published_at`;

export class PostgresIvrFlowStore implements IvrFlowRepository {
  constructor(private readonly pg: PgQueryable) {}

  getFlow(tenantId: string, flowId: string, options: { for_update?: boolean } = {}): Promise<IvrFlow | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${FLOW_COLUMNS}
         FROM ivekit_ivr_flows flow
         WHERE flow.tenant_id = $1 AND flow.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, flowId]
      );
      return result.rows[0] ? decodeFlow(result.rows[0]) : null;
    });
  }

  listFlows(tenantId: string): Promise<IvrFlow[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${FLOW_COLUMNS}
         FROM ivekit_ivr_flows flow
         WHERE flow.tenant_id = $1
         ORDER BY flow.updated_at DESC, flow.id DESC
         LIMIT 201`,
        [tenantId]
      );
      return result.rows.map(decodeFlow);
    });
  }

  insertFlow(flow: IvrFlow): Promise<IvrFlow> {
    return withPgTenant(this.pg, flow.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `INSERT INTO ivekit_ivr_flows
          (id, tenant_id, name, status, draft_graph, draft_revision,
           current_published_version, metadata, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12)
         RETURNING *`,
        flowParams(flow)
      );
      return decodeFlow(requiredRow(result.rows[0], 'not_found'));
    });
  }

  updateDraft(flow: IvrFlow, expectedRevision: number): Promise<IvrFlow> {
    return withPgTenant(this.pg, flow.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `UPDATE ivekit_ivr_flows
         SET name = $3, draft_graph = $4::jsonb, draft_revision = $5,
             metadata = $6::jsonb, updated_by = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2 AND draft_revision = $9
         RETURNING *`,
        [
          flow.tenant_id, flow.id, flow.name, JSON.stringify(flow.draft_graph),
          flow.draft_revision, JSON.stringify(flow.metadata), flow.updated_by,
          flow.updated_at, expectedRevision
        ]
      );
      return decodeFlow(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  updatePublication(flow: IvrFlow, expectedRevision: number): Promise<IvrFlow> {
    return withPgTenant(this.pg, flow.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `UPDATE ivekit_ivr_flows
         SET status = $3, current_published_version = $4,
             updated_by = $5, updated_at = $6
         WHERE tenant_id = $1 AND id = $2 AND draft_revision = $7
         RETURNING *`,
        [
          flow.tenant_id, flow.id, flow.status, flow.current_published_version,
          flow.updated_by, flow.updated_at, expectedRevision
        ]
      );
      return decodeFlow(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  listVersions(tenantId: string, flowId: string): Promise<IvrFlowVersion[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${VERSION_COLUMNS}
         FROM ivekit_ivr_flow_versions version
         WHERE version.tenant_id = $1 AND version.flow_id = $2
         ORDER BY version.version DESC`,
        [tenantId, flowId]
      );
      return result.rows.map(decodeVersion);
    });
  }

  getVersion(tenantId: string, flowId: string, versionNumber: number): Promise<IvrFlowVersion | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${VERSION_COLUMNS}
         FROM ivekit_ivr_flow_versions version
         WHERE version.tenant_id = $1 AND version.flow_id = $2 AND version.version = $3`,
        [tenantId, flowId, versionNumber]
      );
      return result.rows[0] ? decodeVersion(result.rows[0]) : null;
    });
  }

  getPublished(tenantId: string, flowId: string, versionNumber?: number): Promise<IvrFlowVersion | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${VERSION_COLUMNS}
         FROM ivekit_ivr_flow_versions version
         JOIN ivekit_ivr_flows flow
           ON flow.tenant_id = version.tenant_id AND flow.id = version.flow_id
         WHERE version.tenant_id = $1 AND version.flow_id = $2
           AND version.version = COALESCE($3::integer, flow.current_published_version)`,
        [tenantId, flowId, versionNumber ?? null]
      );
      return result.rows[0] ? decodeVersion(result.rows[0]) : null;
    });
  }

  findVersionByPublicationKey(tenantId: string, key: string): Promise<IvrFlowVersion | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${VERSION_COLUMNS}
         FROM ivekit_ivr_flow_versions version
         WHERE version.tenant_id = $1 AND version.publication_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeVersion(result.rows[0]) : null;
    });
  }

  insertVersion(version: IvrFlowVersion): Promise<IvrFlowVersion> {
    return withPgTenant(this.pg, version.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `INSERT INTO ivekit_ivr_flow_versions
          (id, tenant_id, flow_id, version, schema_version, graph, graph_hash,
           dependencies, release_kind, source_version, publication_key,
           publication_payload_hash, release_metadata, published_by, published_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10,
                 $11, $12, $13::jsonb, $14, $15)
         RETURNING *`,
        [
          version.id, version.tenant_id, version.flow_id, version.version,
          version.schema_version, JSON.stringify(version.graph), version.graph_hash,
          JSON.stringify(version.dependencies), version.release_kind, version.source_version,
          version.publication_key, version.publication_payload_hash,
          JSON.stringify(version.release_metadata), version.published_by, version.published_at
        ]
      );
      return decodeVersion(requiredRow(result.rows[0], 'not_found'));
    });
  }
}

function flowParams(flow: IvrFlow): unknown[] {
  return [
    flow.id, flow.tenant_id, flow.name, flow.status, JSON.stringify(flow.draft_graph),
    flow.draft_revision, flow.current_published_version, JSON.stringify(flow.metadata),
    flow.created_by, flow.updated_by, flow.created_at, flow.updated_at
  ];
}

function decodeFlow(row: IvrPgRow): IvrFlow {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), name: String(row.name),
    status: row.status as IvrFlow['status'], draft_graph: jsonRecord(row.draft_graph) as unknown as IvrFlowGraph,
    draft_revision: numberValue(row.draft_revision),
    current_published_version: nullableNumber(row.current_published_version),
    metadata: jsonRecord(row.metadata), created_by: String(row.created_by), updated_by: String(row.updated_by),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeVersion(row: IvrPgRow): IvrFlowVersion {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), flow_id: String(row.flow_id),
    version: numberValue(row.version), schema_version: numberValue(row.schema_version),
    graph: jsonRecord(row.graph) as unknown as IvrFlowGraph, graph_hash: String(row.graph_hash),
    dependencies: jsonRecord(row.dependencies) as unknown as IvrDependencyManifest,
    release_kind: row.release_kind as IvrFlowVersion['release_kind'],
    source_version: nullableNumber(row.source_version), publication_key: String(row.publication_key ?? ''),
    publication_payload_hash: String(row.publication_payload_hash ?? ''),
    release_metadata: jsonRecord(row.release_metadata), published_by: String(row.published_by),
    published_at: timestamp(row.published_at)
  };
}
