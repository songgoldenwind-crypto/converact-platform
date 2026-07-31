import type { ToolRegistry } from './tools/tool-registry.js';
import type { SidecarHealthChecker } from './ops/sidecar-health.js';
import { all, parseJson } from '../db.js';

interface OpsToolDeps {
  db?: unknown;
  voiceStore?: {
    getCallCenterOpsOverview?: (input: any) => Record<string, unknown>;
    getMediaOpsOverview?: (input: any) => Record<string, unknown>;
  };
  quotaStore?: {
    listLimits?: (tenantId: string) => Record<string, unknown>[];
    getUsage?: (input: Record<string, unknown>) => Record<string, unknown>;
  };
  providerRegistryStore?: unknown;
  geoRoutingStore?: {
    listRoutingPolicies?: (input: Record<string, unknown>) => Record<string, unknown>[];
    listRoutingPolicyApprovalRequests?: (input: Record<string, unknown>) => Record<string, unknown>[];
    listRoutingPolicyActionHistory?: (input: Record<string, unknown>) => Record<string, unknown>[];
  };
}

export function registerOpsTools(toolRegistry: ToolRegistry, sidecarHealthChecker: SidecarHealthChecker, deps: OpsToolDeps = {}): void {
  toolRegistry.register(
    {
      tool_id: 'ops.sidecar_health_check',
      display_name: 'Check polyglot sidecar health',
      toolset: 'ops',
      category: 'read',
      risk_level: 'R0',
      input_schema: {},
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['ops_agent', 'orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: false,
      object_scope_required: false,
      audit_event_name: 'tool.ops_sidecar_health_check'
    },
    (input) => sidecarHealthChecker.check(input)
  );

  toolRegistry.register(
    {
      tool_id: 'admin.tenant_operations_overview',
      display_name: 'View tenant operations overview',
      toolset: 'admin',
      category: 'read',
      risk_level: 'R0',
      input_schema: {},
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['ops_agent', 'orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.admin_tenant_operations_overview'
    },
    async (input) => buildTenantOperationsOverview(sidecarHealthChecker, deps, input)
  );

  toolRegistry.register(
    adminReadTool({
      tool_id: 'admin.provider_routing_ops_overview',
      display_name: 'View provider routing operations overview',
      audit_event_name: 'tool.admin_provider_routing_ops_overview'
    }),
    (input) => buildProviderRoutingOpsOverview(deps, input)
  );

  toolRegistry.register(
    adminReadTool({
      tool_id: 'admin.crm_sync_mapping_overview',
      display_name: 'View CRM sync mapping overview',
      audit_event_name: 'tool.admin_crm_sync_mapping_overview'
    }),
    (input) => buildCrmSyncMappingOverview(deps, input)
  );

  toolRegistry.register(
    adminReadTool({
      tool_id: 'admin.notebook_knowledge_ops_overview',
      display_name: 'View notebook knowledge operations overview',
      audit_event_name: 'tool.admin_notebook_knowledge_ops_overview'
    }),
    (input) => buildNotebookKnowledgeOpsOverview(deps, input)
  );

  toolRegistry.register(
    adminReadTool({
      tool_id: 'admin.billing_quota_ops_overview',
      display_name: 'View billing quota operations overview',
      audit_event_name: 'tool.admin_billing_quota_ops_overview'
    }),
    (input) => buildBillingQuotaOpsOverview(deps, input)
  );

  toolRegistry.register(
    adminReadTool({
      tool_id: 'admin.quality_contract_ops_overview',
      display_name: 'View quality contract operations overview',
      audit_event_name: 'tool.admin_quality_contract_ops_overview'
    }),
    (input) => buildQualityContractOpsOverview(toolRegistry, deps, input)
  );

  toolRegistry.register(
    adminReadTool({
      tool_id: 'admin.p1_foundation_overview',
      display_name: 'View P1 foundation operations overview',
      audit_event_name: 'tool.admin_p1_foundation_overview'
    }),
    async (input) => ({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      generated_at: new Date().toISOString(),
      provider_routing: buildProviderRoutingOpsOverview(deps, input),
      crm_sync_mapping: buildCrmSyncMappingOverview(deps, input),
      notebook_knowledge: buildNotebookKnowledgeOpsOverview(deps, input),
      billing_quota: buildBillingQuotaOpsOverview(deps, input),
      quality_contracts: buildQualityContractOpsOverview(toolRegistry, deps, input)
    })
  );
}

function adminReadTool(overrides: Record<string, unknown>): any {
  return {
    toolset: 'admin',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['ops_agent', 'orchestration_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

async function buildTenantOperationsOverview(
  sidecarHealthChecker: SidecarHealthChecker,
  deps: OpsToolDeps,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  const tenantId = String(input.tenant_id);
  const workspaceId = String(input.workspace_id || 'default');
  const db = deps.db;
  const approvals = db ? all(db, 'SELECT * FROM approval_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [tenantId, Number(input.approval_limit || 50)]) : [];
  const toolCalls = db ? all(db, 'SELECT * FROM tool_calls WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [tenantId, Number(input.tool_limit || 100)]) : [];
  const artifacts = db ? all(db, 'SELECT * FROM agent_artifacts WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?', [tenantId, Number(input.artifact_limit || 50)]) : [];
  const policyDecisions = db ? all(db, 'SELECT * FROM policy_decisions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [tenantId, Number(input.policy_decision_limit || 100)]) : [];
  const providerHealth = db ? all(db, 'SELECT * FROM provider_health_snapshots WHERE tenant_id = ? AND workspace_id = ? ORDER BY checked_at DESC LIMIT ?', [tenantId, workspaceId, Number(input.provider_limit || 50)]).map((row) => ({ ...row, details: parseJson(row.details) })) : [];
  const quotaLimits = deps.quotaStore?.listLimits?.(tenantId) || [];
  const quotaUsage = quotaLimits.map((limit) => deps.quotaStore?.getUsage?.({
    tenant_id: tenantId,
    quota_key: limit.quota_key,
    period: limit.period
  }) || null).filter(Boolean);
  const voice = deps.voiceStore?.getCallCenterOpsOverview?.({ tenant_id: tenantId, workspace_id: workspaceId, limit: input.voice_limit || 50 }) || null;
  const media = deps.voiceStore?.getMediaOpsOverview?.({ tenant_id: tenantId, workspace_id: workspaceId, limit: input.voice_limit || 50 }) || null;
  const geoPolicies = deps.geoRoutingStore?.listRoutingPolicies?.({ tenant_id: tenantId, workspace_id: workspaceId, limit: input.geo_limit || 50 }) || [];
  const geoApprovals = deps.geoRoutingStore?.listRoutingPolicyApprovalRequests?.({ tenant_id: tenantId, workspace_id: workspaceId, status: 'pending', limit: input.geo_limit || 50 }) || [];
  const geoHistory = deps.geoRoutingStore?.listRoutingPolicyActionHistory?.({ tenant_id: tenantId, workspace_id: workspaceId, limit: input.geo_limit || 100 }) || [];
  const sidecars = await sidecarHealthChecker.check({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    timeout_ms: input.timeout_ms ? Number(input.timeout_ms) : 300
  });
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const failedToolCalls = toolCalls.filter((call) => call.status === 'failed');
  const quotaNearLimit = quotaUsage.filter((usage) => ['warning', 'blocked', 'warn', 'hard_limit_exceeded'].includes(String(usage?.status || '')));
  const remediationNeeded = buildAdminRemediation({
    sidecars,
    pendingApprovals,
    failedToolCalls,
    quotaNearLimit,
    voice,
    media,
    geoApprovals
  });
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: new Date().toISOString(),
    health_status: remediationNeeded.some((item) => item.severity === 'critical') ? 'critical' : remediationNeeded.length ? 'degraded' : 'healthy',
    components: {
      approvals: {
        total_recent: approvals.length,
        pending: pendingApprovals.length,
        approved: approvals.filter((approval) => approval.status === 'approved').length,
        rejected: approvals.filter((approval) => approval.status === 'rejected').length
      },
      audit: {
        recent_policy_decisions: policyDecisions.length,
        deny_decisions: policyDecisions.filter((decision) => decision.decision === 'deny').length,
        recent_artifacts: artifacts.length,
        failed_tool_calls: failedToolCalls.length
      },
      providers: {
        recent_health_snapshots: providerHealth.length,
        degraded_snapshots: providerHealth.filter((snapshot) => ['degraded', 'not_configured'].includes(String(snapshot.status))).length,
        latest: providerHealth.slice(0, 10)
      },
      voice,
      media,
      geo_routing: {
        policy_count: geoPolicies.length,
        pending_approvals: geoApprovals.length,
        recent_action_history: geoHistory.length,
        blocked_actions: geoHistory.filter((entry) => entry.status === 'blocked_pending_approval').length
      },
      quota: {
        limit_count: quotaLimits.length,
        near_or_over_limit: quotaNearLimit.length,
        usage: quotaUsage
      },
      sidecars
    },
    remediation_needed: remediationNeeded
  };
}

function buildAdminRemediation(input: Record<string, any>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const sidecar of input.sidecars.sidecars || []) {
    if (sidecar.status === 'degraded') {
      items.push({ component: 'sidecar', severity: 'critical', action: 'check_sidecar_runtime', sidecar_id: sidecar.sidecar_id });
    }
  }
  if (input.pendingApprovals.length) {
    items.push({ component: 'approvals', severity: 'high', action: 'review_pending_approvals', count: input.pendingApprovals.length });
  }
  if (input.failedToolCalls.length) {
    items.push({ component: 'audit', severity: 'high', action: 'inspect_failed_tool_calls', count: input.failedToolCalls.length });
  }
  if (input.quotaNearLimit.length) {
    items.push({ component: 'quota', severity: 'high', action: 'review_quota_limits', count: input.quotaNearLimit.length });
  }
  if (Number(input.voice?.summary?.overflow_routing_snapshots || 0) > 0) {
    items.push({ component: 'voice', severity: 'high', action: 'add_agent_capacity_or_queue_members', count: input.voice.summary.overflow_routing_snapshots });
  }
  if (Number(input.media?.summary?.due_recording_count || 0) > 0) {
    items.push({ component: 'media', severity: 'medium', action: 'run_recording_retention_plan', count: input.media.summary.due_recording_count });
  }
  if (input.geoApprovals.length) {
    items.push({ component: 'geo_routing', severity: 'medium', action: 'review_geo_routing_pending_approvals', count: input.geoApprovals.length });
  }
  return items;
}

function buildProviderRoutingOpsOverview(deps: OpsToolDeps, input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId, workspaceId, db } = requireTenantWorkspace(deps, input);
  const providerHealth = db ? all(db, `SELECT * FROM provider_health_snapshots
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY checked_at DESC, created_at DESC
    LIMIT ?`, [tenantId, workspaceId, Number(input.limit || 100)]).map((row) => ({ ...row, details: parseJson(row.details) })) : [];
  const policies = db ? all(db, `SELECT * FROM tenant_provider_policies
    WHERE tenant_id = ? AND workspace_id = ? AND status != 'archived'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?`, [tenantId, workspaceId, Number(input.limit || 100)]).map((row) => ({
      ...row,
      preferred_integration_ids: parseJson(row.preferred_integration_ids),
      blocked_integration_ids: parseJson(row.blocked_integration_ids),
      config: parseJson(row.config)
    })) : [];
  const integrationConfigs = db ? all(db, `SELECT integration_id, status, health_status, last_checked_at, updated_at
    FROM tenant_integration_configs
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC`, [tenantId, workspaceId]) : [];
  const modelConfigs = db ? all(db, `SELECT purpose, provider, model, status, updated_at
    FROM tenant_model_configs
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC`, [tenantId, workspaceId]) : [];
  const modelCalls = db ? all(db, `SELECT provider, model, purpose, status, cost, usage, created_at
    FROM model_calls
    WHERE tenant_id = ?
    ORDER BY created_at DESC
    LIMIT ?`, [tenantId, Number(input.model_call_limit || 100)]).map((row) => ({
      ...row,
      cost: parseJson(row.cost),
      usage: parseJson(row.usage)
    })) : [];
  const latestByIntegration = latestRowsBy(providerHealth, 'integration_id');
  const degradedHealth = providerHealth.filter((snapshot) => ['degraded', 'not_configured', 'reference_only', 'planned'].includes(String(snapshot.status)));
  const policyCoverage = {
    active_policy_count: policies.filter((policy) => policy.status === 'active').length,
    model_policy_count: policies.filter((policy) => ['model', 'llm', 'ai_model'].includes(String(policy.category)) || String(policy.capability).includes('model')).length,
    voice_policy_count: policies.filter((policy) => String(policy.category) === 'voice').length,
    search_policy_count: policies.filter((policy) => ['ai_search', 'search'].includes(String(policy.category))).length,
    fallback_enabled_count: policies.filter((policy) => Number(policy.allow_fallback) === 1).length,
    blocked_provider_refs: sum(policies.map((policy) => asArray(policy.blocked_integration_ids).length))
  };
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: new Date().toISOString(),
    readiness_status: degradedHealth.length ? 'needs_attention' : policies.length || integrationConfigs.length || modelConfigs.length ? 'ready' : 'not_configured',
    summary: {
      configured_integrations: integrationConfigs.filter((config) => config.status === 'configured').length,
      planned_integrations: integrationConfigs.filter((config) => config.status === 'planned').length,
      active_model_configs: modelConfigs.filter((config) => config.status === 'active').length,
      recent_health_snapshots: providerHealth.length,
      degraded_health_snapshots: degradedHealth.length,
      recent_model_calls: modelCalls.length,
      failed_model_calls: modelCalls.filter((call) => call.status === 'failed').length,
      estimated_model_cost: roundMoney(sum(modelCalls.map((call) => extractCost(call.cost))))
    },
    policy_coverage: policyCoverage,
    latest_provider_health: Object.values(latestByIntegration),
    configured_integrations: integrationConfigs,
    model_configs: modelConfigs,
    remediation: buildProviderRoutingRemediation({ policies, integrationConfigs, modelConfigs, degradedHealth, modelCalls })
  };
}

function buildCrmSyncMappingOverview(deps: OpsToolDeps, input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId, workspaceId, db } = requireTenantWorkspace(deps, input);
  const leads = db ? all(db, `SELECT l.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, c.platform_account
    FROM leads l
    LEFT JOIN contacts c ON c.id = l.contact_id
    WHERE l.tenant_id = ?
    ORDER BY l.updated_at DESC
    LIMIT ?`, [tenantId, Number(input.lead_limit || 100)]) : [];
  const tasks = db ? all(db, `SELECT * FROM tasks
    WHERE tenant_id = ?
    ORDER BY updated_at DESC
    LIMIT ?`, [tenantId, Number(input.task_limit || 100)]) : [];
  const rawInquiries = db ? all(db, `SELECT * FROM raw_inquiries
    WHERE tenant_id = ?
    ORDER BY updated_at DESC
    LIMIT ?`, [tenantId, Number(input.inquiry_limit || 100)]) : [];
  const sourceTags = db ? all(db, 'SELECT * FROM source_tags WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [tenantId, Number(input.source_limit || 100)]) : [];
  const crmConfigs = db ? all(db, `SELECT integration_id, status, health_status, updated_at
    FROM tenant_integration_configs
    WHERE tenant_id = ? AND workspace_id = ? AND (integration_id LIKE '%crm%' OR integration_id IN ('chatwoot', 'calcom'))
    ORDER BY updated_at DESC`, [tenantId, workspaceId]) : [];
  const missingContact = leads.filter((lead) => !lead.contact_id || (!lead.contact_email && !lead.contact_phone && !lead.platform_account));
  const openTasks = tasks.filter((task) => task.status === 'open');
  const highPriorityOpenTasks = openTasks.filter((task) => ['P0', 'P1'].includes(String(task.priority)));
  const suggestedMapping = [
    { opc_field: 'contact.name', source_columns: ['contact_name', 'name'], required: true },
    { opc_field: 'contact.phone', source_columns: ['contact_phone', 'phone', 'mobile'], required: true },
    { opc_field: 'contact.email', source_columns: ['contact_email', 'email'], required: false },
    { opc_field: 'lead.status', source_columns: ['status', 'stage'], required: true },
    { opc_field: 'lead.score_total', source_columns: ['score_total', 'score'], required: false },
    { opc_field: 'task.title', source_columns: ['task_title', 'next_action'], required: false },
    { opc_field: 'source.utm', source_columns: ['utm_source', 'utm_medium', 'utm_campaign'], required: false }
  ];
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: new Date().toISOString(),
    readiness_status: missingContact.length || rawInquiries.some((inquiry) => inquiry.status === 'raw_inquiry') ? 'needs_mapping_review' : leads.length || crmConfigs.length ? 'ready' : 'not_configured',
    summary: {
      crm_integration_configs: crmConfigs.length,
      configured_crm_integrations: crmConfigs.filter((config) => config.status === 'configured').length,
      lead_count: leads.length,
      open_task_count: openTasks.length,
      high_priority_open_task_count: highPriorityOpenTasks.length,
      raw_inquiry_count: rawInquiries.length,
      unnormalized_inquiry_count: rawInquiries.filter((inquiry) => inquiry.status === 'raw_inquiry').length,
      missing_contact_key_count: missingContact.length,
      source_tag_count: sourceTags.length
    },
    field_mapping_template: suggestedMapping,
    sync_objects: [
      { object_type: 'contact', local_table: 'contacts', external_key_strategy: 'email_or_phone_or_platform_account' },
      { object_type: 'lead', local_table: 'leads', external_key_strategy: 'raw_inquiry_id_or_external_crm_id_metadata' },
      { object_type: 'task', local_table: 'tasks', external_key_strategy: 'object_type_object_id_title_due_at' },
      { object_type: 'source_attribution', local_table: 'source_tags', external_key_strategy: 'utm_source_utm_medium_utm_campaign' }
    ],
    crm_integrations: crmConfigs,
    remediation: buildCrmMappingRemediation({ crmConfigs, leads, rawInquiries, missingContact, highPriorityOpenTasks })
  };
}

function buildNotebookKnowledgeOpsOverview(deps: OpsToolDeps, input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId, workspaceId, db } = requireTenantWorkspace(deps, input);
  const notebooks = db ? all(db, `SELECT * FROM tenant_notebooks
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC LIMIT ?`, [tenantId, workspaceId, Number(input.limit || 100)]).map((row) => ({ ...row, source_refs: parseJson(row.source_refs), tags: parseJson(row.tags) })) : [];
  const sessions = db ? all(db, `SELECT * FROM tenant_search_sessions
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC LIMIT ?`, [tenantId, workspaceId, Number(input.limit || 100)]).map((row) => ({ ...row, source_modes: parseJson(row.source_modes), domain_filters: parseJson(row.domain_filters), tags: parseJson(row.tags) })) : [];
  const runs = db ? all(db, `SELECT * FROM tenant_search_runs
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY created_at DESC LIMIT ?`, [tenantId, workspaceId, Number(input.run_limit || 100)]).map((row) => ({ ...row, citations: parseJson(row.citations), result_payload: parseJson(row.result_payload) })) : [];
  const sources = db ? all(db, `SELECT id, source_type, title, uri, status, created_at, updated_at FROM knowledge_sources
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC LIMIT ?`, [tenantId, workspaceId, Number(input.limit || 100)]) : [];
  const pages = db ? all(db, `SELECT id, slug, title, category, source_ids, status, version, updated_at FROM wiki_pages
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC LIMIT ?`, [tenantId, workspaceId, Number(input.limit || 100)]).map((row) => ({ ...row, source_ids: parseJson(row.source_ids) })) : [];
  const reviewArtifacts = db ? all(db, `SELECT id, type, status, updated_at FROM agent_artifacts
    WHERE tenant_id = ? AND type IN ('wiki_page_draft', 'wiki_page_diff', 'wiki_contradiction_review', 'notebook_query_result', 'notebook_audio_overview')
    ORDER BY updated_at DESC LIMIT ?`, [tenantId, Number(input.artifact_limit || 100)]) : [];
  const ungroundedPages = pages.filter((page) => asArray(page.source_ids).length === 0 && page.status !== 'archived');
  const notebooksWithoutSources = notebooks.filter((notebook) => asArray(notebook.source_refs).length === 0 && notebook.status === 'active');
  const citationCount = sum(runs.map((run) => asArray(run.citations).length));
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: new Date().toISOString(),
    readiness_status: ungroundedPages.length || notebooksWithoutSources.length ? 'needs_grounding_review' : sources.length || notebooks.length || pages.length ? 'ready' : 'not_configured',
    summary: {
      active_notebooks: notebooks.filter((notebook) => notebook.status === 'active').length,
      notebooks_without_sources: notebooksWithoutSources.length,
      active_search_sessions: sessions.filter((session) => session.status === 'active').length,
      recent_search_runs: runs.length,
      citation_count: citationCount,
      knowledge_source_count: sources.filter((source) => source.status === 'active').length,
      wiki_page_count: pages.filter((page) => page.status !== 'archived').length,
      ungrounded_wiki_pages: ungroundedPages.length,
      review_artifact_count: reviewArtifacts.length
    },
    provider_coverage: {
      search_providers: compactUnique(sessions.map((session) => session.provider_integration_id).filter(Boolean)),
      notebook_providers: compactUnique(notebooks.map((notebook) => notebook.provider_integration_id).filter(Boolean)),
      run_providers: compactUnique(runs.map((run) => run.provider_integration_id).filter(Boolean))
    },
    review_artifacts: reviewArtifacts,
    remediation: buildNotebookKnowledgeRemediation({ ungroundedPages, notebooksWithoutSources, runs, reviewArtifacts })
  };
}

function buildBillingQuotaOpsOverview(deps: OpsToolDeps, input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId, db } = requireTenantWorkspace(deps, input);
  const quotaLimits = deps.quotaStore?.listLimits?.(tenantId) || [];
  const quotaUsage = quotaLimits.map((limit) => deps.quotaStore?.getUsage?.({
    tenant_id: tenantId,
    quota_key: limit.quota_key,
    period: limit.period
  }) || null).filter(Boolean);
  const ledgerRows = db ? all(db, `SELECT quota_key, amount, period_key, metadata, created_at
    FROM usage_ledger
    WHERE tenant_id = ?
    ORDER BY created_at DESC LIMIT ?`, [tenantId, Number(input.ledger_limit || 200)]).map((row) => ({ ...row, metadata: parseJson(row.metadata) })) : [];
  const modelCalls = db ? all(db, `SELECT provider, model, purpose, status, usage, cost, created_at
    FROM model_calls
    WHERE tenant_id = ?
    ORDER BY created_at DESC LIMIT ?`, [tenantId, Number(input.model_call_limit || 200)]).map((row) => ({ ...row, usage: parseJson(row.usage), cost: parseJson(row.cost) })) : [];
  const toolCalls = db ? all(db, `SELECT tool_id, status, risk_level, created_at
    FROM tool_calls
    WHERE tenant_id = ?
    ORDER BY created_at DESC LIMIT ?`, [tenantId, Number(input.tool_call_limit || 200)]) : [];
  const spendByProvider = groupMoney(modelCalls, 'provider');
  const blockedQuotaUsage = quotaUsage.filter((usage) => String(usage?.status) === 'blocked');
  const warningQuotaUsage = quotaUsage.filter((usage) => String(usage?.status) === 'warning');
  return {
    tenant_id: tenantId,
    generated_at: new Date().toISOString(),
    readiness_status: blockedQuotaUsage.length ? 'blocked' : warningQuotaUsage.length ? 'warning' : quotaLimits.length ? 'ready' : 'not_configured',
    summary: {
      quota_limit_count: quotaLimits.length,
      blocked_quota_count: blockedQuotaUsage.length,
      warning_quota_count: warningQuotaUsage.length,
      usage_ledger_rows: ledgerRows.length,
      recent_model_calls: modelCalls.length,
      failed_model_calls: modelCalls.filter((call) => call.status === 'failed').length,
      recent_tool_calls: toolCalls.length,
      failed_tool_calls: toolCalls.filter((call) => call.status === 'failed').length,
      estimated_model_cost: roundMoney(sum(modelCalls.map((call) => extractCost(call.cost))))
    },
    quota_usage: quotaUsage,
    spend_by_provider: spendByProvider,
    usage_by_quota_key: groupAmounts(ledgerRows, 'quota_key'),
    remediation: buildBillingQuotaRemediation({ quotaLimits, quotaUsage, modelCalls, toolCalls })
  };
}

