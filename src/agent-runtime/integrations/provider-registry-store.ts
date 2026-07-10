import { all, id, json, one, parseJson, run } from '../../db.js';
import type {
  AdapterRegistryEntry,
  AdapterRegistryLike,
  IntegrationCatalogEntry,
  IntegrationCatalogLike,
  IntegrationConfigStoreLike,
  JsonRecord,
  ProviderInventoryEntry,
  ProviderPolicy,
  ProviderRegistryStoreOptions,
  ProviderSelection
} from './provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

export class ProviderRegistryStore {
  db: unknown;
  integrationCatalog: IntegrationCatalogLike;
  adapterRegistry: AdapterRegistryLike;
  integrationConfigStore: IntegrationConfigStoreLike;
  runStore: AuditStoreLike | null;

  constructor({ db, integrationCatalog, adapterRegistry, integrationConfigStore, runStore = null }: ProviderRegistryStoreOptions) {
    this.db = db;
    this.integrationCatalog = integrationCatalog;
    this.adapterRegistry = adapterRegistry;
    this.integrationConfigStore = integrationConfigStore;
    this.runStore = runStore;
  }

  listInventory(input: JsonRecord = {}): ProviderInventoryEntry[] {
    const tenantId = input.tenant_id || null;
    const workspaceId = input.workspace_id || 'default';
    const entries = this.integrationCatalog
      .list({
        category: input.category,
        source_type: input.source_type,
        capability: input.capability,
        min_stability: input.min_stability
      })
      .filter((entry) => input.include_skills || entry.source_type !== 'skill');
    const configs = tenantId ? this.integrationConfigStore.listConfigs({ tenant_id: tenantId, workspace_id: workspaceId }) : [];
    const configByIntegrationId = new Map(configs.map((config) => [config.integration_id, config]));
    const latestSnapshots = tenantId ? this.listLatestSnapshots({ tenant_id: tenantId, workspace_id: workspaceId }) : [];
    const snapshotByIntegrationId = new Map(latestSnapshots.map((snapshot) => [snapshot.integration_id, snapshot]));

    return entries
      .map((entry) =>
        composeInventoryEntry({
          entry,
          config: configByIntegrationId.get(entry.id) || null,
          adapterEntry: this.adapterRegistry.has(entry.id) ? this.adapterRegistry.get(entry.id) : null,
          latestSnapshot: snapshotByIntegrationId.get(entry.id) || null,
          workspaceId
        })
      )
      .filter((entry) => !input.configured_only || entry.configured)
      .filter((entry) => !input.status || entry.health_status === input.status);
  }

