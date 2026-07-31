import type { JsonRecord } from './integrations/provider-runtime-types.js';

interface RegisterableToolRegistry {
  register: (definition: JsonRecord, handler: (input: JsonRecord, context: JsonRecord) => unknown) => void;
}

interface GeoRoutingStoreLike {
  listTerritories: (input: JsonRecord) => unknown;
  upsertTerritory: (input: JsonRecord) => unknown;
  getRoutingPolicy: (tenantId: string, workspaceId?: string, policyId?: string) => JsonRecord;
  listRoutingPolicies: (input: JsonRecord) => JsonRecord[];
  listRoutingPolicyApprovalRequests: (input: JsonRecord) => JsonRecord[];
  listRoutingPolicyReviewStates: (input: JsonRecord) => JsonRecord[];
  listRoutingPolicyActionHistory: (input: JsonRecord) => JsonRecord[];
  recordRoutingPolicyActionHistory: (input: JsonRecord) => JsonRecord;
  getRoutingPolicyBatchPlan: (tenantId: string, planId: string) => JsonRecord | null;
  listRoutingPolicyBatchPlans: (input: JsonRecord) => JsonRecord[];
  upsertRoutingPolicyBatchPlan: (input: JsonRecord) => JsonRecord;
  upsertRoutingPolicyReviewState: (input: JsonRecord) => JsonRecord;
  upsertRoutingPolicy: (input: JsonRecord) => JsonRecord;
  recordRoutingPolicyRolloutSnapshot: (input: JsonRecord) => JsonRecord;
  getRoutingPolicyOverride: (tenantId: string, overrideId: string) => JsonRecord | null;
  listRoutingPolicyOverrides: (input: JsonRecord) => JsonRecord[];
  recordRoutingPolicyOverride: (input: JsonRecord) => JsonRecord;
  updateRoutingPolicyOverrideStatus: (tenantId: string, overrideId: string, status: string, actorId?: string) => JsonRecord | null;
  listRepCoverages: (input: JsonRecord) => unknown;
  upsertRepCoverage: (input: JsonRecord) => unknown;
  listHandoffs: (input: JsonRecord) => unknown;
  getHandoff: (tenantId: string, handoffId: string) => JsonRecord | null;
  getTerritoryCapacityReport: (input: JsonRecord) => JsonRecord;
  rebalanceTerritoryAssignments: (input: JsonRecord, context: JsonRecord) => JsonRecord;
  syncTerritoryFeedback: (input: JsonRecord, context: JsonRecord) => JsonRecord;
  runRoutingMaintenance: (input: JsonRecord, context: JsonRecord) => JsonRecord;
  generateHandoffPacket: (input: JsonRecord, context: JsonRecord) => unknown;
  recordHandoffExecution: (input: JsonRecord, context: JsonRecord) => JsonRecord | null;
}

interface NestedToolExecutorLike {
  execute: (context: JsonRecord, toolId: string, input: JsonRecord) => Promise<JsonRecord>;
  resumeApproved: (context: JsonRecord, toolCallId: string) => Promise<JsonRecord>;
}

interface ApprovalQueueLike {
  decide: (tenantId: string, approvalRequestId: string, decision: 'approved' | 'rejected', actorId?: string) => JsonRecord | null;
}

interface TriggerRunnerLike {
  createScheduledTrigger: (input: JsonRecord) => JsonRecord | null;
  listScheduledTriggers: (input: JsonRecord) => JsonRecord[];
  updateScheduledTrigger: (tenantId: string, triggerId: string, patch: JsonRecord) => JsonRecord | null;
}

export function registerGeoRoutingTools(
  toolRegistry: RegisterableToolRegistry,
  geoRoutingStore: GeoRoutingStoreLike,
  nestedToolExecutor: NestedToolExecutorLike,
  triggerRunner: TriggerRunnerLike,
  approvalQueue: ApprovalQueueLike,
): void {
  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.territory_list',
      display_name: 'List geo territories',
      audit_event_name: 'tool.geo_territory_list',
    }),
    (input) => geoRoutingStore.listTerritories(input),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.territory_upsert',
      display_name: 'Upsert geo territory',
      audit_event_name: 'tool.geo_territory_upsert',
    }),
    (input, context) => geoRoutingStore.upsertTerritory({ ...input, created_by: input.created_by || context.userId || 'system' }),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_list',
      display_name: 'List geo routing policies',
      audit_event_name: 'tool.geo_routing_policy_list',
    }),
    (input) => geoRoutingStore.listRoutingPolicies(input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_preview',
      display_name: 'Preview geo routing policy rollout',
      audit_event_name: 'tool.geo_routing_policy_preview',
    }),
    (input) => buildRoutingPolicyPlan(geoRoutingStore, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_override_list',
      display_name: 'List geo routing policy overrides',
      audit_event_name: 'tool.geo_routing_policy_override_list',
    }),
    (input) => geoRoutingStore.listRoutingPolicyOverrides(input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_override_diff',
      display_name: 'Diff geo routing policy override',
      audit_event_name: 'tool.geo_routing_policy_override_diff',
    }),
    (input) => buildRoutingPolicyOverrideDiff(geoRoutingStore, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_timeline',
      display_name: 'View geo routing policy timeline',
      audit_event_name: 'tool.geo_routing_policy_timeline',
    }),
    (input) => buildRoutingPolicyTimeline(geoRoutingStore, triggerRunner, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_ops_overview',
      display_name: 'View geo routing policy ops overview',
      audit_event_name: 'tool.geo_routing_policy_ops_overview',
    }),
    (input) => buildRoutingPolicyOpsOverview(geoRoutingStore, triggerRunner, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_review_queue',
      display_name: 'View geo routing policy review queue',
      audit_event_name: 'tool.geo_routing_policy_review_queue',
    }),
    (input) => buildRoutingPolicyReviewQueue(geoRoutingStore, triggerRunner, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_action_workbench',
      display_name: 'View geo routing policy action workbench',
      audit_event_name: 'tool.geo_routing_policy_action_workbench',
    }),
    (input) => buildRoutingPolicyActionWorkbench(geoRoutingStore, triggerRunner, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_action_history',
      display_name: 'View geo routing policy action history',
      audit_event_name: 'tool.geo_routing_policy_action_history',
    }),
    (input) => buildRoutingPolicyActionHistory(geoRoutingStore, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_target_audit_packet',
      display_name: 'Export geo routing policy target audit packet',
      audit_event_name: 'tool.geo_routing_policy_target_audit_packet',
    }),
    (input) => buildRoutingPolicyTargetAuditPacket(geoRoutingStore, triggerRunner, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_preview',
      display_name: 'Preview geo routing policy batch plan',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_preview',
    }),
    (input) => buildRoutingPolicyBatchPlanPreview(geoRoutingStore, triggerRunner, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_list',
      display_name: 'List geo routing policy batch plans',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_list',
    }),
    (input) => listRoutingPolicyBatchPlans(geoRoutingStore, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_detail',
      display_name: 'View geo routing policy batch plan detail',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_detail',
    }),
    (input) => buildRoutingPolicyBatchPlanDetail(geoRoutingStore, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_lineage',
      display_name: 'View geo routing policy batch plan lineage',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_lineage',
    }),
    (input) => buildRoutingPolicyBatchPlanLineage(geoRoutingStore, input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_target',
      display_name: 'Resolve geo routing policy batch plan target',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_target',
    }),
    (input) => buildRoutingPolicyBatchPlanTarget(geoRoutingStore, input),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_upsert',
      display_name: 'Upsert geo routing policy',
      audit_event_name: 'tool.geo_routing_policy_upsert',
    }),
    (input, context) => geoRoutingStore.upsertRoutingPolicy({ ...input, actor_id: input.actor_id || context.userId || 'system' }),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.override_routing_policy',
      display_name: 'Apply geo routing policy override',
      audit_event_name: 'tool.geo_override_routing_policy',
      risk_level: 'R3',
      approval_required: true,
    }),
    (input, context) => applyRoutingPolicyOverride(geoRoutingStore, triggerRunner, {
      ...input,
      actor_id: input.actor_id || context.userId || 'system'
    }),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.rollback_routing_policy_override',
      display_name: 'Rollback geo routing policy override',
      audit_event_name: 'tool.geo_rollback_routing_policy_override',
      risk_level: 'R3',
      approval_required: true,
    }),
    (input, context) => rollbackRoutingPolicyOverride(geoRoutingStore, triggerRunner, {
      ...input,
      actor_id: input.actor_id || context.userId || 'system'
    }),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_review_acknowledge',
      display_name: 'Acknowledge geo routing policy review item',
      audit_event_name: 'tool.geo_routing_policy_review_acknowledge',
      risk_level: 'R1',
    }),
    (input, context) => acknowledgeRoutingPolicyReviewItem(geoRoutingStore, triggerRunner, {
      ...input,
      actor_id: input.actor_id || context.userId || 'system'
    }),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_review_action_execute',
      display_name: 'Execute geo routing policy review action',
      audit_event_name: 'tool.geo_routing_policy_review_action_execute',
      risk_level: 'R2',
    }),
    (input, context) => executeRoutingPolicyReviewAction(
      geoRoutingStore,
      nestedToolExecutor,
      triggerRunner,
      approvalQueue,
      {
        ...input,
        actor_id: input.actor_id || context.userId || 'system'
      },
      context
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_review_batch_execute',
      display_name: 'Execute geo routing policy review batch actions',
      audit_event_name: 'tool.geo_routing_policy_review_batch_execute',
      risk_level: 'R2',
    }),
    (input, context) => executeRoutingPolicyReviewBatch(
      geoRoutingStore,
      nestedToolExecutor,
      triggerRunner,
      approvalQueue,
      {
        ...input,
        actor_id: input.actor_id || context.userId || 'system'
      },
      context
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_upsert',
      display_name: 'Save geo routing policy batch plan',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_upsert',
      risk_level: 'R1',
    }),
    (input, context) => upsertRoutingPolicyBatchPlan(
      geoRoutingStore,
      triggerRunner,
      {
        ...input,
        actor_id: input.actor_id || context.userId || 'system'
      }
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_refresh',
      display_name: 'Refresh geo routing policy batch plan',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_refresh',
      risk_level: 'R1',
    }),
    (input, context) => refreshRoutingPolicyBatchPlan(
      geoRoutingStore,
      triggerRunner,
      {
        ...input,
        actor_id: input.actor_id || context.userId || 'system'
      }
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.routing_policy_batch_plan_govern',
      display_name: 'Govern geo routing policy batch plan',
      audit_event_name: 'tool.geo_routing_policy_batch_plan_govern',
      risk_level: 'R1',
    }),
    (input, context) => governRoutingPolicyBatchPlan(
      geoRoutingStore,
      {
        ...input,
        actor_id: input.actor_id || context.userId || 'system'
      }
    ),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.rep_coverage_list',
      display_name: 'List geo rep coverages',
      audit_event_name: 'tool.geo_rep_coverage_list',
    }),
    (input) => geoRoutingStore.listRepCoverages(input),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.rep_coverage_upsert',
      display_name: 'Upsert geo rep coverage',
      audit_event_name: 'tool.geo_rep_coverage_upsert',
    }),
    (input, context) => geoRoutingStore.upsertRepCoverage({ ...input, created_by: input.created_by || context.userId || 'system' }),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.handoff_list',
      display_name: 'List geo handoff packets',
      audit_event_name: 'tool.geo_handoff_list',
    }),
    (input) => geoRoutingStore.listHandoffs(input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.territory_capacity_report',
      display_name: 'Get geo territory capacity report',
      audit_event_name: 'tool.geo_territory_capacity_report',
    }),
    (input) => geoRoutingStore.getTerritoryCapacityReport(input),
  );

  toolRegistry.register(
    readGeoRoutingTool({
      tool_id: 'geo.routing_trigger_list',
      display_name: 'List geo routing triggers',
      audit_event_name: 'tool.geo_routing_trigger_list',
    }),
    (input) => listRoutingTriggers(triggerRunner, input),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.generate_handoff_packet',
      display_name: 'Generate geo handoff packet',
      audit_event_name: 'tool.geo_generate_handoff_packet',
    }),
    (input, context) => geoRoutingStore.generateHandoffPacket({ ...input, created_by: input.created_by || context.userId || 'system' }, context),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.rebalance_territory_handoffs',
      display_name: 'Rebalance geo territory handoffs',
      audit_event_name: 'tool.geo_rebalance_territory_handoffs',
    }),
    (input, context) => geoRoutingStore.rebalanceTerritoryAssignments(
      { ...input, rebalanced_by: input.rebalanced_by || context.userId || 'system' },
      context
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.sync_territory_feedback',
      display_name: 'Sync geo territory feedback',
      audit_event_name: 'tool.geo_sync_territory_feedback',
    }),
    (input, context) => geoRoutingStore.syncTerritoryFeedback(
      { ...input, synced_by: input.synced_by || context.userId || 'system' },
      context
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.bootstrap_routing_triggers',
      display_name: 'Bootstrap geo routing triggers',
      audit_event_name: 'tool.geo_bootstrap_routing_triggers',
    }),
    (input, context) => bootstrapRoutingTriggers(geoRoutingStore, triggerRunner, {
      ...input,
      created_by: input.created_by || context.userId || 'system'
    }),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.rollout_routing_policy',
      display_name: 'Roll out geo routing policy',
      audit_event_name: 'tool.geo_rollout_routing_policy',
    }),
    (input, context) => rolloutRoutingPolicy(geoRoutingStore, triggerRunner, {
      ...input,
      actor_id: input.actor_id || context.userId || 'system'
    }),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.run_routing_maintenance',
      display_name: 'Run geo routing maintenance',
      audit_event_name: 'tool.geo_run_routing_maintenance',
    }),
    (input, context) => geoRoutingStore.runRoutingMaintenance(
      { ...input, maintained_by: input.maintained_by || context.userId || 'system' },
      context
    ),
  );

  toolRegistry.register(
    writeGeoRoutingTool({
      tool_id: 'geo.execute_handoff_packet',
      display_name: 'Execute geo handoff packet',
      audit_event_name: 'tool.geo_execute_handoff_packet',
      risk_level: 'R2',
    }),
    async (input, context) => {
      if (!input.handoff_id) {
        throw new Error('handoff_id is required');
      }
      const handoff = geoRoutingStore.getHandoff(String(input.tenant_id), String(input.handoff_id));
      if (!handoff) {
        throw new Error(`Geo handoff not found: ${input.handoff_id}`);
      }
      const priorExecution = typeof handoff.payload?.execution === 'object' && handoff.payload.execution
        ? handoff.payload.execution
        : null;
      if (priorExecution?.crm_task || priorExecution?.voice_followup) {
        return {
          handoff,
          execution: priorExecution,
          already_executed: true
        };
      }

      const crmTaskInput = {
        tenant_id: String(input.tenant_id),
        object_type: String(input.object_type || 'geo_place'),
        object_id: String(handoff.place_id),
        title: String(handoff.payload?.crm_task?.title || `Follow up ${handoff.payload?.place?.name || handoff.place_id}`),
        priority: String(handoff.payload?.crm_task?.priority_tier || handoff.priority_tier || 'P1'),
        due_hours: Number(input.crm_due_hours || 24),
        idempotency_key: `geo-handoff:${handoff.id}:crm-task`
      };
      const crmTask = summarizeExecutionResult(await nestedToolExecutor.execute(
        nestedContext(context, 'crm_agent', 'crm_task'),
        'crm.create_task',
        crmTaskInput
      ));

      const shouldQueueVoice = input.execute_voice_followup === false
        ? false
        : handoff.recommended_next_action === 'queue_voice_followup';
      let voiceFollowup: JsonRecord | null = null;
      if (shouldQueueVoice) {
        const phone = handoff.payload?.place?.phone || input.phone || null;
        if (!phone) {
          voiceFollowup = {
            status: 'skipped_missing_phone',
            reason: 'place.phone is required for voice follow-up execution'
          };
        } else {
          voiceFollowup = summarizeExecutionResult(await nestedToolExecutor.execute(
            nestedContext(context, 'voice_agent', 'voice_followup'),
            'voice.queue_call_for_approval',
            {
              tenant_id: String(input.tenant_id),
              lead_id: String(input.lead_id || handoff.place_id),
              phone: String(phone),
              script: String(handoff.payload?.voice_followup?.script || handoff.summary || `Follow up ${handoff.payload?.place?.name || handoff.place_id}`),
              route_id: String(handoff.payload?.voice_followup?.route_id || handoff.voice_route_id || 'default'),
              idempotency_key: `geo-handoff:${handoff.id}:voice-followup`
            }
          ));
        }
      }

      const execution = {
        source_refs: Array.isArray(handoff.payload?.source_refs) ? handoff.payload.source_refs : [],
        crm_task: crmTask,
        voice_followup: voiceFollowup,
        recommended_next_action: handoff.recommended_next_action,
        queue_route_id: handoff.queue_route_id,
        voice_route_id: handoff.voice_route_id,
      };
      const updated = geoRoutingStore.recordHandoffExecution(
        {
          tenant_id: String(input.tenant_id),
          handoff_id: String(handoff.id),
          status: voiceFollowup ? 'queued' : 'reviewed',
          execution,
          executed_by: input.executed_by || context.userId || 'system'
        },
        context
      );
      return {
        handoff: updated,
        execution,
        already_executed: false
      };
    },
  );
}

function nestedContext(context: JsonRecord, agentId: string, suffix: string): JsonRecord {
  return {
    ...context,
    tenantId: context.tenantId || context.tenant_id,
    agentId,
    stepId: [context.stepId || 'geo_handoff', suffix].join(':')
  };
}

function summarizeExecutionResult(result: JsonRecord): JsonRecord {
  if (!result || typeof result !== 'object') {
    return { status: 'unknown' };
  }
  if (result.status === 'success') {
    return {
      status: result.status,
      output: result.output,
      tool_call_id: result.tool_call?.id || null
    };
  }
  if (result.status === 'blocked_pending_approval') {
    return {
      status: result.status,
      approval_request_id: result.approval_request?.id || null,
      approval_request: result.approval_request || null
    };
  }
  return result;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
  }
  if (typeof value === 'string') {
    return Array.from(new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean)));
  }
  return [];
}