function buildQualityContractOpsOverview(toolRegistry: ToolRegistry, deps: OpsToolDeps, input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId, db } = requireTenantWorkspace(deps, input);
  const tools = toolRegistry.list();
  const completionReports = db ? all(db, `SELECT * FROM completion_reports
    WHERE tenant_id = ?
    ORDER BY created_at DESC LIMIT ?`, [tenantId, Number(input.report_limit || 100)]).map((row) => ({
      ...row,
      required_artifacts: parseJson(row.required_artifacts),
      produced_artifacts: parseJson(row.produced_artifacts),
      quality_results: parseJson(row.quality_results),
      concerns: parseJson(row.concerns)
    })) : [];
  const toolCalls = db ? all(db, `SELECT tool_id, status, risk_level, error, created_at
    FROM tool_calls
    WHERE tenant_id = ?
    ORDER BY created_at DESC LIMIT ?`, [tenantId, Number(input.tool_call_limit || 200)]) : [];
  const artifacts = db ? all(db, `SELECT type, status, quality_score, updated_at
    FROM agent_artifacts
    WHERE tenant_id = ?
    ORDER BY updated_at DESC LIMIT ?`, [tenantId, Number(input.artifact_limit || 100)]) : [];
  const byRisk = tools.reduce((acc, tool) => {
    acc[tool.risk_level] = (acc[tool.risk_level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const toolsWithContracts = tools.filter((tool) => tool.input_schema && tool.output_schema);
  const failedReports = completionReports.filter((report) => ['failed_quality_gate', 'failed_policy', 'cancelled'].includes(String(report.status)));
  const concernedReports = completionReports.filter((report) => asArray(report.concerns).length > 0 || String(report.status) === 'completed_with_concerns');
  const failedToolCalls = toolCalls.filter((call) => call.status === 'failed' || call.status === 'policy_denied');
  return {
    tenant_id: tenantId,
    generated_at: new Date().toISOString(),
    readiness_status: failedReports.length || failedToolCalls.length ? 'needs_regression_review' : completionReports.length || tools.length ? 'ready' : 'not_configured',
    summary: {
      registered_tool_count: tools.length,
      tool_contract_coverage: tools.length ? Number((toolsWithContracts.length / tools.length).toFixed(3)) : 0,
      risk_distribution: byRisk,
      recent_completion_reports: completionReports.length,
      failed_completion_reports: failedReports.length,
      reports_with_concerns: concernedReports.length,
      recent_tool_calls: toolCalls.length,
      failed_or_denied_tool_calls: failedToolCalls.length,
      recent_artifacts: artifacts.length,
      artifacts_needing_review: artifacts.filter((artifact) => ['draft', 'pending_approval'].includes(String(artifact.status))).length
    },
    contract_coverage: {
      tools_with_input_output_schema: toolsWithContracts.length,
      side_effect_tools: tools.filter((tool) => tool.side_effect).length,
      approval_required_tools: tools.filter((tool) => tool.approval_required).length,
      missing_contract_tools: tools.filter((tool) => !tool.input_schema || !tool.output_schema).map((tool) => tool.tool_id).slice(0, 25)
    },
    recent_quality_failures: failedReports.slice(0, 10),
    remediation: buildQualityContractRemediation({ tools, completionReports, failedReports, concernedReports, failedToolCalls, artifacts })
  };
}

function requireTenantWorkspace(deps: OpsToolDeps, input: Record<string, unknown>): { tenantId: string; workspaceId: string; db?: unknown } {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  return {
    tenantId: String(input.tenant_id),
    workspaceId: String(input.workspace_id || 'default'),
    db: deps.db
  };
}

function buildProviderRoutingRemediation(input: Record<string, any>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (!input.integrationConfigs.length) items.push({ component: 'provider_routing', severity: 'medium', action: 'configure_tenant_provider_integrations' });
  if (!input.policies.length) items.push({ component: 'provider_routing', severity: 'medium', action: 'create_provider_policy_overlays' });
  if (!input.modelConfigs.length) items.push({ component: 'model_routing', severity: 'medium', action: 'configure_tenant_default_model' });
  if (input.degradedHealth.length) items.push({ component: 'provider_health', severity: 'high', action: 'inspect_degraded_provider_health', count: input.degradedHealth.length });
  if (input.modelCalls.some((call) => call.status === 'failed')) items.push({ component: 'model_gateway', severity: 'high', action: 'review_failed_model_calls', count: input.modelCalls.filter((call) => call.status === 'failed').length });
  return items;
}

function buildCrmMappingRemediation(input: Record<string, any>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (!input.crmConfigs.length) items.push({ component: 'crm_sync', severity: 'medium', action: 'configure_or_confirm_crm_sync_adapter' });
  if (input.rawInquiries.some((inquiry) => inquiry.status === 'raw_inquiry')) items.push({ component: 'crm_sync', severity: 'high', action: 'normalize_raw_inquiries_before_sync', count: input.rawInquiries.filter((inquiry) => inquiry.status === 'raw_inquiry').length });
  if (input.missingContact.length) items.push({ component: 'crm_mapping', severity: 'high', action: 'repair_missing_contact_keys', count: input.missingContact.length });
  if (input.highPriorityOpenTasks.length) items.push({ component: 'crm_tasks', severity: 'medium', action: 'review_high_priority_open_tasks', count: input.highPriorityOpenTasks.length });
  return items;
}

function buildNotebookKnowledgeRemediation(input: Record<string, any>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (input.ungroundedPages.length) items.push({ component: 'knowledge_wiki', severity: 'high', action: 'attach_sources_to_ungrounded_pages', count: input.ungroundedPages.length });
  if (input.notebooksWithoutSources.length) items.push({ component: 'notebook', severity: 'medium', action: 'attach_sources_to_active_notebooks', count: input.notebooksWithoutSources.length });
  if (!input.runs.length) items.push({ component: 'research', severity: 'low', action: 'run_cited_search_or_notebook_queries' });
  if (input.reviewArtifacts.some((artifact) => artifact.status === 'draft')) items.push({ component: 'artifact_review', severity: 'medium', action: 'review_draft_knowledge_artifacts', count: input.reviewArtifacts.filter((artifact) => artifact.status === 'draft').length });
  return items;
}

function buildBillingQuotaRemediation(input: Record<string, any>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (!input.quotaLimits.length) items.push({ component: 'quota', severity: 'medium', action: 'create_default_tenant_quota_limits' });
  const blocked = input.quotaUsage.filter((usage) => usage.status === 'blocked');
  const warnings = input.quotaUsage.filter((usage) => usage.status === 'warning');
  if (blocked.length) items.push({ component: 'quota', severity: 'critical', action: 'raise_or_reduce_blocked_quotas', count: blocked.length });
  if (warnings.length) items.push({ component: 'quota', severity: 'high', action: 'review_warning_quotas', count: warnings.length });
  if (input.modelCalls.some((call) => call.status === 'failed')) items.push({ component: 'billing', severity: 'medium', action: 'inspect_failed_costed_model_calls', count: input.modelCalls.filter((call) => call.status === 'failed').length });
  if (input.toolCalls.some((call) => call.status === 'failed')) items.push({ component: 'quota', severity: 'medium', action: 'inspect_failed_metered_tool_calls', count: input.toolCalls.filter((call) => call.status === 'failed').length });
  return items;
}

function buildQualityContractRemediation(input: Record<string, any>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (input.failedReports.length) items.push({ component: 'quality_gate', severity: 'high', action: 'review_failed_completion_reports', count: input.failedReports.length });
  if (input.concernedReports.length) items.push({ component: 'quality_gate', severity: 'medium', action: 'triage_completion_report_concerns', count: input.concernedReports.length });
  if (input.failedToolCalls.length) items.push({ component: 'tool_contracts', severity: 'high', action: 'review_failed_or_denied_tool_calls', count: input.failedToolCalls.length });
  const pendingArtifacts = input.artifacts.filter((artifact) => ['draft', 'pending_approval'].includes(String(artifact.status)));
  if (pendingArtifacts.length) items.push({ component: 'artifact_review', severity: 'medium', action: 'review_pending_or_draft_artifacts', count: pendingArtifacts.length });
  if (!input.completionReports.length) items.push({ component: 'eval', severity: 'low', action: 'run_playbook_and_quality_gate_eval_fixtures' });
  return items;
}

function latestRowsBy(rows: Array<Record<string, unknown>>, key: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const value = String(row[key] || '');
    if (value && !result[value]) result[value] = row;
  }
  return result;
}

function compactUnique(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function extractCost(cost: unknown): number {
  if (typeof cost === 'number') return cost;
  if (!cost || typeof cost !== 'object') return 0;
  const record = cost as Record<string, unknown>;
  for (const key of ['total_usd', 'usd', 'total', 'amount']) {
    if (typeof record[key] === 'number') return Number(record[key]);
  }
  return 0;
}

function groupMoney(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const row of rows) {
    const groupKey = String(row[key] || 'unknown');
    grouped[groupKey] = roundMoney((grouped[groupKey] || 0) + extractCost(row.cost));
  }
  return grouped;
}

function groupAmounts(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const row of rows) {
    const groupKey = String(row[key] || 'unknown');
    grouped[groupKey] = (grouped[groupKey] || 0) + Number(row.amount || 0);
  }
  return grouped;
}
