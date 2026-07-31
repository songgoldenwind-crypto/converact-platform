import { id, json, run } from '../db.js';
import { redactPhone, resolveVoiceWritebackStarter } from './voice/voice-store.js';
import type { JsonRecord } from './integrations/provider-runtime-types.js';

interface RegisterableToolRegistry {
  register: (definition: JsonRecord, handler: (input: JsonRecord, context: JsonRecord) => unknown) => void;
}

interface ChannelAdapterRegistryLike {
  deliverOutbound: (adapterId: string, input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface VoiceStoreLike {
  assertOutboundAllowed?: (input: JsonRecord) => JsonRecord;
  createCallSession?: (input: JsonRecord) => JsonRecord | null;
  updateCallSession?: (tenantId: string, callSessionId: string, patch: JsonRecord) => JsonRecord | null;
  upsertPolicy: (input: JsonRecord) => JsonRecord | null;
  recordConsent: (input: JsonRecord) => JsonRecord | null;
  ingestRecording: (input: JsonRecord) => JsonRecord | null;
  enforceRecordingRetention: (input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
  captureDeploymentSnapshot: (input: JsonRecord) => JsonRecord | null;
  listDeploymentSnapshots: (input: JsonRecord) => JsonRecord[];
  rotateRuntimeCredential: (input: JsonRecord) => JsonRecord;
  listCredentialRotations: (input: JsonRecord) => JsonRecord[];
  upsertAgentPresence: (input: JsonRecord) => JsonRecord | null;
  listAgentPresence: (input: JsonRecord) => JsonRecord[];
  upsertSkillQueue: (input: JsonRecord) => JsonRecord | null;
  listSkillQueues: (input: JsonRecord) => JsonRecord[];
  assignAgentToQueue: (input: JsonRecord) => JsonRecord | null;
  createRoutingSnapshot: (input: JsonRecord) => JsonRecord | null;
  listRoutingSnapshots: (input: JsonRecord) => JsonRecord[];
  getCallCenterOpsOverview: (input: JsonRecord) => JsonRecord;
  upsertMediaStoragePolicy: (input: JsonRecord) => JsonRecord | null;
  listMediaStoragePolicies: (input: JsonRecord) => JsonRecord[];
  planRecordingRetention: (input: JsonRecord) => JsonRecord;
  getMediaOpsOverview: (input: JsonRecord) => JsonRecord;
  ingestRustpbxEvent: (input: JsonRecord) => JsonRecord | null;
  createWebrtcSession: (input: JsonRecord) => JsonRecord;
  recordSignal: (input: JsonRecord) => JsonRecord | null;
}

interface ProviderRegistryStoreLike {
  integrationConfigStore: {
    getConfig: (tenantId: string, workspaceId: string, integrationId: string) => JsonRecord | null;
  };
  executeProviderOperation: (input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

export function registerVoiceTools(
  toolRegistry: RegisterableToolRegistry,
  db: unknown,
  channelAdapterRegistry: ChannelAdapterRegistryLike,
  voiceStore: VoiceStoreLike,
  providerRegistryStore: ProviderRegistryStoreLike | null = null
): void {
  toolRegistry.register(
    {
      tool_id: 'voice.queue_call_for_approval',
      display_name: 'Queue RustPBX call',
      toolset: 'voice',
      category: 'external_action',
      risk_level: 'R3',
      input_schema: {},
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: true,
      allowed_agents: ['voice_agent', 'orchestration_agent', 'crm_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: true,
      compensation: {
        status: 'manual_required',
        strategy: 'cancel_before_dial_or_mark_do_not_call',
        reason: 'Queued outbound calls may need cancellation or a do-not-call follow-up before dialing.'
      },
      audit_event_name: 'tool.voice_queue_call_for_approval'
    },
    async (input) => {
      const guard = voiceStore?.assertOutboundAllowed?.(input) || { policy: null, consent: null };
      const liveCall = providerRegistryStore
        ? await maybeExecuteRustpbxCall(providerRegistryStore, input, guard.policy)
        : null;
      const delivery = liveCall || await channelAdapterRegistry.deliverOutbound('voice_rustpbx', {
        tenantId: input.tenant_id,
        threadId: input.lead_id || input.customer_id || 'voice',
        text: input.script || '',
        routeId: input.route_id || 'default'
      });
      const callLog = insertCallLog(db, {
        tenant_id: input.tenant_id,
        provider: 'rustpbx',
        lead_id: input.lead_id || '',
        phone: input.phone || '',
        status: 'queued',
        direction: 'outbound',
        script: input.script || '',
        result: {
          delivery,
          provider_execution_mode: liveCall ? 'live_provider' : 'planned_adapter_fallback',
          workspace_id: input.workspace_id || 'default',
          mode: String(input.lead_run_context_kind || '').trim() === 'ai_outbound_approved_draft'
            ? 'ai_outbound'
            : 'voice_queue_approval',
          lead_run_id: input.lead_run_id || '',
          lead_run_task_id: input.lead_run_task_id || '',
          lead_run_context_kind: input.lead_run_context_kind || '',
          lead_run_route_label: input.lead_run_route_label || '',
          lead_run_outcome_tag: input.lead_run_outcome_tag || ''
        },
        external_call_id: delivery.delivery_id || delivery.external_call_id
      });
      const writebackStarterTemplate = input.lead_run_writeback_starter_template && typeof input.lead_run_writeback_starter_template === 'object'
        ? input.lead_run_writeback_starter_template
        : null;
      const callSession = voiceStore?.createCallSession?.({
        tenant_id: input.tenant_id,
        provider: 'rustpbx',
        call_log_id: callLog.id,
        lead_id: input.lead_id || '',
        customer_id: input.customer_id || '',
        phone: input.phone || '',
        direction: 'outbound',
        route_id: input.route_id || 'default',
        status: 'queued',
        rustpbx_call_id: delivery.delivery_id || delivery.external_call_id,
        sip_endpoint: delivery.sip_endpoint || input.sip_endpoint || '',
        metadata: {
          workspace_id: input.workspace_id || 'default',
          mode: String(input.lead_run_context_kind || '').trim() === 'ai_outbound_approved_draft'
            ? 'ai_outbound'
            : 'voice_queue_approval',
          agent_id: input.agent_id || 'voice_agent',
          task_id: input.task_id || input.lead_run_task_id || '',
          contact_name: input.contact_name || input.lead_run_lead_name || '',
          phone_input: redactPhone(input.phone || ''),
          script: input.script || '',
          notes: input.notes || '',
          draft_title: input.draft_title || '',
          draft_context: input.draft_context && typeof input.draft_context === 'object'
            ? input.draft_context
            : null,
          lead_run_context_kind: input.lead_run_context_kind || '',
          lead_run_id: input.lead_run_id || '',
          lead_run_task_id: input.lead_run_task_id || '',
          lead_run_lead_name: input.lead_run_lead_name || '',
          lead_run_reason: input.lead_run_reason || '',
          lead_run_next_action: input.lead_run_next_action || '',
          lead_run_route_label: input.lead_run_route_label || '',
          lead_run_outcome_tag: input.lead_run_outcome_tag || '',
          lead_run_call_readiness_pack: input.lead_run_call_readiness_pack && typeof input.lead_run_call_readiness_pack === 'object'
            ? input.lead_run_call_readiness_pack
            : null,
          lead_run_live_call_guidance_pack: input.lead_run_live_call_guidance_pack && typeof input.lead_run_live_call_guidance_pack === 'object'
            ? input.lead_run_live_call_guidance_pack
            : null,
          lead_run_live_opening_trajectory_pack: input.lead_run_live_opening_trajectory_pack && typeof input.lead_run_live_opening_trajectory_pack === 'object'
            ? input.lead_run_live_opening_trajectory_pack
            : null,
          lead_run_objection_turn_response_pack: input.lead_run_objection_turn_response_pack && typeof input.lead_run_objection_turn_response_pack === 'object'
            ? input.lead_run_objection_turn_response_pack
            : null,
          lead_run_commitment_close_pack: input.lead_run_commitment_close_pack && typeof input.lead_run_commitment_close_pack === 'object'
            ? input.lead_run_commitment_close_pack
            : null,
          lead_run_writeback_starter_template: writebackStarterTemplate,
          lead_run_writeback_preview: input.lead_run_writeback_preview && typeof input.lead_run_writeback_preview === 'object'
            ? input.lead_run_writeback_preview
            : null,
          provider_execution_mode: liveCall ? 'live_provider' : 'planned_adapter_fallback',
          voice_policy: guard.policy,
          consent_id: guard.consent?.id || null,
          recording_requested: Boolean(guard.policy && guard.policy.recording_mode !== 'disabled'),
          delivery
        }
      });
      const writebackStarter = resolveVoiceWritebackStarter(writebackStarterTemplate, callSession?.id);
      const persistedCallSession = writebackStarter && callSession?.id && voiceStore?.updateCallSession
        ? voiceStore.updateCallSession(String(input.tenant_id || ''), String(callSession.id), {
            metadata: {
              ...(callSession.metadata && typeof callSession.metadata === 'object' ? callSession.metadata : {}),
              lead_run_writeback_starter: writebackStarter
            }
          })
        : callSession;
      return {
        queued: true,
        provider: 'rustpbx',
        provider_execution_mode: liveCall ? 'live_provider' : 'planned_adapter_fallback',
        voice_policy: guard.policy,
        consent: guard.consent,
        delivery,
        call_log: callLog,
        call_session: persistedCallSession,
        writeback_starter: writebackStarter
      };
    }
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.policy_upsert',
      display_name: 'Upsert tenant voice policy',
      audit_event_name: 'tool.voice_policy_upsert'
    }),
    async (input, context) => voiceStore.upsertPolicy({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.consent_record',
      display_name: 'Record voice consent evidence',
      audit_event_name: 'tool.voice_consent_record'
    }),
    async (input, context) => voiceStore.recordConsent({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.recording_ingest',
      display_name: 'Ingest voice recording metadata',
      audit_event_name: 'tool.voice_recording_ingest'
    }),
    async (input, context) => voiceStore.ingestRecording({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.recording_retention_enforce',
      display_name: 'Enforce voice recording retention',
      audit_event_name: 'tool.voice_recording_retention_enforce'
    }),
    async (input, context) => voiceStore.enforceRecordingRetention({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.agent_presence_upsert',
      display_name: 'Upsert call center agent presence',
      audit_event_name: 'tool.voice_agent_presence_upsert'
    }),
    async (input, context) => voiceStore.upsertAgentPresence({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.agent_presence_list',
      display_name: 'List call center agent presence',
      audit_event_name: 'tool.voice_agent_presence_list'
    }),
    async (input) => voiceStore.listAgentPresence(input)
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.skill_queue_upsert',
      display_name: 'Upsert call center skill queue',
      audit_event_name: 'tool.voice_skill_queue_upsert'
    }),
    async (input, context) => voiceStore.upsertSkillQueue({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.skill_queue_list',
      display_name: 'List call center skill queues',
      audit_event_name: 'tool.voice_skill_queue_list'
    }),
    async (input) => voiceStore.listSkillQueues(input)
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.skill_queue_assign_agent',
      display_name: 'Assign call center agent to skill queue',
      audit_event_name: 'tool.voice_skill_queue_assign_agent'
    }),
    async (input, context) => voiceStore.assignAgentToQueue({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.call_center_routing_snapshot',
      display_name: 'Create call center routing snapshot',
      audit_event_name: 'tool.voice_call_center_routing_snapshot'
    }),
    async (input, context) => voiceStore.createRoutingSnapshot({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.call_center_routing_snapshot_list',
      display_name: 'List call center routing snapshots',
      audit_event_name: 'tool.voice_call_center_routing_snapshot_list'
    }),
    async (input) => voiceStore.listRoutingSnapshots(input)
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.call_center_ops_overview',
      display_name: 'View call center ops overview',
      audit_event_name: 'tool.voice_call_center_ops_overview'
    }),
    async (input) => voiceStore.getCallCenterOpsOverview(input)
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.media_storage_policy_upsert',
      display_name: 'Upsert voice media storage policy',
      audit_event_name: 'tool.voice_media_storage_policy_upsert'
    }),
    async (input, context) => voiceStore.upsertMediaStoragePolicy({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.media_storage_policy_list',
      display_name: 'List voice media storage policies',
      audit_event_name: 'tool.voice_media_storage_policy_list'
    }),
    async (input) => voiceStore.listMediaStoragePolicies(input)
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.recording_retention_plan',
      display_name: 'Plan voice recording retention batches',
      audit_event_name: 'tool.voice_recording_retention_plan'
    }),
    async (input) => voiceStore.planRecordingRetention(input)
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.media_ops_overview',
      display_name: 'View voice media ops overview',
      audit_event_name: 'tool.voice_media_ops_overview'
    }),
    async (input) => voiceStore.getMediaOpsOverview(input)
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.runtime_deployment_snapshot_list',
      display_name: 'List voice runtime deployment snapshots',
      audit_event_name: 'tool.voice_runtime_deployment_snapshot_list'
    }),
    async (input) => voiceStore.listDeploymentSnapshots(input)
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.runtime_deployment_snapshot_create',
      display_name: 'Capture voice runtime deployment snapshot',
      audit_event_name: 'tool.voice_runtime_deployment_snapshot_create'
    }),
    async (input, context) => voiceStore.captureDeploymentSnapshot({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readVoiceTool({
      tool_id: 'voice.runtime_credential_rotation_list',
      display_name: 'List voice runtime credential rotations',
      audit_event_name: 'tool.voice_runtime_credential_rotation_list'
    }),
    async (input) => voiceStore.listCredentialRotations(input)
  );

  toolRegistry.register(
    adminVoiceTool({
      tool_id: 'voice.runtime_credential_rotate',
      display_name: 'Rotate voice runtime credential',
      audit_event_name: 'tool.voice_runtime_credential_rotate'
    }),
    async (input, context) => voiceStore.rotateRuntimeCredential({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    {
      tool_id: 'voice.ingest_call_result',
      display_name: 'Ingest call result',
      toolset: 'voice',
      category: 'internal_write',
      risk_level: 'R2',
      input_schema: {},
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: false,
      allowed_agents: ['voice_agent', 'orchestration_agent', 'crm_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: true,
      audit_event_name: 'tool.voice_ingest_call_result'
    },
    async (input) =>
      insertCallLog(db, {
        tenant_id: input.tenant_id,
        provider: 'rustpbx',
        lead_id: input.lead_id || '',
        phone: input.phone || '',
        status: input.status || 'completed',
        direction: input.direction || 'outbound',
        script: input.script || '',
        result: input.result || {},
        external_call_id: input.external_call_id || ''
      })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.rustpbx_create_call_session',
      display_name: 'Create RustPBX call session',
      audit_event_name: 'tool.voice_rustpbx_create_call_session'
    }),
    async (input) => voiceStore.createCallSession({ ...input, provider: 'rustpbx' })
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.rustpbx_ingest_event',
      display_name: 'Ingest RustPBX event',
      audit_event_name: 'tool.voice_rustpbx_ingest_event'
    }),
    async (input) => voiceStore.ingestRustpbxEvent(input)
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.webrtc_create_session',
      display_name: 'Create WebRTC voice session',
      audit_event_name: 'tool.voice_webrtc_create_session'
    }),
    async (input) => voiceStore.createWebrtcSession(input)
  );

  toolRegistry.register(
    internalVoiceTool({
      tool_id: 'voice.webrtc_signal',
      display_name: 'Record WebRTC signaling event',
      audit_event_name: 'tool.voice_webrtc_signal'
    }),
    async (input) => voiceStore.recordSignal(input)
  );

  toolRegistry.register(
    {
      tool_id: 'voice.test_sip_route',
      display_name: 'Test RustPBX SIP route',
      toolset: 'voice',
      category: 'read',
      risk_level: 'R0',
      input_schema: {},
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['voice_agent', 'orchestration_agent', 'crm_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.voice_test_sip_route'
    },
    async (input) => {
      const liveResult = providerRegistryStore
        ? await maybeExecuteRustpbxRouteTest(providerRegistryStore, input)
        : null;
      return liveResult || {
        provider: 'rustpbx',
        route_id: input.route_id || 'default',
        status: 'planned_adapter_ready',
        outbound_requires_approval: true
      };
    }
  );
}

