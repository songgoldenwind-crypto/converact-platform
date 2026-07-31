import { json, one, parseJson, run } from '../../db.js';
import { validateAgentManifest, validateAgentPlaybook } from '../contracts.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export type AgentManifestRecord = JsonRecord & {
  agent_id: string;
  version: string;
  name: string;
  description: string;
};

export type AgentPlaybookRecord = JsonRecord & {
  playbook_id: string;
  agent_id: string;
  version: string;
  name: string;
  description: string;
};

export class AgentRegistry {
  db: unknown;
  manifests: Map<string, AgentManifestRecord>;
  playbooks: Map<string, AgentPlaybookRecord>;

  constructor(db: unknown) {
    this.db = db;
    this.manifests = new Map();
    this.playbooks = new Map();
  }

  registerManifest(manifest: JsonRecord): AgentManifestRecord {
    const normalized = validateAgentManifest(manifest) as AgentManifestRecord;
    const key = manifestKey(normalized.agent_id, normalized.version);
    this.manifests.set(key, normalized);
    run(
      this.db,
      `INSERT INTO agent_manifests (agent_id, version, name, description, manifest, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
       ON CONFLICT(agent_id, version) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         manifest = excluded.manifest,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
      [normalized.agent_id, normalized.version, normalized.name, normalized.description, json(normalized)]
    );
    return normalized;
  }

  registerPlaybook(playbook: JsonRecord): AgentPlaybookRecord {
    const normalized = validateAgentPlaybook(playbook) as AgentPlaybookRecord;
    this.playbooks.set(normalized.playbook_id, normalized);
    run(
      this.db,
      `INSERT INTO agent_playbooks (playbook_id, agent_id, version, name, description, playbook, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
       ON CONFLICT(playbook_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         version = excluded.version,
         name = excluded.name,
         description = excluded.description,
         playbook = excluded.playbook,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        normalized.playbook_id,
        normalized.agent_id,
        normalized.version,
        normalized.name,
        normalized.description,
        json(normalized)
      ]
    );
    return normalized;
  }

  enableTenantAgent(tenantId: string, agentId: string, configOverride: JsonRecord = {}): void {
    run(
      this.db,
      `INSERT INTO tenant_agent_subscriptions (tenant_id, agent_id, enabled, config_override, updated_at)
       VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
         enabled = 1,
         config_override = excluded.config_override,
         updated_at = CURRENT_TIMESTAMP`,
      [tenantId, agentId, json(configOverride)]
    );
  }

  getManifest(agentId: string, version: string | null = null): AgentManifestRecord {
    if (version) {
      const cached = this.manifests.get(manifestKey(agentId, version));
      if (cached) return cached;
    }

    const row = version
      ? one(this.db, 'SELECT manifest FROM agent_manifests WHERE agent_id = ? AND version = ? AND status = ?', [
          agentId,
          version,
          'active'
        ])
      : one(
          this.db,
          'SELECT manifest FROM agent_manifests WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
          [agentId, 'active']
        );
    if (!row) throw new Error(`agent manifest not found: ${agentId}`);
    return parseJson(row.manifest);
  }

  getPlaybook(playbookId: string): AgentPlaybookRecord {
    const cached = this.playbooks.get(playbookId);
    if (cached) return cached;
    const row = one(this.db, 'SELECT playbook FROM agent_playbooks WHERE playbook_id = ? AND status = ?', [
      playbookId,
      'active'
    ]);
    if (!row) throw new Error(`agent playbook not found: ${playbookId}`);
    return parseJson(row.playbook);
  }

  isEnabledForTenant(tenantId: string, agentId: string): boolean {
    const row = one(this.db, 'SELECT enabled FROM tenant_agent_subscriptions WHERE tenant_id = ? AND agent_id = ?', [
      tenantId,
      agentId
    ]);
    return !row || row.enabled === 1;
  }
}

function manifestKey(agentId: string, version: string): string {
  return `${agentId}@${version}`;
}
