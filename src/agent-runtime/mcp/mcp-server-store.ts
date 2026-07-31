import { all, id, json, one, parseJson, run } from '../../db.js';
import type {
  AdapterRegistryLike,
  IntegrationCatalogLike,
  IntegrationConfigStoreLike,
  JsonRecord
} from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface McpServerStoreOptions {
  db: unknown;
  integrationCatalog: IntegrationCatalogLike;
  adapterRegistry: AdapterRegistryLike;
  integrationConfigStore: IntegrationConfigStoreLike;
  runStore?: AuditStoreLike | null;
}

export class McpServerStore {
  db: unknown;
  integrationCatalog: IntegrationCatalogLike;
  adapterRegistry: AdapterRegistryLike;
  integrationConfigStore: IntegrationConfigStoreLike;
  runStore: AuditStoreLike | null;

  constructor({ db, integrationCatalog, adapterRegistry, integrationConfigStore, runStore = null }: McpServerStoreOptions) {
    this.db = db;
    this.integrationCatalog = integrationCatalog;
    this.adapterRegistry = adapterRegistry;
    this.integrationConfigStore = integrationConfigStore;
    this.runStore = runStore;
  }

  upsertServer(input: JsonRecord): JsonRecord {
    const normalized = normalizeMcpServerInput(this.integrationCatalog, input);
    run(
      this.db,
      `INSERT INTO tenant_mcp_servers
        (id, tenant_id, workspace_id, server_id, integration_id, name, transport, endpoint, toolsets, capabilities, secret_ref_ids, config, status, health_status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, server_id) DO UPDATE SET
         integration_id = excluded.integration_id,
         name = excluded.name,
         transport = excluded.transport,
         endpoint = excluded.endpoint,
         toolsets = excluded.toolsets,
         capabilities = excluded.capabilities,
         secret_ref_ids = excluded.secret_ref_ids,
         config = excluded.config,
         status = excluded.status,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        normalized.id,
        normalized.tenant_id,
        normalized.workspace_id,
        normalized.server_id,
        normalized.integration_id,
        normalized.name,
        normalized.transport,
        normalized.endpoint,
        json(normalized.toolsets),
        json(normalized.capabilities),
        json(normalized.secret_ref_ids),
        json(normalized.config),
        normalized.status,
        normalized.health_status,
        normalized.created_by,
        normalized.updated_by
      ]
    );
    const server = this.getServer(normalized.tenant_id, normalized.workspace_id, normalized.server_id);
    this.runStore?.audit?.(normalized.tenant_id, 'mcp.server_upserted', 'tenant_mcp_server', server.id, {
      server_id: server.server_id,
      integration_id: server.integration_id,
      status: server.status
    }, normalized.updated_by);
    return server;
  }

  getServer(tenantId: string, workspaceId: string, serverId: string): JsonRecord | null {
    const row = one(
      this.db,
      'SELECT * FROM tenant_mcp_servers WHERE tenant_id = ? AND workspace_id = ? AND server_id = ?',
      [tenantId, workspaceId, serverId]
    );
    return row ? decodeServer(row) : null;
  }

  listServers({ tenant_id, workspace_id = 'default', status = null, capability = null, integration_id = null }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (integration_id) {
      clauses.push('integration_id = ?');
      params.push(integration_id);
    }
    return all(this.db, `SELECT * FROM tenant_mcp_servers WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`, params)
      .map(decodeServer)
      .filter((server) => !capability || server.capabilities.includes(capability));
  }

  async healthCheck({ tenant_id, workspace_id = 'default', server_id, actor_id = 'system' }: JsonRecord): Promise<JsonRecord> {
    const server = this.getServer(tenant_id, workspace_id, server_id);
    if (!server) throw new Error(`mcp server not found: ${server_id}`);
    const secretRefs = (server.secret_ref_ids || []).map((secretRefId) => this.integrationConfigStore.getSecretRefById(tenant_id, secretRefId)).filter(Boolean);
    const adapterEntry = this.adapterRegistry.has(server.integration_id) ? this.adapterRegistry.get(server.integration_id) : null;
    const adapterHealth = adapterEntry?.adapter?.health
      ? await adapterEntry.adapter.health({
          tenant_id,
          workspace_id,
          integration_id: server.integration_id,
          config: server.config
        })
      : null;
    const status = resolveMcpHealthStatus(server, secretRefs, adapterHealth);
    const checkedAt = new Date().toISOString();
    run(
      this.db,
      `UPDATE tenant_mcp_servers
       SET health_status = ?, last_checked_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND workspace_id = ? AND server_id = ?`,
      [status, checkedAt, tenant_id, workspace_id, server_id]
    );
    const snapshot = {
      id: id('mcpsnap'),
      tenant_id,
      workspace_id,
      server_id,
      integration_id: server.integration_id,
      status,
      details: {
        adapter_health: adapterHealth || null,
        secret_ref_count: secretRefs.length,
        transport: server.transport,
        endpoint: server.endpoint
      },
      checked_at: checkedAt,
      created_by: actor_id
    };
    run(
      this.db,
      `INSERT INTO tenant_mcp_server_snapshots
        (id, tenant_id, workspace_id, server_id, integration_id, status, details, checked_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.tenant_id,
        snapshot.workspace_id,
        snapshot.server_id,
        snapshot.integration_id,
        snapshot.status,
        json(snapshot.details),
        snapshot.checked_at,
        snapshot.created_by
      ]
    );
    this.runStore?.audit?.(tenant_id, 'mcp.server_health_checked', 'tenant_mcp_server', server.id, {
      server_id,
      integration_id: server.integration_id,
      status
    }, actor_id);
    return {
      server: this.getServer(tenant_id, workspace_id, server_id),
      snapshot: this.listSnapshots({ tenant_id, workspace_id, server_id, limit: 1 })[0]
    };
  }