function insertCallLog(db: unknown, input: JsonRecord): JsonRecord {
  const callLog = {
    id: id('vcall'),
    tenant_id: input.tenant_id,
    provider: input.provider || 'rustpbx',
    lead_id: input.lead_id || '',
    phone_redacted: redactPhone(input.phone || ''),
    status: input.status || 'queued',
    direction: input.direction || 'outbound',
    script: input.script || '',
    result: input.result || {},
    external_call_id: input.external_call_id || ''
  };
  run(
    db,
    `INSERT INTO voice_call_logs
      (id, tenant_id, provider, lead_id, phone_redacted, status, direction, script, result, external_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      callLog.id,
      callLog.tenant_id,
      callLog.provider,
      callLog.lead_id,
      callLog.phone_redacted,
      callLog.status,
      callLog.direction,
      callLog.script,
      json(callLog.result),
      callLog.external_call_id
    ]
  );
  return callLog;
}

function internalVoiceTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'voice',
    category: 'internal_write',
    risk_level: 'R2',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['voice_agent', 'orchestration_agent', 'crm_agent', 'ops_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function readVoiceTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'voice',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['voice_agent', 'orchestration_agent', 'crm_agent', 'ops_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function adminVoiceTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'voice',
    category: 'admin_action',
    risk_level: 'R5',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: true,
    allowed_agents: ['ops_agent', 'orchestration_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

async function maybeExecuteRustpbxCall(
  providerRegistryStore: ProviderRegistryStoreLike,
  input: JsonRecord,
  policy: JsonRecord | null = null
): Promise<JsonRecord | null> {
  const config = providerRegistryStore.integrationConfigStore.getConfig(input.tenant_id, input.workspace_id || 'default', 'rustpbx');
  if (!config || config.status === 'disabled') return null;
  const result = await providerRegistryStore.executeProviderOperation({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id || 'default',
    integration_id: 'rustpbx',
    operation: 'call.queue_for_approval',
    payload: {
      lead_id: input.lead_id || '',
      customer_id: input.customer_id || '',
      phone: input.phone || '',
      script: input.script || '',
      route_id: input.route_id || 'default',
      sip_endpoint: input.sip_endpoint || '',
      idempotency_key: input.idempotency_key || '',
      recording: {
        enabled: Boolean(policy && policy.recording_mode !== 'disabled'),
        mode: policy?.recording_mode || 'disabled',
        retention_days: Number(policy?.recording_retention_days || 0)
      }
    },
    actor_id: input.actor_id || 'system'
  });
  return {
    ...result,
    delivery_id: result.delivery_id || result.external_call_id || ''
  };
}

async function maybeExecuteRustpbxRouteTest(
  providerRegistryStore: ProviderRegistryStoreLike,
  input: JsonRecord
): Promise<JsonRecord | null> {
  const config = providerRegistryStore.integrationConfigStore.getConfig(input.tenant_id, input.workspace_id || 'default', 'rustpbx');
  if (!config || config.status === 'disabled') return null;
  const result = await providerRegistryStore.executeProviderOperation({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id || 'default',
    integration_id: 'rustpbx',
    operation: 'sip_route.test',
    payload: {
      route_id: input.route_id || 'default',
      lead_id: input.lead_id || '',
      sip_endpoint: input.sip_endpoint || ''
    },
    actor_id: input.actor_id || 'system'
  });
  return {
    ...result,
    provider_execution_mode: 'live_provider'
  };
}