  upsertPolicy(input: JsonRecord): ProviderPolicy {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.policy_id) throw new Error('policy_id is required');
    if (!input.name) throw new Error('policy name is required');
    const workspaceId = input.workspace_id || 'default';
    run(
      this.db,
      `INSERT INTO tenant_provider_policies
        (id, tenant_id, workspace_id, policy_id, name, description, use_case, category, capability,
         preferred_integration_ids, blocked_integration_ids, allow_fallback, min_stability, config, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, policy_id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         use_case = excluded.use_case,
         category = excluded.category,
         capability = excluded.capability,
         preferred_integration_ids = excluded.preferred_integration_ids,
         blocked_integration_ids = excluded.blocked_integration_ids,
         allow_fallback = excluded.allow_fallback,
         min_stability = excluded.min_stability,
         config = excluded.config,
         status = excluded.status,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('providerpolicy'),
        input.tenant_id,
        workspaceId,
        input.policy_id,
        input.name,
        input.description || '',
        input.use_case || '',
        input.category || '',
        input.capability || '',
        json(input.preferred_integration_ids || input.preferred_ids || []),
        json(input.blocked_integration_ids || input.blocked_ids || []),
        input.allow_fallback ? 1 : 0,
        input.min_stability == null ? null : Number(input.min_stability),
        json(input.config || {}),
        input.status || 'active',
        input.actor_id || 'system',
        input.actor_id || 'system'
      ]
    );
    const policy = this.getPolicy(input.tenant_id, workspaceId, input.policy_id);
    this.runStore?.audit?.(input.tenant_id, 'integration.provider_policy.upserted', 'tenant_provider_policy', policy.id, {
      policy_id: policy.policy_id,
      use_case: policy.use_case,
      category: policy.category,
      capability: policy.capability
    }, input.actor_id || 'system');
    return policy;
  }

  getPolicy(tenantId: string, workspaceId: string, policyId: string): ProviderPolicy | null {
    const row = one(
      this.db,
      `SELECT * FROM tenant_provider_policies
       WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ?`,
      [tenantId, workspaceId, policyId]
    );
    return row ? decodePolicy(row) : null;
  }

  listPolicies({ tenant_id, workspace_id = 'default', status = null, use_case = null, category = null, capability = null }: JsonRecord): ProviderPolicy[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (use_case) {
      clauses.push('use_case = ?');
      params.push(use_case);
    }
    if (category) {
      clauses.push('category = ?');
      params.push(category);
    }
    if (capability) {
      clauses.push('capability = ?');
      params.push(capability);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_provider_policies
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC`,
      params
    ).map(decodePolicy);
  }

  async snapshotHealth(input: JsonRecord): Promise<JsonRecord> {
    const workspaceId = input.workspace_id || 'default';
    const inventory = this.listInventory({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      include_skills: true
    }).find((entry) => entry.integration_id === input.integration_id);
    if (!inventory) throw new Error(`integration not found: ${input.integration_id}`);

    const config = this.integrationConfigStore.getConfig(input.tenant_id, workspaceId, input.integration_id);
    const configHealth = config && inventory.config_required
      ? this.integrationConfigStore.healthCheck({
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          integration_id: input.integration_id,
          required_secret_keys: input.required_secret_keys || []
        }).health
      : null;
    const runtimeConfig = config
      ? this.integrationConfigStore.resolveRuntimeConfig({
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          integration_id: input.integration_id,
          required_secret_keys: input.required_secret_keys || []
        })
      : null;
    const adapterEntry = this.adapterRegistry.has(input.integration_id) ? this.adapterRegistry.get(input.integration_id) : null;
    const adapterHealth = adapterEntry?.adapter?.health
      ? await adapterEntry.adapter.health({
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          integration_id: input.integration_id,
          config: runtimeConfig?.runtime_config || config,
          secrets: runtimeConfig?.resolved_secrets || {}
        })
      : null;
    const status = resolveSnapshotStatus({
      entry: inventory,
      config,
      configHealth,
      adapterEntry,
      adapterHealth
    });
    const snapshot = {
      id: id('providerhealth'),
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: input.integration_id,
      category: inventory.category,
      source_type: inventory.source_type,
      adapter_type: inventory.adapter_type || '',
      adapter_status: inventory.adapter_runtime_status || inventory.adapter_status || '',
      config_status: config?.status || (inventory.config_required ? 'not_configured' : 'not_required'),
      status,
      summary: buildSnapshotSummary(status, inventory),
      details: {
        required_secret_keys: input.required_secret_keys || [],
        config_health: configHealth || null,
        runtime_status: runtimeConfig?.runtime_status || null,
        missing_secret_keys: runtimeConfig?.missing_secret_keys || [],
        adapter_health: adapterHealth || null,
        inventory_status: inventory.health_status
      },
      checked_at: new Date().toISOString(),
      created_by: input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO provider_health_snapshots
        (id, tenant_id, workspace_id, integration_id, category, source_type, adapter_type, adapter_status, config_status, status, summary, details, checked_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.tenant_id,
        snapshot.workspace_id,
        snapshot.integration_id,
        snapshot.category,
        snapshot.source_type,
        snapshot.adapter_type,
        snapshot.adapter_status,
        snapshot.config_status,
        snapshot.status,
        snapshot.summary,
        json(snapshot.details),
        snapshot.checked_at,
        snapshot.created_by
      ]
    );
    this.runStore?.audit?.(input.tenant_id, 'integration.provider_health_snapshot.created', 'provider_health_snapshot', snapshot.id, {
      integration_id: input.integration_id,
      status: snapshot.status,
      workspace_id: workspaceId
    }, input.actor_id || 'system');
    return this.listHealthSnapshots({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: input.integration_id,
      limit: 1
    })[0];
  }

  async executeProviderOperation(input: JsonRecord): Promise<JsonRecord> {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.integration_id) throw new Error('integration_id is required');
    if (!input.operation) throw new Error('operation is required');
    const workspaceId = input.workspace_id || 'default';
    if (!this.adapterRegistry.has(input.integration_id)) {
      throw new Error(`adapter not registered: ${input.integration_id}`);
    }
    const adapterEntry = this.adapterRegistry.get(input.integration_id);
    const runtimeConfig = this.integrationConfigStore.resolveRuntimeConfig({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: input.integration_id,
      required_secret_keys: input.required_secret_keys || []
    });
    if (runtimeConfig.status === 'disabled') throw new Error(`integration config is disabled: ${input.integration_id}`);
    if (runtimeConfig.missing_secret_keys.length) {
      throw new Error(`missing runtime secrets for ${input.integration_id}: ${runtimeConfig.missing_secret_keys.join(', ')}`);
    }
    const output = await adapterEntry.adapter.execute(input.operation, {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: input.integration_id,
      input: input.payload || {},
      config: runtimeConfig.runtime_config,
      secrets: runtimeConfig.resolved_secrets
    });
    this.runStore?.audit?.(input.tenant_id, 'integration.provider_operation.executed', 'tenant_integration_config', runtimeConfig.id, {
      integration_id: input.integration_id,
      operation: input.operation,
      workspace_id: workspaceId
    }, input.actor_id || 'system');
    return output;
  }

  listHealthSnapshots({ tenant_id, workspace_id = 'default', integration_id = null, limit = 50 }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (integration_id) {
      clauses.push('integration_id = ?');
      params.push(integration_id);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM provider_health_snapshots
       WHERE ${clauses.join(' AND ')}
       ORDER BY checked_at DESC, created_at DESC
       LIMIT ?`,
      params
    ).map(decodeSnapshot);
  }

  listLatestSnapshots({ tenant_id, workspace_id = 'default' }: JsonRecord): JsonRecord[] {
    return all(
      this.db,
      `SELECT s.*
       FROM provider_health_snapshots s
       JOIN (
         SELECT integration_id, MAX(checked_at) AS max_checked_at
         FROM provider_health_snapshots
         WHERE tenant_id = ? AND workspace_id = ?
         GROUP BY integration_id
       ) latest
         ON s.integration_id = latest.integration_id AND s.checked_at = latest.max_checked_at
       WHERE s.tenant_id = ? AND s.workspace_id = ?
       ORDER BY s.integration_id ASC`,
      [tenant_id, workspace_id, tenant_id, workspace_id]
    ).map(decodeSnapshot);
  }

  selectProvider(input: JsonRecord = {}): ProviderSelection {
    const selection = this.previewSelection(input);
    if (!selection.candidates.length) throw new Error('no provider candidates found');
    return selection;
  }

  previewSelection(input: JsonRecord = {}): ProviderSelection {
    const workspaceId = input.workspace_id || 'default';
    const policyOverlay = this.resolvePolicyOverlay({ ...input, workspace_id: workspaceId });
    const selectionInput = applyPolicyOverlay(input, policyOverlay);
    const candidates = this.listInventory({
      tenant_id: selectionInput.tenant_id,
      workspace_id: workspaceId,
      category: selectionInput.category,
      source_type: selectionInput.source_type,
      capability: selectionInput.capability,
      min_stability: selectionInput.min_stability,
      include_skills: Boolean(selectionInput.include_skills)
    })
      .filter((candidate) => !(selectionInput.blocked_ids || []).includes(candidate.integration_id))
      .map((candidate) => ({
        ...candidate,
        selection_score: scoreCandidate(candidate, selectionInput)
      }))
      .sort((a, b) => b.selection_score - a.selection_score || b.stability_score - a.stability_score || a.name.localeCompare(b.name));

    if (!candidates.length) {
      return {
        selected: null,
        selection_basis: 'no_provider_candidates',
        policy_overlay: policyOverlay,
        candidates: []
      };
    }
    const selected = candidates.find((candidate) => isSelectable(candidate, selectionInput)) || candidates[0];
    return {
      selected,
      selection_basis: isSelectable(selected, selectionInput) ? 'best_selectable_candidate' : 'best_fallback_candidate',
      policy_overlay: policyOverlay,
      candidates: candidates.slice(0, selectionInput.limit || 10)
    };
  }

  buildContextPack({ tenant_id, workspace_id = 'default', agent = null, playbook = null }: JsonRecord = {}) {
    if (!tenant_id) throw new Error('tenant_id is required');
    const routingProfiles = resolveContextRoutingProfiles(agent, playbook);
    if (!routingProfiles.length) {
      return {
        inventory_summary: [],
        active_policies: [],
        routing_hints: []
      };
    }
    const relevantCategories = [...new Set(routingProfiles.map((profile) => profile.category))];
    const inventorySummary = relevantCategories
      .map((category) => summarizeInventory(category, this.listInventory({ tenant_id, workspace_id, category })))
      .filter(Boolean);
    const activePolicies = this.listPolicies({
      tenant_id,
      workspace_id,
      status: 'active'
    })
      .filter((policy) => !policy.category || relevantCategories.includes(policy.category))
      .map((policy) => ({
        policy_id: policy.policy_id,
        name: policy.name,
        use_case: policy.use_case,
        category: policy.category,
        capability: policy.capability,
        preferred_integration_ids: policy.preferred_integration_ids,
        blocked_integration_ids: policy.blocked_integration_ids,
        allow_fallback: Boolean(policy.allow_fallback),
        min_stability: policy.min_stability,
        updated_at: policy.updated_at
      }));
    const routingHints = routingProfiles.map((profile) => {
      const selection = this.previewSelection({
        tenant_id,
        workspace_id,
        category: profile.category,
        capability: profile.capability,
        use_case: profile.use_case,
        allow_fallback: profile.allow_fallback
      });
      return {
        hint_id: profile.hint_id,
        label: profile.label,
        category: profile.category,
        capability: profile.capability || '',
        use_case: profile.use_case || '',
        selected_integration_id: selection.selected?.integration_id || null,
        selection_basis: selection.selection_basis,
        policy_id: selection.policy_overlay?.policy_id || null,
        allow_fallback: profile.allow_fallback,
        candidate_integration_ids: selection.candidates.map((candidate) => candidate.integration_id)
      };
    });
    return {
      inventory_summary: inventorySummary,
      active_policies: activePolicies,
      routing_hints: routingHints
    };
  }

  resolvePolicyOverlay(input: JsonRecord = {}): ProviderPolicy | null {
    if (!input.tenant_id) return null;
    const workspaceId = input.workspace_id || 'default';
    if (input.policy_id) {
      const policy = this.getPolicy(input.tenant_id, workspaceId, input.policy_id);
      if (!policy || policy.status !== 'active') return null;
      return policyMatchesSelection(policy, input) ? policy : null;
    }
    const candidates = this.listPolicies({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      status: 'active'
    }).filter((policy) => policyMatchesSelection(policy, input));
    return candidates
      .map((policy) => ({ ...policy, match_score: scorePolicyMatch(policy, input) }))
      .sort((a, b) => b.match_score - a.match_score || b.updated_at.localeCompare(a.updated_at))[0] || null;
  }
}

function composeInventoryEntry({ entry, config, adapterEntry, latestSnapshot, workspaceId }) {
  const configRequired = requiresConfig(entry);
  const healthStatus = latestSnapshot?.status || deriveInventoryHealthStatus({ entry, config, adapterEntry });
  return {
    integration_id: entry.id,
    workspace_id: workspaceId,
    name: entry.name,
    category: entry.category,
    source_type: entry.source_type,
    license: entry.license,
    maturity: entry.maturity,
    stability_score: entry.stability_score,
    capabilities: entry.capabilities,
    adapter_status: entry.adapter_status,
    adapter_type: adapterEntry?.definition?.adapter_type || '',
    adapter_runtime_status: adapterEntry?.definition?.status || '',
    operations: adapterEntry?.definition?.operations || [],
    adoption_tier: entry.adoption_tier,
    config_required: configRequired,
    configured: Boolean(config) || !configRequired,
    config_status: config?.status || (configRequired ? 'not_configured' : 'not_required'),
    health_status: healthStatus,
    health_checked_at: latestSnapshot?.checked_at || config?.last_checked_at || null,
    latest_health_snapshot_id: latestSnapshot?.id || null,
    secret_ref_count: config?.secret_ref_ids?.length || 0,
    recommended_use: entry.recommended_use,
    caution_notes: entry.caution_notes
  };
}

function deriveInventoryHealthStatus({ entry, config, adapterEntry }) {
  if (entry.adapter_status === 'manual_reference') return 'reference_only';
  if (!requiresConfig(entry)) return entry.adapter_status === 'native' ? 'ready' : 'healthy';
  if (!config) return entry.adapter_status === 'planned' || adapterEntry?.definition?.status === 'planned' ? 'planned' : 'not_configured';
  if (config.status === 'disabled' || config.health_status === 'degraded') return 'degraded';
  if (entry.adapter_status === 'planned' || adapterEntry?.definition?.status === 'planned') return 'configured_planned_adapter';
  if (config.health_status === 'healthy') return 'healthy';
  return 'configured';
}

function resolveSnapshotStatus({ entry, config, configHealth, adapterEntry, adapterHealth }) {
  if (entry.adapter_status === 'manual_reference') return 'reference_only';
  if (!entry.config_required) return entry.adapter_status === 'native' ? 'ready' : adapterHealth?.status || 'healthy';
  if (!config) return entry.adapter_status === 'planned' || adapterEntry?.definition?.status === 'planned' ? 'planned' : 'not_configured';
  if (config.status === 'disabled' || configHealth?.status === 'degraded' || adapterHealth?.status === 'degraded') return 'degraded';
  if (entry.adapter_status === 'planned' || adapterEntry?.definition?.status === 'planned') return 'configured_planned_adapter';
  if (configHealth?.status === 'healthy' || adapterHealth?.status === 'healthy') return 'healthy';
  return 'configured';
}

function scoreCandidate(candidate, input) {
  let score = candidate.stability_score;
  if (candidate.health_status === 'ready') score += 50;
  if (candidate.health_status === 'healthy') score += 45;
  if (candidate.health_status === 'configured') score += 35;
  if (candidate.health_status === 'configured_planned_adapter') score += 18;
  if (candidate.health_status === 'planned') score += 4;
  if (candidate.health_status === 'not_configured') score -= 30;
  if (candidate.health_status === 'degraded') score -= 40;
  if (candidate.health_status === 'reference_only') score -= 50;
  if ((input.preferred_ids || []).includes(candidate.integration_id)) score += 200;
  if (candidate.configured) score += 15;
  if (candidate.adapter_status === 'native') score += 10;
  if (candidate.adapter_status === 'http_adapter' || candidate.adapter_status === 'mcp') score += 6;
  if (candidate.adoption_tier === 'core') score += 8;
  return score;
}

function applyPolicyOverlay(input, policy) {
  if (!policy) return input;
  return {
    ...input,
    category: input.category || policy.category || undefined,
    capability: input.capability || policy.capability || undefined,
    min_stability: input.min_stability ?? policy.min_stability ?? undefined,
    preferred_ids: compactUnique([...(input.preferred_ids || []), ...policy.preferred_integration_ids]),
    blocked_ids: compactUnique([...(input.blocked_ids || []), ...policy.blocked_integration_ids]),
    allow_fallback: input.allow_fallback ?? Boolean(policy.allow_fallback)
  };
}

function policyMatchesSelection(policy, input) {
  if (policy.use_case && input.use_case && policy.use_case !== input.use_case) return false;
  if (policy.use_case && !input.use_case && input.policy_id !== policy.policy_id) return false;
  if (policy.category && input.category && policy.category !== input.category) return false;
  if (policy.capability && input.capability && policy.capability !== input.capability) return false;
  return true;
}

function scorePolicyMatch(policy, input) {
  let score = 0;
  if (policy.policy_id && policy.policy_id === input.policy_id) score += 1000;
  if (policy.use_case && policy.use_case === input.use_case) score += 100;
  if (policy.category && policy.category === input.category) score += 40;
  if (policy.capability && policy.capability === input.capability) score += 20;
  if (!policy.use_case) score += 1;
  return score;
}

function compactUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isSelectable(candidate, input) {
  const allowedStatuses = input.allow_fallback
    ? ['ready', 'healthy', 'configured', 'configured_planned_adapter', 'planned']
    : ['ready', 'healthy', 'configured', 'configured_planned_adapter'];
  if (allowedStatuses.includes(candidate.health_status)) return true;
  return Boolean(input.allow_fallback
    && (input.preferred_ids || []).includes(candidate.integration_id)
    && candidate.health_status === 'not_configured');
}

function resolveContextRoutingProfiles(agent, playbook) {
  const allowedToolsets = new Set([...(agent?.allowed_toolsets || []), ...(playbook?.allowed_toolsets || [])]);
  const profiles = [
    {
      hint_id: 'model.default',
      label: 'Default model routing',
      category: 'model_provider',
      capability: 'chat_completion',
      use_case: '',
      allow_fallback: true
    }
  ];
  if (agent?.agent_id === 'orchestration_agent' || String(playbook?.playbook_id || '').startsWith('orchestration_agent.')) {
    profiles.push({
      hint_id: 'model.commander_plan',
      label: 'Commander planning model routing',
      category: 'model_provider',
      capability: 'chat_completion',
      use_case: 'commander_plan',
      allow_fallback: true
    });
  }
  if (allowedToolsets.has('knowledge')) {
    profiles.push(
      {
        hint_id: 'model.wiki_synthesize',
        label: 'Wiki synthesis model routing',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'wiki.synthesize_page_draft',
        allow_fallback: true
      },
      {
        hint_id: 'model.wiki_diff',
        label: 'Wiki diff model routing',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'wiki.propose_page_diff',
        allow_fallback: true
      },
      {
        hint_id: 'model.wiki_review',
        label: 'Wiki review model routing',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'wiki.detect_contradictions',
        allow_fallback: true
      }
    );
  }
  if (allowedToolsets.has('voice')) {
    profiles.push(
      {
        hint_id: 'voice.default',
        label: 'Default voice routing',
        category: 'voice',
        capability: '',
        use_case: '',
        allow_fallback: true
      },
      {
        hint_id: 'voice.outbound_call',
        label: 'Outbound call routing',
        category: 'voice',
        capability: '',
        use_case: 'outbound_call',
        allow_fallback: true
      }
    );
  }
  if (allowedToolsets.has('search')) {
    profiles.push(
      {
        hint_id: 'search.default',
        label: 'Default AI search routing',
        category: 'ai_search',
        capability: 'ai_search',
        use_case: '',
        allow_fallback: true
      },
      {
        hint_id: 'search.lead_discovery',
        label: 'Lead discovery search routing',
        category: 'ai_search',
        capability: '',
        use_case: 'lead_discovery',
        allow_fallback: true
      }
    );
  }
  if (allowedToolsets.has('notebook')) {
    profiles.push(
      {
        hint_id: 'notebook.default',
        label: 'Default notebook routing',
        category: 'notebook_workspace',
        capability: 'citation_chat',
        use_case: '',
        allow_fallback: true
      },
      {
        hint_id: 'notebook.audio_overview',
        label: 'Notebook audio overview routing',
        category: 'notebook_workspace',
        capability: 'podcast_generation',
        use_case: '',
        allow_fallback: true
      }
    );
  }
  if (allowedToolsets.has('geo')) {
    profiles.push(
      {
        hint_id: 'geo.place_discovery',
        label: 'Local business place discovery routing',
        category: 'geo_business_data',
        capability: 'place_search',
        use_case: 'lead_discovery',
        allow_fallback: true
      },
      {
        hint_id: 'geo.review_enrichment',
        label: 'Business review enrichment routing',
        category: 'geo_business_data',
        capability: 'business_reviews',
        use_case: 'lead_discovery',
        allow_fallback: true
      },
      {
        hint_id: 'model.geo_pain_signals',
        label: 'Geo pain insight model routing',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'geo.extract_pain_signals',
        allow_fallback: true
      },
      {
        hint_id: 'model.geo_outreach',
        label: 'Geo outreach draft model routing',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'geo.generate_outreach_draft',
        allow_fallback: true
      }
    );
  }
  return profiles;
}

function summarizeInventory(category, entries) {
  if (!entries.length) return null;
  return {
    category,
    total: entries.length,
    selectable: entries.filter((entry) => isSelectable(entry, { allow_fallback: true })).length,
    configured: entries.filter((entry) => entry.configured).length,
    healthy: entries.filter((entry) => ['ready', 'healthy', 'configured'].includes(entry.health_status)).length,
    top_integration_ids: entries
      .slice()
      .sort((a, b) => b.stability_score - a.stability_score || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((entry) => entry.integration_id)
  };
}

function requiresConfig(entry) {
  return !['internal', 'skill'].includes(entry.source_type);
}

function buildSnapshotSummary(status, inventory) {
  return `${inventory.integration_id} provider snapshot is ${status}`;
}

function decodeSnapshot(row) {
  return {
    ...row,
    details: parseJson(row.details)
  };
}

function decodePolicy(row) {
  return {
    ...row,
    preferred_integration_ids: parseJson(row.preferred_integration_ids, []),
    blocked_integration_ids: parseJson(row.blocked_integration_ids, []),
    allow_fallback: Boolean(row.allow_fallback),
    config: parseJson(row.config)
  };
}