function hasOwnField(input: JsonRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function extractRoutingPolicyPatch(input: JsonRecord): JsonRecord {
  const source = input.override_patch && typeof input.override_patch === 'object'
    ? input.override_patch as JsonRecord
    : input;
  const allowedFields = [
    'maintenance_scope',
    'interval_seconds',
    'dry_run',
    'territory_status',
    'territory_include_ids',
    'territory_exclude_ids',
    'auto_bootstrap',
    'status',
    'paused_until',
    'pause_reason',
    'notes',
    'metadata'
  ];
  const patch: JsonRecord = {};
  for (const field of allowedFields) {
    if (hasOwnField(source, field)) {
      patch[field] = source[field];
    }
  }
  return patch;
}

function mergeRoutingPolicy(basePolicy: JsonRecord, patch: JsonRecord): JsonRecord {
  return {
    ...basePolicy,
    ...(hasOwnField(patch, 'maintenance_scope') ? { maintenance_scope: patch.maintenance_scope || 'tenant' } : {}),
    ...(hasOwnField(patch, 'interval_seconds') ? { interval_seconds: Number(patch.interval_seconds || 3600) } : {}),
    ...(hasOwnField(patch, 'dry_run') ? { dry_run: Boolean(patch.dry_run) } : {}),
    ...(hasOwnField(patch, 'territory_status') ? { territory_status: patch.territory_status || 'active' } : {}),
    ...(hasOwnField(patch, 'territory_include_ids') ? { territory_include_ids: normalizeStringList(patch.territory_include_ids) } : {}),
    ...(hasOwnField(patch, 'territory_exclude_ids') ? { territory_exclude_ids: normalizeStringList(patch.territory_exclude_ids) } : {}),
    ...(hasOwnField(patch, 'auto_bootstrap') ? { auto_bootstrap: patch.auto_bootstrap !== false } : {}),
    ...(hasOwnField(patch, 'status') ? { status: patch.status || 'active' } : {}),
    ...(hasOwnField(patch, 'paused_until') ? { paused_until: patch.paused_until || null } : {}),
    ...(hasOwnField(patch, 'pause_reason') ? { pause_reason: patch.pause_reason || '' } : {}),
    ...(hasOwnField(patch, 'notes') ? { notes: patch.notes || '' } : {}),
    ...(hasOwnField(patch, 'metadata') ? { metadata: patch.metadata || {} } : {})
  };
}

function buildRoutingPolicyPlanForPolicy(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
  policy: JsonRecord,
): JsonRecord {
  const scope = input.scope || policy.maintenance_scope || 'tenant';
  const evaluatedAt = String(input.evaluated_at || input.now || new Date().toISOString());
  const requestedTerritoryId = input.territory_id ? String(input.territory_id) : null;
  const includeIds = normalizeStringList(policy.territory_include_ids);
  const excludeIds = new Set(normalizeStringList(policy.territory_exclude_ids));
  const pausedUntil = policy.paused_until ? String(policy.paused_until) : null;
  const paused = Boolean(pausedUntil && Date.parse(pausedUntil) > Date.parse(evaluatedAt));
  const pauseReason = paused
    ? String(policy.pause_reason || `policy paused until ${pausedUntil}`)
    : '';

  if (scope !== 'territory') {
    return {
      policy,
      evaluated_at: evaluatedAt,
      scope: 'tenant',
      paused,
      pause_reason: pauseReason,
      guardrails: {
        territory_status: policy.territory_status,
        territory_include_ids: includeIds,
        territory_exclude_ids: Array.from(excludeIds),
        paused_until: pausedUntil,
        pause_reason: policy.pause_reason || ''
      },
      totals: {
        catalogued_territories: 0,
        eligible_targets: 1,
        skipped_targets: 0
      },
      eligible_targets: [
        {
          scope: 'tenant',
          territory_id: null,
          name: input.trigger_name || 'Geo routing maintenance',
          status: 'active'
        }
      ],
      skipped_targets: []
    };
  }

  const territories = geoRoutingStore.listTerritories({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id || 'default',
    limit: input.limit || 500
  }) as JsonRecord[];
  const scopedTerritories = requestedTerritoryId
    ? territories.filter((territory) => territory.territory_id === requestedTerritoryId)
    : territories;
  const eligibleTargets = [];
  const skippedTargets = [];

  if (requestedTerritoryId && !scopedTerritories.length) {
    skippedTargets.push({
      scope: 'territory',
      territory_id: requestedTerritoryId,
      name: requestedTerritoryId,
      status: 'missing',
      reason: 'territory_not_found'
    });
  }

  for (const territory of scopedTerritories) {
    let reason = '';
    if (policy.territory_status && territory.status !== policy.territory_status) {
      reason = `status_mismatch:${territory.status}`;
    } else if (includeIds.length && !includeIds.includes(String(territory.territory_id))) {
      reason = 'not_in_policy_include_list';
    } else if (excludeIds.has(String(territory.territory_id))) {
      reason = 'excluded_by_policy';
    }

    const target = {
      scope: 'territory',
      territory_id: String(territory.territory_id),
      name: String(territory.name || territory.territory_id),
      status: String(territory.status || 'active')
    };
    if (reason) {
      skippedTargets.push({
        ...target,
        reason
      });
    } else {
      eligibleTargets.push(target);
    }
  }

  return {
    policy,
    evaluated_at: evaluatedAt,
    scope: 'territory',
    paused,
    pause_reason: pauseReason,
    guardrails: {
      territory_status: policy.territory_status,
      territory_include_ids: includeIds,
      territory_exclude_ids: Array.from(excludeIds),
      paused_until: pausedUntil,
      pause_reason: policy.pause_reason || ''
    },
    totals: {
      catalogued_territories: territories.length,
      eligible_targets: eligibleTargets.length,
      skipped_targets: skippedTargets.length
    },
    eligible_targets: eligibleTargets,
    skipped_targets: skippedTargets
  };
}

function buildRoutingPolicyDiffSummary(
  beforePolicy: JsonRecord,
  afterPolicy: JsonRecord,
  beforePreview: JsonRecord,
  afterPreview: JsonRecord,
): JsonRecord {
  const changedFields = [];
  for (const field of [
    'maintenance_scope',
    'interval_seconds',
    'dry_run',
    'territory_status',
    'territory_include_ids',
    'territory_exclude_ids',
    'auto_bootstrap',
    'status',
    'paused_until',
    'pause_reason',
    'notes'
  ]) {
    const beforeValue = JSON.stringify(beforePolicy[field] ?? null);
    const afterValue = JSON.stringify(afterPolicy[field] ?? null);
    if (beforeValue !== afterValue) {
      changedFields.push({
        field,
        before: beforePolicy[field] ?? null,
        after: afterPolicy[field] ?? null
      });
    }
  }
  const beforeEligibleIds = new Set((beforePreview.eligible_targets || []).map((target: JsonRecord) => String(target.territory_id || 'tenant')));
  const afterEligibleIds = new Set((afterPreview.eligible_targets || []).map((target: JsonRecord) => String(target.territory_id || 'tenant')));
  const addedTargets = [...afterEligibleIds].filter((id) => !beforeEligibleIds.has(id));
  const removedTargets = [...beforeEligibleIds].filter((id) => !afterEligibleIds.has(id));
  return {
    changed_fields: changedFields,
    impact: {
      paused_before: Boolean(beforePreview.paused),
      paused_after: Boolean(afterPreview.paused),
      eligible_target_count_before: Number(beforePreview.totals?.eligible_targets || 0),
      eligible_target_count_after: Number(afterPreview.totals?.eligible_targets || 0),
      added_targets: addedTargets,
      removed_targets: removedTargets
    }
  };
}

function routingTriggerKey(value: JsonRecord | null | undefined): string {
  return String(value?.territory_id || value?.input?.territory_id || 'tenant');
}

function buildRoutingLifecycleStatus(policy: JsonRecord, preview: JsonRecord): JsonRecord {
  if (policy.status !== 'active') {
    return { status: 'inactive', reason: `policy is ${policy.status}` };
  }
  if (!policy.auto_bootstrap) {
    return { status: 'manual', reason: 'policy auto_bootstrap is disabled' };
  }
  if (preview.paused) {
    return { status: 'paused', reason: preview.pause_reason || 'policy is paused' };
  }
  return { status: 'active', reason: '' };
}

function buildRoutingTriggerDrift(
  policy: JsonRecord,
  preview: JsonRecord,
  triggers: JsonRecord[],
): JsonRecord {
  const lifecycle = buildRoutingLifecycleStatus(policy, preview);
  const desiredActiveKeys = lifecycle.status === 'active'
    ? new Set((preview.eligible_targets || []).map((target: JsonRecord) => routingTriggerKey(target)))
    : new Set<string>();
  const byKey = new Map<string, JsonRecord[]>();
  for (const trigger of triggers) {
    const key = routingTriggerKey(trigger);
    const existing = byKey.get(key) || [];
    existing.push(trigger);
    byKey.set(key, existing);
  }

  const missingActiveTargets = [];
  const pausedExpectedTargets = [];
  const staleConfiguration = [];
  for (const target of preview.eligible_targets || []) {
    const key = routingTriggerKey(target);
    const matches = byKey.get(key) || [];
    const activeMatch = matches.find((trigger) => trigger.status === 'active');
    if (lifecycle.status !== 'active') {
      continue;
    }
    if (!matches.length) {
      missingActiveTargets.push({
        territory_id: target.territory_id || null,
        reason: 'missing_trigger'
      });
      continue;
    }
    if (!activeMatch) {
      pausedExpectedTargets.push({
        territory_id: target.territory_id || null,
        statuses: matches.map((trigger) => trigger.status)
      });
      continue;
    }
    if (
      Number(activeMatch.interval_seconds || 0) !== Number(policy.interval_seconds || 0)
      || Boolean(activeMatch.input?.dry_run) !== Boolean(policy.dry_run)
    ) {
      staleConfiguration.push({
        territory_id: target.territory_id || null,
        trigger_id: activeMatch.id,
        interval_seconds: {
          expected: Number(policy.interval_seconds || 0),
          actual: Number(activeMatch.interval_seconds || 0)
        },
        dry_run: {
          expected: Boolean(policy.dry_run),
          actual: Boolean(activeMatch.input?.dry_run)
        }
      });
    }
  }

  const unexpectedActiveTargets = triggers
    .filter((trigger) => trigger.status === 'active' && !desiredActiveKeys.has(routingTriggerKey(trigger)))
    .map((trigger) => ({
      trigger_id: trigger.id,
      territory_id: trigger.input?.territory_id || null,
      status: trigger.status
    }));
  const duplicateTargets = [...byKey.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([key, matches]) => ({
      territory_id: key === 'tenant' ? null : key,
      trigger_ids: matches.map((trigger) => trigger.id),
      statuses: matches.map((trigger) => trigger.status)
    }));

  return {
    lifecycle,
    totals: {
      triggers: triggers.length,
      active_triggers: triggers.filter((trigger) => trigger.status === 'active').length,
      paused_triggers: triggers.filter((trigger) => trigger.status === 'paused').length,
      desired_active_targets: desiredActiveKeys.size
    },
    healthy: (
      missingActiveTargets.length === 0
      && pausedExpectedTargets.length === 0
      && staleConfiguration.length === 0
      && unexpectedActiveTargets.length === 0
      && duplicateTargets.length === 0
    ),
    missing_active_targets: missingActiveTargets,
    paused_expected_targets: pausedExpectedTargets,
    unexpected_active_targets: unexpectedActiveTargets,
    stale_configuration: staleConfiguration,
    duplicate_targets: duplicateTargets
  };
}

function buildRoutingPolicyTimeline(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const policy = geoRoutingStore.getRoutingPolicy(input.tenant_id, workspaceId, policyId);
  const approvalRequests = geoRoutingStore.listRoutingPolicyApprovalRequests({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    status: input.approval_status || null,
    limit: input.approval_limit || input.limit || 50
  });
  const overrides = geoRoutingStore.listRoutingPolicyOverrides({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    status: input.override_status || null,
    limit: input.override_limit || input.limit || 50
  });
  const triggerDrift = buildRoutingTriggerDrift(
    policy,
    buildRoutingPolicyPlan(geoRoutingStore, { ...input, workspace_id: workspaceId, policy_id: policyId }),
    listRoutingTriggers(triggerRunner, {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId,
      limit: input.trigger_limit || 500
    })
  );
  const batchPlanTargeting = buildRoutingPolicyBatchPlanTargetGovernance(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    plan_limit: input.plan_limit || input.limit || 200,
    target_event_limit: input.target_event_limit || input.limit || 50
  });
  const events = [];
  if (policy.last_rollout_at) {
    events.push({
      event_type: 'policy_rollout_snapshot',
      occurred_at: policy.last_rollout_at,
      policy_id: policy.policy_id,
      status: policy.last_rollout_snapshot?.status || 'unknown',
      payload: policy.last_rollout_snapshot || {}
    });
  }
  for (const approval of approvalRequests) {
    events.push({
      event_type: 'approval_request',
      occurred_at: approval.created_at,
      policy_id: approval.policy_id,
      status: approval.status,
      approval_request_id: approval.id,
      action_type: approval.action_type,
      payload: {
        reason: approval.reason,
        requested_by: approval.requested_by,
        decided_by: approval.decided_by || null,
        decided_at: approval.decided_at || null,
        tool_call_id: approval.tool_call_id || null,
        source_override_id: approval.source_override?.id || null
      }
    });
  }
  for (const override of overrides) {
    events.push({
      event_type: override.override_kind,
      occurred_at: override.created_at,
      policy_id: override.policy_id,
      status: override.status,
      override_id: override.id,
      payload: {
        reason: override.reason,
        diff_summary: override.diff_summary,
        source_override_id: override.source_override_id || null
      }
    });
  }
  for (const event of Array.isArray(batchPlanTargeting.recent_events) ? batchPlanTargeting.recent_events : []) {
    events.push(event);
  }
  events.sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')));
  return {
    policy,
    trigger_drift: triggerDrift,
    batch_plan_targeting: {
      summary: batchPlanTargeting.summary,
      current_target: batchPlanTargeting.current_target
    },
    total_events: events.length,
    events: events.slice(0, Number(input.limit || 50))
  };
}

function buildRoutingPolicyOpsOverview(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const policy = geoRoutingStore.getRoutingPolicy(input.tenant_id, workspaceId, policyId);
  const preview = buildRoutingPolicyPlan(geoRoutingStore, { ...input, workspace_id: workspaceId, policy_id: policyId });
  const triggers = listRoutingTriggers(triggerRunner, {
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.trigger_limit || 500
  });
  const pendingApprovals = geoRoutingStore.listRoutingPolicyApprovalRequests({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    status: 'pending',
    limit: input.approval_limit || 20
  });
  const overrides = geoRoutingStore.listRoutingPolicyOverrides({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.override_limit || 20
  });
  const triggerDrift = buildRoutingTriggerDrift(policy, preview, triggers);
  const targetGovernance = buildRoutingPolicyBatchPlanTargetGovernance(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    plan_limit: input.plan_limit || 200,
    target_event_limit: input.target_event_limit || 10
  });
  const timeline = buildRoutingPolicyTimeline(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.timeline_limit || 20,
    trigger_limit: input.trigger_limit || 500
  });
  const rolloutHistory = [];
  if (policy.last_rollout_at) {
    rolloutHistory.push({
      event_type: 'policy_rollout_snapshot',
      occurred_at: policy.last_rollout_at,
      status: policy.last_rollout_snapshot?.status || 'unknown',
      snapshot: policy.last_rollout_snapshot || {}
    });
  }
  for (const override of overrides) {
    if (!override.rollout_result || typeof override.rollout_result !== 'object' || !Object.keys(override.rollout_result).length) {
      continue;
    }
    rolloutHistory.push({
      event_type: override.override_kind,
      occurred_at: override.created_at,
      status: override.status,
      override_id: override.id,
      rollout_result: override.rollout_result
    });
  }
  rolloutHistory.sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')));
  return {
    policy,
    preview,
    current_execution_target: targetGovernance.current_target,
    target_governance: targetGovernance,
    pending_approvals: pendingApprovals,
    overrides_recent: overrides,
    trigger_drift: triggerDrift,
    rollout_history: rolloutHistory.slice(0, Number(input.rollout_limit || 20)),
    timeline: timeline.events,
    summary: {
      pending_approval_count: pendingApprovals.length,
      override_count: overrides.length,
      trigger_count: triggers.length,
      drift_healthy: triggerDrift.healthy,
      batch_plan_count: targetGovernance.summary.total_plans,
      active_batch_plan_count: targetGovernance.summary.active_plans,
      target_event_count: targetGovernance.summary.target_event_count,
      current_target_plan_id: targetGovernance.summary.current_target_plan_id,
      current_target_resolution_reason: targetGovernance.summary.current_resolution_reason
    }
  };
}

function routingPolicyReviewKey(...parts: unknown[]): string {
  return parts.map((part) => String(part ?? '').trim() || 'none').join(':');
}

function reviewStatusRank(status: unknown): number {
  if (status === 'open') return 0;
  if (status === 'acknowledged') return 1;
  return 2;
}

function reviewSeverityRank(severity: unknown): number {
  if (severity === 'critical') return 0;
  if (severity === 'high') return 1;
  if (severity === 'medium') return 2;
  return 3;
}

function pushRoutingPolicyReviewItem(
  items: JsonRecord[],
  reviewStateByKey: Map<string, JsonRecord>,
  input: JsonRecord,
  item: JsonRecord,
): void {
  const reviewState = reviewStateByKey.get(String(item.review_key));
  const merged: JsonRecord = {
    ...item,
    review_status: reviewState?.item_status || 'open',
    review_note: reviewState?.note || '',
    review_state: reviewState || null
  };
  if (input.review_status && merged.review_status !== input.review_status) {
    return;
  }
  if (input.item_type && merged.item_type !== input.item_type) {
    return;
  }
  items.push(merged);
}

const APPROVE_AND_RESUME_ACTION_ID = 'approve_and_resume_pending_approval';
const ROLLOUT_POLICY_ACTION_ID = 'rollout_policy_from_review';
const LAUNCH_ROLLBACK_ACTION_ID = 'launch_rollback_from_review';

function buildRoutingPolicyWorkbenchAction(
  actionId: string,
  actionType: string,
  label: string,
  input: JsonRecord,
  reviewKey: string,
  payloadTemplate: JsonRecord = {},
): JsonRecord {
  return {
    action_id: actionId,
    action_type: actionType,
    label,
    executable: true,
    workbench_action: true,
    method: 'POST',
    endpoint: '/api/geo/routing/policies/review/actions/execute',
    payload_template: {
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      policy_id: input.policy_id || 'default',
      review_key: reviewKey,
      action_id: actionId,
      ...payloadTemplate
    }
  };
}

function listRoutingPolicyWorkbenchActions(item: JsonRecord): JsonRecord[] {
  return Array.isArray(item.actions)
    ? item.actions.filter((action: JsonRecord) => action?.workbench_action)
    : [];
}

function buildRoutingPolicyActionHistory(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const targetContext = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    target_event_limit: input.target_event_limit || 50
  });
  const entries = geoRoutingStore.listRoutingPolicyActionHistory({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    review_key: input.review_key || null,
    action_id: input.action_id || null,
    status: input.status || null,
    limit: input.limit || 100
  });
  const decoratedEntriesAll = decorateRoutingPolicyActionHistoryEntries(entries, targetContext, Number(input.target_audit_event_limit || 5));
  const targetChangedOnly = routingPolicyInputFlag(input.target_changed_since_execution);
  const targetDriftOnly = routingPolicyInputFlag(input.target_drift_only || input.target_plan_drift_only);
  const decoratedEntries = decoratedEntriesAll.filter((entry) => {
    const diff = entry.historical_current_target_diff && typeof entry.historical_current_target_diff === 'object'
      ? entry.historical_current_target_diff as JsonRecord
      : {};
    if (targetDriftOnly && diff.target_plan_changed !== true) {
      return false;
    }
    if (targetChangedOnly && diff.changed !== true) {
      return false;
    }
    return true;
  });
  const historyAuditSummary = buildRoutingPolicyActionHistoryTargetAuditSummary(decoratedEntriesAll);
  return {
    policy: {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId
    },
    current_execution_target: targetContext.current_execution_target,
    target_governance_summary: targetContext.summary,
    recent_target_events: targetContext.recent_target_events,
    report_summary: targetContext.report_summary,
    summary: {
      total_entries: entries.length,
      returned_entries: decoratedEntries.length,
      filtered_out_entries: decoratedEntriesAll.length - decoratedEntries.length,
      target_changed_since_execution_filter: targetChangedOnly,
      target_drift_only_filter: targetDriftOnly,
      succeeded_entries: entries.filter((entry) => entry.status === 'succeeded').length,
      blocked_entries: entries.filter((entry) => entry.status === 'blocked_pending_approval').length,
      failed_entries: entries.filter((entry) => entry.status === 'failed').length,
      latest_at: entries[0]?.created_at || null,
      current_target_plan_id: targetContext.report_summary.current_execution_target?.target_plan_id || null,
      latest_target_event_type: targetContext.report_summary.latest_target_event?.event_type || null,
      entries_with_execution_target_snapshot: historyAuditSummary.entries_with_execution_target_snapshot,
      entries_with_target_change_since_execution: historyAuditSummary.entries_with_target_change_since_execution,
      entries_with_target_plan_drift: historyAuditSummary.entries_with_target_plan_drift,
      entries_with_target_governance_events_after_execution: historyAuditSummary.entries_with_target_governance_events_after_execution
    },
    target_audit_summary: historyAuditSummary,
    entries: decoratedEntries
  };
}

function buildRoutingPolicyTargetAuditPacket(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const generatedAt = input.generated_at || new Date().toISOString();
  const history = buildRoutingPolicyActionHistory(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    target_event_limit: input.target_event_limit || 100,
    target_audit_event_limit: input.target_audit_event_limit || 10,
    limit: input.history_limit || input.limit || 200
  });
  const reviewQueue = buildRoutingPolicyReviewQueue(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.review_limit || 100,
    attention_limit: input.review_limit || 100,
    target_event_limit: input.target_event_limit || 100
  });
  const driftEntries = (Array.isArray(history.entries) ? history.entries : [])
    .filter((entry: JsonRecord) => entry.historical_current_target_diff?.target_plan_changed === true);
  const queueItems = Array.isArray(reviewQueue.items) ? reviewQueue.items : [];
  const severityRollup = buildRoutingPolicyTargetAuditSeverityRollup(queueItems, driftEntries);
  const remediationSuggestions = buildRoutingPolicyTargetAuditRemediationSuggestions(queueItems, driftEntries);
  return {
    export_metadata: {
      packet_type: 'geo_routing_policy_target_audit',
      generated_at: generatedAt,
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId,
      generated_by: input.actor_id || input.user_id || 'system',
      format_version: 1
    },
    policy: history.policy,
    current_execution_target: history.current_execution_target,
    report_summary: history.report_summary,
    target_audit_summary: history.target_audit_summary,
    sla_rollup: severityRollup,
    remediation_suggestions: remediationSuggestions,
    decision_records: {
      review_queue_summary: reviewQueue.summary,
      action_history_summary: history.summary
    },
    audit_trail: {
      recent_target_events: history.recent_target_events,
      drifted_action_history: driftEntries,
      action_history: history.entries
    }
  };
}

function buildRoutingPolicyTargetAuditSeverityRollup(queueItems: JsonRecord[], driftEntries: JsonRecord[]): JsonRecord {
  const severityRank: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of queueItems) {
    const severity = String(item.severity || 'low');
    severityRank[severity] = Number(severityRank[severity] || 0) + 1;
  }
  const driftedBlockedEntries = driftEntries.filter((entry) => entry.status === 'blocked_pending_approval');
  return {
    review_item_severity_counts: severityRank,
    open_critical_items: queueItems.filter((item) => item.review_status === 'open' && item.severity === 'critical').length,
    open_high_items: queueItems.filter((item) => item.review_status === 'open' && item.severity === 'high').length,
    drifted_execution_count: driftEntries.length,
    drifted_blocked_execution_count: driftedBlockedEntries.length,
    breach_count: queueItems.filter((item) => item.review_status === 'open' && ['critical', 'high'].includes(String(item.severity || ''))).length + driftEntries.length,
    health_status: queueItems.some((item) => item.severity === 'critical') || driftEntries.length > 0 ? 'attention_required' : 'healthy'
  };
}

function buildRoutingPolicyTargetAuditRemediationSuggestions(queueItems: JsonRecord[], driftEntries: JsonRecord[]): JsonRecord[] {
  const suggestions: JsonRecord[] = [];
  for (const entry of driftEntries.slice(0, 10)) {
    suggestions.push({
      remediation_id: `target_drift:${entry.id}`,
      priority: entry.status === 'blocked_pending_approval' ? 'P0' : 'P1',
      source: 'action_history',
      review_key: entry.review_key || null,
      action_id: entry.action_id || null,
      reason: 'execution_target_drifted_from_current_target',
      suggested_next_tools: [
        'geo.routing_policy_action_history',
        'geo.routing_policy_batch_plan_preview',
        'geo.routing_policy_review_batch_execute'
      ],
      governance_path: 'review_action_or_batch_plan_only',
      target_context: entry.historical_current_target_diff || {}
    });
  }
  for (const item of queueItems.filter((candidate) => candidate.review_status === 'open' && ['critical', 'high'].includes(String(candidate.severity || ''))).slice(0, 10)) {
    suggestions.push({
      remediation_id: `review_item:${item.review_key}`,
      priority: item.severity === 'critical' ? 'P0' : 'P1',
      source: 'review_queue',
      review_key: item.review_key,
      reason: item.item_type || 'review_attention_required',
      suggested_actions: Array.isArray(item.suggested_actions)
        ? item.suggested_actions.filter((action: JsonRecord) => action?.workbench_action).map((action: JsonRecord) => ({
            action_id: action.action_id,
            label: action.label,
            endpoint: action.endpoint || null
          }))
        : [],
      governance_path: 'existing_review_workbench_action'
    });
  }
  return suggestions;
}

function summarizeRoutingPolicyActionHistoryEntry(entry: JsonRecord | null | undefined): JsonRecord | null {
  if (!entry) return null;
  const executionTargetContext = entry.execution_target_context && typeof entry.execution_target_context === 'object'
    ? entry.execution_target_context as JsonRecord
    : buildRoutingPolicyActionHistoryExecutionTargetContext(entry);
  const historicalCurrentTargetDiff = entry.historical_current_target_diff && typeof entry.historical_current_target_diff === 'object'
    ? entry.historical_current_target_diff as JsonRecord
    : null;
  const targetSnapshot = executionTargetContext.target_snapshot_after && typeof executionTargetContext.target_snapshot_after === 'object'
    ? executionTargetContext.target_snapshot_after as JsonRecord
    : (executionTargetContext.target_snapshot_before && typeof executionTargetContext.target_snapshot_before === 'object'
      ? executionTargetContext.target_snapshot_before as JsonRecord
      : null);
  const executionTarget = targetSnapshot?.current_execution_target && typeof targetSnapshot.current_execution_target === 'object'
    ? targetSnapshot.current_execution_target as JsonRecord
    : {};
  return {
    id: entry.id,
    action_id: entry.action_id,
    action_type: entry.action_type,
    status: entry.status,
    executed_by: entry.executed_by,
    created_at: entry.created_at,
    note: entry.note || '',
    target_plan_id_at_execution: executionTarget.target_plan_id || null,
    target_resolution_reason_at_execution: executionTarget.resolution_reason || null,
    target_changed_since_execution: historicalCurrentTargetDiff?.changed === true,
    target_plan_changed_since_execution: historicalCurrentTargetDiff?.target_plan_changed === true,
    current_target_plan_id: historicalCurrentTargetDiff?.current_target_plan_id || null
  };
}

function routingPolicyInputFlag(value: unknown): boolean {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true' || String(value || '') === '1';
}

function applyRepeatGuardToWorkbenchAction(action: JsonRecord, latestAction: JsonRecord | null, input: JsonRecord): JsonRecord {
  if (!latestAction) {
    return {
      ...action,
      executable: true,
      latest_execution: null
    };
  }
  const allowRepeat = input.force_repeat === true;
  if (!allowRepeat && latestAction.status === 'blocked_pending_approval') {
    return {
      ...action,
      executable: false,
      repeat_guarded: true,
      repeat_guard_reason: 'latest_action_pending_followup',
      latest_execution: summarizeRoutingPolicyActionHistoryEntry(latestAction)
    };
  }
  if (!allowRepeat && latestAction.status === 'succeeded') {
    return {
      ...action,
      executable: false,
      repeat_guarded: true,
      repeat_guard_reason: 'latest_action_already_succeeded',
      latest_execution: summarizeRoutingPolicyActionHistoryEntry(latestAction)
    };
  }
  return {
    ...action,
    executable: true,
    latest_execution: summarizeRoutingPolicyActionHistoryEntry(latestAction)
  };
}