  listSnapshots({ tenant_id, workspace_id = 'default', server_id = null, limit = 50 }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (server_id) {
      clauses.push('server_id = ?');
      params.push(server_id);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM tenant_mcp_server_snapshots WHERE ${clauses.join(' AND ')} ORDER BY checked_at DESC, created_at DESC LIMIT ?`,
      params
    ).map((row) => ({ ...row, details: parseJson(row.details) }));
  }

  selectServer(input: JsonRecord): JsonRecord {
    const candidates: JsonRecord[] = this.listServers({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      capability: input.capability,
      integration_id: input.integration_id
    })
      .map((server) => ({
        ...server,
        selection_score: scoreMcpServer(server, input)
      }))
      .sort((a: JsonRecord, b: JsonRecord) =>
        b.selection_score - a.selection_score || String(a.name || '').localeCompare(String(b.name || ''))
      );
    if (!candidates.length) throw new Error('no mcp server candidates found');
    return {
      selected: candidates[0],
      candidates: candidates.slice(0, input.limit || 10)
    };
  }
}

function normalizeMcpServerInput(integrationCatalog: IntegrationCatalogLike, input: JsonRecord): JsonRecord {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  if (!input.server_id) throw new Error('server_id is required');
  if (!input.integration_id) throw new Error('integration_id is required');
  const entry = integrationCatalog.get(input.integration_id);
  if (entry.source_type !== 'mcp_server') {
    throw new Error(`integration_id must reference an mcp catalog entry: ${input.integration_id}`);
  }
  return {
    id: input.id || id('mcpserver'),
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id || 'default',
    server_id: input.server_id,
    integration_id: input.integration_id,
    name: input.name || entry.name,
    transport: input.transport || 'http',
    endpoint: input.endpoint || '',
    toolsets: input.toolsets || ['integration'],
    capabilities: input.capabilities || entry.capabilities || [],
    secret_ref_ids: input.secret_ref_ids || [],
    config: input.config || {},
    status: input.status || 'planned',
    health_status: input.health_status || 'unknown',
    created_by: input.created_by || input.actor_id || 'system',
    updated_by: input.updated_by || input.actor_id || 'system'
  };
}

function resolveMcpHealthStatus(server: JsonRecord, secretRefs: JsonRecord[], adapterHealth: JsonRecord | null): string {
  if (server.status === 'disabled') return 'degraded';
  if (server.status === 'planned') return 'planned';
  if (!server.endpoint && server.transport !== 'stdio') return 'not_configured';
  if ((server.secret_ref_ids || []).length && secretRefs.length !== server.secret_ref_ids.length) return 'error';
  if (adapterHealth?.status === 'degraded' || adapterHealth?.status === 'error') return adapterHealth.status;
  return 'healthy';
}

function scoreMcpServer(server: JsonRecord, input: JsonRecord): number {
  let score = 0;
  if (server.status === 'active') score += 40;
  if (server.health_status === 'healthy') score += 40;
  if ((input.preferred_server_ids || []).includes(server.server_id)) score += 100;
  if (server.capabilities.includes(input.capability)) score += 20;
  return score;
}

function decodeServer(row: JsonRecord): JsonRecord {
  return {
    ...row,
    toolsets: parseJson(row.toolsets, []),
    capabilities: parseJson(row.capabilities, []),
    secret_ref_ids: parseJson(row.secret_ref_ids, []),
    config: parseJson(row.config)
  };
}
