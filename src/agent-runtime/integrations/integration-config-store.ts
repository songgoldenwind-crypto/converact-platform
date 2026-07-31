import { resolveConveractEnv } from '../../config/converact-env.js';
import { createHash } from 'node:crypto';
import { all, id, json, one, parseJson, run } from '../../db.js';
import type {
  IntegrationSecretRef,
  JsonRecord,
  RuntimeIntegrationConfig,
  TenantIntegrationConfig
} from './provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

export class IntegrationConfigStore {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
  }

  upsertSecretRef(input: JsonRecord): IntegrationSecretRef {
    const fingerprint = input.secret_value ? fingerprintSecret(input.secret_value) : input.secret_fingerprint || '';
    const redacted = input.secret_value ? redactSecret(input.secret_value) : input.redacted_preview || '';
    run(
      this.db,
      `INSERT INTO integration_secret_refs
        (id, tenant_id, workspace_id, integration_id, secret_key, env_var_name, secret_fingerprint, redacted_preview, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, integration_id, secret_key) DO UPDATE SET
         env_var_name = excluded.env_var_name,
         secret_fingerprint = excluded.secret_fingerprint,
         redacted_preview = excluded.redacted_preview,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('secretref'),
        input.tenant_id,
        input.workspace_id || 'default',
        input.integration_id,
        input.secret_key,
        input.env_var_name || '',
        fingerprint,
        redacted,
        input.status || 'active'
      ]
    );
    const ref = this.getSecretRef(input.tenant_id, input.workspace_id || 'default', input.integration_id, input.secret_key);
    this.runStore?.audit(input.tenant_id, 'integration.secret_ref.upserted', 'integration_secret_ref', ref.id, {
      integration_id: input.integration_id,
      secret_key: input.secret_key,
      stores_plaintext: false
    });
    return ref;
  }

  upsertConfig(input: JsonRecord): TenantIntegrationConfig {
    const secretRefIds = input.secret_ref_ids || [];
    run(
      this.db,
      `INSERT INTO tenant_integration_configs
        (id, tenant_id, workspace_id, integration_id, status, config, secret_ref_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, integration_id) DO UPDATE SET
         status = excluded.status,
         config = excluded.config,
         secret_ref_ids = excluded.secret_ref_ids,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('intcfg'),
        input.tenant_id,
        input.workspace_id || 'default',
        input.integration_id,
        input.status || 'configured',
        json(redactConfig(input.config || {})),
        json(secretRefIds)
      ]
    );
    const config = this.getConfig(input.tenant_id, input.workspace_id || 'default', input.integration_id);
    this.runStore?.audit(input.tenant_id, 'integration.config.upserted', 'tenant_integration_config', config.id, {
      integration_id: input.integration_id,
      status: config.status
    });
    return config;
  }

  healthCheck(input: JsonRecord): TenantIntegrationConfig & { health: JsonRecord } {
    const config = this.getConfig(input.tenant_id, input.workspace_id || 'default', input.integration_id);
    if (!config) throw new Error(`integration config not found: ${input.integration_id}`);
    const secretRefs = (config.secret_ref_ids || [])
      .map((secretRefId) => this.getSecretRefById(input.tenant_id, secretRefId))
      .filter(Boolean);
    const missingSecretRefs = (input.required_secret_keys || []).filter(
      (key) => !secretRefs.some((ref) => ref.secret_key === key && ref.status === 'active')
    );
    const healthStatus = config.status === 'disabled' ? 'degraded' : missingSecretRefs.length ? 'degraded' : 'healthy';
    const result = {
      integration_id: config.integration_id,
      status: healthStatus,
      config_status: config.status,
      missing_secret_keys: missingSecretRefs,
      checked_at: new Date().toISOString()
    };
    run(
      this.db,
      `UPDATE tenant_integration_configs
       SET health_status = ?, last_checked_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND workspace_id = ? AND integration_id = ?`,
      [healthStatus, result.checked_at, input.tenant_id, input.workspace_id || 'default', input.integration_id]
    );
    this.runStore?.audit(input.tenant_id, 'integration.health_checked', 'tenant_integration_config', config.id, result);
    return { ...this.getConfig(input.tenant_id, input.workspace_id || 'default', input.integration_id), health: result };
  }

  resolveRuntimeConfig(input: JsonRecord): RuntimeIntegrationConfig {
    const workspaceId = input.workspace_id || 'default';
    const config = this.getConfig(input.tenant_id, workspaceId, input.integration_id);
    if (!config) throw new Error(`integration config not found: ${input.integration_id}`);
    const secretRefs = (config.secret_ref_ids || [])
      .map((secretRefId) => this.getSecretRefById(input.tenant_id, secretRefId))
      .filter(Boolean)
      .filter((ref) => ref.status === 'active');
    const secretRefByKey = new Map(secretRefs.map((ref) => [ref.secret_key, ref]));
    const expectedSecretKeys = compactUnique([...(input.required_secret_keys || []), ...secretRefs.map((ref) => ref.secret_key)]);
    const resolvedSecrets: Record<string, string> = {};
    const missingSecretKeys: string[] = [];

    for (const key of expectedSecretKeys) {
      const secretRef = secretRefByKey.get(key);
      if (!secretRef?.env_var_name) {
        missingSecretKeys.push(key);
        continue;
      }
      const value = resolveConveractEnv(process.env, secretRef.env_var_name);
      if (value == null || value === '') {
        missingSecretKeys.push(key);
        continue;
      }
      resolvedSecrets[key] = value;
    }

    const runtimeConfig = { ...config.config };
    for (const [key, value] of Object.entries(resolvedSecrets)) runtimeConfig[key] = value;

    return {
      ...config,
      secret_refs: secretRefs,
      resolved_secrets: resolvedSecrets,
      missing_secret_keys: compactUnique(missingSecretKeys),
      runtime_status: config.status === 'disabled'
        ? 'disabled'
        : missingSecretKeys.length
          ? 'missing_secrets'
          : 'ready',
      runtime_config: runtimeConfig
    };
  }

  getConfig(tenantId: string, workspaceId: string, integrationId: string): TenantIntegrationConfig | null {
    const row = one(
      this.db,
      'SELECT * FROM tenant_integration_configs WHERE tenant_id = ? AND workspace_id = ? AND integration_id = ?',
      [tenantId, workspaceId, integrationId]
    );
    return row ? decodeConfig(row) : null;
  }

  listConfigs({ tenant_id, workspace_id = 'default', status = null }: JsonRecord): TenantIntegrationConfig[] {
    const conditions = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_integration_configs
       WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC`,
      params
    ).map(decodeConfig);
  }

  getSecretRef(tenantId: string, workspaceId: string, integrationId: string, secretKey: string): IntegrationSecretRef | null {
    const row = one(
      this.db,
      `SELECT * FROM integration_secret_refs
       WHERE tenant_id = ? AND workspace_id = ? AND integration_id = ? AND secret_key = ?`,
      [tenantId, workspaceId, integrationId, secretKey]
    );
    return row || null;
  }

  getSecretRefById(tenantId: string, secretRefId: string): IntegrationSecretRef | null {
    return one(this.db, 'SELECT * FROM integration_secret_refs WHERE tenant_id = ? AND id = ?', [tenantId, secretRefId]);
  }
}

function decodeConfig(row: JsonRecord): TenantIntegrationConfig {
  return {
    ...row,
    id: String(row.id || ''),
    tenant_id: String(row.tenant_id || ''),
    workspace_id: String(row.workspace_id || 'default'),
    integration_id: String(row.integration_id || ''),
    status: String(row.status || 'configured'),
    config: parseJson(row.config),
    secret_ref_ids: parseJson(row.secret_ref_ids, [])
  };
}

function fingerprintSecret(secret: unknown): string {
  return createHash('sha256').update(String(secret)).digest('hex');
}

function redactSecret(secret: unknown): string {
  const value = String(secret || '');
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 6))}${value.slice(-4)}`;
}

function redactConfig(config: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      shouldRedactConfigKey(key) ? '[REDACTED_CONFIG_SECRET]' : value
    ])
  );
}

function compactUnique(values: unknown[]): string[] {
  return [...new Set(values.filter(Boolean).map(String))];
}

function shouldRedactConfigKey(key: unknown): boolean {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'auth_secret_key') return false;
  return /secret|token|password|api[_-]?key/i.test(normalized);
}