function deriveRoutingPolicyActionStatus(actionId: string, actionResult: JsonRecord | null): string {
  if (actionId === APPROVE_AND_RESUME_ACTION_ID) {
    return actionResult?.resumed?.status === 'success' ? 'succeeded' : 'failed';
  }
  if (actionId === ROLLOUT_POLICY_ACTION_ID) {
    return actionResult?.rollout?.status === 'success' ? 'succeeded' : 'failed';
  }
  if (actionId === LAUNCH_ROLLBACK_ACTION_ID) {
    if (actionResult?.rollback?.status === 'blocked_pending_approval') return 'blocked_pending_approval';
    return actionResult?.rollback?.status === 'success' ? 'succeeded' : 'failed';
  }
  return 'failed';
}

function routingPolicyActionRiskLevel(actionId: string): string {
  if (actionId === ROLLOUT_POLICY_ACTION_ID) {
    return 'R1';
  }
  if (actionId === APPROVE_AND_RESUME_ACTION_ID || actionId === LAUNCH_ROLLBACK_ACTION_ID) {
    return 'R3';
  }
  return 'R2';
}

function describeRoutingPolicyActionOutcome(actionId: string): string {
  if (actionId === APPROVE_AND_RESUME_ACTION_ID) {
    return 'Approve the pending request and resume the blocked governed tool call.';
  }
  if (actionId === ROLLOUT_POLICY_ACTION_ID) {
    return 'Reconcile scheduled routing triggers against the latest stored policy defaults.';
  }
  if (actionId === LAUNCH_ROLLBACK_ACTION_ID) {
    return 'Launch a governed rollback request for the selected override using the approval queue.';
  }
  return 'Execute a governed geo routing policy action.';
}

function routingPolicyBatchSelectionKey(reviewKey: string, actionId: string): string {
  return `${reviewKey}::${actionId}`;
}

function toRoutingPolicyBatchSavedItem(item: JsonRecord): JsonRecord {
  return {
    review_key: item.review_key,
    action_id: item.action_id,
    note: item.note || '',
    reason: item.reason || '',
    force_repeat: item.force_repeat === true
  };
}

function routingPolicyBatchPlanMetadata(plan: JsonRecord | null | undefined): JsonRecord {
  return plan?.metadata && typeof plan.metadata === 'object' ? plan.metadata as JsonRecord : {};
}

function routingPolicyBatchPlanParentId(plan: JsonRecord | null | undefined): string | null {
  const parentId = String(routingPolicyBatchPlanMetadata(plan).refreshed_from_plan_id || '');
  return parentId && parentId !== String(plan?.id || '') ? parentId : null;
}

function routingPolicyBatchPlanSuccessorId(plan: JsonRecord | null | undefined): string | null {
  const successorId = String(routingPolicyBatchPlanMetadata(plan).superseded_by_plan_id || '');
  return successorId && successorId !== String(plan?.id || '') ? successorId : null;
}

function isRoutingPolicyBatchPlanPreferred(plan: JsonRecord | null | undefined): boolean {
  if (!plan || plan.status !== 'active') {
    return false;
  }
  return routingPolicyBatchPlanMetadata(plan).preferred === true;
}

function preferredRoutingPolicyBatchPlan(plans: JsonRecord[]): JsonRecord | null {
  return plans
    .filter((plan) => isRoutingPolicyBatchPlanPreferred(plan))
    .slice()
    .sort((left, right) => routingPolicyBatchPlanTimestamp(right).localeCompare(routingPolicyBatchPlanTimestamp(left)))[0] || null;
}

function summarizeRoutingPolicyBatchPlan(plan: JsonRecord | null | undefined, extra: JsonRecord = {}): JsonRecord | null {
  if (!plan) {
    return null;
  }
  const metadata = routingPolicyBatchPlanMetadata(plan);
  return {
    id: plan.id,
    workspace_id: plan.workspace_id,
    policy_id: plan.policy_id,
    plan_name: plan.plan_name,
    status: plan.status,
    notes: plan.notes || '',
    created_at: plan.created_at || null,
    updated_at: plan.updated_at || null,
    item_count: Array.isArray(plan.items) ? plan.items.length : 0,
    is_preferred: isRoutingPolicyBatchPlanPreferred(plan),
    selection_summary: plan.selection_summary || {},
    refreshed_from_plan_id: metadata.refreshed_from_plan_id || null,
    superseded_by_plan_id: metadata.superseded_by_plan_id || null,
    refresh_mode: metadata.refresh_mode || null,
    refreshed_at: metadata.refreshed_at || null,
    superseded_at: metadata.superseded_at || null,
    refreshed_by: metadata.refreshed_by || null,
    superseded_by: metadata.superseded_by || null,
    preferred_at: metadata.preferred_at || null,
    preferred_by: metadata.preferred_by || null,
    preference_reason: metadata.preference_reason || null,
    previous_preferred_plan_id: metadata.previous_preferred_plan_id || null,
    preference_source_plan_id: metadata.preference_source_plan_id || null,
    demoted_at: metadata.demoted_at || null,
    demoted_by: metadata.demoted_by || null,
    demoted_reason: metadata.demoted_reason || null,
    demoted_to_plan_id: metadata.demoted_to_plan_id || null,
    restored_at: metadata.restored_at || null,
    restored_by: metadata.restored_by || null,
    archived_at: metadata.archived_at || null,
    archived_by: metadata.archived_by || null,
    archived_reason: metadata.archived_reason || null,
    preferred_before_archive: metadata.preferred_before_archive === true,
    target_fallback_plan_id: metadata.target_fallback_plan_id || null,
    ...extra
  };
}

function describeRoutingPolicyBatchPlanTargetReason(reason: unknown): string | null {
  const value = String(reason || '');
  if (!value) return null;
  const labels: Record<string, string> = {
    initial_active_plan: 'Initial active plan became the default execution target.',
    plan_upsert_preferred: 'Plan save/upsert assigned or retained preferred target status.',
    refresh_replace: 'Refresh-in-place retained preferred target status on the updated plan.',
    refresh_supersede: 'Refresh created a successor plan and moved preferred target status to it.',
    auto_fallback_latest_active: 'Preferred target automatically fell back to the latest active plan.',
    archive_auto_fallback: 'Archiving the preferred plan automatically moved the target to another active plan.',
    restore_make_preferred: 'Restore explicitly promoted the restored plan back to preferred target status.',
    manual_promote: 'Operator explicitly promoted this plan to preferred target status.',
    manual_preference_assignment: 'Preferred target status was assigned directly.'
  };
  return labels[value] || value.replaceAll('_', ' ');
}

function buildRoutingPolicyBatchPlanLastTargetChange(plan: JsonRecord | null | undefined): JsonRecord | null {
  if (!plan) {
    return null;
  }
  const metadata = routingPolicyBatchPlanMetadata(plan);
  const changes: JsonRecord[] = [];
  const pushChange = (
    eventType: string,
    occurredAt: unknown,
    actorId: unknown,
    reason: unknown = null,
    extra: JsonRecord = {}
  ): void => {
    const timestamp = String(occurredAt || '');
    if (!timestamp) {
      return;
    }
    changes.push({
      event_type: eventType,
      occurred_at: timestamp,
      actor_id: actorId || null,
      reason: reason || null,
      reason_label: describeRoutingPolicyBatchPlanTargetReason(reason),
      ...extra
    });
  };
  pushChange('preferred', metadata.preferred_at, metadata.preferred_by, metadata.preference_reason, {
    previous_preferred_plan_id: metadata.previous_preferred_plan_id || null,
    preference_source_plan_id: metadata.preference_source_plan_id || null
  });
  pushChange('demoted', metadata.demoted_at, metadata.demoted_by, metadata.demoted_reason, {
    demoted_to_plan_id: metadata.demoted_to_plan_id || null
  });
  pushChange('restored', metadata.restored_at, metadata.restored_by, metadata.preference_reason || 'restored');
  pushChange('archived', metadata.archived_at, metadata.archived_by, metadata.archived_reason, {
    preferred_before_archive: metadata.preferred_before_archive === true,
    target_fallback_plan_id: metadata.target_fallback_plan_id || null
  });
  pushChange('superseded', metadata.superseded_at, metadata.superseded_by, metadata.archived_reason || 'superseded_by_refreshed_plan', {
    superseded_by_plan_id: metadata.superseded_by_plan_id || null,
    target_fallback_plan_id: metadata.target_fallback_plan_id || null
  });
  pushChange('refreshed', metadata.refreshed_at, metadata.refreshed_by, metadata.refresh_mode || 'refresh', {
    refreshed_from_plan_id: metadata.refreshed_from_plan_id || null
  });
  changes.sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')));
  return changes[0] || null;
}

function buildRoutingPolicyBatchPlanTargetState(
  plan: JsonRecord | null | undefined,
  context: {
    preferred_active_plan?: JsonRecord | null;
    latest_active_plan?: JsonRecord | null;
    recommended_plan?: JsonRecord | null;
    current_target_plan?: JsonRecord | null;
    current_target?: string | null;
    current_resolution_reason?: string | null;
    summarized_by_id?: Map<string, JsonRecord | null>;
  }
): JsonRecord | null {
  if (!plan) {
    return null;
  }
  const metadata = routingPolicyBatchPlanMetadata(plan);
  const planId = String(plan.id);
  const currentRoles: string[] = [];
  if (plan.status === 'active') {
    currentRoles.push('active');
  } else if (plan.status === 'archived') {
    currentRoles.push('archived');
  } else {
    currentRoles.push(String(plan.status || 'unknown'));
  }
  if (context.preferred_active_plan && String(context.preferred_active_plan.id) === planId) {
    currentRoles.push('preferred_active');
  }
  if (context.latest_active_plan && String(context.latest_active_plan.id) === planId) {
    currentRoles.push('latest_active');
  }
  if (context.recommended_plan && String(context.recommended_plan.id) === planId) {
    currentRoles.push('recommended');
  }
  if (context.current_target_plan && String(context.current_target_plan.id) === planId) {
    currentRoles.push('current_target');
  }
  const summarizedById = context.summarized_by_id || new Map<string, JsonRecord | null>();
  const summarizeLinkedPlan = (linkedPlanId: unknown): JsonRecord | null => {
    const id = String(linkedPlanId || '');
    return id ? (summarizedById.get(id) || null) : null;
  };
  return {
    current_roles: currentRoles,
    current_target: context.current_target || null,
    current_resolution_reason: context.current_target_plan && String(context.current_target_plan.id) === planId
      ? (context.current_resolution_reason || null)
      : null,
    current_resolution_reason_label: context.current_target_plan && String(context.current_target_plan.id) === planId
      ? describeRoutingPolicyBatchPlanTargetReason(context.current_resolution_reason)
      : null,
    last_target_change: buildRoutingPolicyBatchPlanLastTargetChange(plan),
    preference: metadata.preferred_at ? {
      preferred_at: metadata.preferred_at,
      preferred_by: metadata.preferred_by || null,
      preference_reason: metadata.preference_reason || null,
      preference_reason_label: describeRoutingPolicyBatchPlanTargetReason(metadata.preference_reason),
      previous_preferred_plan: summarizeLinkedPlan(metadata.previous_preferred_plan_id),
      preference_source_plan: summarizeLinkedPlan(metadata.preference_source_plan_id)
    } : null,
    demotion: metadata.demoted_at ? {
      demoted_at: metadata.demoted_at,
      demoted_by: metadata.demoted_by || null,
      demoted_reason: metadata.demoted_reason || null,
      demoted_reason_label: describeRoutingPolicyBatchPlanTargetReason(metadata.demoted_reason),
      demoted_to_plan: summarizeLinkedPlan(metadata.demoted_to_plan_id)
    } : null,
    refresh: (metadata.refreshed_at || metadata.superseded_at) ? {
      refresh_mode: metadata.refresh_mode || null,
      refreshed_at: metadata.refreshed_at || null,
      refreshed_by: metadata.refreshed_by || null,
      refreshed_from_plan: summarizeLinkedPlan(metadata.refreshed_from_plan_id),
      superseded_at: metadata.superseded_at || null,
      superseded_by: metadata.superseded_by || null,
      superseded_by_plan: summarizeLinkedPlan(metadata.superseded_by_plan_id)
    } : null,
    archive: metadata.archived_at ? {
      archived_at: metadata.archived_at,
      archived_by: metadata.archived_by || null,
      archived_reason: metadata.archived_reason || null,
      archived_reason_label: describeRoutingPolicyBatchPlanTargetReason(metadata.archived_reason),
      preferred_before_archive: metadata.preferred_before_archive === true,
      target_fallback_plan: summarizeLinkedPlan(metadata.target_fallback_plan_id)
    } : null,
    restore: metadata.restored_at ? {
      restored_at: metadata.restored_at,
      restored_by: metadata.restored_by || null
    } : null
  };
}

function buildRoutingPolicyBatchPlanCompactReport(
  plan: JsonRecord | null | undefined,
  targetState: JsonRecord | null | undefined,
): JsonRecord | null {
  if (!plan) {
    return null;
  }
  const lastTargetChange = targetState?.last_target_change as JsonRecord | null | undefined;
  const archive = targetState?.archive as JsonRecord | null | undefined;
  return {
    plan_id: plan.id,
    plan_name: plan.plan_name || '',
    status: plan.status,
    current_roles: Array.isArray(targetState?.current_roles) ? targetState.current_roles : [],
    current_target: targetState?.current_target || null,
    current_resolution_reason: targetState?.current_resolution_reason || null,
    current_resolution_reason_label: targetState?.current_resolution_reason_label || null,
    last_target_change_type: lastTargetChange?.event_type || null,
    last_target_change_at: lastTargetChange?.occurred_at || null,
    last_target_change_reason: lastTargetChange?.reason || null,
    last_target_change_reason_label: lastTargetChange?.reason_label || null,
    target_fallback_plan_id: archive?.target_fallback_plan?.id || null,
    target_fallback_plan_name: archive?.target_fallback_plan?.plan_name || null
  };
}

function buildRoutingPolicyCurrentExecutionTargetReport(currentTarget: JsonRecord | null | undefined): JsonRecord | null {
  if (!currentTarget) {
    return null;
  }
  const summary = currentTarget.summary && typeof currentTarget.summary === 'object'
    ? currentTarget.summary as JsonRecord
    : {};
  return {
    target: summary.target || null,
    resolution_reason: summary.resolution_reason || null,
    resolution_reason_label: describeRoutingPolicyBatchPlanTargetReason(summary.resolution_reason),
    target_plan_id: summary.target_plan_id || null,
    target_plan_name: currentTarget.target_plan?.plan_name || null,
    preferred_active_plan_id: summary.preferred_active_plan_id || null,
    latest_active_plan_id: summary.latest_active_plan_id || null,
    recommended_plan_id: summary.recommended_plan_id || null
  };
}

function buildRoutingPolicyRecentTargetEventReport(event: JsonRecord | null | undefined): JsonRecord | null {
  if (!event) {
    return null;
  }
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as JsonRecord
    : {};
  const reason = payload.preference_reason
    || payload.archived_reason
    || payload.refresh_mode
    || (event.event_type === 'batch_plan_restored' && payload.make_preferred === true ? 'restore_make_preferred' : null);
  const fallbackPlan = payload.target_fallback_plan && typeof payload.target_fallback_plan === 'object'
    ? payload.target_fallback_plan as JsonRecord
    : null;
  return {
    event_type: event.event_type || null,
    occurred_at: event.occurred_at || null,
    plan_id: event.plan_id || null,
    plan_name: event.plan?.plan_name || null,
    reason: reason || null,
    reason_label: describeRoutingPolicyBatchPlanTargetReason(reason),
    target_fallback_plan_id: payload.target_fallback_plan_id || fallbackPlan?.id || null,
    target_fallback_plan_name: fallbackPlan?.plan_name || null
  };
}

function buildRoutingPolicyOperatorTargetContext(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const targetGovernance = buildRoutingPolicyBatchPlanTargetGovernance(geoRoutingStore, {
    ...input,
    target_event_limit: input.target_event_limit || 5
  });
  const currentExecutionTarget = targetGovernance.current_target || null;
  const recentTargetEvents = Array.isArray(targetGovernance.recent_events)
    ? targetGovernance.recent_events
    : [];
  return {
    current_execution_target: currentExecutionTarget,
    summary: targetGovernance.summary || {},
    recent_target_events: recentTargetEvents,
    report_summary: {
      current_execution_target: buildRoutingPolicyCurrentExecutionTargetReport(currentExecutionTarget),
      latest_target_event: buildRoutingPolicyRecentTargetEventReport(recentTargetEvents[0] || null),
      target_event_count: targetGovernance.summary?.target_event_count || 0
    }
  };
}

function buildRoutingPolicyOperatorTargetSnapshot(targetContext: JsonRecord | null | undefined): JsonRecord {
  const reportSummary = targetContext?.report_summary && typeof targetContext.report_summary === 'object'
    ? targetContext.report_summary as JsonRecord
    : {};
  return {
    current_execution_target: reportSummary.current_execution_target || null,
    latest_target_event: reportSummary.latest_target_event || null,
    target_event_count: Number(reportSummary.target_event_count || 0)
  };
}

function buildRoutingPolicyOperatorTargetTransition(
  beforeContext: JsonRecord | null | undefined,
  afterContext: JsonRecord | null | undefined,
): JsonRecord {
  const beforeSnapshot = buildRoutingPolicyOperatorTargetSnapshot(beforeContext);
  const afterSnapshot = buildRoutingPolicyOperatorTargetSnapshot(afterContext);
  const beforeTarget = beforeSnapshot.current_execution_target && typeof beforeSnapshot.current_execution_target === 'object'
    ? beforeSnapshot.current_execution_target as JsonRecord
    : {};
  const afterTarget = afterSnapshot.current_execution_target && typeof afterSnapshot.current_execution_target === 'object'
    ? afterSnapshot.current_execution_target as JsonRecord
    : {};
  const beforeEvent = beforeSnapshot.latest_target_event && typeof beforeSnapshot.latest_target_event === 'object'
    ? beforeSnapshot.latest_target_event as JsonRecord
    : {};
  const afterEvent = afterSnapshot.latest_target_event && typeof afterSnapshot.latest_target_event === 'object'
    ? afterSnapshot.latest_target_event as JsonRecord
    : {};
  const targetPlanChanged = String(beforeTarget.target_plan_id || '') !== String(afterTarget.target_plan_id || '');
  const resolutionChanged = String(beforeTarget.resolution_reason || '') !== String(afterTarget.resolution_reason || '');
  const latestTargetEventChanged = String(beforeEvent.event_type || '') !== String(afterEvent.event_type || '')
    || String(beforeEvent.occurred_at || '') !== String(afterEvent.occurred_at || '');
  const targetEventCountChanged = Number(beforeSnapshot.target_event_count || 0) !== Number(afterSnapshot.target_event_count || 0);
  return {
    changed: targetPlanChanged || resolutionChanged || latestTargetEventChanged || targetEventCountChanged,
    target_plan_changed: targetPlanChanged,
    resolution_changed: resolutionChanged,
    latest_target_event_changed: latestTargetEventChanged,
    target_event_count_changed: targetEventCountChanged,
    before: beforeSnapshot,
    after: afterSnapshot
  };
}

function buildRoutingPolicySourceTargetAlignment(
  source: {
    plan?: JsonRecord | null;
    target_resolution?: JsonRecord | null;
  },
  targetContext: JsonRecord | null | undefined,
): JsonRecord {
  const snapshot = buildRoutingPolicyOperatorTargetSnapshot(targetContext);
  const currentExecutionTarget = snapshot.current_execution_target && typeof snapshot.current_execution_target === 'object'
    ? snapshot.current_execution_target as JsonRecord
    : {};
  const targetResolution = source.target_resolution && typeof source.target_resolution === 'object'
    ? source.target_resolution as JsonRecord
    : {};
  return {
    source_plan_id: source.plan?.id || null,
    source_plan_name: source.plan?.plan_name || null,
    current_target_plan_id: currentExecutionTarget.target_plan_id || null,
    current_target_plan_name: currentExecutionTarget.target_plan_name || null,
    source_matches_current_target: source.plan
      ? String(source.plan.id) === String(currentExecutionTarget.target_plan_id || '')
      : null,
    resolved_target: targetResolution.target || null,
    resolved_target_reason: targetResolution.resolution_reason || null
  };
}

function buildRoutingPolicyReviewDecisionDiff(
  beforeItem: JsonRecord | null | undefined,
  afterItem: JsonRecord | null | undefined,
  beforeContext: JsonRecord | null | undefined,
  afterContext: JsonRecord | null | undefined,
): JsonRecord {
  const beforeStatus = String(beforeItem?.review_status || '');
  const afterStatus = String(afterItem?.review_status || '');
  const beforeNote = String(beforeItem?.review_note || '');
  const afterNote = String(afterItem?.review_note || '');
  const targetTransition = buildRoutingPolicyOperatorTargetTransition(beforeContext, afterContext);
  return {
    changed: beforeStatus !== afterStatus || beforeNote !== afterNote || targetTransition.changed === true,
    review_status_changed: beforeStatus !== afterStatus,
    note_changed: beforeNote !== afterNote,
    target_changed: targetTransition.changed === true,
    before_review_status: beforeStatus || null,
    after_review_status: afterStatus || null,
    before_note: beforeNote || null,
    after_note: afterNote || null,
    target_transition: targetTransition
  };
}

function readRoutingPolicyActionHistoryTargetSnapshot(entry: JsonRecord | null | undefined): JsonRecord | null {
  const metadata = entry?.metadata && typeof entry.metadata === 'object'
    ? entry.metadata as JsonRecord
    : {};
  const snapshotAfter = metadata.target_snapshot_after && typeof metadata.target_snapshot_after === 'object'
    ? metadata.target_snapshot_after as JsonRecord
    : null;
  const snapshotBefore = metadata.target_snapshot_before && typeof metadata.target_snapshot_before === 'object'
    ? metadata.target_snapshot_before as JsonRecord
    : null;
  return snapshotAfter || snapshotBefore || null;
}

function buildRoutingPolicyActionHistoryExecutionTargetContext(entry: JsonRecord | null | undefined): JsonRecord {
  const metadata = entry?.metadata && typeof entry.metadata === 'object'
    ? entry.metadata as JsonRecord
    : {};
  return {
    target_snapshot_before: metadata.target_snapshot_before && typeof metadata.target_snapshot_before === 'object'
      ? metadata.target_snapshot_before as JsonRecord
      : null,
    target_snapshot_after: metadata.target_snapshot_after && typeof metadata.target_snapshot_after === 'object'
      ? metadata.target_snapshot_after as JsonRecord
      : null,
    target_transition: metadata.target_transition && typeof metadata.target_transition === 'object'
      ? metadata.target_transition as JsonRecord
      : null
  };
}

function buildRoutingPolicyActionHistoryCurrentTargetDiff(
  entry: JsonRecord | null | undefined,
  targetContext: JsonRecord | null | undefined,
): JsonRecord {
  const executionSnapshot = readRoutingPolicyActionHistoryTargetSnapshot(entry);
  const currentSnapshot = buildRoutingPolicyOperatorTargetSnapshot(targetContext);
  const transition = executionSnapshot
    ? buildRoutingPolicyOperatorTargetTransition(
        { report_summary: executionSnapshot },
        { report_summary: currentSnapshot }
      )
    : {
        changed: false,
        target_plan_changed: false,
        resolution_changed: false,
        latest_target_event_changed: false,
        target_event_count_changed: false,
        before: executionSnapshot,
        after: currentSnapshot
      };
  const executionTarget = executionSnapshot?.current_execution_target && typeof executionSnapshot.current_execution_target === 'object'
    ? executionSnapshot.current_execution_target as JsonRecord
    : {};
  const currentTarget = currentSnapshot.current_execution_target && typeof currentSnapshot.current_execution_target === 'object'
    ? currentSnapshot.current_execution_target as JsonRecord
    : {};
  return {
    changed: transition.changed === true,
    target_plan_changed: transition.target_plan_changed === true,
    resolution_changed: transition.resolution_changed === true,
    latest_target_event_changed: transition.latest_target_event_changed === true,
    execution_target: executionSnapshot?.current_execution_target || null,
    current_target: currentSnapshot.current_execution_target || null,
    execution_target_plan_id: executionTarget.target_plan_id || null,
    current_target_plan_id: currentTarget.target_plan_id || null,
    execution_resolution_reason: executionTarget.resolution_reason || null,
    current_resolution_reason: currentTarget.resolution_reason || null,
    execution_latest_target_event: executionSnapshot?.latest_target_event || null,
    current_latest_target_event: currentSnapshot.latest_target_event || null,
    transition
  };
}

