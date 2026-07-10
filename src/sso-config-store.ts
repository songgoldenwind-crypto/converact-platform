import { id, one, run } from './db.js';

export interface TenantSsoConfig {
  tenant_id: string;
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes: string;
  default_role: 'owner' | 'admin' | 'operator' | 'viewer';
  updated_at: string;
}

export function getSsoConfig(db: unknown, tenantId: string): TenantSsoConfig | null {
  const row = one(db, 'SELECT * FROM tenant_sso_configs WHERE tenant_id = ?', [tenantId]);
  if (!row) return null;
  return decode(row as Record<string, unknown>);
}

export function getPublicSsoConfig(db: unknown, tenantId: string): Omit<TenantSsoConfig, 'client_secret'> | null {
  const config = getSsoConfig(db, tenantId);
  if (!config || !config.enabled) return null;
  const { client_secret: _secret, ...publicConfig } = config;
  return publicConfig;
}

export function upsertSsoConfig(
  db: unknown,
  tenantId: string,
  patch: Partial<Omit<TenantSsoConfig, 'tenant_id' | 'updated_at'>>
): TenantSsoConfig {
  const existing = one(db, 'SELECT tenant_id FROM tenant_sso_configs WHERE tenant_id = ?', [tenantId]);
  if (!existing) {
    run(
      db,
      `INSERT INTO tenant_sso_configs
        (id, tenant_id, enabled, issuer_url, client_id, client_secret, redirect_uri, scopes, default_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id('sso'),
        tenantId,
        patch.enabled === false ? 0 : 1,
        patch.issuer_url || '',
        patch.client_id || '',
        patch.client_secret || '',
        patch.redirect_uri || '',
        patch.scopes || 'openid profile email',
        patch.default_role || 'operator'
      ]
    );
  } else {
    const fields: string[] = [];
    const params: (string | number)[] = [];
    if (patch.enabled !== undefined) {
      fields.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.issuer_url !== undefined) {
      fields.push('issuer_url = ?');
      params.push(patch.issuer_url);
    }
    if (patch.client_id !== undefined) {
      fields.push('client_id = ?');
      params.push(patch.client_id);
    }
    if (patch.client_secret !== undefined && patch.client_secret) {
      fields.push('client_secret = ?');
      params.push(patch.client_secret);
    }
    if (patch.redirect_uri !== undefined) {
      fields.push('redirect_uri = ?');
      params.push(patch.redirect_uri);
    }
    if (patch.scopes !== undefined) {
      fields.push('scopes = ?');
      params.push(patch.scopes);
    }
    if (patch.default_role !== undefined) {
      fields.push('default_role = ?');
      params.push(patch.default_role);
    }
    if (fields.length) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(tenantId);
      run(db, `UPDATE tenant_sso_configs SET ${fields.join(', ')} WHERE tenant_id = ?`, params);
    }
  }
  return getSsoConfig(db, tenantId)!;
}

function decode(row: Record<string, unknown>): TenantSsoConfig {
  return {
    tenant_id: String(row.tenant_id),
    enabled: Boolean(row.enabled),
    issuer_url: String(row.issuer_url || ''),
    client_id: String(row.client_id || ''),
    client_secret: String(row.client_secret || ''),
    redirect_uri: String(row.redirect_uri || ''),
    scopes: String(row.scopes || 'openid profile email'),
    default_role: (String(row.default_role || 'operator') as TenantSsoConfig['default_role']),
    updated_at: String(row.updated_at || '')
  };
}