function routingPolicyTargetEventPayload(event: JsonRecord | null | undefined): JsonRecord {
  return event?.payload && typeof event.payload === 'object'
    ? event.payload as JsonRecord
    : {};
}

function routingPolicyTargetEventReferencesPlan(event: JsonRecord | null | undefined, planId: unknown): boolean {
  const targetPlanId = String(planId || '');
  if (!targetPlanId) {
    return false;
  }
  const payload = routingPolicyTargetEventPayload(event);
  return String(event?.plan_id || '') === targetPlanId
    || String(payload.previous_preferred_plan_id || '') === targetPlanId
    || String(payload.preference_source_plan_id || '') === targetPlanId
    || String(payload.refreshed_from_plan_id || '') === targetPlanId
    || String(payload.superseded_by_plan_id || '') === targetPlanId
    || String(payload.target_fallback_plan_id || '') === targetPlanId;
}

function buildRoutingPolicyActionHistoryTargetGovernanceTrail(
  entry: JsonRecord | null | undefined,
  targetContext: JsonRecord | null | undefined,
  limit = 5,
): JsonRecord {
  const diff = buildRoutingPolicyActionHistoryCurrentTargetDiff(entry, targetContext);
  const executionAt = String(entry?.created_at || '');
  const executionTargetPlanId = diff.execution_target_plan_id || null;
  const currentTargetPlanId = diff.current_target_plan_id || null;
  const events = Array.isArray(targetContext?.recent_target_events)
    ? targetContext.recent_target_events as JsonRecord[]
    : [];
  const eventsAfterExecution = events
    .filter((event) => String(event.occurred_at || '') > executionAt)
    .map((event) => ({
      ...buildRoutingPolicyRecentTargetEventReport(event),
      touches_execution_target: routingPolicyTargetEventReferencesPlan(event, executionTargetPlanId),
      touches_current_target: routingPolicyTargetEventReferencesPlan(event, currentTargetPlanId)
    }));
  return {
    execution_at: executionAt || null,
    execution_target_plan_id: executionTargetPlanId,
    current_target_plan_id: currentTargetPlanId,
    has_target_change_since_execution: diff.changed === true,
    has_target_plan_drift: diff.target_plan_changed === true,
    events_after_execution_count: eventsAfterExecution.length,
    latest_event_after_execution: eventsAfterExecution[0] || null,
    linked_events: eventsAfterExecution.slice(0, limit)
  };
}

function decorateRoutingPolicyActionHistoryEntries(
  entries: JsonRecord[],
  targetContext: JsonRecord | null | undefined,
  targetAuditEventLimit = 5,
): JsonRecord[] {
  return entries.map((entry) => ({
    ...entry,
    operator_context: targetContext?.report_summary || {},
    execution_target_context: buildRoutingPolicyActionHistoryExecutionTargetContext(entry),
    historical_current_target_diff: buildRoutingPolicyActionHistoryCurrentTargetDiff(entry, targetContext),
    target_governance_trail: buildRoutingPolicyActionHistoryTargetGovernanceTrail(entry, targetContext, targetAuditEventLimit)
  }));
}

function buildRoutingPolicyActionHistoryTargetAuditSummary(entries: JsonRecord[]): JsonRecord {
  const driftEntries = entries.filter((entry) => entry.historical_current_target_diff?.changed === true);
  const planDriftEntries = entries.filter((entry) => entry.historical_current_target_diff?.target_plan_changed === true);
  const entriesWithGovernanceAfterExecution = entries.filter((entry) => Number(entry.target_governance_trail?.events_after_execution_count || 0) > 0);
  return {
    entries_with_execution_target_snapshot: entries.filter((entry) => entry.execution_target_context?.target_snapshot_after || entry.execution_target_context?.target_snapshot_before).length,
    entries_with_target_change_since_execution: driftEntries.length,
    entries_with_target_plan_drift: planDriftEntries.length,
    entries_with_target_governance_events_after_execution: entriesWithGovernanceAfterExecution.length,
    latest_target_plan_drift: summarizeRoutingPolicyActionHistoryEntry(planDriftEntries[0] || null),
    latest_target_change_since_execution: summarizeRoutingPolicyActionHistoryEntry(driftEntries[0] || null)
  };
}

function routingPolicyBatchPlanTimestamp(plan: JsonRecord | null | undefined): string {
  return String(plan?.updated_at || plan?.created_at || '');
}

function isRoutingPolicyBatchPlanDescendant(
  candidate: JsonRecord,
  ancestorId: string,
  planById: Map<string, JsonRecord>,
): boolean {
  const visited = new Set<string>();
  let currentParentId = routingPolicyBatchPlanParentId(candidate);
  while (currentParentId && !visited.has(currentParentId)) {
    if (currentParentId === ancestorId) {
      return true;
    }
    visited.add(currentParentId);
    currentParentId = routingPolicyBatchPlanParentId(planById.get(currentParentId) || null);
  }
  return false;
}

function buildRoutingPolicyBatchPlanLineageModel(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  if (!input.plan_id) {
    throw new Error('plan_id is required');
  }
  const anchorPlan = geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(input.plan_id));
  if (!anchorPlan) {
    throw new Error(`routing policy batch plan not found: ${String(input.plan_id)}`);
  }
  const workspaceId = String(input.workspace_id || anchorPlan.workspace_id || 'default');
  const policyId = String(input.policy_id || anchorPlan.policy_id || 'default');
  const plans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.limit || input.lineage_limit || 200
  });
  const planById = new Map<string, JsonRecord>();
  const childrenByParent = new Map<string, JsonRecord[]>();
  for (const plan of plans) {
    const planId = String(plan.id);
    planById.set(planId, plan);
    const parentId = routingPolicyBatchPlanParentId(plan);
    if (parentId) {
      const siblings = childrenByParent.get(parentId) || [];
      siblings.push(plan);
      childrenByParent.set(parentId, siblings);
    }
  }

  const familyIds = new Set<string>([String(anchorPlan.id)]);
  const queue: string[] = [String(anchorPlan.id)];
  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId) continue;
    const currentPlan = planById.get(currentId) || null;
    if (!currentPlan) continue;
    const relatedIds = [
      routingPolicyBatchPlanParentId(currentPlan),
      routingPolicyBatchPlanSuccessorId(currentPlan),
      ...(childrenByParent.get(currentId) || []).map((child) => String(child.id))
    ].filter((value): value is string => Boolean(value));
    for (const relatedId of relatedIds) {
      if (!planById.has(relatedId) || familyIds.has(relatedId)) {
        continue;
      }
      familyIds.add(relatedId);
      queue.push(relatedId);
    }
  }

  const familyPlans = Array.from(familyIds)
    .map((planId) => planById.get(planId))
    .filter((plan): plan is JsonRecord => Boolean(plan));
  const familyPlanById = new Map<string, JsonRecord>(familyPlans.map((plan) => [String(plan.id), plan]));

  const visitedRootIds = new Set<string>();
  let rootPlan = anchorPlan;
  let currentParentId = routingPolicyBatchPlanParentId(anchorPlan);
  while (currentParentId && familyPlanById.has(currentParentId) && !visitedRootIds.has(currentParentId)) {
    visitedRootIds.add(currentParentId);
    rootPlan = familyPlanById.get(currentParentId) || rootPlan;
    currentParentId = routingPolicyBatchPlanParentId(rootPlan);
  }

  const predecessor = familyPlanById.get(routingPolicyBatchPlanParentId(anchorPlan) || '') || null;
  const successor = familyPlanById.get(routingPolicyBatchPlanSuccessorId(anchorPlan) || '') || null;
  const descendants = familyPlans.filter((plan) => (
    String(plan.id) !== String(anchorPlan.id)
    && isRoutingPolicyBatchPlanDescendant(plan, String(anchorPlan.id), familyPlanById)
  ));
  const preferredActivePlan = preferredRoutingPolicyBatchPlan(familyPlans);
  const latestSuccessor = descendants
    .slice()
    .sort((left, right) => routingPolicyBatchPlanTimestamp(right).localeCompare(routingPolicyBatchPlanTimestamp(left)))[0] || null;
  const latestActivePlan = familyPlans
    .filter((plan) => plan.status === 'active')
    .slice()
    .sort((left, right) => routingPolicyBatchPlanTimestamp(right).localeCompare(routingPolicyBatchPlanTimestamp(left)))[0] || null;
  const recommendedPlan = preferredActivePlan || latestActivePlan || latestSuccessor || anchorPlan;
  const currentTargetSummary = {
    target: 'recommended',
    resolution_reason: preferredActivePlan ? 'preferred_active_plan' : (latestActivePlan ? 'latest_active_plan' : (latestSuccessor ? 'latest_successor' : 'anchor_plan')),
    target_plan_id: recommendedPlan?.id || null,
    preferred_active_plan_id: preferredActivePlan?.id || null,
    latest_active_plan_id: latestActivePlan?.id || null,
    recommended_plan_id: recommendedPlan?.id || null
  };
  const summarizedById = new Map<string, JsonRecord | null>();
  for (const plan of familyPlans) {
    summarizedById.set(String(plan.id), summarizeRoutingPolicyBatchPlan(plan));
  }
  const statusFilter = input.status === 'active' || input.status === 'archived' ? input.status : null;
  const filteredPlans = statusFilter ? familyPlans.filter((plan) => plan.status === statusFilter) : familyPlans;
  const lineagePlans = filteredPlans
    .slice()
    .sort((left, right) => {
       const byCreated = String(left.created_at || '').localeCompare(String(right.created_at || ''));
       if (byCreated !== 0) return byCreated;
       return String(left.updated_at || '').localeCompare(String(right.updated_at || ''));
     })
    .map((plan) => {
      const targetState = buildRoutingPolicyBatchPlanTargetState(plan, {
        preferred_active_plan: preferredActivePlan,
        latest_active_plan: latestActivePlan,
        recommended_plan: recommendedPlan,
        current_target_plan: recommendedPlan,
        current_target: currentTargetSummary.target,
        current_resolution_reason: currentTargetSummary.resolution_reason,
        summarized_by_id: summarizedById
      });
      return summarizeRoutingPolicyBatchPlan(plan, {
        is_anchor_plan: String(plan.id) === String(anchorPlan.id),
        is_root_plan: String(plan.id) === String(rootPlan.id),
        is_direct_predecessor: predecessor ? String(plan.id) === String(predecessor.id) : false,
        is_direct_successor: successor ? String(plan.id) === String(successor.id) : false,
        is_latest_successor: latestSuccessor ? String(plan.id) === String(latestSuccessor.id) : false,
        is_latest_active_plan: latestActivePlan ? String(plan.id) === String(latestActivePlan.id) : false,
        is_preferred_active_plan: preferredActivePlan ? String(plan.id) === String(preferredActivePlan.id) : false,
        is_recommended_plan: recommendedPlan ? String(plan.id) === String(recommendedPlan.id) : false,
        current_target_roles: targetState?.current_roles || [],
        last_target_change_type: targetState?.last_target_change?.event_type || null,
        last_target_change_at: targetState?.last_target_change?.occurred_at || null,
        last_target_change_reason: targetState?.last_target_change?.reason || null,
        last_target_change_reason_label: targetState?.last_target_change?.reason_label || null
      });
    });
  const lineageTargetDrilldown = {
    current_execution_target: {
      summary: currentTargetSummary,
      target_plan: summarizeRoutingPolicyBatchPlan(recommendedPlan),
      preferred_active_plan: summarizeRoutingPolicyBatchPlan(preferredActivePlan),
      latest_active_plan: summarizeRoutingPolicyBatchPlan(latestActivePlan),
      recommended_plan: summarizeRoutingPolicyBatchPlan(recommendedPlan)
    },
    anchor_plan_state: buildRoutingPolicyBatchPlanTargetState(anchorPlan, {
      preferred_active_plan: preferredActivePlan,
      latest_active_plan: latestActivePlan,
      recommended_plan: recommendedPlan,
      current_target_plan: recommendedPlan,
      current_target: currentTargetSummary.target,
      current_resolution_reason: currentTargetSummary.resolution_reason,
      summarized_by_id: summarizedById
    }),
    root_plan_state: buildRoutingPolicyBatchPlanTargetState(rootPlan, {
      preferred_active_plan: preferredActivePlan,
      latest_active_plan: latestActivePlan,
      recommended_plan: recommendedPlan,
      current_target_plan: recommendedPlan,
      current_target: currentTargetSummary.target,
      current_resolution_reason: currentTargetSummary.resolution_reason,
      summarized_by_id: summarizedById
    })
  };

  return {
    policy: {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId
    },
    anchor_plan: anchorPlan,
    root_plan: rootPlan,
    predecessor,
    successor,
    preferred_active_plan: preferredActivePlan,
    latest_successor: latestSuccessor,
    latest_active_plan: latestActivePlan,
    recommended_plan: recommendedPlan,
    summary: {
      total_related_plans: familyPlans.length,
      displayed_plans: lineagePlans.length,
      active_plans: familyPlans.filter((plan) => plan.status === 'active').length,
      archived_plans: familyPlans.filter((plan) => plan.status === 'archived').length,
      preferred_active_plan_id: preferredActivePlan?.id || null,
      descendant_plans: descendants.length,
      has_predecessor: Boolean(predecessor),
      has_successor: Boolean(successor),
      latest_successor_id: latestSuccessor?.id || null,
      latest_active_plan_id: latestActivePlan?.id || null,
      recommended_plan_id: recommendedPlan?.id || null,
      current_target_plan_id: currentTargetSummary.target_plan_id,
      current_target_resolution_reason: currentTargetSummary.resolution_reason,
      root_plan_id: rootPlan.id,
      current_is_latest_active: latestActivePlan ? String(latestActivePlan.id) === String(anchorPlan.id) : false,
      current_is_preferred: isRoutingPolicyBatchPlanPreferred(anchorPlan),
      current_is_archived: anchorPlan.status === 'archived',
      anchor_last_target_change_type: lineageTargetDrilldown.anchor_plan_state?.last_target_change?.event_type || null,
      anchor_last_target_change_at: lineageTargetDrilldown.anchor_plan_state?.last_target_change?.occurred_at || null
    },
    target_drilldown: lineageTargetDrilldown,
    plans: lineagePlans
  };
}

function applyRoutingPolicyBatchPlanPreference(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const tenantId = String(input.tenant_id);
  const workspaceId = String(input.workspace_id || 'default');
  const policyId = String(input.policy_id || 'default');
  const actorId = String(input.actor_id || 'system');
  const planId = String(input.plan_id);
  const preferPlan = input.preferred === true;
  const preferredAt = new Date().toISOString();
  const plans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
      limit: input.limit || 200
  });
  const previousPreferredPlan = preferredRoutingPolicyBatchPlan(plans);
  const preferenceReason = String(input.preference_reason || 'manual_preference_assignment');
  const preferenceSourcePlanId = input.preference_source_plan_id ? String(input.preference_source_plan_id) : null;
  const targetPlan = plans.find((plan) => String(plan.id) === planId) || geoRoutingStore.getRoutingPolicyBatchPlan(tenantId, planId);
  if (!targetPlan) {
    throw new Error(`routing policy batch plan not found: ${planId}`);
  }
  if (preferPlan && targetPlan.status !== 'active') {
    throw new Error('only active batch plans can be preferred');
  }

  for (const plan of plans) {
    const shouldPrefer = preferPlan && String(plan.id) === planId;
    const currentlyPreferred = isRoutingPolicyBatchPlanPreferred(plan);
    if (currentlyPreferred === shouldPrefer) {
      continue;
    }
    const metadata = {
      ...(plan.metadata || {}),
      preferred: shouldPrefer
    } as JsonRecord;
    if (shouldPrefer) {
      metadata.preferred_at = preferredAt;
      metadata.preferred_by = actorId;
      metadata.preference_reason = preferenceReason;
      metadata.previous_preferred_plan_id = (
        previousPreferredPlan
        && String(previousPreferredPlan.id) !== String(plan.id)
      ) ? previousPreferredPlan.id : null;
      metadata.preference_source_plan_id = preferenceSourcePlanId;
    } else {
      if (currentlyPreferred) {
        metadata.demoted_at = preferredAt;
        metadata.demoted_by = actorId;
        metadata.demoted_reason = String(input.demotion_reason || preferenceReason || 'preferred_reassigned');
        metadata.demoted_to_plan_id = planId;
      }
      metadata.preferred_by = null;
    }
    geoRoutingStore.upsertRoutingPolicyBatchPlan({
      tenant_id: tenantId,
      workspace_id: plan.workspace_id,
      policy_id: plan.policy_id,
      plan_id: plan.id,
      plan_name: plan.plan_name,
      status: plan.status,
      items: Array.isArray(plan.items) ? plan.items : [],
      selection_summary: plan.selection_summary || {},
      preview: plan.preview || {},
      notes: plan.notes || '',
      metadata,
      actor_id: actorId
    });
  }

  return geoRoutingStore.getRoutingPolicyBatchPlan(tenantId, planId) || targetPlan;
}

function ensureRoutingPolicyBatchPlanPreferredTarget(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord | null {
  const tenantId = String(input.tenant_id);
  const workspaceId = String(input.workspace_id || 'default');
  const policyId = String(input.policy_id || 'default');
  const activePlans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
    status: 'active',
    limit: input.limit || 200
  });
  const existingPreferred = preferredRoutingPolicyBatchPlan(activePlans);
  if (existingPreferred) {
    return existingPreferred;
  }
  const fallbackPlan = activePlans
    .slice()
    .sort((left, right) => routingPolicyBatchPlanTimestamp(right).localeCompare(routingPolicyBatchPlanTimestamp(left)))[0] || null;
  if (!fallbackPlan) {
    return null;
  }
  return applyRoutingPolicyBatchPlanPreference(geoRoutingStore, {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
    plan_id: fallbackPlan.id,
    preferred: true,
    actor_id: input.actor_id || 'system',
    preference_reason: input.preference_reason || 'auto_fallback_latest_active',
    demotion_reason: input.demotion_reason || 'auto_fallback_latest_active'
  });
}

function resolveRoutingPolicyBatchPlanTarget(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const tenantId = String(input.tenant_id);
  const workspaceId = String(input.workspace_id || 'default');
  const policyId = String(input.policy_id || 'default');
  const target = String(input.plan_target || input.target || 'recommended');
  if (!['preferred', 'recommended', 'latest_active'].includes(target)) {
    throw new Error('plan_target must be preferred, recommended, or latest_active');
  }
  const activePlans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
    status: 'active',
    limit: input.limit || 200
  });
  if (!activePlans.length) {
    throw new Error(`no active routing policy batch plans found for ${workspaceId}/${policyId}`);
  }
  const preferredActivePlan = preferredRoutingPolicyBatchPlan(activePlans);
  const latestActivePlan = activePlans
    .slice()
    .sort((left, right) => routingPolicyBatchPlanTimestamp(right).localeCompare(routingPolicyBatchPlanTimestamp(left)))[0] || null;
  const recommendedPlan = preferredActivePlan || latestActivePlan;
  let selectedPlan: JsonRecord | null = null;
  let resolutionReason = '';
  if (target === 'preferred') {
    selectedPlan = preferredActivePlan;
    resolutionReason = 'preferred_active_plan';
  } else if (target === 'latest_active') {
    selectedPlan = latestActivePlan;
    resolutionReason = 'latest_active_plan';
  } else {
    selectedPlan = recommendedPlan;
    resolutionReason = preferredActivePlan ? 'preferred_active_plan' : 'latest_active_plan';
  }
  if (!selectedPlan) {
    throw new Error(`routing policy batch plan target could not be resolved: ${target}`);
  }
  return {
    target,
    resolution_reason: resolutionReason,
    workspace_id: workspaceId,
    policy_id: policyId,
    target_plan: selectedPlan,
    preferred_active_plan: preferredActivePlan,
    latest_active_plan: latestActivePlan,
    recommended_plan: recommendedPlan
  };
}

function compareRoutingPolicyBatchPlanItems(savedItem: JsonRecord, currentItem: JsonRecord): JsonRecord[] {
  const changes: JsonRecord[] = [];
  const pushChange = (field: string, previousValue: unknown, currentValue: unknown, blocking = false): void => {
    if (previousValue === currentValue) {
      return;
    }
    changes.push({
      field,
      previous: previousValue,
      current: currentValue,
      blocking
    });
  };

  pushChange(
    'status',
    String(savedItem.status || ''),
    String(currentItem.status || ''),
    !['ready', 'forced_ready'].includes(String(currentItem.status || ''))
  );
  pushChange(
    'executable',
    Boolean(savedItem.executable),
    Boolean(currentItem.executable),
    currentItem.executable === false
  );
  pushChange(
    'repeat_guard_reason',
    String(savedItem.repeat_guard_reason || ''),
    String(currentItem.repeat_guard_reason || ''),
    currentItem.repeat_guarded === true
  );
  pushChange('review_status', String(savedItem.review_status || ''), String(currentItem.review_status || ''));
  pushChange('severity', String(savedItem.severity || ''), String(currentItem.severity || ''));
  pushChange('title', String(savedItem.title || ''), String(currentItem.title || ''));
  pushChange('summary', String(savedItem.summary || ''), String(currentItem.summary || ''));
  return changes;
}

function buildRoutingPolicyBatchPlanFreshness(plan: JsonRecord | null, currentItems: JsonRecord[]): JsonRecord {
  if (!plan) {
    return {
      source: 'inline',
      stale: false,
      requires_confirmation: false,
      blocking_changes: 0,
      non_blocking_changes: 0,
      changed_review_status_items: 0,
      changed_severity_items: 0,
      changed_content_items: 0,
      missing_review_items: 0,
      missing_action_items: 0,
      newly_repeat_guarded_items: 0,
      changed_items: []
    };
  }

  const savedPreview = (plan.preview && typeof plan.preview === 'object') ? plan.preview as JsonRecord : {};
  const savedItemByKey = new Map<string, JsonRecord>();
  for (const item of Array.isArray(savedPreview.items) ? savedPreview.items : []) {
    const reviewKey = String(item?.review_key || '');
    const actionId = String(item?.action_id || '');
    if (!reviewKey || !actionId) {
      continue;
    }
    savedItemByKey.set(routingPolicyBatchSelectionKey(reviewKey, actionId), item as JsonRecord);
  }

  const changedItems: JsonRecord[] = [];
  let changedReviewStatusItems = 0;
  let changedSeverityItems = 0;
  let changedContentItems = 0;
  let missingReviewItems = 0;
  let missingActionItems = 0;
  let newlyRepeatGuardedItems = 0;
  let blockingChanges = 0;
  let nonBlockingChanges = 0;

  for (const currentItem of currentItems) {
    const reviewKey = String(currentItem.review_key || '');
    const actionId = String(currentItem.action_id || '');
    const selectionKey = routingPolicyBatchSelectionKey(reviewKey, actionId);
    const savedItem = savedItemByKey.get(selectionKey) || null;
    const changes = savedItem
      ? compareRoutingPolicyBatchPlanItems(savedItem, currentItem)
      : [{
          field: 'saved_selection',
          previous: 'missing_from_saved_preview',
          current: 'present_in_current_preview',
          blocking: false
        }];
    if (!changes.length) {
      continue;
    }
    const hasBlockingChange = changes.some((change) => change.blocking === true);
    if (changes.some((change) => change.field === 'review_status')) {
      changedReviewStatusItems += 1;
    }
    if (changes.some((change) => change.field === 'severity')) {
      changedSeverityItems += 1;
    }
    if (changes.some((change) => change.field === 'title' || change.field === 'summary')) {
      changedContentItems += 1;
    }
    if (currentItem.status === 'missing_review_item') {
      missingReviewItems += 1;
    }
    if (currentItem.status === 'missing_action') {
      missingActionItems += 1;
    }
    if (
      currentItem.status === 'repeat_guarded'
      && String(savedItem?.status || '') !== 'repeat_guarded'
    ) {
      newlyRepeatGuardedItems += 1;
    }
    if (hasBlockingChange) {
      blockingChanges += 1;
    } else {
      nonBlockingChanges += 1;
    }
    changedItems.push({
      review_key: reviewKey,
      action_id: actionId,
      title: currentItem.title,
      item_type: currentItem.item_type,
      previous_status: savedItem?.status || null,
      current_status: currentItem.status,
      previous_review_status: savedItem?.review_status || null,
      current_review_status: currentItem.review_status || null,
      blocking: hasBlockingChange,
      changes
    });
  }

  return {
    source: 'saved_plan',
    plan_id: plan.id,
    plan_updated_at: plan.updated_at || null,
    stale: changedItems.length > 0,
    requires_confirmation: changedItems.length > 0,
    blocking_changes: blockingChanges,
    non_blocking_changes: nonBlockingChanges,
    changed_review_status_items: changedReviewStatusItems,
    changed_severity_items: changedSeverityItems,
    changed_content_items: changedContentItems,
    missing_review_items: missingReviewItems,
    missing_action_items: missingActionItems,
    newly_repeat_guarded_items: newlyRepeatGuardedItems,
    blocking_review_keys: changedItems.filter((item) => item.blocking).map((item) => item.review_key),
    saved_summary: plan.selection_summary || savedPreview.summary || {},
    changed_items: changedItems
  };
}

function buildRoutingPolicyBatchPlanRefreshSelection(preview: JsonRecord, input: JsonRecord): JsonRecord {
  const adoptStrategy = input.adopt_strategy === 'current_selection' ? 'current_selection' : 'actionable_only';
  const droppedItems: JsonRecord[] = [];
  const refreshedItems: JsonRecord[] = [];
  for (const item of Array.isArray(preview.items) ? preview.items : []) {
    const status = String(item?.status || '');
    const missingOrInvalid = ['invalid_selection', 'duplicate_selection', 'missing_review_item', 'missing_action'].includes(status);
    const repeatGuarded = status === 'repeat_guarded';
    const actionable = status === 'ready' || status === 'forced_ready';
    if (missingOrInvalid) {
      droppedItems.push({
        review_key: item.review_key,
        action_id: item.action_id,
        status,
        drop_reason: status,
        title: item.title || '',
        item_type: item.item_type || ''
      });
      continue;
    }
    if (repeatGuarded && adoptStrategy === 'actionable_only') {
      droppedItems.push({
        review_key: item.review_key,
        action_id: item.action_id,
        status,
        drop_reason: 'repeat_guarded_excluded',
        title: item.title || '',
        item_type: item.item_type || ''
      });
      continue;
    }
    if (!actionable && !(repeatGuarded && adoptStrategy === 'current_selection')) {
      droppedItems.push({
        review_key: item.review_key,
        action_id: item.action_id,
        status,
        drop_reason: 'non_actionable_selection',
        title: item.title || '',
        item_type: item.item_type || ''
      });
      continue;
    }
    refreshedItems.push(toRoutingPolicyBatchSavedItem(item));
  }
  return {
    adopt_strategy: adoptStrategy,
    items: refreshedItems,
    dropped_items: droppedItems,
    summary: {
      kept_items: refreshedItems.length,
      dropped_items: droppedItems.length,
      dropped_missing_items: droppedItems.filter((item) => item.drop_reason === 'missing_review_item' || item.drop_reason === 'missing_action').length,
      dropped_repeat_guarded_items: droppedItems.filter((item) => item.drop_reason === 'repeat_guarded_excluded').length,
      dropped_invalid_items: droppedItems.filter((item) => item.drop_reason === 'invalid_selection' || item.drop_reason === 'duplicate_selection').length
    }
  };
}

function resolveRoutingPolicyBatchPlanSource(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const inlineItems = Array.isArray(input.items) ? input.items as JsonRecord[] : [];
  if (inlineItems.length) {
    return {
      workspace_id: input.workspace_id || 'default',
      policy_id: input.policy_id || 'default',
      plan: null,
      target_resolution: null,
      items: inlineItems
    };
  }
  if (!input.plan_id && !input.plan_target && !input.target) {
    throw new Error('items, plan_id, or plan_target is required');
  }
  const targetResolution = input.plan_id
    ? null
    : resolveRoutingPolicyBatchPlanTarget(geoRoutingStore, input);
  const plan = input.plan_id
    ? geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(input.plan_id))
    : targetResolution?.target_plan || null;
  if (!plan) {
    throw new Error(`routing policy batch plan not found: ${String(input.plan_id || input.plan_target || input.target)}`);
  }
  return {
    workspace_id: plan.workspace_id || input.workspace_id || 'default',
    policy_id: plan.policy_id || input.policy_id || 'default',
    plan,
    target_resolution: targetResolution,
    items: Array.isArray(plan.items) ? plan.items : []
  };
}

function buildRoutingPolicyBatchPlanPreview(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const source = resolveRoutingPolicyBatchPlanSource(geoRoutingStore, input);
  const workspaceId = source.workspace_id || 'default';
  const policyId = source.policy_id || 'default';
  const items = Array.isArray(source.items) ? source.items as JsonRecord[] : [];
  const targetContext = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId
  });
  const workbench = buildRoutingPolicyActionWorkbench(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.lookup_limit || 500,
    attention_limit: input.lookup_limit || 500,
    approval_limit: input.approval_limit || 200,
    override_limit: input.override_limit || 200,
    trigger_limit: input.trigger_limit || 500,
    history_limit: input.history_limit || 200
  });
  const workbenchItemByKey = new Map<string, JsonRecord>();
  for (const workbenchItem of Array.isArray(workbench.items) ? workbench.items : []) {
    workbenchItemByKey.set(String(workbenchItem.review_key), workbenchItem);
  }
  const uniqueSelections = new Set<string>();
  const actionMix: Record<string, number> = {};
  const riskMix: Record<string, number> = {};
  const reviewStatusMix: Record<string, number> = {};
  const selectedItems: JsonRecord[] = [];
  const duplicateSelections: string[] = [];
  for (const [index, item] of items.entries()) {
    const reviewKey = String(item?.review_key || '');
    const actionId = String(item?.action_id || '');
    const uniqueKey = `${reviewKey}::${actionId}`;
    if (!reviewKey || !actionId) {
      selectedItems.push({
        selection_index: index,
        review_key: reviewKey,
        action_id: actionId,
        status: 'invalid_selection',
        error: 'review_key and action_id are required'
      });
      continue;
    }
    if (uniqueSelections.has(uniqueKey)) {
      duplicateSelections.push(uniqueKey);
      selectedItems.push({
        selection_index: index,
        review_key: reviewKey,
        action_id: actionId,
        status: 'duplicate_selection',
        error: `duplicate batch action item: ${uniqueKey}`
      });
      continue;
    }
    uniqueSelections.add(uniqueKey);
    const workbenchItem = workbenchItemByKey.get(reviewKey) || null;
    if (!workbenchItem) {
      selectedItems.push({
        selection_index: index,
        review_key: reviewKey,
        action_id: actionId,
        status: 'missing_review_item',
        error: `routing policy action item not found: ${reviewKey}`
      });
      continue;
    }
    const action = listRoutingPolicyWorkbenchActions(workbenchItem).find(
      (candidate: JsonRecord) => candidate.action_id === actionId
    ) || null;
    if (!action) {
      selectedItems.push({
        selection_index: index,
        review_key: reviewKey,
        action_id: actionId,
        item_type: workbenchItem.item_type,
        title: workbenchItem.title,
        status: 'missing_action',
        error: `routing policy action not found: ${actionId}`
      });
      continue;
    }
    const forceRepeat = item.force_repeat === true;
    const status = action.executable === false && !forceRepeat ? 'repeat_guarded' : (forceRepeat ? 'forced_ready' : 'ready');
    const riskLevel = routingPolicyActionRiskLevel(actionId);
    actionMix[actionId] = (actionMix[actionId] || 0) + 1;
    riskMix[riskLevel] = (riskMix[riskLevel] || 0) + 1;
    reviewStatusMix[String(workbenchItem.review_status || 'open')] = (reviewStatusMix[String(workbenchItem.review_status || 'open')] || 0) + 1;
    selectedItems.push({
      selection_index: index,
      review_key: reviewKey,
      action_id: actionId,
      action_label: action.label,
      status,
      force_repeat: forceRepeat,
      note: String(item.note || ''),
      reason: String(item.reason || ''),
      risk_level: riskLevel,
      expected_outcome: describeRoutingPolicyActionOutcome(actionId),
      executable: action.executable !== false || forceRepeat,
      repeat_guarded: action.repeat_guarded === true,
      repeat_guard_reason: action.repeat_guard_reason || '',
      item_type: workbenchItem.item_type,
      severity: workbenchItem.severity,
      title: workbenchItem.title,
      summary: workbenchItem.summary,
      review_status: workbenchItem.review_status,
      source_type: workbenchItem.source_type,
      source_id: workbenchItem.source_id,
      latest_action: summarizeRoutingPolicyActionHistoryEntry(workbenchItem.latest_action || action.latest_execution || null),
      payload_template: action.payload_template || {}
    });
  }
  const freshness = buildRoutingPolicyBatchPlanFreshness(source.plan || null, selectedItems);
  const decoratedSelectedItems: JsonRecord[] = selectedItems.map((item) => ({
    ...item,
    operator_context: targetContext.report_summary
  }));
  const targetSnapshot = buildRoutingPolicyOperatorTargetSnapshot(targetContext);
  const sourceAlignment = buildRoutingPolicySourceTargetAlignment(source, targetContext);
  return {
    policy: {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId
    },
    source: source.plan ? 'saved_plan' : 'inline',
    current_execution_target: targetContext.current_execution_target,
    target_governance_summary: targetContext.summary,
    recent_target_events: targetContext.recent_target_events,
    target_resolution: source.target_resolution ? {
      target: source.target_resolution.target,
      resolution_reason: source.target_resolution.resolution_reason,
      target_plan: summarizeRoutingPolicyBatchPlan(source.target_resolution.target_plan),
      preferred_active_plan: summarizeRoutingPolicyBatchPlan(source.target_resolution.preferred_active_plan),
      latest_active_plan: summarizeRoutingPolicyBatchPlan(source.target_resolution.latest_active_plan),
      recommended_plan: summarizeRoutingPolicyBatchPlan(source.target_resolution.recommended_plan)
    } : null,
    plan: source.plan ? {
      id: source.plan.id,
      plan_name: source.plan.plan_name,
      status: source.plan.status,
      updated_at: source.plan.updated_at,
      notes: source.plan.notes || ''
    } : null,
    summary: {
      total_selected: items.length,
      ready_items: selectedItems.filter((item) => item.status === 'ready' || item.status === 'forced_ready').length,
      forced_repeat_items: selectedItems.filter((item) => item.status === 'forced_ready').length,
      repeat_guarded_items: selectedItems.filter((item) => item.status === 'repeat_guarded').length,
      missing_items: selectedItems.filter((item) => item.status === 'missing_review_item').length,
      missing_actions: selectedItems.filter((item) => item.status === 'missing_action').length,
      invalid_items: selectedItems.filter((item) => item.status === 'invalid_selection').length,
      duplicate_items: selectedItems.filter((item) => item.status === 'duplicate_selection').length,
      mixed_risk: riskMix,
      action_mix: actionMix,
      review_status_mix: reviewStatusMix,
      plan_ready: selectedItems.length > 0 && selectedItems.every((item) => item.status === 'ready' || item.status === 'forced_ready'),
      current_target_plan_id: targetSnapshot.current_execution_target?.target_plan_id || null
    },
    report_summary: {
      ...targetSnapshot,
      source_alignment: sourceAlignment
    },
    issues: {
      duplicate_selections: duplicateSelections,
      blocked_review_keys: selectedItems.filter((item) => item.status === 'repeat_guarded').map((item) => item.review_key),
      missing_review_keys: selectedItems.filter((item) => item.status === 'missing_review_item').map((item) => item.review_key),
        missing_action_keys: selectedItems.filter((item) => item.status === 'missing_action').map((item) => `${String(item.review_key)}::${String(item.action_id)}`)
      },
    freshness,
    items: decoratedSelectedItems,
    saved_items: selectedItems
      .filter((item) => item.review_key && item.action_id)
      .map((item) => toRoutingPolicyBatchSavedItem(item)),
    workbench
  };
}

function listRoutingPolicyBatchPlans(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const rawPlans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    status: input.status || null,
    plan_id: input.plan_id || null,
    limit: input.limit || 50
  });
  const preferredActivePlan = preferredRoutingPolicyBatchPlan(rawPlans);
  const latestActivePlan = rawPlans
    .filter((plan) => plan.status === 'active')
    .slice()
    .sort((left, right) => routingPolicyBatchPlanTimestamp(right).localeCompare(routingPolicyBatchPlanTimestamp(left)))[0] || null;
  const currentExecutionTarget = rawPlans.some((plan) => plan.status === 'active')
    ? buildRoutingPolicyCurrentExecutionTarget(geoRoutingStore, {
        ...input,
        workspace_id: workspaceId,
        policy_id: policyId,
        plan_target: 'recommended',
        limit: input.limit || 200
      })
    : null;
  const summarizedById = new Map<string, JsonRecord | null>();
  for (const plan of rawPlans) {
    summarizedById.set(String(plan.id), summarizeRoutingPolicyBatchPlan(plan));
  }
  const plans: JsonRecord[] = rawPlans.map((plan: JsonRecord) => {
    const targetState = buildRoutingPolicyBatchPlanTargetState(plan, {
      preferred_active_plan: preferredActivePlan,
      latest_active_plan: latestActivePlan,
      recommended_plan: preferredActivePlan || latestActivePlan,
      current_target_plan: currentExecutionTarget?.target_plan || null,
      current_target: currentExecutionTarget?.summary?.target || null,
      current_resolution_reason: currentExecutionTarget?.summary?.resolution_reason || null,
      summarized_by_id: summarizedById
    });
    return {
      ...plan,
      is_preferred: isRoutingPolicyBatchPlanPreferred(plan),
      is_latest_active_plan: latestActivePlan ? String(plan.id) === String(latestActivePlan.id) : false,
      is_recommended_plan: preferredActivePlan
        ? String(plan.id) === String(preferredActivePlan.id)
        : (latestActivePlan ? String(plan.id) === String(latestActivePlan.id) : false),
      report_summary: buildRoutingPolicyBatchPlanCompactReport(plan, targetState)
    };
  });
  const currentTargetReport = buildRoutingPolicyCurrentExecutionTargetReport(currentExecutionTarget);
  return {
    policy: {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId
    },
    summary: {
      total_plans: plans.length,
      active_plans: plans.filter((plan) => plan.status === 'active').length,
      archived_plans: plans.filter((plan) => plan.status === 'archived').length,
      preferred_plans: plans.filter((plan) => plan.is_preferred).length,
      preferred_plan_id: preferredActivePlan?.id || null,
      recommended_plan_id: preferredActivePlan?.id || latestActivePlan?.id || null,
      current_target_plan_id: currentTargetReport?.target_plan_id || null,
      current_target_plan_name: currentTargetReport?.target_plan_name || null,
      current_target_resolution_reason: currentTargetReport?.resolution_reason || null,
      current_target_resolution_reason_label: currentTargetReport?.resolution_reason_label || null
    },
    current_execution_target: currentExecutionTarget,
    report_summary: {
      current_execution_target: currentTargetReport,
      active_plan_count: plans.filter((plan) => plan.status === 'active').length,
      archived_plan_count: plans.filter((plan) => plan.status === 'archived').length
    },
    plans
  };
}

function buildRoutingPolicyBatchPlanTarget(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const resolution = resolveRoutingPolicyBatchPlanTarget(geoRoutingStore, input);
  const plans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: resolution.workspace_id,
    policy_id: resolution.policy_id,
    limit: input.limit || 200
  });
  const summarizedPlans: JsonRecord[] = plans.map((plan) => summarizeRoutingPolicyBatchPlan(plan, {
    is_latest_active_plan: resolution.latest_active_plan ? String(plan.id) === String(resolution.latest_active_plan.id) : false,
    is_preferred_active_plan: resolution.preferred_active_plan ? String(plan.id) === String(resolution.preferred_active_plan.id) : false,
    is_recommended_plan: resolution.recommended_plan ? String(plan.id) === String(resolution.recommended_plan.id) : false,
    is_target_plan: String(plan.id) === String(resolution.target_plan.id)
  }) || {});
  return {
    policy: {
      tenant_id: input.tenant_id,
      workspace_id: resolution.workspace_id,
      policy_id: resolution.policy_id
    },
    summary: {
      total_plans: plans.length,
      active_plans: plans.filter((plan) => plan.status === 'active').length,
      archived_plans: plans.filter((plan) => plan.status === 'archived').length,
      target: resolution.target,
      resolution_reason: resolution.resolution_reason,
      target_plan_id: resolution.target_plan.id,
      preferred_active_plan_id: resolution.preferred_active_plan?.id || null,
      latest_active_plan_id: resolution.latest_active_plan?.id || null,
      recommended_plan_id: resolution.recommended_plan?.id || null
    },
    report_summary: {
      current_execution_target: buildRoutingPolicyCurrentExecutionTargetReport({
        summary: {
          target: resolution.target,
          resolution_reason: resolution.resolution_reason,
          target_plan_id: resolution.target_plan.id,
          preferred_active_plan_id: resolution.preferred_active_plan?.id || null,
          latest_active_plan_id: resolution.latest_active_plan?.id || null,
          recommended_plan_id: resolution.recommended_plan?.id || null
        },
        target_plan: summarizeRoutingPolicyBatchPlan(resolution.target_plan)
      }),
      target_plan: buildRoutingPolicyBatchPlanCompactReport(
        resolution.target_plan,
        buildRoutingPolicyBatchPlanTargetState(resolution.target_plan, {
          preferred_active_plan: resolution.preferred_active_plan,
          latest_active_plan: resolution.latest_active_plan,
          recommended_plan: resolution.recommended_plan,
          current_target_plan: resolution.target_plan,
          current_target: resolution.target,
          current_resolution_reason: resolution.resolution_reason,
          summarized_by_id: new Map(plans.map((plan) => [String(plan.id), summarizeRoutingPolicyBatchPlan(plan)]))
        })
      )
    },
    target_plan: summarizeRoutingPolicyBatchPlan(resolution.target_plan),
    preferred_active_plan: summarizeRoutingPolicyBatchPlan(resolution.preferred_active_plan),
    latest_active_plan: summarizeRoutingPolicyBatchPlan(resolution.latest_active_plan),
    recommended_plan: summarizeRoutingPolicyBatchPlan(resolution.recommended_plan),
    plans: summarizedPlans
  };
}

function summarizeRoutingPolicyBatchPlanTargetModel(model: JsonRecord | null): JsonRecord | null {
  if (!model) {
    return null;
  }
  return {
    summary: model.summary || {},
    target_plan: model.target_plan || null,
    preferred_active_plan: model.preferred_active_plan || null,
    latest_active_plan: model.latest_active_plan || null,
    recommended_plan: model.recommended_plan || null
  };
}

function buildRoutingPolicyCurrentExecutionTarget(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord | null {
  const activePlans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: String(input.workspace_id || 'default'),
    policy_id: String(input.policy_id || 'default'),
    status: 'active',
    limit: input.limit || 200
  });
  if (!activePlans.length) {
    return null;
  }
  return summarizeRoutingPolicyBatchPlanTargetModel(buildRoutingPolicyBatchPlanTarget(geoRoutingStore, {
    ...input,
    plan_target: input.plan_target || 'recommended'
  }));
}

function buildRoutingPolicyBatchPlanTargetGovernance(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = String(input.workspace_id || 'default');
  const policyId = String(input.policy_id || 'default');
  const planLimit = Number(input.plan_limit || input.limit || 200);
  const eventLimit = Number(input.target_event_limit || input.limit || 20);
  const plans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: planLimit
  });
  const activePlans = plans.filter((plan) => plan.status === 'active');
  const currentTarget = activePlans.length > 0
    ? buildRoutingPolicyCurrentExecutionTarget(geoRoutingStore, {
        ...input,
        workspace_id: workspaceId,
        policy_id: policyId,
        plan_target: input.plan_target || 'recommended',
        limit: planLimit
      })
    : null;
  const summarizedById = new Map<string, JsonRecord | null>();
  for (const plan of plans) {
    summarizedById.set(String(plan.id), summarizeRoutingPolicyBatchPlan(plan));
  }
  const events: JsonRecord[] = [];
  const pushEvent = (event: JsonRecord): void => {
    if (!event.occurred_at) {
      return;
    }
    events.push(event);
  };

  for (const plan of plans) {
    const metadata = routingPolicyBatchPlanMetadata(plan);
    const planSummary = summarizedById.get(String(plan.id)) || summarizeRoutingPolicyBatchPlan(plan);
    const parentPlan = summarizedById.get(String(metadata.refreshed_from_plan_id || '')) || null;
    const successorPlan = summarizedById.get(String(metadata.superseded_by_plan_id || '')) || null;

    if (metadata.refreshed_at && metadata.refreshed_from_plan_id) {
      pushEvent({
        event_type: 'batch_plan_refreshed',
        occurred_at: metadata.refreshed_at,
        policy_id: policyId,
        status: plan.status,
        plan_id: plan.id,
        plan: planSummary,
        payload: {
          refresh_mode: metadata.refresh_mode || null,
          refreshed_by: metadata.refreshed_by || null,
          refreshed_from_plan_id: metadata.refreshed_from_plan_id || null,
          refreshed_from_plan: parentPlan,
          adopt_strategy: metadata.adopt_strategy || null,
          preference_reason: metadata.preference_reason || null
        }
      });
    }

    if (metadata.preferred_at) {
      pushEvent({
        event_type: 'batch_plan_preferred',
        occurred_at: metadata.preferred_at,
        policy_id: policyId,
        status: plan.status === 'active' ? 'preferred' : plan.status,
        plan_id: plan.id,
        plan: planSummary,
        payload: {
          preferred_by: metadata.preferred_by || null,
          preference_reason: metadata.preference_reason || null,
          previous_preferred_plan_id: metadata.previous_preferred_plan_id || null,
          previous_preferred_plan: summarizedById.get(String(metadata.previous_preferred_plan_id || '')) || null,
          preference_source_plan_id: metadata.preference_source_plan_id || null,
          preference_source_plan: summarizedById.get(String(metadata.preference_source_plan_id || '')) || null
        }
      });
    }

    if (metadata.restored_at) {
      pushEvent({
        event_type: 'batch_plan_restored',
        occurred_at: metadata.restored_at,
        policy_id: policyId,
        status: plan.status,
        plan_id: plan.id,
        plan: planSummary,
        payload: {
          restored_by: metadata.restored_by || null,
          make_preferred: metadata.preference_reason === 'restore_make_preferred'
        }
      });
    }

    if (metadata.superseded_at && metadata.superseded_by_plan_id) {
      pushEvent({
        event_type: 'batch_plan_superseded',
        occurred_at: metadata.superseded_at,
        policy_id: policyId,
        status: plan.status,
        plan_id: plan.id,
        plan: planSummary,
        payload: {
          archived_by: metadata.archived_by || metadata.superseded_by || null,
          archived_reason: metadata.archived_reason || null,
          superseded_by_plan_id: metadata.superseded_by_plan_id || null,
          superseded_by_plan: successorPlan,
          preferred_before_archive: metadata.preferred_before_archive === true,
          target_fallback_plan_id: metadata.target_fallback_plan_id || null,
          target_fallback_plan: summarizedById.get(String(metadata.target_fallback_plan_id || '')) || null
        }
      });
    }

    if (metadata.archived_at) {
      pushEvent({
        event_type: 'batch_plan_archived',
        occurred_at: metadata.archived_at,
        policy_id: policyId,
        status: plan.status,
        plan_id: plan.id,
        plan: planSummary,
        payload: {
          archived_by: metadata.archived_by || null,
          archived_reason: metadata.archived_reason || null,
          preferred_before_archive: metadata.preferred_before_archive === true,
          target_fallback_plan_id: metadata.target_fallback_plan_id || null,
          target_fallback_plan: summarizedById.get(String(metadata.target_fallback_plan_id || '')) || null
        }
      });
    }
  }

  events.sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')));
  return {
    policy: {
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      policy_id: policyId
    },
    summary: {
      total_plans: plans.length,
      active_plans: activePlans.length,
      archived_plans: plans.filter((plan) => plan.status === 'archived').length,
      target_event_count: events.length,
      current_target: currentTarget?.summary?.target || null,
      current_target_plan_id: currentTarget?.summary?.target_plan_id || null,
      current_resolution_reason: currentTarget?.summary?.resolution_reason || null,
      preferred_active_plan_id: currentTarget?.summary?.preferred_active_plan_id || null,
      latest_active_plan_id: currentTarget?.summary?.latest_active_plan_id || null,
      recommended_plan_id: currentTarget?.summary?.recommended_plan_id || null
    },
    current_target: currentTarget,
    recent_events: events.slice(0, eventLimit)
  };
}

function buildRoutingPolicyBatchPlanDetail(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const lineage = buildRoutingPolicyBatchPlanLineageModel(geoRoutingStore, input);
  const anchorPlan = lineage.anchor_plan as JsonRecord;
  const planTargetState = lineage.target_drilldown?.anchor_plan_state || null;
  return {
    policy: lineage.policy,
    summary: lineage.summary,
    plan: summarizeRoutingPolicyBatchPlan(anchorPlan, {
      preview_summary: anchorPlan.selection_summary || {},
      freshness_summary: anchorPlan.preview?.freshness || {},
      target_state: planTargetState
    }),
    relationships: {
      root_plan: summarizeRoutingPolicyBatchPlan(lineage.root_plan),
      predecessor: summarizeRoutingPolicyBatchPlan(lineage.predecessor),
      successor: summarizeRoutingPolicyBatchPlan(lineage.successor),
      preferred_active_plan: summarizeRoutingPolicyBatchPlan(lineage.preferred_active_plan),
      latest_successor: summarizeRoutingPolicyBatchPlan(lineage.latest_successor),
      latest_active_plan: summarizeRoutingPolicyBatchPlan(lineage.latest_active_plan),
      recommended_plan: summarizeRoutingPolicyBatchPlan(lineage.recommended_plan)
    },
    target_drilldown: lineage.target_drilldown,
    preview: anchorPlan.preview || {},
    lineage: lineage.plans
  };
}

function buildRoutingPolicyBatchPlanLineage(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const lineage = buildRoutingPolicyBatchPlanLineageModel(geoRoutingStore, input);
  return {
    policy: lineage.policy,
    summary: lineage.summary,
    anchor_plan: summarizeRoutingPolicyBatchPlan(lineage.anchor_plan),
    root_plan: summarizeRoutingPolicyBatchPlan(lineage.root_plan),
    preferred_active_plan: summarizeRoutingPolicyBatchPlan(lineage.preferred_active_plan),
    latest_successor: summarizeRoutingPolicyBatchPlan(lineage.latest_successor),
    latest_active_plan: summarizeRoutingPolicyBatchPlan(lineage.latest_active_plan),
    recommended_plan: summarizeRoutingPolicyBatchPlan(lineage.recommended_plan),
    target_drilldown: lineage.target_drilldown,
    plans: lineage.plans
  };
}

function upsertRoutingPolicyBatchPlan(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  if (!input.plan_id && !input.plan_name) {
    throw new Error('plan_name is required when creating a batch plan');
  }
  const preview = buildRoutingPolicyBatchPlanPreview(geoRoutingStore, triggerRunner, input);
  const existingPlan = input.plan_id ? geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(input.plan_id)) : null;
  const siblingPlans = geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: preview.policy.workspace_id,
    policy_id: preview.policy.policy_id,
    limit: input.preference_limit || 200
  });
  const previousPreferredPlan = preferredRoutingPolicyBatchPlan(siblingPlans);
  const hasOtherPreferred = siblingPlans.some((plan) => String(plan.id) !== String(existingPlan?.id || input.plan_id || '') && isRoutingPolicyBatchPlanPreferred(plan));
  const shouldPrefer = (input.status || existingPlan?.status || 'active') === 'active'
    && (
      input.preferred === true
      || (existingPlan ? isRoutingPolicyBatchPlanPreferred(existingPlan) : false)
      || (!hasOtherPreferred && input.preferred !== false)
    );
  const plan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
    tenant_id: String(input.tenant_id),
    workspace_id: preview.policy.workspace_id,
    policy_id: preview.policy.policy_id,
    plan_id: input.plan_id || null,
    plan_name: input.plan_name || preview.plan?.plan_name || '',
    status: input.status || preview.plan?.status || 'active',
    items: preview.saved_items,
    selection_summary: preview.summary,
    preview,
    notes: input.notes || preview.plan?.notes || '',
    metadata: {
      source: preview.source,
      freshness_stale: preview.freshness?.stale === true,
      plan_ready: preview.summary?.plan_ready === true,
      preferred: shouldPrefer,
      preferred_at: shouldPrefer ? new Date().toISOString() : null,
      preferred_by: shouldPrefer ? (input.actor_id || 'system') : null,
      preference_reason: shouldPrefer
        ? String(input.preference_reason || (existingPlan ? 'plan_upsert_preferred' : 'initial_active_plan'))
        : null,
      previous_preferred_plan_id: shouldPrefer && previousPreferredPlan ? previousPreferredPlan.id : null,
      preference_source_plan_id: input.preference_source_plan_id || null,
      actor_id: input.actor_id || 'system'
    },
    actor_id: input.actor_id || 'system'
  });
  if (shouldPrefer) {
    applyRoutingPolicyBatchPlanPreference(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: plan.workspace_id,
      policy_id: plan.policy_id,
      plan_id: plan.id,
      preferred: true,
      actor_id: input.actor_id || 'system',
      preference_reason: input.preference_reason || (existingPlan ? 'plan_upsert_preferred' : 'initial_active_plan'),
      demotion_reason: input.demotion_reason || (existingPlan ? 'plan_upsert_preferred' : 'initial_active_plan'),
      preference_source_plan_id: input.preference_source_plan_id || null
    });
  } else {
    ensureRoutingPolicyBatchPlanPreferredTarget(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: plan.workspace_id,
      policy_id: plan.policy_id,
      actor_id: input.actor_id || 'system',
      preference_reason: input.preference_reason || 'auto_fallback_latest_active',
      demotion_reason: input.demotion_reason || 'auto_fallback_latest_active'
    });
  }
  return {
    plan: geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(plan.id)) || plan,
    preview
  };
}

function refreshRoutingPolicyBatchPlan(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  if (!input.plan_id) {
    throw new Error('plan_id is required');
  }
  const existingPlan = geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(input.plan_id));
  if (!existingPlan) {
    throw new Error(`routing policy batch plan not found: ${String(input.plan_id)}`);
  }
  const currentPreview = buildRoutingPolicyBatchPlanPreview(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: existingPlan.workspace_id,
    policy_id: existingPlan.policy_id,
    plan_id: existingPlan.id,
    items: []
  });
  const refreshSelection = buildRoutingPolicyBatchPlanRefreshSelection(currentPreview, input);
  if (!Array.isArray(refreshSelection.items) || refreshSelection.items.length === 0) {
    throw new Error('refresh produced no selectable batch items');
  }

  const refreshMode = input.refresh_mode === 'replace' ? 'replace' : 'supersede';
  const actorId = String(input.actor_id || 'system');
  const refreshedAt = new Date().toISOString();
  const planName = String(input.plan_name || existingPlan.plan_name || '');
  const notes = String(input.notes || existingPlan.notes || '');
  const previewInput: JsonRecord = {
    tenant_id: String(input.tenant_id),
    workspace_id: String(existingPlan.workspace_id || 'default'),
    policy_id: String(existingPlan.policy_id || 'default'),
    items: refreshSelection.items
  };
  const refreshedPreview = buildRoutingPolicyBatchPlanPreview(geoRoutingStore, triggerRunner, previewInput);
  let archivedPlan: JsonRecord | null = null;
  let refreshedPlan: JsonRecord;

  if (refreshMode === 'replace') {
    refreshedPlan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: existingPlan.id,
      plan_name: planName,
      status: 'active',
      items: refreshSelection.items,
      selection_summary: refreshedPreview.summary,
      preview: refreshedPreview,
      notes,
      metadata: {
        ...(existingPlan.metadata || {}),
        refresh_mode: refreshMode,
        refreshed_at: refreshedAt,
        refreshed_by: actorId,
        adopt_strategy: refreshSelection.adopt_strategy,
        refreshed_from_plan_id: existingPlan.id,
        dropped_summary: refreshSelection.summary,
        dropped_items: refreshSelection.dropped_items
      },
      actor_id: actorId
    });
    refreshedPlan = applyRoutingPolicyBatchPlanPreference(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: refreshedPlan.id,
      preferred: true,
      actor_id: actorId,
      preference_reason: 'refresh_replace',
      demotion_reason: 'refresh_replace',
      preference_source_plan_id: existingPlan.id
    });
  } else {
    const newPlanId = String(input.new_plan_id || '');
    refreshedPlan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: newPlanId || null,
      plan_name: planName,
      status: 'active',
      items: refreshSelection.items,
      selection_summary: refreshedPreview.summary,
      preview: refreshedPreview,
      notes,
      metadata: {
        refreshed_from_plan_id: existingPlan.id,
        refresh_mode: refreshMode,
        refreshed_at: refreshedAt,
        refreshed_by: actorId,
        adopt_strategy: refreshSelection.adopt_strategy,
        dropped_summary: refreshSelection.summary,
        dropped_items: refreshSelection.dropped_items
      },
      actor_id: actorId
    });
    refreshedPlan = applyRoutingPolicyBatchPlanPreference(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: refreshedPlan.id,
      preferred: true,
      actor_id: actorId,
      preference_reason: 'refresh_supersede',
      demotion_reason: 'refresh_supersede',
      preference_source_plan_id: existingPlan.id
    });
    archivedPlan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: existingPlan.id,
      plan_name: String(existingPlan.plan_name || ''),
      status: 'archived',
      items: Array.isArray(existingPlan.items) ? existingPlan.items : [],
      selection_summary: existingPlan.selection_summary || {},
      preview: existingPlan.preview || {},
      notes: String(existingPlan.notes || ''),
      metadata: {
        ...(existingPlan.metadata || {}),
        archived_reason: String(input.archive_reason || 'Superseded by refreshed batch plan'),
        archived_at: refreshedAt,
        archived_by: actorId,
        superseded_by_plan_id: refreshedPlan.id,
        superseded_at: refreshedAt,
        superseded_by: actorId,
        preferred_before_archive: isRoutingPolicyBatchPlanPreferred(existingPlan),
        target_fallback_plan_id: refreshedPlan.id,
        preferred: false,
        preferred_by: null
      },
      actor_id: actorId
    });
  }

  const currentExecutionTarget = buildRoutingPolicyCurrentExecutionTarget(geoRoutingStore, {
    tenant_id: String(input.tenant_id),
    workspace_id: refreshedPlan.workspace_id,
    policy_id: refreshedPlan.policy_id,
    plan_target: 'recommended'
  });
  const summarizedById = new Map<string, JsonRecord | null>();
  for (const plan of geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: refreshedPlan.workspace_id,
    policy_id: refreshedPlan.policy_id,
    limit: input.limit || 200
  })) {
    summarizedById.set(String(plan.id), summarizeRoutingPolicyBatchPlan(plan));
  }
  return {
    refresh_mode: refreshMode,
    refresh_selection: refreshSelection,
    preview_before: currentPreview,
    archived_plan: archivedPlan,
    refreshed_plan: refreshedPlan,
    current_execution_target: currentExecutionTarget,
    report_summary: {
      current_execution_target: buildRoutingPolicyCurrentExecutionTargetReport(currentExecutionTarget),
      refreshed_plan: buildRoutingPolicyBatchPlanCompactReport(
        refreshedPlan,
        buildRoutingPolicyBatchPlanTargetState(refreshedPlan, {
          preferred_active_plan: currentExecutionTarget?.preferred_active_plan || null,
          latest_active_plan: currentExecutionTarget?.latest_active_plan || null,
          recommended_plan: currentExecutionTarget?.recommended_plan || null,
          current_target_plan: currentExecutionTarget?.target_plan || null,
          current_target: currentExecutionTarget?.summary?.target || null,
          current_resolution_reason: currentExecutionTarget?.summary?.resolution_reason || null,
          summarized_by_id: summarizedById
        })
      ),
      archived_plan: buildRoutingPolicyBatchPlanCompactReport(
        archivedPlan,
        archivedPlan ? buildRoutingPolicyBatchPlanTargetState(archivedPlan, {
          preferred_active_plan: currentExecutionTarget?.preferred_active_plan || null,
          latest_active_plan: currentExecutionTarget?.latest_active_plan || null,
          recommended_plan: currentExecutionTarget?.recommended_plan || null,
          current_target_plan: currentExecutionTarget?.target_plan || null,
          current_target: currentExecutionTarget?.summary?.target || null,
          current_resolution_reason: currentExecutionTarget?.summary?.resolution_reason || null,
          summarized_by_id: summarizedById
        }) : null
      )
    },
    preview_after: buildRoutingPolicyBatchPlanPreview(geoRoutingStore, triggerRunner, {
      tenant_id: String(input.tenant_id),
      workspace_id: refreshedPlan.workspace_id,
      policy_id: refreshedPlan.policy_id,
      plan_id: refreshedPlan.id,
      items: []
    })
  };
}

function governRoutingPolicyBatchPlan(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  if (!input.plan_id) {
    throw new Error('plan_id is required');
  }
  const action = String(input.action || input.operation || '');
  if (!['archive', 'restore', 'promote'].includes(action)) {
    throw new Error('action must be archive, restore, or promote');
  }
  const existingPlan = geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(input.plan_id));
  if (!existingPlan) {
    throw new Error(`routing policy batch plan not found: ${String(input.plan_id)}`);
  }
  const actorId = String(input.actor_id || 'system');
  const beforePlan = existingPlan;
  let changedPlan: JsonRecord = existingPlan;
  let autoPreferredPlan: JsonRecord | null = null;

  if (action === 'archive') {
    changedPlan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: existingPlan.id,
      plan_name: existingPlan.plan_name,
      status: 'archived',
      items: Array.isArray(existingPlan.items) ? existingPlan.items : [],
      selection_summary: existingPlan.selection_summary || {},
      preview: existingPlan.preview || {},
      notes: existingPlan.notes || '',
      metadata: {
        ...(existingPlan.metadata || {}),
        preferred: false,
        preferred_by: null,
        archived_reason: String(input.reason || input.archive_reason || 'Archived by governance action'),
        archived_at: new Date().toISOString(),
        archived_by: actorId,
        preferred_before_archive: isRoutingPolicyBatchPlanPreferred(existingPlan)
      },
      actor_id: actorId
    });
    autoPreferredPlan = ensureRoutingPolicyBatchPlanPreferredTarget(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      actor_id: actorId,
      preference_reason: 'archive_auto_fallback',
      demotion_reason: 'archive_auto_fallback'
    });
    if (autoPreferredPlan) {
      changedPlan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
        tenant_id: String(input.tenant_id),
        workspace_id: changedPlan.workspace_id,
        policy_id: changedPlan.policy_id,
        plan_id: changedPlan.id,
        plan_name: changedPlan.plan_name,
        status: changedPlan.status,
        items: Array.isArray(changedPlan.items) ? changedPlan.items : [],
        selection_summary: changedPlan.selection_summary || {},
        preview: changedPlan.preview || {},
        notes: changedPlan.notes || '',
        metadata: {
          ...(changedPlan.metadata || {}),
          target_fallback_plan_id: autoPreferredPlan.id
        },
        actor_id: actorId
      });
    }
  } else if (action === 'restore') {
    changedPlan = geoRoutingStore.upsertRoutingPolicyBatchPlan({
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: existingPlan.id,
      plan_name: existingPlan.plan_name,
      status: 'active',
      items: Array.isArray(existingPlan.items) ? existingPlan.items : [],
      selection_summary: existingPlan.selection_summary || {},
      preview: existingPlan.preview || {},
      notes: existingPlan.notes || '',
      metadata: {
        ...(existingPlan.metadata || {}),
        restored_at: new Date().toISOString(),
        restored_by: actorId
      },
      actor_id: actorId
    });
    if (input.make_preferred === true) {
      changedPlan = applyRoutingPolicyBatchPlanPreference(geoRoutingStore, {
        tenant_id: String(input.tenant_id),
        workspace_id: existingPlan.workspace_id,
        policy_id: existingPlan.policy_id,
        plan_id: changedPlan.id,
        preferred: true,
        actor_id: actorId,
        preference_reason: 'restore_make_preferred',
        demotion_reason: 'restore_make_preferred'
      });
    } else {
      autoPreferredPlan = ensureRoutingPolicyBatchPlanPreferredTarget(geoRoutingStore, {
        tenant_id: String(input.tenant_id),
        workspace_id: existingPlan.workspace_id,
        policy_id: existingPlan.policy_id,
        actor_id: actorId,
        preference_reason: 'auto_fallback_latest_active',
        demotion_reason: 'auto_fallback_latest_active'
      });
      changedPlan = geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(changedPlan.id)) || changedPlan;
    }
  } else if (action === 'promote') {
    if (existingPlan.status !== 'active') {
      throw new Error('only active batch plans can be promoted');
    }
    changedPlan = applyRoutingPolicyBatchPlanPreference(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: existingPlan.id,
      preferred: true,
      actor_id: actorId,
      preference_reason: 'manual_promote',
      demotion_reason: 'manual_promote'
    });
  }

  const currentExecutionTarget = buildRoutingPolicyCurrentExecutionTarget(geoRoutingStore, {
    tenant_id: String(input.tenant_id),
    workspace_id: existingPlan.workspace_id,
    policy_id: existingPlan.policy_id,
    plan_target: 'recommended'
  });
  const summarizedById = new Map<string, JsonRecord | null>();
  for (const plan of geoRoutingStore.listRoutingPolicyBatchPlans({
    tenant_id: String(input.tenant_id),
    workspace_id: existingPlan.workspace_id,
    policy_id: existingPlan.policy_id,
    limit: input.limit || 200
  })) {
    summarizedById.set(String(plan.id), summarizeRoutingPolicyBatchPlan(plan));
  }
  return {
    action,
    plan_before: summarizeRoutingPolicyBatchPlan(beforePlan),
    plan_after: summarizeRoutingPolicyBatchPlan(
      geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(changedPlan.id)) || changedPlan
    ),
    auto_preferred_plan: summarizeRoutingPolicyBatchPlan(autoPreferredPlan),
    current_execution_target: currentExecutionTarget,
    report_summary: {
      action,
      current_execution_target: buildRoutingPolicyCurrentExecutionTargetReport(currentExecutionTarget),
      plan_after: buildRoutingPolicyBatchPlanCompactReport(
        geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(changedPlan.id)) || changedPlan,
        buildRoutingPolicyBatchPlanTargetState(
          geoRoutingStore.getRoutingPolicyBatchPlan(String(input.tenant_id), String(changedPlan.id)) || changedPlan,
          {
            preferred_active_plan: currentExecutionTarget?.preferred_active_plan || null,
            latest_active_plan: currentExecutionTarget?.latest_active_plan || null,
            recommended_plan: currentExecutionTarget?.recommended_plan || null,
            current_target_plan: currentExecutionTarget?.target_plan || null,
            current_target: currentExecutionTarget?.summary?.target || null,
            current_resolution_reason: currentExecutionTarget?.summary?.resolution_reason || null,
            summarized_by_id: summarizedById
          }
        )
      ),
      auto_preferred_plan: buildRoutingPolicyBatchPlanCompactReport(
        autoPreferredPlan,
        autoPreferredPlan ? buildRoutingPolicyBatchPlanTargetState(autoPreferredPlan, {
          preferred_active_plan: currentExecutionTarget?.preferred_active_plan || null,
          latest_active_plan: currentExecutionTarget?.latest_active_plan || null,
          recommended_plan: currentExecutionTarget?.recommended_plan || null,
          current_target_plan: currentExecutionTarget?.target_plan || null,
          current_target: currentExecutionTarget?.summary?.target || null,
          current_resolution_reason: currentExecutionTarget?.summary?.resolution_reason || null,
          summarized_by_id: summarizedById
        }) : null
      )
    },
    lineage: buildRoutingPolicyBatchPlanLineage(geoRoutingStore, {
      tenant_id: String(input.tenant_id),
      workspace_id: existingPlan.workspace_id,
      policy_id: existingPlan.policy_id,
      plan_id: existingPlan.id
    })
  };
}

function buildRoutingPolicyReviewQueue(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const overview = buildRoutingPolicyOpsOverview(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    approval_limit: input.approval_limit || input.limit || 50,
    override_limit: input.override_limit || input.limit || 50,
    timeline_limit: input.timeline_limit || input.limit || 50,
    trigger_limit: input.trigger_limit || 500
  });
  const targetContext = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId
  });
  const reviewStates = geoRoutingStore.listRoutingPolicyReviewStates({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.review_state_limit || 200
  });
  const reviewStateByKey = new Map<string, JsonRecord>();
  for (const state of reviewStates) {
    reviewStateByKey.set(String(state.review_key), state);
  }
  const items: JsonRecord[] = [];
  const policy = overview.policy || {};
  const overviewQuery = `/api/geo/routing/policies/ops/overview?tenant_id=${encodeURIComponent(String(input.tenant_id || ''))}&workspace_id=${encodeURIComponent(String(workspaceId))}&policy_id=${encodeURIComponent(String(policyId))}`;

  for (const approval of Array.isArray(overview.pending_approvals) ? overview.pending_approvals : []) {
    const reviewKey = routingPolicyReviewKey('approval', approval.id);
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: reviewKey,
      item_type: 'pending_approval',
      severity: 'high',
      title: `${approval.action_type === 'geo.rollback_routing_policy_override' ? 'Rollback' : 'Override'} approval pending`,
      summary: approval.reason
        ? `${approval.reason} is waiting for approval before the policy can continue.`
        : 'A geo routing policy approval request is waiting for an operator decision.',
      occurred_at: approval.created_at,
      workspace_id: workspaceId,
      policy_id: approval.policy_id || policyId,
      source_type: 'approval_request',
      source_id: approval.id,
      context: {
        approval_request_id: approval.id,
        action_type: approval.action_type,
        requested_by: approval.requested_by,
        tool_call_id: approval.tool_call_id || null,
        source_override_id: approval.source_override?.id || null
      },
      suggested_actions: [
        {
          action_type: 'inspect_policy_overview',
          method: 'GET',
          endpoint: overviewQuery
        },
        {
          action_type: 'decide_approval',
          method: 'POST',
          endpoint: `/api/approvals/${approval.id}/decide`,
          payload_template: {
            tenant_id: input.tenant_id,
            decision: 'approved',
            actor_id: 'ops_manager'
          }
        },
        ...(approval.tool_call_id ? [{
          action_type: 'resume_tool_call',
          method: 'POST',
          endpoint: `/api/tool-calls/${approval.tool_call_id}/resume`,
          payload_template: {
            tenant_id: input.tenant_id,
            agent_id: 'ops_agent',
            user_id: 'ops_manager',
            step_id: 'geo-policy-review-resume'
          }
        }] : []),
        ...(approval.tool_call_id ? [buildRoutingPolicyWorkbenchAction(
          APPROVE_AND_RESUME_ACTION_ID,
          'approve_and_resume',
          'Approve and resume',
          { ...input, workspace_id: workspaceId, policy_id: approval.policy_id || policyId },
          reviewKey
        )] : [])
      ]
    });
  }

  for (const drift of Array.isArray(overview.trigger_drift?.missing_active_targets) ? overview.trigger_drift.missing_active_targets : []) {
    const territoryId = String(drift.territory_id || 'tenant');
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: routingPolicyReviewKey('drift', 'missing_active_target', territoryId),
      item_type: 'trigger_drift',
      severity: 'critical',
      title: `Missing active trigger for ${territoryId}`,
      summary: 'The policy preview expects an active routing trigger for this target, but no matching trigger is currently scheduled.',
      occurred_at: policy.last_rollout_at || policy.updated_at || '',
      workspace_id: workspaceId,
      policy_id: policyId,
      source_type: 'trigger_drift',
      source_id: territoryId,
      context: drift,
      suggested_actions: [
        {
          action_type: 'inspect_policy_overview',
          method: 'GET',
          endpoint: overviewQuery
        },
        {
          action_type: 'rollout_policy',
          method: 'POST',
          endpoint: '/api/geo/routing/policies/rollout',
          payload_template: {
            tenant_id: input.tenant_id,
            workspace_id: workspaceId,
            policy_id: policyId
          }
        },
        buildRoutingPolicyWorkbenchAction(
          ROLLOUT_POLICY_ACTION_ID,
          'rollout_policy',
          'Run guarded rollout',
          { ...input, workspace_id: workspaceId, policy_id: policyId },
          routingPolicyReviewKey('drift', 'missing_active_target', territoryId)
        )
      ]
    });
  }

  for (const drift of Array.isArray(overview.trigger_drift?.paused_expected_targets) ? overview.trigger_drift.paused_expected_targets : []) {
    const territoryId = String(drift.territory_id || 'tenant');
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: routingPolicyReviewKey('drift', 'paused_expected_target', territoryId),
      item_type: 'trigger_drift',
      severity: 'high',
      title: `Expected trigger is paused for ${territoryId}`,
      summary: 'The policy preview expects an active trigger, but only paused trigger state is present for this target.',
      occurred_at: policy.last_rollout_at || policy.updated_at || '',
      workspace_id: workspaceId,
      policy_id: policyId,
      source_type: 'trigger_drift',
      source_id: territoryId,
      context: drift,
      suggested_actions: [
        {
          action_type: 'inspect_policy_overview',
          method: 'GET',
          endpoint: overviewQuery
        },
        {
          action_type: 'rollout_policy',
          method: 'POST',
          endpoint: '/api/geo/routing/policies/rollout',
          payload_template: {
            tenant_id: input.tenant_id,
            workspace_id: workspaceId,
            policy_id: policyId
          }
        },
        buildRoutingPolicyWorkbenchAction(
          ROLLOUT_POLICY_ACTION_ID,
          'rollout_policy',
          'Run guarded rollout',
          { ...input, workspace_id: workspaceId, policy_id: policyId },
          routingPolicyReviewKey('drift', 'paused_expected_target', territoryId)
        )
      ]
    });
  }

  for (const drift of Array.isArray(overview.trigger_drift?.stale_configuration) ? overview.trigger_drift.stale_configuration : []) {
    const sourceId = String(drift.trigger_id || drift.territory_id || 'tenant');
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: routingPolicyReviewKey('drift', 'stale_configuration', sourceId),
      item_type: 'trigger_drift',
      severity: 'high',
      title: `Trigger configuration is stale for ${String(drift.territory_id || 'tenant')}`,
      summary: 'An active trigger exists, but its interval or dry-run settings no longer match the current policy.',
      occurred_at: policy.last_rollout_at || policy.updated_at || '',
      workspace_id: workspaceId,
      policy_id: policyId,
      source_type: 'trigger_drift',
      source_id: sourceId,
      context: drift,
      suggested_actions: [
        {
          action_type: 'inspect_policy_overview',
          method: 'GET',
          endpoint: overviewQuery
        },
        {
          action_type: 'rollout_policy',
          method: 'POST',
          endpoint: '/api/geo/routing/policies/rollout',
          payload_template: {
            tenant_id: input.tenant_id,
            workspace_id: workspaceId,
            policy_id: policyId
          }
        },
        buildRoutingPolicyWorkbenchAction(
          ROLLOUT_POLICY_ACTION_ID,
          'rollout_policy',
          'Run guarded rollout',
          { ...input, workspace_id: workspaceId, policy_id: policyId },
          routingPolicyReviewKey('drift', 'stale_configuration', sourceId)
        )
      ]
    });
  }

  for (const drift of Array.isArray(overview.trigger_drift?.unexpected_active_targets) ? overview.trigger_drift.unexpected_active_targets : []) {
    const sourceId = String(drift.trigger_id || drift.territory_id || 'tenant');
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: routingPolicyReviewKey('drift', 'unexpected_active_target', sourceId),
      item_type: 'trigger_drift',
      severity: 'medium',
      title: `Unexpected active trigger for ${String(drift.territory_id || 'tenant')}`,
      summary: 'An active trigger is running outside the current policy preview and should be reviewed before the next rollout.',
      occurred_at: policy.last_rollout_at || policy.updated_at || '',
      workspace_id: workspaceId,
      policy_id: policyId,
      source_type: 'trigger_drift',
      source_id: sourceId,
      context: drift,
      suggested_actions: [
        {
          action_type: 'inspect_policy_overview',
          method: 'GET',
          endpoint: overviewQuery
        },
        {
          action_type: 'review_trigger_drift',
          method: 'GET',
          endpoint: overviewQuery
        }
      ]
    });
  }

  for (const drift of Array.isArray(overview.trigger_drift?.duplicate_targets) ? overview.trigger_drift.duplicate_targets : []) {
    const territoryId = String(drift.territory_id || 'tenant');
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: routingPolicyReviewKey('drift', 'duplicate_target', territoryId),
      item_type: 'trigger_drift',
      severity: 'medium',
      title: `Duplicate trigger coverage for ${territoryId}`,
      summary: 'More than one scheduled trigger currently targets the same routing scope, which can create duplicate maintenance runs.',
      occurred_at: policy.last_rollout_at || policy.updated_at || '',
      workspace_id: workspaceId,
      policy_id: policyId,
      source_type: 'trigger_drift',
      source_id: territoryId,
      context: drift,
      suggested_actions: [
        {
          action_type: 'inspect_policy_overview',
          method: 'GET',
          endpoint: overviewQuery
        }
      ]
    });
  }

  for (const override of Array.isArray(overview.overrides_recent) ? overview.overrides_recent : []) {
    pushRoutingPolicyReviewItem(items, reviewStateByKey, input, {
      review_key: routingPolicyReviewKey('override', override.id),
      item_type: 'override_change',
      severity: override.override_kind === 'policy_rollback' ? 'info' : 'medium',
      title: override.override_kind === 'policy_rollback'
        ? 'Policy rollback recorded'
        : 'Policy override applied',
      summary: override.reason
        ? `${override.reason} changed policy behavior and should be reviewed against the latest rollout state.`
        : 'A routing policy change was recorded and should be reviewed against the latest rollout state.',
      occurred_at: override.created_at,
      workspace_id: workspaceId,
      policy_id: override.policy_id || policyId,
      source_type: 'routing_policy_override',
      source_id: override.id,
      context: {
        override_id: override.id,
        override_kind: override.override_kind,
        status: override.status,
        diff_summary: override.diff_summary,
        source_override_id: override.source_override_id || null
      },
      suggested_actions: [
        {
          action_type: 'inspect_override_ledger',
          method: 'GET',
          endpoint: `/api/geo/routing/policies/overrides?tenant_id=${encodeURIComponent(String(input.tenant_id || ''))}&workspace_id=${encodeURIComponent(String(workspaceId))}&policy_id=${encodeURIComponent(String(policyId))}`
        },
        ...(override.override_kind === 'policy_override' && override.status === 'applied' ? [{
          action_type: 'consider_rollback',
          method: 'POST',
          endpoint: `/api/geo/routing/policies/overrides/${override.id}/rollback`,
          payload_template: {
            tenant_id: input.tenant_id,
            workspace_id: workspaceId,
            policy_id: policyId,
            reason: 'Rollback from policy review queue'
          }
        }] : []),
        ...(override.override_kind === 'policy_override' && override.status === 'applied' ? [buildRoutingPolicyWorkbenchAction(
          LAUNCH_ROLLBACK_ACTION_ID,
          'launch_rollback',
          'Launch governed rollback',
          { ...input, workspace_id: workspaceId, policy_id: policyId, reason: 'Rollback from action workbench' },
          routingPolicyReviewKey('override', override.id),
          {
            reason: 'Rollback from action workbench'
          }
        )] : [])
      ]
    });
  }

  items.sort((left, right) => {
    const byStatus = reviewStatusRank(left.review_status) - reviewStatusRank(right.review_status);
    if (byStatus !== 0) return byStatus;
    const bySeverity = reviewSeverityRank(left.severity) - reviewSeverityRank(right.severity);
    if (bySeverity !== 0) return bySeverity;
    return String(right.occurred_at || '').localeCompare(String(left.occurred_at || ''));
  });

  const decoratedItems: JsonRecord[] = items.map((item) => ({
    ...item,
    operator_context: targetContext.report_summary
  }));
  const openItems = decoratedItems.filter((item) => item.review_status === 'open');
  const acknowledgedItems = items.filter((item) => item.review_status === 'acknowledged');

  return {
    policy: overview.policy,
    preview: overview.preview,
    trigger_drift: overview.trigger_drift,
    current_execution_target: targetContext.current_execution_target,
    target_governance_summary: targetContext.summary,
    recent_target_events: targetContext.recent_target_events,
    report_summary: targetContext.report_summary,
    summary: {
      total_items: items.length,
      open_items: openItems.length,
      acknowledged_items: acknowledgedItems.length,
      critical_items: items.filter((item) => item.severity === 'critical').length,
      high_items: items.filter((item) => item.severity === 'high').length,
      pending_approval_items: items.filter((item) => item.item_type === 'pending_approval').length,
      drift_items: items.filter((item) => item.item_type === 'trigger_drift').length,
      override_items: items.filter((item) => item.item_type === 'override_change').length,
      current_target_plan_id: targetContext.report_summary.current_execution_target?.target_plan_id || null,
      latest_target_event_type: targetContext.report_summary.latest_target_event?.event_type || null
    },
    attention_items: openItems.slice(0, Number(input.attention_limit || 10)),
    items: decoratedItems.slice(0, Number(input.limit || 50))
  };
}

function buildRoutingPolicyActionWorkbench(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const queue = buildRoutingPolicyReviewQueue(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.limit || 100,
    attention_limit: input.attention_limit || 20,
    approval_limit: input.approval_limit || 100,
    override_limit: input.override_limit || 100,
    target_event_limit: input.target_event_limit || input.history_limit || 50
  });
  const history = geoRoutingStore.listRoutingPolicyActionHistory({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.history_limit || 200
  });
  const reportSummary = queue.report_summary && typeof queue.report_summary === 'object'
    ? queue.report_summary as JsonRecord
    : {};
  const historyTargetContext = {
    current_execution_target: queue.current_execution_target || null,
    summary: queue.target_governance_summary || {},
    recent_target_events: Array.isArray(queue.recent_target_events) ? queue.recent_target_events : [],
    report_summary: reportSummary
  };
  const decoratedHistory = decorateRoutingPolicyActionHistoryEntries(history, historyTargetContext, Number(input.target_audit_event_limit || 5));
  const targetAuditSummary = buildRoutingPolicyActionHistoryTargetAuditSummary(decoratedHistory);
  const latestByActionKey = new Map<string, JsonRecord>();
  const historyByReviewKey = new Map<string, JsonRecord[]>();
  for (const entry of decoratedHistory) {
    const actionKey = `${String(entry.review_key)}::${String(entry.action_id)}`;
    if (!latestByActionKey.has(actionKey)) {
      latestByActionKey.set(actionKey, entry);
    }
    const reviewEntries = historyByReviewKey.get(String(entry.review_key)) || [];
    reviewEntries.push(entry);
    historyByReviewKey.set(String(entry.review_key), reviewEntries);
  }
  const items: JsonRecord[] = (Array.isArray(queue.items) ? queue.items : []).map((item: JsonRecord) => {
    const actions = (Array.isArray(item.suggested_actions) ? item.suggested_actions : []).map((action: JsonRecord) => {
      if (!action?.workbench_action) {
        return action;
      }
      return {
        ...applyRepeatGuardToWorkbenchAction(
          action,
          latestByActionKey.get(`${String(item.review_key)}::${String(action.action_id)}`) || null,
          input
        ),
        operator_context: reportSummary
      };
    });
    return {
      ...item,
      actions,
      action_history: (historyByReviewKey.get(String(item.review_key)) || []).slice(0, Number(input.item_history_limit || 5)),
      latest_action: summarizeRoutingPolicyActionHistoryEntry((historyByReviewKey.get(String(item.review_key)) || [])[0] || null),
      executable_actions: actions.filter((action: JsonRecord) => action?.workbench_action && action.executable)
    };
  });
  const workbenchItems: JsonRecord[] = items.filter((item) => Array.isArray(item.actions) && item.actions.some((action: JsonRecord) => action?.workbench_action));
  const actionableItems: JsonRecord[] = workbenchItems.filter((item) => Array.isArray(item.executable_actions) && item.executable_actions.length);
  const repeatGuardedActions = items.flatMap((item) => Array.isArray(item.actions) ? item.actions : []).filter((action: JsonRecord) => action?.repeat_guarded);
  const attentionItems = actionableItems
    .filter((item) => item.review_status === 'open')
    .slice(0, Number(input.attention_limit || 10));
  const attentionActions = attentionItems.flatMap((item) => (
    item.executable_actions.map((action: JsonRecord) => ({
      ...action,
      review_key: item.review_key,
      item_type: item.item_type,
      title: item.title,
      severity: item.severity,
      operator_context: reportSummary
    }))
  ));

  return {
    policy: queue.policy,
    preview: queue.preview,
    trigger_drift: queue.trigger_drift,
    current_execution_target: queue.current_execution_target || null,
    target_governance_summary: queue.target_governance_summary || {},
    recent_target_events: Array.isArray(queue.recent_target_events) ? queue.recent_target_events : [],
    report_summary: reportSummary,
    queue_summary: queue.summary,
    summary: {
      total_items: workbenchItems.length,
      history_entries: decoratedHistory.length,
      actionable_items: actionableItems.length,
      open_actionable_items: actionableItems.filter((item) => item.review_status === 'open').length,
      executable_action_count: attentionActions.length,
      repeat_guarded_actions: repeatGuardedActions.length,
      approve_and_resume_actions: actionableItems.filter((item) => item.executable_actions.some((action: JsonRecord) => action.action_id === APPROVE_AND_RESUME_ACTION_ID)).length,
      rollout_actions: actionableItems.filter((item) => item.executable_actions.some((action: JsonRecord) => action.action_id === ROLLOUT_POLICY_ACTION_ID)).length,
      rollback_actions: actionableItems.filter((item) => item.executable_actions.some((action: JsonRecord) => action.action_id === LAUNCH_ROLLBACK_ACTION_ID)).length,
      current_target_plan_id: reportSummary.current_execution_target?.target_plan_id || null,
      latest_target_event_type: reportSummary.latest_target_event?.event_type || null,
      history_entries_with_target_change_since_execution: targetAuditSummary.entries_with_target_change_since_execution,
      history_entries_with_target_plan_drift: targetAuditSummary.entries_with_target_plan_drift
    },
    target_audit_summary: targetAuditSummary,
    target_drift_history: decoratedHistory
      .filter((entry) => entry.historical_current_target_diff?.target_plan_changed === true)
      .slice(0, Number(input.history_preview_limit || 20)),
    recent_history: decoratedHistory.slice(0, Number(input.history_preview_limit || 20)),
    attention_actions: attentionActions,
    attention_items: attentionItems,
    items: workbenchItems.slice(0, Number(input.limit || 50))
  };
}

async function executeRoutingPolicyReviewAction(
  geoRoutingStore: GeoRoutingStoreLike,
  nestedToolExecutor: NestedToolExecutorLike,
  triggerRunner: TriggerRunnerLike,
  approvalQueue: ApprovalQueueLike,
  input: JsonRecord,
  context: JsonRecord,
): Promise<JsonRecord> {
  if (!input.review_key) {
    throw new Error('review_key is required');
  }
  if (!input.action_id) {
    throw new Error('action_id is required');
  }
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const actorId = input.actor_id || context.userId || 'system';
  const targetContextBefore = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId
  });
  const workbench = buildRoutingPolicyActionWorkbench(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.lookup_limit || 500,
    attention_limit: input.lookup_limit || 500,
    approval_limit: input.approval_limit || 200,
    override_limit: input.override_limit || 200,
    trigger_limit: input.trigger_limit || 500
  });
  const item = (Array.isArray(workbench.items) ? workbench.items : []).find(
    (candidate: JsonRecord) => candidate.review_key === input.review_key
  );
  if (!item) {
    throw new Error(`routing policy action item not found: ${String(input.review_key)}`);
  }
  const action = listRoutingPolicyWorkbenchActions(item).find(
    (candidate: JsonRecord) => candidate.action_id === input.action_id
  );
  if (!action) {
    throw new Error(`routing policy action not found: ${String(input.action_id)}`);
  }
  if (action.executable === false && input.force_repeat !== true) {
    throw new Error(`routing policy action is repeat-guarded: ${String(input.action_id)}`);
  }

  const nestedActionContext = nestedContext(
    {
      ...context,
      userId: actorId,
      workspaceId
    },
    'ops_agent',
    `review_action:${String(input.action_id)}`
  );

  let actionResult: JsonRecord | null = null;
  if (input.action_id === APPROVE_AND_RESUME_ACTION_ID) {
    const approvalRequestId = String(item.context?.approval_request_id || '');
    const toolCallId = String(item.context?.tool_call_id || '');
    if (!approvalRequestId || !toolCallId) {
      throw new Error('pending approval action requires approval_request_id and tool_call_id');
    }
    const approval = approvalQueue.decide(String(input.tenant_id), approvalRequestId, 'approved', String(actorId));
    if (!approval || approval.status !== 'approved') {
      throw new Error(`unable to approve routing policy action: ${approvalRequestId}`);
    }
    const resumed = await nestedToolExecutor.resumeApproved(nestedActionContext, toolCallId);
    actionResult = {
      approval_request: approval,
      resumed
    };
  } else if (input.action_id === ROLLOUT_POLICY_ACTION_ID) {
    actionResult = {
      rollout: await nestedToolExecutor.execute(nestedActionContext, 'geo.rollout_routing_policy', {
        tenant_id: String(input.tenant_id),
        workspace_id: workspaceId,
        policy_id: item.policy_id || policyId,
        next_run_at: input.next_run_at || null
      })
    };
  } else if (input.action_id === LAUNCH_ROLLBACK_ACTION_ID) {
    const overrideId = String(item.context?.override_id || item.source_id || '');
    if (!overrideId) {
      throw new Error('rollback action requires override_id');
    }
    actionResult = {
      rollback: await nestedToolExecutor.execute(nestedActionContext, 'geo.rollback_routing_policy_override', {
        tenant_id: String(input.tenant_id),
        workspace_id: workspaceId,
        policy_id: item.policy_id || policyId,
        override_id: overrideId,
        reason: input.reason || 'Rollback from action workbench'
      })
    };
  } else {
    throw new Error(`unsupported routing policy action: ${String(input.action_id)}`);
  }

  const targetContextAfter = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId
  });
  const targetSnapshotBefore = buildRoutingPolicyOperatorTargetSnapshot(targetContextBefore);
  const targetSnapshotAfter = buildRoutingPolicyOperatorTargetSnapshot(targetContextAfter);
  const targetTransition = buildRoutingPolicyOperatorTargetTransition(targetContextBefore, targetContextAfter);

  const actionHistory = geoRoutingStore.recordRoutingPolicyActionHistory({
    tenant_id: String(input.tenant_id),
    workspace_id: workspaceId,
    policy_id: item.policy_id || policyId,
    review_key: item.review_key,
    action_id: action.action_id,
    action_type: action.action_type,
    item_type: item.item_type,
    source_type: item.source_type,
    source_id: item.source_id,
    status: deriveRoutingPolicyActionStatus(String(input.action_id), actionResult),
    executed_by: actorId,
    note: input.note || '',
    result: actionResult,
    item_snapshot: {
      review_status: item.review_status,
      title: item.title,
      severity: item.severity,
      summary: item.summary,
      context: item.context || {},
      operator_context: item.operator_context || {}
    },
    metadata: {
      action_label: action.label,
      force_repeat: Boolean(input.force_repeat),
      target_snapshot_before: targetSnapshotBefore,
      target_snapshot_after: targetSnapshotAfter,
      target_transition: targetTransition
    }
  });

  const nextWorkbench = buildRoutingPolicyActionWorkbench(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.limit || 50,
    attention_limit: input.attention_limit || 10,
    approval_limit: input.approval_limit || 50,
    override_limit: input.override_limit || 50,
    trigger_limit: input.trigger_limit || 500
  });
  const decoratedActionHistory = decorateRoutingPolicyActionHistoryEntries([actionHistory], targetContextAfter)[0] || actionHistory;

  return {
    action,
    item_before: item,
    action_history: decoratedActionHistory,
    result: actionResult,
    target_snapshot_before: targetSnapshotBefore,
    target_snapshot_after: targetSnapshotAfter,
    target_transition: targetTransition,
    report_summary: {
      target_snapshot_before: targetSnapshotBefore,
      target_snapshot_after: targetSnapshotAfter,
      target_transition: targetTransition
    },
    item_after: (Array.isArray(nextWorkbench.items) ? nextWorkbench.items : []).find(
      (candidate: JsonRecord) => candidate.review_key === input.review_key
    ) || null,
    workbench: nextWorkbench
  };
}

async function executeRoutingPolicyReviewBatch(
  geoRoutingStore: GeoRoutingStoreLike,
  nestedToolExecutor: NestedToolExecutorLike,
  triggerRunner: TriggerRunnerLike,
  approvalQueue: ApprovalQueueLike,
  input: JsonRecord,
  context: JsonRecord,
): Promise<JsonRecord> {
  const batchSource = resolveRoutingPolicyBatchPlanSource(geoRoutingStore, input);
  const items = Array.isArray(batchSource.items) ? batchSource.items as JsonRecord[] : [];
  const workspaceId = batchSource.workspace_id || input.workspace_id || 'default';
  const policyId = batchSource.policy_id || input.policy_id || 'default';
  const targetContextBefore = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId
  });
  const planPreview = batchSource.plan
    ? buildRoutingPolicyBatchPlanPreview(geoRoutingStore, triggerRunner, {
        ...input,
        plan_id: batchSource.plan.id,
        items: []
      })
    : null;
  if (batchSource.plan?.status === 'archived') {
    throw new Error(`routing policy batch plan is archived: ${String(batchSource.plan.id)}`);
  }
  if (!items.length) {
    throw new Error('items must contain at least one batch action');
  }
  if (planPreview?.freshness?.requires_confirmation === true && input.confirm_stale_plan !== true) {
    throw new Error(
      `routing policy batch plan is stale: ${String(batchSource.plan?.id || input.plan_id)}; preview it again and retry with confirm_stale_plan=true`
    );
  }
  if (items.length > Number(input.max_items || 20)) {
    throw new Error(`batch action limit exceeded: ${items.length}`);
  }
  const uniqueKeys = new Set<string>();
  for (const item of items) {
    const reviewKey = String(item?.review_key || '');
    const actionId = String(item?.action_id || '');
    if (!reviewKey || !actionId) {
      throw new Error('each batch item requires review_key and action_id');
    }
    const uniqueKey = `${reviewKey}::${actionId}`;
    if (uniqueKeys.has(uniqueKey)) {
      throw new Error(`duplicate batch action item: ${uniqueKey}`);
    }
    uniqueKeys.add(uniqueKey);
  }

  const continueOnError = input.continue_on_error === true;
  const results: JsonRecord[] = [];
  let stoppedAfterFailure = false;
  let stopReason = '';

  for (const item of items) {
    const itemInput: JsonRecord = {
      ...input,
      ...(item && typeof item === 'object' ? item : {}),
      tenant_id: input.tenant_id,
      workspace_id: item?.workspace_id || input.workspace_id || 'default',
      policy_id: item?.policy_id || input.policy_id || 'default',
      actor_id: item?.actor_id || input.actor_id || context.userId || 'system',
      note: item?.note || input.note || '',
      reason: item?.reason || input.reason || '',
      force_repeat: item?.force_repeat === true || input.force_repeat === true,
      next_run_at: item?.next_run_at || input.next_run_at || null
    };
    try {
      const executed = await executeRoutingPolicyReviewAction(
        geoRoutingStore,
        nestedToolExecutor,
        triggerRunner,
        approvalQueue,
        itemInput,
        context
      );
      results.push({
        review_key: itemInput.review_key,
        action_id: itemInput.action_id,
        status: executed.action_history?.status || 'succeeded',
        output: executed
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        review_key: itemInput.review_key,
        action_id: itemInput.action_id,
        status: 'failed',
        error: {
          message,
          name: error instanceof Error ? error.name : 'Error'
        }
      });
      if (!continueOnError) {
        stoppedAfterFailure = true;
        stopReason = message;
        break;
      }
    }
  }

  const workbench = buildRoutingPolicyActionWorkbench(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.limit || 50,
    attention_limit: input.attention_limit || 10,
    approval_limit: input.approval_limit || 50,
    override_limit: input.override_limit || 50,
    trigger_limit: input.trigger_limit || 500
  });
  const history = buildRoutingPolicyActionHistory(geoRoutingStore, {
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policyId,
    limit: input.history_limit || 100
  });
  const targetContextAfter = buildRoutingPolicyOperatorTargetContext(geoRoutingStore, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId
  });
  const targetSnapshotBefore = buildRoutingPolicyOperatorTargetSnapshot(targetContextBefore);
  const targetSnapshotAfter = buildRoutingPolicyOperatorTargetSnapshot(targetContextAfter);
  const targetTransition = buildRoutingPolicyOperatorTargetTransition(targetContextBefore, targetContextAfter);
  const sourceAlignment = buildRoutingPolicySourceTargetAlignment(batchSource, targetContextBefore);

  return {
    plan: batchSource.plan ? {
      id: batchSource.plan.id,
      plan_name: batchSource.plan.plan_name,
      status: batchSource.plan.status,
      updated_at: batchSource.plan.updated_at
    } : null,
    target_resolution: batchSource.target_resolution ? {
      target: batchSource.target_resolution.target,
      resolution_reason: batchSource.target_resolution.resolution_reason,
      target_plan: summarizeRoutingPolicyBatchPlan(batchSource.target_resolution.target_plan),
      preferred_active_plan: summarizeRoutingPolicyBatchPlan(batchSource.target_resolution.preferred_active_plan),
      latest_active_plan: summarizeRoutingPolicyBatchPlan(batchSource.target_resolution.latest_active_plan),
      recommended_plan: summarizeRoutingPolicyBatchPlan(batchSource.target_resolution.recommended_plan)
    } : null,
    plan_preflight: planPreview ? {
      stale: planPreview.freshness?.stale === true,
      requires_confirmation: planPreview.freshness?.requires_confirmation === true,
        blocking_changes: Number(planPreview.freshness?.blocking_changes || 0),
        non_blocking_changes: Number(planPreview.freshness?.non_blocking_changes || 0)
      } : null,
    target_snapshot_before: targetSnapshotBefore,
    target_snapshot_after: targetSnapshotAfter,
    target_transition: targetTransition,
    summary: {
      requested_items: items.length,
      processed_items: results.length,
      succeeded_items: results.filter((entry) => entry.status === 'succeeded').length,
      blocked_items: results.filter((entry) => entry.status === 'blocked_pending_approval').length,
      failed_items: results.filter((entry) => entry.status === 'failed').length,
      stopped_after_failure: stoppedAfterFailure,
      skipped_items: items.length - results.length,
      continue_on_error: continueOnError,
      stop_reason: stopReason || null,
      current_target_plan_id_before: targetSnapshotBefore.current_execution_target?.target_plan_id || null,
      current_target_plan_id_after: targetSnapshotAfter.current_execution_target?.target_plan_id || null,
      target_changed: targetTransition.changed === true
    },
    report_summary: {
      target_snapshot_before: targetSnapshotBefore,
      target_snapshot_after: targetSnapshotAfter,
      target_transition: targetTransition,
      source_alignment: sourceAlignment
    },
    results,
    workbench,
    action_history: history
  };
}

function acknowledgeRoutingPolicyReviewItem(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  if (!input.review_key) {
    throw new Error('review_key is required');
  }
  const workspaceId = input.workspace_id || 'default';
  const policyId = input.policy_id || 'default';
  const queue = buildRoutingPolicyReviewQueue(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    review_status: null,
    item_type: null,
    limit: input.lookup_limit || 500,
    attention_limit: input.lookup_limit || 500,
    approval_limit: input.approval_limit || 200,
    override_limit: input.override_limit || 200,
    trigger_limit: input.trigger_limit || 500
  });
  const item = (Array.isArray(queue.items) ? queue.items : []).find(
    (candidate: JsonRecord) => candidate.review_key === input.review_key
  );
  if (!item) {
    throw new Error(`routing policy review item not found: ${String(input.review_key)}`);
  }
  const targetContextBefore = {
    current_execution_target: queue.current_execution_target || null,
    summary: queue.target_governance_summary || {},
    recent_target_events: Array.isArray(queue.recent_target_events) ? queue.recent_target_events : [],
    report_summary: queue.report_summary || {}
  };
  const reviewState = geoRoutingStore.upsertRoutingPolicyReviewState({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: item.policy_id || policyId,
    review_key: item.review_key,
    item_type: item.item_type,
    item_status: input.item_status || 'acknowledged',
    source_type: item.source_type,
    source_id: item.source_id,
    note: input.note || '',
    metadata: {
      item_context: item.context || {},
      suggested_actions: item.suggested_actions || [],
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})
    },
    actor_id: input.actor_id || 'system'
  });
  const updatedQueue = buildRoutingPolicyReviewQueue(geoRoutingStore, triggerRunner, {
    ...input,
    workspace_id: workspaceId,
    policy_id: policyId,
    review_status: null,
    item_type: null,
    limit: input.limit || 50,
    attention_limit: input.attention_limit || 10,
    approval_limit: input.approval_limit || 50,
    override_limit: input.override_limit || 50,
    trigger_limit: input.trigger_limit || 500
  });
  const updatedItem = (Array.isArray(updatedQueue.items) ? updatedQueue.items : []).find(
    (candidate: JsonRecord) => candidate.review_key === input.review_key
  ) || {
    ...item,
    review_status: reviewState.item_status,
    review_note: reviewState.note,
    review_state: reviewState
  };
  const targetContextAfter = {
    current_execution_target: updatedQueue.current_execution_target || null,
    summary: updatedQueue.target_governance_summary || {},
    recent_target_events: Array.isArray(updatedQueue.recent_target_events) ? updatedQueue.recent_target_events : [],
    report_summary: updatedQueue.report_summary || {}
  };
  const targetSnapshotBefore = buildRoutingPolicyOperatorTargetSnapshot(targetContextBefore);
  const targetSnapshotAfter = buildRoutingPolicyOperatorTargetSnapshot(targetContextAfter);
  const targetTransition = buildRoutingPolicyOperatorTargetTransition(targetContextBefore, targetContextAfter);
  const decisionDiff = buildRoutingPolicyReviewDecisionDiff(item, updatedItem, targetContextBefore, targetContextAfter);
  return {
    item: updatedItem,
    review_state: reviewState,
    summary: updatedQueue.summary,
    target_snapshot_before: targetSnapshotBefore,
    target_snapshot_after: targetSnapshotAfter,
    target_transition: targetTransition,
    decision_diff: decisionDiff,
    report_summary: {
      target_snapshot_before: targetSnapshotBefore,
      target_snapshot_after: targetSnapshotAfter,
      target_transition: targetTransition,
      decision_diff: decisionDiff
    }
  };
}

function buildRoutingPolicyOverrideDiff(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const currentPolicy = geoRoutingStore.getRoutingPolicy(input.tenant_id, workspaceId, input.policy_id || 'default');
  const patch = extractRoutingPolicyPatch(input);
  const proposedPolicy = mergeRoutingPolicy(currentPolicy, patch);
  const beforePreview = buildRoutingPolicyPlanForPolicy(geoRoutingStore, input, currentPolicy);
  const afterPreview = buildRoutingPolicyPlanForPolicy(geoRoutingStore, input, proposedPolicy);
  return {
    current_policy: currentPolicy,
    proposed_policy: proposedPolicy,
    requested_patch: patch,
    before_preview: beforePreview,
    after_preview: afterPreview,
    diff_summary: buildRoutingPolicyDiffSummary(currentPolicy, proposedPolicy, beforePreview, afterPreview)
  };
}

function buildRoutingPolicyPlan(
  geoRoutingStore: GeoRoutingStoreLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policy = geoRoutingStore.getRoutingPolicy(input.tenant_id, workspaceId, input.policy_id || 'default');
  return buildRoutingPolicyPlanForPolicy(geoRoutingStore, { ...input, workspace_id: workspaceId }, policy);
}

function listRoutingTriggers(triggerRunner: TriggerRunnerLike, input: JsonRecord): JsonRecord[] {
  const triggers = triggerRunner.listScheduledTriggers({
    tenant_id: input.tenant_id,
    status: input.status,
    playbook_id: 'ops_agent.geo_routing_maintenance.v1',
    limit: input.limit || 200
  });
  return triggers.filter((trigger) => {
    const triggerPolicyId = trigger.input?.policy_id || 'default';
    if (input.policy_id && triggerPolicyId !== input.policy_id) {
      return false;
    }
    if (input.scope === 'tenant') {
      return !trigger.input?.territory_id;
    }
    if (input.scope === 'territory') {
      if (!trigger.input?.territory_id) {
        return false;
      }
      if (input.territory_id) {
        return trigger.input?.territory_id === input.territory_id;
      }
      return true;
    }
    if (input.territory_id) {
      return trigger.input?.territory_id === input.territory_id;
    }
    return true;
  });
}

function buildRoutingTriggerShape(target: JsonRecord, input: JsonRecord): JsonRecord {
  return {
    name: target.scope === 'territory'
      ? `Geo routing maintenance / ${target.name}`
      : (input.trigger_name || 'Geo routing maintenance'),
    goal: target.scope === 'territory'
      ? `Maintain geo routing for ${target.name}`
      : 'Maintain geo routing for all active territories',
    input: {
      workspace_id: input.workspace_id || 'default',
      territory_id: target.territory_id || undefined,
      dry_run: Boolean(input.dry_run),
      policy_id: input.policy_id || undefined
    }
  };
}

function reconcileRoutingTriggers(
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const scope = input.scope || 'tenant';
  const intervalSeconds = Number(input.interval_seconds || 3600);
  const nextRunAt = input.next_run_at || new Date().toISOString();
  const desiredTargets = Array.isArray(input.targets) ? input.targets : [];
  const existing = listRoutingTriggers(triggerRunner, {
    tenant_id: input.tenant_id,
    territory_id: input.territory_id,
    scope,
    limit: 500
  });
  const created = [];
  const updated = [];
  const paused = [];

  for (const target of desiredTargets) {
    const match = existing.find((trigger) => (trigger.input?.territory_id || null) === (target.territory_id || null));
    const triggerShape = buildRoutingTriggerShape(target, input);
    if (match) {
      const refreshed = triggerRunner.updateScheduledTrigger(input.tenant_id, String(match.id), {
        status: 'active',
        name: triggerShape.name,
        goal: triggerShape.goal,
        interval_seconds: intervalSeconds,
        next_run_at: nextRunAt,
        input: {
          ...match.input,
          ...triggerShape.input
        }
      });
      if (refreshed) {
        updated.push(refreshed);
      }
      continue;
    }
    const trigger = triggerRunner.createScheduledTrigger({
      tenant_id: input.tenant_id,
      name: triggerShape.name,
      playbook_id: 'ops_agent.geo_routing_maintenance.v1',
      goal: triggerShape.goal,
      interval_seconds: intervalSeconds,
      next_run_at: nextRunAt,
      created_by: input.created_by || 'system',
      input: triggerShape.input
    });
    if (trigger) {
      created.push(trigger);
    }
  }

  if (input.reconcile_unmatched) {
    for (const trigger of existing) {
      const territoryId = trigger.input?.territory_id || null;
      const stillDesired = desiredTargets.some((target) => (target.territory_id || null) === territoryId);
      if (stillDesired) {
        continue;
      }
      const managedByPolicy = input.policy_id
        ? (trigger.input?.policy_id === input.policy_id || !trigger.input?.policy_id)
        : true;
      if (!managedByPolicy) {
        continue;
      }
      const suspended = triggerRunner.updateScheduledTrigger(input.tenant_id, String(trigger.id), {
        status: input.unmatched_status || 'paused',
        input: {
          ...trigger.input,
          policy_id: input.policy_id || trigger.input?.policy_id,
          guardrail_reason: input.unmatched_reason || 'not_selected_by_policy_rollout'
        }
      });
      if (suspended) {
        paused.push(suspended);
      }
    }
  }

  return {
    scope,
    interval_seconds: intervalSeconds,
    next_run_at: nextRunAt,
    created_count: created.length,
    updated_count: updated.length,
    paused_count: paused.length,
    existing_count: existing.length,
    created,
    updated,
    paused
  };
}

function bootstrapRoutingTriggers(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const scope = input.scope || 'tenant';
  const desiredTargets = Array.isArray(input.targets)
    ? input.targets
    : (scope === 'territory'
    ? ((geoRoutingStore.listTerritories({
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        status: input.territory_status || 'active',
        limit: input.limit || 200
      }) as JsonRecord[]).filter((territory: JsonRecord) => !input.territory_id || territory.territory_id === input.territory_id)
        .map((territory: JsonRecord) => ({
          scope: 'territory',
          territory_id: territory.territory_id,
          name: territory.name
      })))
    : [{
        scope: 'tenant',
        territory_id: null,
        name: input.trigger_name || 'Geo routing maintenance'
      }]);
  return reconcileRoutingTriggers(triggerRunner, {
    ...input,
    scope,
    targets: desiredTargets,
    reconcile_unmatched: Boolean(input.reconcile_unmatched)
  });
}

function rolloutRoutingPolicy(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const policy = geoRoutingStore.getRoutingPolicy(input.tenant_id, workspaceId, input.policy_id || 'default');
  const preview = buildRoutingPolicyPlan(geoRoutingStore, input);
  let skipped = false;
  let reason = '';

  if (policy.status !== 'active') {
    skipped = true;
    reason = `policy is ${policy.status}`;
  } else if (!policy.auto_bootstrap) {
    skipped = true;
    reason = 'policy auto_bootstrap is disabled';
  } else if (preview.paused) {
    skipped = true;
    reason = preview.pause_reason || 'policy is paused';
  }

  const bootstrap = skipped
    ? reconcileRoutingTriggers(triggerRunner, {
        tenant_id: input.tenant_id,
        workspace_id: workspaceId,
        territory_id: input.territory_id,
        scope: preview.scope,
        interval_seconds: policy.interval_seconds,
        next_run_at: input.next_run_at,
        dry_run: policy.dry_run,
        policy_id: policy.policy_id,
        created_by: input.actor_id || input.created_by || 'system',
        targets: [],
        reconcile_unmatched: true,
        unmatched_status: 'paused',
        unmatched_reason: reason
      })
    : bootstrapRoutingTriggers(geoRoutingStore, triggerRunner, {
        tenant_id: input.tenant_id,
        workspace_id: workspaceId,
        territory_id: input.territory_id,
        scope: preview.scope,
        interval_seconds: policy.interval_seconds,
        next_run_at: input.next_run_at,
        dry_run: policy.dry_run,
        territory_status: policy.territory_status,
        limit: input.limit,
        created_by: input.actor_id || input.created_by || 'system',
        policy_id: policy.policy_id,
        targets: preview.eligible_targets,
        reconcile_unmatched: true,
        unmatched_status: 'paused',
        unmatched_reason: 'not_selected_by_policy_rollout'
      });
  const snapshot = {
    status: skipped ? 'skipped' : 'applied',
    reason: skipped ? reason : '',
    evaluated_at: preview.evaluated_at,
    scope: preview.scope,
    paused: preview.paused,
    guardrails: preview.guardrails,
    totals: preview.totals,
    eligible_targets: preview.eligible_targets,
    skipped_targets: preview.skipped_targets,
    trigger_changes: {
      created_count: bootstrap.created_count,
      updated_count: bootstrap.updated_count,
      paused_count: bootstrap.paused_count
    }
  };
  const updatedPolicy = geoRoutingStore.recordRoutingPolicyRolloutSnapshot({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: policy.policy_id,
    actor_id: input.actor_id || input.created_by || 'system',
    last_rollout_at: preview.evaluated_at,
    last_rollout_snapshot: snapshot
  });
  return {
    policy: updatedPolicy,
    preview,
    bootstrap,
    skipped,
    reason
  };
}

function applyRoutingPolicyOverride(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const actorId = input.actor_id || input.created_by || 'system';
  if (!input.reason) {
    throw new Error('reason is required for routing policy override');
  }
  const diff = buildRoutingPolicyOverrideDiff(geoRoutingStore, input);
  if (!diff.diff_summary.changed_fields?.length) {
    throw new Error('routing policy override produced no policy change');
  }
  const proposedPolicy = diff.proposed_policy;
  const updatedPolicy = geoRoutingStore.upsertRoutingPolicy({
    ...proposedPolicy,
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: proposedPolicy.policy_id || input.policy_id || 'default',
    actor_id: actorId
  });
  const rollout = rolloutRoutingPolicy(geoRoutingStore, triggerRunner, {
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: updatedPolicy.policy_id,
    next_run_at: input.next_run_at,
    territory_id: input.territory_id,
    actor_id: actorId,
    limit: input.limit
  });
  const override = geoRoutingStore.recordRoutingPolicyOverride({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: updatedPolicy.policy_id,
    override_kind: 'policy_override',
    status: 'applied',
    reason: input.reason,
    requested_patch: diff.requested_patch,
    before_policy: diff.current_policy,
    after_policy: rollout.policy,
    before_preview: diff.before_preview,
    after_preview: rollout.preview,
    diff_summary: diff.diff_summary,
    rollout_result: rollout,
    actor_id: actorId
  });
  return {
    policy: rollout.policy,
    override,
    diff,
    rollout
  };
}

function rollbackRoutingPolicyOverride(
  geoRoutingStore: GeoRoutingStoreLike,
  triggerRunner: TriggerRunnerLike,
  input: JsonRecord,
): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const actorId = input.actor_id || input.created_by || 'system';
  if (!input.reason) {
    throw new Error('reason is required for routing policy rollback');
  }
  const sourceOverride = input.override_id
    ? geoRoutingStore.getRoutingPolicyOverride(String(input.tenant_id), String(input.override_id))
    : geoRoutingStore.listRoutingPolicyOverrides({
        tenant_id: input.tenant_id,
        workspace_id: workspaceId,
        policy_id: input.policy_id || 'default',
        status: 'applied',
        limit: 1
      })[0];
  if (!sourceOverride) {
    throw new Error('routing policy override not found for rollback');
  }
  const targetPolicy = sourceOverride.before_policy;
  if (!targetPolicy || typeof targetPolicy !== 'object') {
    throw new Error('source override is missing a rollback policy snapshot');
  }
  const currentPolicy = geoRoutingStore.getRoutingPolicy(input.tenant_id, workspaceId, sourceOverride.policy_id || input.policy_id || 'default');
  const beforePreview = buildRoutingPolicyPlanForPolicy(geoRoutingStore, input, currentPolicy);
  const restoredPolicy = mergeRoutingPolicy(currentPolicy, targetPolicy);
  const afterPreview = buildRoutingPolicyPlanForPolicy(geoRoutingStore, input, restoredPolicy);
  const diffSummary = buildRoutingPolicyDiffSummary(currentPolicy, restoredPolicy, beforePreview, afterPreview);
  if (!diffSummary.changed_fields?.length) {
    throw new Error('routing policy rollback produced no policy change');
  }
  const updatedPolicy = geoRoutingStore.upsertRoutingPolicy({
    ...restoredPolicy,
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: restoredPolicy.policy_id || sourceOverride.policy_id || 'default',
    actor_id: actorId
  });
  const rollout = rolloutRoutingPolicy(geoRoutingStore, triggerRunner, {
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: updatedPolicy.policy_id,
    next_run_at: input.next_run_at,
    territory_id: input.territory_id,
    actor_id: actorId,
    limit: input.limit
  });
  geoRoutingStore.updateRoutingPolicyOverrideStatus(String(input.tenant_id), String(sourceOverride.id), 'rolled_back', actorId);
  const rollbackOverride = geoRoutingStore.recordRoutingPolicyOverride({
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    policy_id: updatedPolicy.policy_id,
    override_kind: 'policy_rollback',
    status: 'applied',
    source_override_id: sourceOverride.id,
    reason: input.reason,
    requested_patch: {},
    before_policy: currentPolicy,
    after_policy: rollout.policy,
    before_preview: beforePreview,
    after_preview: rollout.preview,
    diff_summary: diffSummary,
    rollout_result: rollout,
    actor_id: actorId
  });
  return {
    policy: rollout.policy,
    source_override: geoRoutingStore.getRoutingPolicyOverride(String(input.tenant_id), String(sourceOverride.id)),
    override: rollbackOverride,
    diff: {
      current_policy: currentPolicy,
      proposed_policy: restoredPolicy,
      requested_patch: {},
      before_preview: beforePreview,
      after_preview: afterPreview,
      diff_summary: diffSummary
    },
    rollout
  };
}

function readGeoRoutingTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'geo',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'crm_agent', 'geo_agent', 'voice_agent', 'ops_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides,
  };
}

function writeGeoRoutingTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'geo',
    category: 'internal_write',
    risk_level: 'R1',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'crm_agent', 'geo_agent', 'voice_agent', 'ops_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides,
  };
}
