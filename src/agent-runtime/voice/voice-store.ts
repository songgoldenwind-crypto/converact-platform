import { createHash, randomBytes } from 'node:crypto';
import { all, id, json, one, parseJson, run } from '../../db.js';
import { VoiceMediaClient } from './voice-media-client.js';
import type { IntegrationConfigStoreLike, JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

export class VoiceStore {
  db: unknown;
  runStore: AuditStoreLike | null;
  integrationConfigStore: IntegrationConfigStoreLike | null;
  voiceMediaClient: VoiceMediaClient;

  constructor(db: unknown, runStore: AuditStoreLike | null = null, integrationConfigStore: IntegrationConfigStoreLike | null = null, voiceMediaClient: VoiceMediaClient | null = null) {
    this.db = db;
    this.runStore = runStore;
    this.integrationConfigStore = integrationConfigStore;
    this.voiceMediaClient = voiceMediaClient || new VoiceMediaClient();
  }

  createCallSession(input) {
    const session = {
      id: id('vsession'),
      tenant_id: input.tenant_id,
      provider: input.provider || 'rustpbx',
      call_log_id: input.call_log_id || null,
      lead_id: input.lead_id || '',
      customer_id: input.customer_id || '',
      direction: input.direction || 'outbound',
      route_id: input.route_id || 'default',
      status: input.status || 'planned',
      phone_redacted: redactPhone(input.phone || input.phone_redacted || ''),
      rustpbx_call_id: input.rustpbx_call_id || input.external_call_id || '',
      sip_endpoint: input.sip_endpoint || '',
      webrtc_session_id: input.webrtc_session_id || '',
      metadata: input.metadata || {}
    };
    run(
      this.db,
      `INSERT INTO voice_call_sessions
        (id, tenant_id, provider, call_log_id, lead_id, customer_id, direction, route_id, status, phone_redacted, rustpbx_call_id, sip_endpoint, webrtc_session_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.tenant_id,
        session.provider,
        session.call_log_id,
        session.lead_id,
        session.customer_id,
        session.direction,
        session.route_id,
        session.status,
        session.phone_redacted,
        session.rustpbx_call_id,
        session.sip_endpoint,
        session.webrtc_session_id,
        json(session.metadata)
      ]
    );
    this.runStore?.audit(session.tenant_id, 'voice.call_session.created', 'voice_call_session', session.id, {
      provider: session.provider,
      status: session.status
    });
    return this.getCallSession(session.tenant_id, session.id);
  }

  updateCallSession(tenantId, callSessionId, patch) {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(tenantId, callSessionId);
    run(this.db, `UPDATE voice_call_sessions SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    return this.getCallSession(tenantId, callSessionId);
  }

  ingestRustpbxEvent(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const rustpbxCallId = input.rustpbx_call_id || input.call_id || input.external_call_id;
    if (!rustpbxCallId) throw new Error('rustpbx_call_id is required');
    const existing = this.getCallSessionByRustpbxId(input.tenant_id, rustpbxCallId);
    const status = mapRustpbxStatus(input.event_type || input.status);
    const patch: JsonRecord = {
      status,
      rustpbx_call_id: rustpbxCallId,
      metadata: {
        ...(existing?.metadata || {}),
        last_event: input.event_type || input.status,
        payload: input.payload || {}
      }
    };
    if (status === 'active') patch.started_at = input.occurred_at || new Date().toISOString();
    if (['completed', 'failed', 'cancelled'].includes(status)) patch.ended_at = input.occurred_at || new Date().toISOString();
    const session = existing
      ? this.updateCallSession(input.tenant_id, existing.id, patch)
      : this.createCallSession({
          tenant_id: input.tenant_id,
          provider: 'rustpbx',
          direction: input.direction || 'inbound',
          route_id: input.route_id || 'webhook',
          status,
          rustpbx_call_id: rustpbxCallId,
          lead_id: input.lead_id || '',
          customer_id: input.customer_id || '',
          metadata: patch.metadata
        });
    this.runStore?.audit(input.tenant_id, 'voice.rustpbx_event.ingested', 'voice_call_session', session.id, {
      rustpbx_call_id: rustpbxCallId,
      status
    });
    return session;
  }

  getCallSession(tenantId, callSessionId) {
    const row = one(this.db, 'SELECT * FROM voice_call_sessions WHERE tenant_id = ? AND id = ?', [
      tenantId,
      callSessionId
    ]);
    return row ? decodeCallSession(row) : null;
  }

  getCallSessionById(callSessionId) {
    const row = one(this.db, 'SELECT * FROM voice_call_sessions WHERE id = ?', [callSessionId]);
    return row ? decodeCallSession(row) : null;
  }

  mergeCallSessionMetadata(
    tenantId,
    callSessionId,
    merge: (existing: Record<string, unknown>) => Record<string, unknown>
  ) {
    const session = this.getCallSession(tenantId, callSessionId);
    if (!session) return null;
    const existingMeta =
      session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    return this.updateCallSession(tenantId, callSessionId, { metadata: merge(existingMeta) });
  }

  mergeCallSessionMetadataIf(
    tenantId,
    callSessionId,
    expectedVersion: number,
    merge: (existing: Record<string, unknown>) => Record<string, unknown>
  ) {
    const session = this.getCallSession(tenantId, callSessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    const existingMeta =
      session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    const currentVersion = Number(existingMeta.navigation_version || 0);
    if (currentVersion !== expectedVersion) {
      return { ok: false, reason: 'conflict', currentVersion };
    }
    const nextMeta = {
      ...merge(existingMeta),
      navigation_version: currentVersion + 1
    };
    const updated = this.updateCallSession(tenantId, callSessionId, { metadata: nextMeta });
    return { ok: true, session: updated, navigation_version: currentVersion + 1 };
  }

  getCallSessionByRustpbxId(tenantId, rustpbxCallId) {
    const row = one(this.db, 'SELECT * FROM voice_call_sessions WHERE tenant_id = ? AND rustpbx_call_id = ?', [
      tenantId,
      rustpbxCallId
    ]);
    return row ? decodeCallSession(row) : null;
  }

  listCallSessions({ tenant_id, status = null, limit = 50 }) {
    const conditions = ['tenant_id = ?'];
    const params = [tenant_id];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_call_sessions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeCallSession);
  }

  listCallLogs({ tenant_id, status = null, direction = null, limit = 50 }) {
    const conditions = ['tenant_id = ?'];
    const params = [tenant_id];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (direction) {
      conditions.push('direction = ?');
      params.push(direction);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_call_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeCallLog);
  }

  startManualOutboundCall(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!String(input.phone || '').trim()) throw new Error('phone is required');
    const workspaceId = input.workspace_id || 'default';
    const now = input.started_at || new Date().toISOString();
    const callLog = this.createCallLog({
      tenant_id: input.tenant_id,
      provider: input.provider || 'browser_manual',
      lead_id: input.lead_id || '',
      phone: input.phone,
      status: 'queued',
      direction: 'outbound',
      script: input.script || '',
      result: {
        mode: 'manual_outbound',
        workspace_id: workspaceId,
        agent_id: input.agent_id || 'manual-agent',
        task_id: input.task_id || input.lead_run_task_id || '',
        lead_run_id: input.lead_run_id || '',
        lead_run_task_id: input.lead_run_task_id || '',
        started_at: now
      },
      external_call_id: input.external_call_id || ''
    });
    const writebackStarterTemplate = asJsonRecord(input.lead_run_writeback_starter_template);
    const session = this.createCallSession({
      tenant_id: input.tenant_id,
      provider: input.provider || 'browser_manual',
      call_log_id: callLog.id,
      lead_id: input.lead_id || '',
      customer_id: input.customer_id || '',
      phone: input.phone,
      direction: 'outbound',
      route_id: input.route_id || 'manual-outbound',
      status: input.status || 'active',
      started_at: now,
      metadata: {
        workspace_id: workspaceId,
        mode: 'manual_outbound',
        agent_id: input.agent_id || 'manual-agent',
        task_id: input.task_id || input.lead_run_task_id || '',
        contact_name: input.contact_name || '',
        phone_input: redactPhone(input.phone || ''),
        script: input.script || '',
        notes: input.notes || '',
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
          : null
      }
    });
    const writebackStarter = resolveVoiceWritebackStarter(writebackStarterTemplate, session.id);
    const persistedSession = writebackStarter
      ? this.updateCallSession(input.tenant_id, session.id, {
          metadata: {
            ...(session.metadata || {}),
            lead_run_writeback_starter: writebackStarter
          }
        })
      : session;
    this.runStore?.audit(input.tenant_id, 'voice.manual_outbound.started', 'voice_call_session', session.id, {
      call_log_id: callLog.id,
      lead_id: input.lead_id || '',
      task_id: input.task_id || ''
    }, input.actor_id || 'system');
    return {
      call_log: callLog,
      call_session: persistedSession,
      writeback_starter: writebackStarter,
      next_required_action: 'complete_call_disposition'
    };
  }

  createInboundCall(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!String(input.phone || '').trim()) throw new Error('phone is required');
    const workspaceId = input.workspace_id || 'default';
    const callLog = this.createCallLog({
      tenant_id: input.tenant_id,
      provider: input.provider || 'browser_manual',
      lead_id: input.lead_id || '',
      phone: input.phone,
      status: 'queued',
      direction: 'inbound',
      script: '',
      result: {
        mode: 'manual_inbound',
        workspace_id: workspaceId,
        caller_name: input.caller_name || '',
        intent: input.intent || ''
      },
      external_call_id: input.external_call_id || ''
    });
    const routing = this.createRoutingSnapshot({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      route_id: input.route_id || 'inbound-main',
      queue_id: input.queue_id || '',
      required_skills: input.required_skills || ['inbound'],
      actor_id: input.actor_id || 'system'
    });
    const session = this.createCallSession({
      tenant_id: input.tenant_id,
      provider: input.provider || 'browser_manual',
      call_log_id: callLog.id,
      lead_id: input.lead_id || '',
      customer_id: input.customer_id || '',
      phone: input.phone,
      direction: 'inbound',
      route_id: input.route_id || 'inbound-main',
      status: 'ringing',
      metadata: {
        workspace_id: workspaceId,
        mode: 'manual_inbound',
        caller_name: input.caller_name || '',
        intent: input.intent || '',
        queue_id: routing.queue_id || input.queue_id || '',
        selected_agent_id: routing.selected_agent_id || '',
        routing_snapshot_id: routing.id
      }
    });
    this.runStore?.audit(input.tenant_id, 'voice.inbound.received', 'voice_call_session', session.id, {
      call_log_id: callLog.id,
      routing_snapshot_id: routing.id,
      selected_agent_id: routing.selected_agent_id || ''
    }, input.actor_id || 'system');
    return {
      call_log: callLog,
      routing,
      call_session: session,
      next_required_action: routing.selected_agent_id ? 'answer_call' : 'assign_or_answer_call'
    };
  }

  answerCallSession(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.call_session_id) throw new Error('call_session_id is required');
    const session = this.getCallSession(input.tenant_id, input.call_session_id);
    if (!session) throw new Error(`call session not found: ${input.call_session_id}`);
    if (!['ringing', 'queued', 'planned'].includes(session.status)) {
      throw new Error(`call session cannot be answered from status:${session.status}`);
    }
    const answeredAt = input.answered_at || new Date().toISOString();
    const updated = this.updateCallSession(input.tenant_id, session.id, {
      status: 'active',
      started_at: answeredAt,
      metadata: {
        ...(session.metadata || {}),
        answered_at: answeredAt,
        answered_by: input.agent_id || input.actor_id || 'manual-agent'
      }
    });
    this.runStore?.audit(input.tenant_id, 'voice.call_session.answered', 'voice_call_session', session.id, {
      direction: session.direction,
      agent_id: input.agent_id || ''
    }, input.actor_id || 'system');
    return updated;
  }

  completeManualCall(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.call_session_id) throw new Error('call_session_id is required');
    const session = this.getCallSession(input.tenant_id, input.call_session_id);
    if (!session) throw new Error(`call session not found: ${input.call_session_id}`);
    const disposition = normalizeCallDisposition(input.disposition || input.result || 'completed');
    const completedAt = input.completed_at || new Date().toISOString();
    const nextAction = callNextAction(disposition, input);
    const status = disposition === 'no_answer' || disposition === 'invalid_number' ? 'failed' : 'completed';
    const metadata = {
      ...(session.metadata || {}),
      disposition,
      summary: input.summary || '',
      next_action: nextAction,
      outcome_tag: input.outcome_tag || '',
      next_step_type: input.next_step_type || defaultCallNextStepType(disposition) || '',
      next_step_due_at: input.next_step_due_at || input.callback_time || input.appointment_time || '',
      appointment_time: input.appointment_time || '',
      callback_time: input.callback_time || '',
      completed_at: completedAt,
      completed_by: input.agent_id || input.actor_id || 'manual-agent'
    };
    const updated = this.updateCallSession(input.tenant_id, session.id, {
      status,
      ended_at: completedAt,
      metadata
    });
    if (session.call_log_id) {
      run(
        this.db,
        `UPDATE voice_call_logs
           SET status = ?, result = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND id = ?`,
        [
          status,
          json({
            disposition,
            summary: input.summary || '',
            next_action: nextAction,
            outcome_tag: input.outcome_tag || '',
            next_step_type: input.next_step_type || defaultCallNextStepType(disposition) || '',
            next_step_due_at: input.next_step_due_at || input.callback_time || input.appointment_time || '',
            appointment_time: input.appointment_time || '',
            callback_time: input.callback_time || '',
            completed_at: completedAt
          }),
          input.tenant_id,
          session.call_log_id
        ]
      );
    }
    const followupTask = this.createCallFollowupTask({
      ...input,
      session,
      disposition,
      next_action: nextAction,
      completed_at: completedAt
    });
    const completedTask = this.completeLinkedCallTask({
      ...input,
      session,
      disposition,
      next_action: nextAction,
      followup_task_id: followupTask?.id || ''
    });
    this.updateLeadAfterCall(input.tenant_id, session.lead_id, disposition, nextAction);
    this.runStore?.audit(input.tenant_id, 'voice.call_session.completed', 'voice_call_session', session.id, {
      disposition,
      followup_task_id: followupTask?.id || '',
      completed_task_id: completedTask?.id || ''
    }, input.actor_id || 'system');
    return {
      call_session: updated,
      call_log: session.call_log_id ? this.getCallLog(input.tenant_id, session.call_log_id) : null,
      completed_task: completedTask,
      followup_task: followupTask,
      next_action: nextAction
    };
  }

  getCallLog(tenantId, callLogId) {
    const row = one(this.db, 'SELECT * FROM voice_call_logs WHERE tenant_id = ? AND id = ?', [tenantId, callLogId]);
    return row ? decodeCallLog(row) : null;
  }

  createCallLog(input) {
    const callLog = {
      id: id('vcall'),
      tenant_id: input.tenant_id,
      provider: input.provider || 'browser_manual',
      lead_id: input.lead_id || '',
      phone_redacted: redactPhone(input.phone || input.phone_redacted || ''),
      status: input.status || 'queued',
      direction: input.direction || 'outbound',
      script: input.script || '',
      result: input.result || {},
      external_call_id: input.external_call_id || ''
    };
    run(
      this.db,
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
    return this.getCallLog(callLog.tenant_id, callLog.id);
  }

  createCallFollowupTask(input) {
    const nextStepType = input.next_step_type || defaultCallNextStepType(input.disposition);
    if (!nextStepType) return null;
    const objectType = input.object_type || (input.session.lead_id ? 'lead' : 'voice_call_session');
    const objectId = input.object_id || input.session.lead_id || input.session.id;
    const dueAt = input.next_step_due_at || input.callback_time || input.appointment_time || new Date(Date.now() + defaultCallDueHours(nextStepType) * 60 * 60 * 1000).toISOString();
    const taskId = id('task');
    run(
      this.db,
      `INSERT INTO tasks (id, tenant_id, object_type, object_id, title, priority, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        input.tenant_id,
        objectType,
        objectId,
        input.followup_title || callFollowupTitle(input.disposition, input.session),
        input.priority || (nextStepType === 'appointment' || nextStepType === 'transfer' ? 'P0' : 'P1'),
        dueAt
      ]
    );
    return one(this.db, 'SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', [input.tenant_id, taskId]);
  }

  completeLinkedCallTask(input) {
    const taskId = input.lead_run_task_id || input.task_id || input.session?.metadata?.lead_run_task_id || input.session?.metadata?.task_id || '';
    if (!taskId) return null;
    const task = one(this.db, 'SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', [input.tenant_id, taskId]);
    if (!task || task.status !== 'open') return task || null;
    const resultText = input.outcome_tag || callDispositionLabel(input.disposition) || '通话结果已回写';
    const reasonText = input.summary || input.next_action || resultText;
    run(
      this.db,
      `UPDATE tasks
          SET status = 'done',
              completion_result = ?,
              completion_reason = ?,
              next_step_type = ?,
              next_step_due_at = ?,
              followup_task_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND id = ?`,
      [
        resultText,
        reasonText,
        input.next_step_type || defaultCallNextStepType(input.disposition) || '',
        input.next_step_due_at || input.callback_time || input.appointment_time || '',
        input.followup_task_id || null,
        input.tenant_id,
        taskId
      ]
    );
    const completedTask = one(this.db, 'SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', [input.tenant_id, taskId]);
    this.runStore?.audit(input.tenant_id, 'crm.task.completed_from_call', 'task', taskId, {
      call_session_id: input.session?.id || '',
      disposition: input.disposition || '',
      followup_task_id: input.followup_task_id || ''
    }, input.actor_id || 'system');
    return completedTask;
  }

  updateLeadAfterCall(tenantId, leadId, disposition, nextAction) {
    if (!leadId) return;
    const status = {
      connected_booked: 'booked',
      connected_callback: 'contacted',
      connected_not_interested: 'disqualified',
      transfer_required: 'contacted',
      completed: 'contacted',
      no_answer: 'qualified_lead',
      invalid_number: 'disqualified'
    }[disposition] || 'contacted';
    run(
      this.db,
      `UPDATE leads
          SET status = ?, next_action = ?, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND id = ?`,
      [status, nextAction || callDispositionLabel(disposition), tenantId, leadId]
    );
  }

  getCallCenterWorkbench({ tenant_id, workspace_id = 'default', limit = 50 }) {
    const sessions = this.listCallSessions({ tenant_id, limit });
    const logs = this.listCallLogs({ tenant_id, limit });
    const agents = this.listAgentPresence({ tenant_id, workspace_id, limit: 100 });
    const queues = this.listSkillQueues({ tenant_id, workspace_id, limit: 100 });
    const activeStatuses = new Set(['queued', 'ringing', 'active']);
    const inboundQueue = sessions.filter((session) => session.direction === 'inbound' && activeStatuses.has(session.status));
    const activeCalls = sessions.filter((session) => activeStatuses.has(session.status));
    const completedCalls = sessions.filter((session) => ['completed', 'failed', 'cancelled'].includes(session.status));
    return {
      summary: {
        active_calls: activeCalls.length,
        inbound_waiting: inboundQueue.length,
        available_agents: agents.filter((agent) => agent.status === 'available').length,
        completed_calls: completedCalls.length,
        outbound_today: sessions.filter((session) => session.direction === 'outbound').length,
        inbound_today: sessions.filter((session) => session.direction === 'inbound').length
      },
      active_calls: activeCalls,
      inbound_queue: inboundQueue,
      recent_sessions: sessions,
      recent_logs: logs,
      agents,
      queues
    };
  }

  upsertAgentPresence(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.agent_id) throw new Error('agent_id is required');
    const workspaceId = input.workspace_id || 'default';
    const skills = Array.isArray(input.skills) ? input.skills : [];
    const capacity = Number(input.capacity ?? 1);
    const activeCallCount = Number(input.active_call_count ?? 0);
    if (activeCallCount > capacity) {
      throw new Error(`active_call_count cannot exceed capacity for agent:${input.agent_id}`);
    }
    run(
      this.db,
      `INSERT INTO voice_agent_presence
        (id, tenant_id, workspace_id, agent_id, display_name, status, capacity, active_call_count, skills, metadata, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, agent_id) DO UPDATE SET
         display_name = excluded.display_name,
         status = excluded.status,
         capacity = excluded.capacity,
         active_call_count = excluded.active_call_count,
         skills = excluded.skills,
         metadata = excluded.metadata,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('vagent'),
        input.tenant_id,
        workspaceId,
        input.agent_id,
        input.display_name || input.agent_id,
        input.status || 'available',
        capacity,
        activeCallCount,
        json(skills),
        json(input.metadata || {}),
        input.actor_id || 'system'
      ]
    );
    const presence = this.getAgentPresence(input.tenant_id, workspaceId, input.agent_id);
    this.runStore?.audit(input.tenant_id, 'voice.agent_presence.upserted', 'voice_agent_presence', presence.id, {
      workspace_id: workspaceId,
      agent_id: input.agent_id,
      status: presence.status,
      capacity: presence.capacity
    }, input.actor_id || 'system');
    return presence;
  }

  getAgentPresence(tenantId, workspaceId, agentId) {
    const row = one(
      this.db,
      `SELECT * FROM voice_agent_presence WHERE tenant_id = ? AND workspace_id = ? AND agent_id = ?`,
      [tenantId, workspaceId, agentId]
    );
    return row ? decodeAgentPresence(row) : null;
  }

  listAgentPresence({ tenant_id, workspace_id = null, status = null, skill = null, limit = 100 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    const rows = all(
      this.db,
      `SELECT * FROM voice_agent_presence
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      params
    ).map(decodeAgentPresence);
    return skill ? rows.filter((agent) => agent.skills.includes(skill)) : rows;
  }

  upsertSkillQueue(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.queue_id) throw new Error('queue_id is required');
    const workspaceId = input.workspace_id || 'default';
    const skillTags = Array.isArray(input.skill_tags) ? input.skill_tags : [];
    run(
      this.db,
      `INSERT INTO voice_skill_queues
        (id, tenant_id, workspace_id, queue_id, name, skill_tags, priority, max_wait_seconds, status, metadata, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, queue_id) DO UPDATE SET
         name = excluded.name,
         skill_tags = excluded.skill_tags,
         priority = excluded.priority,
         max_wait_seconds = excluded.max_wait_seconds,
         status = excluded.status,
         metadata = excluded.metadata,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('vqueue'),
        input.tenant_id,
        workspaceId,
        input.queue_id,
        input.name || input.queue_id,
        json(skillTags),
        Number(input.priority ?? 50),
        Number(input.max_wait_seconds ?? 300),
        input.status || 'active',
        json(input.metadata || {}),
        input.actor_id || 'system'
      ]
    );
    const queue = this.getSkillQueue(input.tenant_id, workspaceId, input.queue_id);
    this.runStore?.audit(input.tenant_id, 'voice.skill_queue.upserted', 'voice_skill_queue', queue.id, {
      workspace_id: workspaceId,
      queue_id: input.queue_id,
      status: queue.status
    }, input.actor_id || 'system');
    return queue;
  }

  getSkillQueue(tenantId, workspaceId, queueId) {
    const row = one(
      this.db,
      `SELECT * FROM voice_skill_queues WHERE tenant_id = ? AND workspace_id = ? AND queue_id = ?`,
      [tenantId, workspaceId, queueId]
    );
    return row ? decodeSkillQueue(row) : null;
  }

  listSkillQueues({ tenant_id, workspace_id = null, status = null, limit = 100 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_skill_queues
       WHERE ${clauses.join(' AND ')}
       ORDER BY priority DESC, updated_at DESC
       LIMIT ?`,
      params
    ).map(decodeSkillQueue);
  }

  assignAgentToQueue(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.queue_id) throw new Error('queue_id is required');
    if (!input.agent_id) throw new Error('agent_id is required');
    const workspaceId = input.workspace_id || 'default';
    run(
      this.db,
      `INSERT INTO voice_queue_memberships
        (id, tenant_id, workspace_id, queue_id, agent_id, status, priority, metadata, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, queue_id, agent_id) DO UPDATE SET
         status = excluded.status,
         priority = excluded.priority,
         metadata = excluded.metadata,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('vqmem'),
        input.tenant_id,
        workspaceId,
        input.queue_id,
        input.agent_id,
        input.status || 'active',
        Number(input.priority ?? 50),
        json(input.metadata || {}),
        input.actor_id || 'system'
      ]
    );
    const membership = this.getQueueMembership(input.tenant_id, workspaceId, input.queue_id, input.agent_id);
    this.runStore?.audit(input.tenant_id, 'voice.skill_queue.agent_assigned', 'voice_queue_membership', membership.id, {
      workspace_id: workspaceId,
      queue_id: input.queue_id,
      agent_id: input.agent_id,
      status: membership.status
    }, input.actor_id || 'system');
    return membership;
  }

  getQueueMembership(tenantId, workspaceId, queueId, agentId) {
    const row = one(
      this.db,
      `SELECT * FROM voice_queue_memberships
       WHERE tenant_id = ? AND workspace_id = ? AND queue_id = ? AND agent_id = ?`,
      [tenantId, workspaceId, queueId, agentId]
    );
    return row ? decodeQueueMembership(row) : null;
  }

  listQueueMemberships({ tenant_id, workspace_id = null, queue_id = null, agent_id = null, status = null, limit = 200 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (queue_id) {
      clauses.push('queue_id = ?');
      params.push(queue_id);
    }
    if (agent_id) {
      clauses.push('agent_id = ?');
      params.push(agent_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_queue_memberships
       WHERE ${clauses.join(' AND ')}
       ORDER BY priority DESC, updated_at DESC
       LIMIT ?`,
      params
    ).map(decodeQueueMembership);
  }

  createRoutingSnapshot(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const requestedSkills = Array.isArray(input.required_skills) ? input.required_skills : [];
    const queues = this.listSkillQueues({ tenant_id: input.tenant_id, workspace_id: workspaceId, status: 'active', limit: 200 });
    const selectedQueue = input.queue_id
      ? queues.find((queue) => queue.queue_id === input.queue_id) || null
      : queues.find((queue) => requestedSkills.every((skill) => queue.skill_tags.includes(skill))) || queues[0] || null;
    const memberships = selectedQueue
      ? this.listQueueMemberships({ tenant_id: input.tenant_id, workspace_id: workspaceId, queue_id: selectedQueue.queue_id, status: 'active', limit: 200 })
      : [];
    const agents = this.listAgentPresence({ tenant_id: input.tenant_id, workspace_id: workspaceId, limit: 500 });
    const agentById = new Map(agents.map((agent) => [String(agent.agent_id), agent]));
    const eligibleAgents = memberships
      .map((membership) => ({ membership, agent: agentById.get(String(membership.agent_id)) || null }))
      .filter(({ agent }) => agent && agent.status === 'available' && Number(agent.active_call_count || 0) < Number(agent.capacity || 0))
      .filter(({ agent }) => requestedSkills.every((skill) => agent.skills.includes(skill)))
      .sort((left, right) => Number(right.membership.priority || 0) - Number(left.membership.priority || 0));
    const selected = eligibleAgents[0] || null;
    const status = selected ? 'assigned' : selectedQueue ? 'queued' : 'overflow';
    const payload = {
      route_id: input.route_id || 'default',
      requested_skills: requestedSkills,
      queue: selectedQueue,
      eligible_agent_count: eligibleAgents.length,
      available_agent_count: agents.filter((agent) => agent.status === 'available').length,
      selected_agent: selected?.agent || null,
      decision_reason: selected
        ? 'available_skill_queue_agent'
        : selectedQueue
          ? 'no_available_agent_capacity'
          : 'no_active_skill_queue'
    };
    const snapshotId = id('vrouting');
    run(
      this.db,
      `INSERT INTO voice_routing_snapshots
        (id, tenant_id, workspace_id, route_id, queue_id, selected_agent_id, status, payload, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        input.tenant_id,
        workspaceId,
        input.route_id || 'default',
        selectedQueue?.queue_id || '',
        selected?.agent?.agent_id || '',
        status,
        json(payload),
        input.actor_id || 'system'
      ]
    );
    const snapshot = this.getRoutingSnapshot(input.tenant_id, snapshotId);
    this.runStore?.audit(input.tenant_id, 'voice.routing.snapshot_created', 'voice_routing_snapshot', snapshot.id, {
      workspace_id: workspaceId,
      route_id: snapshot.route_id,
      queue_id: snapshot.queue_id,
      status: snapshot.status
    }, input.actor_id || 'system');
    return snapshot;
  }

  getRoutingSnapshot(tenantId, snapshotId) {
    const row = one(this.db, 'SELECT * FROM voice_routing_snapshots WHERE tenant_id = ? AND id = ?', [tenantId, snapshotId]);
    return row ? decodeRoutingSnapshot(row) : null;
  }

  listRoutingSnapshots({ tenant_id, workspace_id = null, route_id = null, status = null, limit = 50 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (route_id) {
      clauses.push('route_id = ?');
      params.push(route_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_routing_snapshots
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeRoutingSnapshot);
  }

  upsertPolicy(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const policyId = input.policy_id || 'default';
    run(
      this.db,
      `INSERT INTO tenant_voice_policies
        (id, tenant_id, workspace_id, policy_id, require_outbound_consent, recording_mode, recording_retention_days, consent_ttl_days, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, policy_id) DO UPDATE SET
         require_outbound_consent = excluded.require_outbound_consent,
         recording_mode = excluded.recording_mode,
         recording_retention_days = excluded.recording_retention_days,
         consent_ttl_days = excluded.consent_ttl_days,
         status = excluded.status,
         updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        id('vpolicy'),
        input.tenant_id,
        workspaceId,
        policyId,
        input.require_outbound_consent ? 1 : 0,
        input.recording_mode || 'disabled',
        Number(input.recording_retention_days || 30),
        Number(input.consent_ttl_days || 365),
        input.status || 'active',
        input.actor_id || 'system',
        input.actor_id || 'system'
      ]
    );
    const policy = this.getPolicy(input.tenant_id, workspaceId, policyId);
      this.runStore?.audit(input.tenant_id, 'voice.policy.upserted', 'tenant_voice_policy', policy.id, {
        policy_id: policy.policy_id,
        require_outbound_consent: policy.require_outbound_consent,
        recording_mode: policy.recording_mode,
        recording_retention_days: policy.recording_retention_days
      }, input.actor_id || 'system');
    return policy;
  }

  getPolicy(tenantId, workspaceId = 'default', policyId = 'default') {
    const row = one(
      this.db,
      `SELECT * FROM tenant_voice_policies
       WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ?`,
      [tenantId, workspaceId, policyId]
    );
    return row ? decodeVoicePolicy(row) : defaultVoicePolicy(tenantId, workspaceId, policyId);
  }

  listPolicies({ tenant_id, workspace_id = null, status = null, limit = 50 }) {
    const conditions = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      conditions.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM tenant_voice_policies
       WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      params
    ).map(decodeVoicePolicy);
  }

  recordConsent(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const subject = resolveConsentSubject(input);
    const consentType = input.consent_type || 'outbound_call';
    const expiresAt = input.expires_at || new Date(Date.now() + Number(input.ttl_days || 365) * 24 * 60 * 60 * 1000).toISOString();
    const consentId = id('vconsent');
    run(
      this.db,
      `INSERT INTO voice_call_consents
        (id, tenant_id, workspace_id, subject_type, subject_id, phone_redacted, consent_type, status, evidence, expires_at, granted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        consentId,
        input.tenant_id,
        workspaceId,
        subject.subject_type,
        subject.subject_id,
        redactPhone(input.phone || input.phone_redacted || ''),
        consentType,
        input.status || 'granted',
        json(input.evidence || {}),
        expiresAt,
        input.actor_id || input.granted_by || 'system'
      ]
    );
    const consent = this.getConsent(input.tenant_id, consentId);
    this.runStore?.audit(input.tenant_id, 'voice.consent.recorded', 'voice_call_consent', consent.id, {
      subject_type: subject.subject_type,
      consent_type: consentType,
      expires_at: expiresAt
    }, input.actor_id || 'system');
    return consent;
  }

  getConsent(tenantId, consentId) {
    const row = one(this.db, 'SELECT * FROM voice_call_consents WHERE tenant_id = ? AND id = ?', [tenantId, consentId]);
    return row ? decodeVoiceConsent(row) : null;
  }

  findActiveConsent(input) {
    const row = one(
      this.db,
      `SELECT * FROM voice_call_consents
       WHERE tenant_id = ? AND workspace_id = ? AND subject_type = ? AND subject_id = ?
         AND consent_type = ? AND status = 'granted'
         AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
       ORDER BY created_at DESC
       LIMIT 1`,
      [
        input.tenant_id,
        input.workspace_id || 'default',
        input.subject_type,
        input.subject_id,
        input.consent_type || 'outbound_call'
      ]
    );
    return row ? decodeVoiceConsent(row) : null;
  }

  listConsents({ tenant_id, workspace_id = null, subject_type = null, subject_id = null, status = null, limit = 50 }) {
    const conditions = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      conditions.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (subject_type) {
      conditions.push('subject_type = ?');
      params.push(subject_type);
    }
    if (subject_id) {
      conditions.push('subject_id = ?');
      params.push(subject_id);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_call_consents
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeVoiceConsent);
  }

  ingestRecording(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const session = input.call_session_id
      ? this.getCallSession(input.tenant_id, input.call_session_id)
      : input.rustpbx_call_id
        ? this.getCallSessionByRustpbxId(input.tenant_id, input.rustpbx_call_id)
        : null;
    if (!session) throw new Error('call session is required for voice recording ingest');
    const policy = this.getPolicy(input.tenant_id, workspaceId);
    if (policy.status === 'active' && policy.recording_mode === 'disabled') {
      throw new Error(`voice recording disabled by tenant policy for call_session:${session.id}`);
    }
    const recordingConsent = policy.status === 'active' && policy.recording_mode === 'consent_required'
      ? this.findActiveConsent({
          tenant_id: input.tenant_id,
          workspace_id: workspaceId,
          ...resolveConsentSubject({
            lead_id: session.lead_id,
            customer_id: session.customer_id,
            phone_redacted: session.phone_redacted
          }),
          consent_type: 'recording'
        })
      : null;
    if (policy.status === 'active' && policy.recording_mode === 'consent_required' && !recordingConsent) {
      throw new Error(`voice recording consent required for call_session:${session.id}`);
    }
    const recordingId = id('vrecording');
    const capturedAt = input.captured_at || new Date().toISOString();
    const retentionDays = Number(input.retention_days || policy.recording_retention_days || 30);
    const retentionUntil = input.retention_until || new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
    run(
      this.db,
      `INSERT INTO voice_recordings
        (id, tenant_id, workspace_id, call_session_id, provider, provider_recording_id, status, recording_mode, consent_id,
         phone_redacted, duration_seconds, recording_url, retention_until, captured_at, metadata, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordingId,
        input.tenant_id,
        workspaceId,
        session.id,
        input.provider || session.provider || 'rustpbx',
        input.provider_recording_id || '',
        input.status || 'available',
        policy.recording_mode || 'disabled',
        recordingConsent?.id || null,
        session.phone_redacted || '',
        Number(input.duration_seconds || 0),
        input.recording_url || '',
        retentionUntil,
        capturedAt,
        json(input.metadata || {}),
        input.actor_id || 'system'
      ]
    );
    const recording = this.getRecording(input.tenant_id, recordingId);
    this.updateCallSession(input.tenant_id, session.id, {
      metadata: {
        ...(session.metadata || {}),
        recording_mode: policy.recording_mode,
        latest_recording_id: recording.id,
        recording_retention_until: retentionUntil
      }
    });
    this.runStore?.audit(input.tenant_id, 'voice.recording.ingested', 'voice_recording', recording.id, {
      call_session_id: session.id,
      provider: recording.provider,
      recording_mode: recording.recording_mode,
      consent_id: recording.consent_id,
      retention_until: retentionUntil
    }, input.actor_id || 'system');
    return recording;
  }

  getRecording(tenantId, recordingId) {
    const row = one(this.db, 'SELECT * FROM voice_recordings WHERE tenant_id = ? AND id = ?', [tenantId, recordingId]);
    return row ? decodeVoiceRecording(row) : null;
  }

  listRecordings({ tenant_id, workspace_id = null, call_session_id = null, status = null, due_before = null, limit = 50 }) {
    const conditions = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      conditions.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (call_session_id) {
      conditions.push('call_session_id = ?');
      params.push(call_session_id);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (due_before) {
      conditions.push('retention_until IS NOT NULL');
      conditions.push('datetime(retention_until) <= datetime(?)');
      params.push(due_before);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_recordings
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeVoiceRecording);
  }

  upsertMediaStoragePolicy(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const policyId = input.policy_id || 'default';
    const retentionTiers = Array.isArray(input.retention_tiers) ? input.retention_tiers : [];
    run(
      this.db,
      `INSERT INTO voice_media_storage_policies
        (id, tenant_id, workspace_id, policy_id, storage_provider, archive_url_base, retention_tiers, purge_mode, status, metadata, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, policy_id) DO UPDATE SET
         storage_provider = excluded.storage_provider,
         archive_url_base = excluded.archive_url_base,
         retention_tiers = excluded.retention_tiers,
         purge_mode = excluded.purge_mode,
         status = excluded.status,
         metadata = excluded.metadata,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('vmedia'),
        input.tenant_id,
        workspaceId,
        policyId,
        input.storage_provider || 'opc-native-webrtc',
        input.archive_url_base || '',
        json(retentionTiers),
        input.purge_mode || 'archive_before_delete',
        input.status || 'active',
        json(input.metadata || {}),
        input.actor_id || 'system'
      ]
    );
    const policy = this.getMediaStoragePolicy(input.tenant_id, workspaceId, policyId);
    this.runStore?.audit(input.tenant_id, 'voice.media_storage_policy.upserted', 'voice_media_storage_policy', policy.id, {
      workspace_id: workspaceId,
      policy_id: policy.policy_id,
      purge_mode: policy.purge_mode
    }, input.actor_id || 'system');
    return policy;
  }

  getMediaStoragePolicy(tenantId, workspaceId = 'default', policyId = 'default') {
    const row = one(
      this.db,
      `SELECT * FROM voice_media_storage_policies
       WHERE tenant_id = ? AND workspace_id = ? AND policy_id = ?`,
      [tenantId, workspaceId, policyId]
    );
    return row ? decodeMediaStoragePolicy(row) : defaultMediaStoragePolicy(tenantId, workspaceId, policyId);
  }

  listMediaStoragePolicies({ tenant_id, workspace_id = null, status = null, limit = 50 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_media_storage_policies
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      params
    ).map(decodeMediaStoragePolicy);
  }

  planRecordingRetention(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const now = input.now || input.due_before || new Date().toISOString();
    const mediaPolicy = this.getMediaStoragePolicy(input.tenant_id, workspaceId, input.policy_id || 'default');
    const expireCandidates = this.listRetentionCandidates({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      action: 'expire',
      due_before: now,
      limit: input.limit || 100
    });
    const archiveCandidates = this.listRetentionCandidates({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      action: 'archive',
      due_before: now,
      limit: input.limit || 100
    });
    const purgeCandidates = this.listRetentionCandidates({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      action: 'delete',
      due_before: now,
      limit: input.limit || 100
    });
    const recommendedAction = mediaPolicy.purge_mode === 'manual_review'
      ? 'manual_review'
      : purgeCandidates.length
        ? 'delete'
        : archiveCandidates.length
          ? 'archive'
          : expireCandidates.length
            ? 'expire'
            : 'none';
    return {
      policy: mediaPolicy,
      generated_at: now,
      summary: {
        expire_candidates: expireCandidates.length,
        archive_candidates: archiveCandidates.length,
        purge_candidates: purgeCandidates.length,
        recommended_action: recommendedAction,
        archive_before_delete: mediaPolicy.purge_mode === 'archive_before_delete',
        live_media_storage_configured: Boolean(mediaPolicy.archive_url_base || this.resolveWebrtcRuntimeConfig(input.tenant_id, workspaceId).media_service_url)
      },
      batches: {
        expire: expireCandidates,
        archive: archiveCandidates,
        delete: purgeCandidates
      },
      execution_guidance: buildRetentionExecutionGuidance(mediaPolicy, recommendedAction)
    };
  }

  async enforceRecordingRetention(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const now = input.now || input.due_before || new Date().toISOString();
    const action = input.action || 'expire';
    if (!['archive', 'expire', 'delete'].includes(action)) throw new Error(`unsupported retention action: ${action}`);
    const candidates = this.listRetentionCandidates({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      action,
      due_before: now,
      limit: input.limit || 100
    });
    if (input.dry_run) {
      return {
        action,
        dry_run: true,
        now,
        candidate_count: candidates.length,
        candidates
      };
    }
    const updated = await Promise.all(candidates.map((recording) => this.transitionRecordingRetention(input.tenant_id, recording, {
        action,
        actor_id: input.actor_id || 'system',
        now,
        workspace_id: workspaceId,
        archive_url_base: input.archive_url_base,
        archive_url: input.archive_url,
        execute_live: input.execute_live !== false
      })));
    this.runStore?.audit(input.tenant_id, `voice.recording.retention_${action}d`, 'voice_recording_batch', `retention_${action}`, {
      workspace_id: workspaceId,
      action,
      candidate_count: candidates.length,
      now
    }, input.actor_id || 'system');
    return {
      action,
      dry_run: false,
      now,
      candidate_count: candidates.length,
      updated
    };
  }

  async transitionRecordingRetention(tenantId, recording, { action, actor_id = 'system', now, workspace_id = 'default', archive_url_base = '', archive_url = '', execute_live = true }) {
    const nextStatus = action === 'expire' ? 'expired' : action === 'archive' ? 'archived' : 'deleted';
    const runtimeWebrtcConfig = action === 'expire' ? null : this.resolveWebrtcRuntimeConfig(tenantId, workspace_id);
    const liveResult = execute_live && runtimeWebrtcConfig && this.voiceMediaClient?.isConfigured?.(runtimeWebrtcConfig)
      ? await this.executeLiveRetentionOperation({
          tenant_id: tenantId,
          recording,
          action,
          runtimeConfig: runtimeWebrtcConfig,
          archive_url_base,
          archive_url
        })
      : null;
    const archivedRecordingUrl = action === 'archive'
      ? String(liveResult?.archived_recording_url || resolveArchivedRecordingUrl(recording, {
          archive_url_base: archive_url_base || runtimeWebrtcConfig?.recording_archive_url_base || '',
          archive_url
        }))
      : '';
    const nextMetadata = {
      ...(recording.metadata || {}),
      retention_action: action,
      retention_action_at: now,
      retention_action_by: actor_id,
      retention_execution_mode: liveResult ? 'rust_media_sidecar' : 'control_plane',
      retention_boundary: String(liveResult?.boundary || 'node_runtime'),
      ...(action === 'archive'
        ? {
            archived_at: now,
            archived_by: actor_id,
            archived_recording_url: archivedRecordingUrl || recording.recording_url || ''
          }
        : {}),
      ...(action === 'delete'
        ? {
            purged_at: now,
            purged_by: actor_id,
            purged_recording_url: String(liveResult?.purged_recording_url || recording.metadata?.archived_recording_url || recording.recording_url || '')
          }
        : {}),
      ...(liveResult ? { retention_operation_result: liveResult } : {})
    };
    const fields = ['status = ?', 'metadata = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [nextStatus, json(nextMetadata)];
    if (action === 'archive') {
      fields.splice(2, 0, 'recording_url = ?');
      params.push(archivedRecordingUrl || recording.recording_url || '');
    }
    if (action === 'delete') {
      fields.splice(2, 0, 'recording_url = ?');
      params.push('');
    }
    params.push(tenantId, recording.id);
    run(this.db, `UPDATE voice_recordings SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    const updated = this.getRecording(tenantId, recording.id);
    this.runStore?.audit(tenantId, `voice.recording.${nextStatus}`, 'voice_recording', recording.id, {
      previous_status: recording.status,
      next_status: nextStatus,
      retention_until: recording.retention_until,
      boundary: liveResult?.boundary || 'node_runtime'
    }, actor_id);
    return updated;
  }

  async executeLiveRetentionOperation({ tenant_id, recording, action, runtimeConfig, archive_url_base = '', archive_url = '' }) {
    if (action === 'archive') {
      return await this.voiceMediaClient.archiveRecording({
        runtimeConfig,
        tenant_id,
        recording_id: recording.id,
        provider_recording_id: recording.provider_recording_id || '',
        recording_url: recording.recording_url || '',
        archive_url,
        archive_url_base: archive_url_base || runtimeConfig.recording_archive_url_base || '',
        metadata: recording.metadata || {}
      });
    }
    if (action === 'delete') {
      return await this.voiceMediaClient.purgeRecording({
        runtimeConfig,
        tenant_id,
        recording_id: recording.id,
        provider_recording_id: recording.provider_recording_id || '',
        recording_url: recording.recording_url || '',
        archived_recording_url: recording.metadata?.archived_recording_url || recording.recording_url || '',
        metadata: recording.metadata || {}
      });
    }
    return null;
  }

  listRetentionCandidates({ tenant_id, workspace_id = 'default', action = 'expire', due_before = null, limit = 100 }) {
    const statuses = action === 'expire'
      ? ['available']
      : action === 'archive'
        ? ['available', 'expired']
        : ['archived', 'expired'];
    const placeholders = statuses.map(() => '?').join(', ');
    const params = [tenant_id, workspace_id, ...statuses];
    let sql = `SELECT * FROM voice_recordings
      WHERE tenant_id = ?
        AND workspace_id = ?
        AND status IN (${placeholders})`;
    if (due_before) {
      sql += ' AND retention_until IS NOT NULL AND datetime(retention_until) <= datetime(?)';
      params.push(due_before);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return all(this.db, sql, params).map(decodeVoiceRecording);
  }

  assertOutboundAllowed(input) {
    const workspaceId = input.workspace_id || 'default';
    const policy = this.getPolicy(input.tenant_id, workspaceId);
    if (policy.status !== 'active') return { policy, consent: null };
    const requiresOutboundConsent = policy.require_outbound_consent || policy.recording_mode === 'consent_required';
    if (!requiresOutboundConsent) return { policy, consent: null };
    const subject = resolveConsentSubject(input);
    const consent = this.findActiveConsent({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      ...subject,
      consent_type: 'outbound_call'
    });
    if (!consent) {
      const error = new Error(`outbound call consent required for ${subject.subject_type}:${subject.subject_id}`);
      error.status = 409;
      throw error;
    }
    return { policy, consent };
  }

  async createWebrtcSession(input) {
    const runtimeWebrtcConfig = this.resolveWebrtcRuntimeConfig(input.tenant_id, input.workspace_id || 'default');
    const expiresAt = input.expires_at || new Date(Date.now() + Number(input.ttl_seconds || 900) * 1000).toISOString();
    const issuance = this.voiceMediaClient?.isConfigured?.(runtimeWebrtcConfig)
      ? await this.voiceMediaClient.issueWebrtcSession({
          runtimeConfig: runtimeWebrtcConfig,
          tenant_id: input.tenant_id,
          call_session_id: input.call_session_id || null,
          endpoint_id: input.endpoint_id || 'browser',
          token: input.token,
          ttl_seconds: Number(input.ttl_seconds || 900),
          status: input.status || 'initialized',
          expires_at: expiresAt,
          ice_servers: input.ice_servers || runtimeWebrtcConfig.ice_servers
        })
      : null;
    const token = issuance?.token || input.token || randomBytes(24).toString('base64url');
    const session = {
      id: id('webrtc'),
      tenant_id: input.tenant_id,
      call_session_id: input.call_session_id || null,
      endpoint_id: input.endpoint_id || 'browser',
      status: input.status || 'initialized',
      token_hash: issuance?.token_hash || hashToken(token),
      ice_servers: issuance?.ice_servers || input.ice_servers || runtimeWebrtcConfig.ice_servers,
      expires_at: issuance?.expires_at || expiresAt
    };
    run(
      this.db,
      `INSERT INTO voice_webrtc_sessions
        (id, tenant_id, call_session_id, endpoint_id, status, token_hash, ice_servers, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.tenant_id,
        session.call_session_id,
        session.endpoint_id,
        session.status,
        session.token_hash,
        json(session.ice_servers),
        session.expires_at
      ]
    );
    if (session.call_session_id) {
      this.updateCallSession(session.tenant_id, session.call_session_id, { webrtc_session_id: session.id });
    }
    this.runStore?.audit(session.tenant_id, 'voice.webrtc_session.created', 'voice_webrtc_session', session.id, {
      call_session_id: session.call_session_id,
      endpoint_id: session.endpoint_id
    });
    return { session: this.getWebrtcSession(session.tenant_id, session.id), token, boundary: issuance?.boundary || 'node_runtime' };
  }

  recordSignal(input) {
    const session = this.getWebrtcSession(input.tenant_id, input.webrtc_session_id);
    if (!session) throw new Error(`webrtc session not found: ${input.webrtc_session_id}`);
    if (new Date(session.expires_at).getTime() < Date.now()) {
      this.updateWebrtcSession(input.tenant_id, input.webrtc_session_id, { status: 'expired' });
      throw new Error('webrtc session expired');
    }
    run(
      this.db,
      `INSERT INTO voice_webrtc_signals (id, tenant_id, webrtc_session_id, signal_type, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [id('wsig'), input.tenant_id, input.webrtc_session_id, input.signal_type, json(input.payload || {})]
    );
    const nextStatus = signalStatus(input.signal_type);
    if (nextStatus) this.updateWebrtcSession(input.tenant_id, input.webrtc_session_id, { status: nextStatus });
    this.runStore?.audit(input.tenant_id, 'voice.webrtc_signal.recorded', 'voice_webrtc_session', input.webrtc_session_id, {
      signal_type: input.signal_type
    });
    return {
      session: this.getWebrtcSession(input.tenant_id, input.webrtc_session_id),
      signals: this.listSignals(input.tenant_id, input.webrtc_session_id)
    };
  }

  updateWebrtcSession(tenantId, webrtcSessionId, patch) {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(tenantId, webrtcSessionId);
    run(this.db, `UPDATE voice_webrtc_sessions SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    return this.getWebrtcSession(tenantId, webrtcSessionId);
  }

  getWebrtcSession(tenantId, webrtcSessionId) {
    const row = one(this.db, 'SELECT * FROM voice_webrtc_sessions WHERE tenant_id = ? AND id = ?', [
      tenantId,
      webrtcSessionId
    ]);
    return row ? decodeWebrtcSession(row) : null;
  }

  listSignals(tenantId, webrtcSessionId) {
    return all(
      this.db,
      `SELECT * FROM voice_webrtc_signals
       WHERE tenant_id = ? AND webrtc_session_id = ?
       ORDER BY created_at ASC`,
       [tenantId, webrtcSessionId]
     ).map((row) => ({ ...row, payload: parseJson(row.payload) }));
  }

  captureDeploymentSnapshot(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const generatedAt = input.generated_at || new Date().toISOString();
    const rustpbx = this.resolveIntegrationDeployment({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: 'rustpbx',
      url_keys: ['base_url'],
      required_secret_keys: ['api_token']
    });
    const webrtc = this.resolveWebrtcDeployment({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId
    });
    const status = deriveDeploymentStatus([rustpbx.status, webrtc.status]);
    const snapshot = {
      id: id('vdeploy'),
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      status,
      payload: {
        generated_at: generatedAt,
        rustpbx,
        webrtc
      },
      created_by: input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO voice_runtime_deployment_snapshots
        (id, tenant_id, workspace_id, status, payload, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [snapshot.id, snapshot.tenant_id, snapshot.workspace_id, snapshot.status, json(snapshot.payload), snapshot.created_by]
    );
    const stored = this.getDeploymentSnapshot(input.tenant_id, snapshot.id);
    this.runStore?.audit(input.tenant_id, 'voice.runtime_deployment.snapshot_created', 'voice_runtime_deployment_snapshot', stored.id, {
      workspace_id: workspaceId,
      status: stored.status
    }, input.actor_id || 'system');
    return stored;
  }

  getDeploymentSnapshot(tenantId, snapshotId) {
    const row = one(this.db, 'SELECT * FROM voice_runtime_deployment_snapshots WHERE tenant_id = ? AND id = ?', [tenantId, snapshotId]);
    return row ? decodeVoiceRuntimeDeploymentSnapshot(row) : null;
  }

  listDeploymentSnapshots({ tenant_id, workspace_id = null, status = null, limit = 20 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_runtime_deployment_snapshots
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeVoiceRuntimeDeploymentSnapshot);
  }

  rotateRuntimeCredential(input) {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!this.integrationConfigStore?.upsertSecretRef) throw new Error('integration config store is required for credential rotation');
    const workspaceId = input.workspace_id || 'default';
    const integrationId = String(input.integration_id || '');
    const secretKey = String(input.secret_key || '');
    if (!isVoiceRuntimeIntegration(integrationId)) {
      throw new Error(`unsupported voice runtime integration: ${integrationId}`);
    }
    if (!isVoiceRuntimeSecret(integrationId, secretKey)) {
      throw new Error(`unsupported voice runtime secret key: ${integrationId}.${secretKey}`);
    }
    if (!input.secret_value) throw new Error('secret_value is required');
    const previous = this.integrationConfigStore.getSecretRef?.(input.tenant_id, workspaceId, integrationId, secretKey) || null;
    const secretRef = this.integrationConfigStore.upsertSecretRef({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: integrationId,
      secret_key: secretKey,
      secret_value: input.secret_value,
      env_var_name: input.env_var_name || previous?.env_var_name || '',
      status: 'active'
    });
    const rotation = {
      id: id('vcred'),
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: integrationId,
      secret_key: secretKey,
      secret_ref_id: secretRef.id,
      previous_secret_fingerprint: previous?.secret_fingerprint || '',
      next_secret_fingerprint: secretRef.secret_fingerprint || '',
      previous_env_var_name: previous?.env_var_name || '',
      next_env_var_name: secretRef.env_var_name || '',
      status: 'rotated',
      reason: input.reason || '',
      metadata: {
        ...(input.metadata || {}),
        previous_secret_ref_id: previous?.id || null,
        reused_secret_ref_id: previous?.id === secretRef.id
      },
      created_by: input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO voice_credential_rotations
        (id, tenant_id, workspace_id, integration_id, secret_key, secret_ref_id, previous_secret_fingerprint, next_secret_fingerprint,
         previous_env_var_name, next_env_var_name, status, reason, metadata, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rotation.id,
        rotation.tenant_id,
        rotation.workspace_id,
        rotation.integration_id,
        rotation.secret_key,
        rotation.secret_ref_id,
        rotation.previous_secret_fingerprint,
        rotation.next_secret_fingerprint,
        rotation.previous_env_var_name,
        rotation.next_env_var_name,
        rotation.status,
        rotation.reason,
        json(rotation.metadata),
        rotation.created_by
      ]
    );
    const stored = this.getCredentialRotation(input.tenant_id, rotation.id);
    const health = this.integrationConfigStore.healthCheck({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      integration_id: integrationId,
      required_secret_keys: [secretKey]
    });
    this.runStore?.audit(input.tenant_id, 'voice.runtime_credential.rotated', 'voice_credential_rotation', stored.id, {
      integration_id: integrationId,
      secret_key: secretKey,
      env_var_name: secretRef.env_var_name
    }, input.actor_id || 'system');
    return {
      rotation: stored,
      secret_ref: secretRef,
      health: health.health
    };
  }

  getCredentialRotation(tenantId, rotationId) {
    const row = one(this.db, 'SELECT * FROM voice_credential_rotations WHERE tenant_id = ? AND id = ?', [tenantId, rotationId]);
    return row ? decodeVoiceCredentialRotation(row) : null;
  }

  listCredentialRotations({ tenant_id, workspace_id = null, integration_id = null, secret_key = null, limit = 20 }) {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(workspace_id);
    }
    if (integration_id) {
      clauses.push('integration_id = ?');
      params.push(integration_id);
    }
    if (secret_key) {
      clauses.push('secret_key = ?');
      params.push(secret_key);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM voice_credential_rotations
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeVoiceCredentialRotation);
  }

  resolveWebrtcRuntimeConfig(tenantId, workspaceId = 'default') {
    if (!this.integrationConfigStore) {
      return {
        ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
        source: 'default',
        media_service_url: process.env.OPC_VOICE_MEDIA_URL || null,
        media_api_token: process.env.OPC_VOICE_MEDIA_API_TOKEN || null,
        recording_archive_url_base: process.env.OPC_VOICE_MEDIA_ARCHIVE_URL_BASE || null
      };
    }
    const config = this.integrationConfigStore.getConfig(tenantId, workspaceId, 'opc-native-webrtc');
    if (!config || config.status === 'disabled') {
      return {
        ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
        source: 'default',
        media_service_url: process.env.OPC_VOICE_MEDIA_URL || null,
        media_api_token: process.env.OPC_VOICE_MEDIA_API_TOKEN || null,
        recording_archive_url_base: process.env.OPC_VOICE_MEDIA_ARCHIVE_URL_BASE || null
      };
    }
    const runtime = this.integrationConfigStore.resolveRuntimeConfig({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      integration_id: 'opc-native-webrtc'
    });
    return {
      source: runtime.runtime_status === 'ready' ? 'tenant_config' : 'default',
      runtime_status: runtime.runtime_status,
      missing_secret_keys: runtime.missing_secret_keys,
      ice_servers: buildIceServers(runtime.runtime_config),
      media_service_url: runtime.runtime_config?.media_service_url || runtime.runtime_config?.media_url || process.env.OPC_VOICE_MEDIA_URL || null,
      media_api_token: runtime.runtime_config?.media_api_token || process.env.OPC_VOICE_MEDIA_API_TOKEN || null,
      recording_archive_url_base: runtime.runtime_config?.recording_archive_url_base || runtime.runtime_config?.archive_url_base || process.env.OPC_VOICE_MEDIA_ARCHIVE_URL_BASE || null
    };
  }

  resolveIntegrationDeployment({ tenant_id, workspace_id = 'default', integration_id, url_keys = [], required_secret_keys = [] }) {
    if (!this.integrationConfigStore) {
      return {
        integration_id,
        config_status: 'not_configured',
        runtime_status: 'not_configured',
        status: 'not_configured',
        url: null,
        missing_secret_keys: required_secret_keys,
        source: 'none'
      };
    }
    const config = this.integrationConfigStore.getConfig(tenant_id, workspace_id, integration_id);
    if (!config || config.status === 'disabled') {
      return {
        integration_id,
        config_status: config?.status || 'not_configured',
        runtime_status: config?.status === 'disabled' ? 'disabled' : 'not_configured',
        status: 'not_configured',
        url: null,
        missing_secret_keys: [],
        source: 'none',
        last_checked_at: config?.last_checked_at || null
      };
    }
    const runtime = this.integrationConfigStore.resolveRuntimeConfig({
      tenant_id,
      workspace_id,
      integration_id,
      required_secret_keys
    });
    const url = firstString(runtime.runtime_config, url_keys);
    return {
      integration_id,
      config_status: config.status,
      health_status: config.health_status || null,
      last_checked_at: config.last_checked_at || null,
      runtime_status: runtime.runtime_status,
      status: runtime.runtime_status === 'ready' && url ? 'ready' : 'degraded',
      url,
      missing_secret_keys: runtime.missing_secret_keys,
      source: url ? 'tenant_config' : 'configured_without_url'
    };
  }

  resolveWebrtcDeployment({ tenant_id, workspace_id = 'default' }) {
    const config = this.integrationConfigStore?.getConfig(tenant_id, workspace_id, 'opc-native-webrtc');
    const runtimeConfig = this.resolveWebrtcRuntimeConfig(tenant_id, workspace_id);
    const requiresTurnSecret = runtimeConfig.source === 'tenant_config'
      && Boolean(firstString(runtimeConfig, ['media_service_url']) || hasTurnCredentialedServer(runtimeConfig.ice_servers));
    return {
      integration_id: 'opc-native-webrtc',
      config_status: config?.status || 'not_configured',
      health_status: config?.health_status || null,
      last_checked_at: config?.last_checked_at || null,
      runtime_status: runtimeConfig.runtime_status || (runtimeConfig.source === 'tenant_config' ? 'ready' : 'not_configured'),
      status: runtimeConfig.source === 'tenant_config'
        ? runtimeConfig.runtime_status === 'ready'
          ? 'ready'
          : 'degraded'
        : runtimeConfig.media_service_url
          ? 'ready'
          : 'not_configured',
      source: runtimeConfig.source,
      media_service_url: runtimeConfig.media_service_url || null,
      archive_execution_enabled: Boolean(runtimeConfig.media_service_url),
      recording_archive_url_base: runtimeConfig.recording_archive_url_base || null,
      missing_secret_keys: requiresTurnSecret ? runtimeConfig.missing_secret_keys || [] : [],
      ice_server_count: Array.isArray(runtimeConfig.ice_servers) ? runtimeConfig.ice_servers.length : 0,
      ice_servers: runtimeConfig.ice_servers
    };
  }

  getCallCenterOpsOverview({ tenant_id, workspace_id = 'default', limit = 50 }) {
    const agents = this.listAgentPresence({ tenant_id, workspace_id, limit: 500 });
    const queues = this.listSkillQueues({ tenant_id, workspace_id, limit: 200 });
    const memberships = this.listQueueMemberships({ tenant_id, workspace_id, limit: 500 });
    const sessions = this.listCallSessions({ tenant_id, limit });
    const snapshots = this.listRoutingSnapshots({ tenant_id, workspace_id, limit });
    const queueMembershipCount = new Map();
    for (const membership of memberships) {
      if (membership.status !== 'active') continue;
      queueMembershipCount.set(membership.queue_id, Number(queueMembershipCount.get(membership.queue_id) || 0) + 1);
    }
    const activeStatuses = new Set(['queued', 'ringing', 'active']);
    return {
      policy: {
        tenant_id,
        workspace_id
      },
      summary: {
        agent_count: agents.length,
        available_agents: agents.filter((agent) => agent.status === 'available').length,
        busy_agents: agents.filter((agent) => ['busy', 'wrap_up'].includes(agent.status)).length,
        active_queue_count: queues.filter((queue) => queue.status === 'active').length,
        active_call_sessions: sessions.filter((session) => activeStatuses.has(session.status)).length,
        overflow_routing_snapshots: snapshots.filter((snapshot) => snapshot.status === 'overflow').length,
        queued_routing_snapshots: snapshots.filter((snapshot) => snapshot.status === 'queued').length
      },
      queues: queues.map((queue) => ({
        ...queue,
        active_member_count: Number(queueMembershipCount.get(queue.queue_id) || 0)
      })),
      agents,
      recent_sessions: sessions,
      recent_routing_snapshots: snapshots
    };
  }

  getMediaOpsOverview({ tenant_id, workspace_id = 'default', limit = 50 }) {
    const policies = this.listMediaStoragePolicies({ tenant_id, workspace_id, limit: 20 });
    const recordings = this.listRecordings({ tenant_id, workspace_id, limit });
    const dueRecordings = this.listRecordings({ tenant_id, workspace_id, due_before: new Date().toISOString(), limit });
    const latestPlan = this.planRecordingRetention({ tenant_id, workspace_id, limit });
    return {
      policy: {
        tenant_id,
        workspace_id
      },
      summary: {
        media_storage_policy_count: policies.length,
        recording_count: recordings.length,
        due_recording_count: dueRecordings.length,
        available_recordings: recordings.filter((recording) => recording.status === 'available').length,
        archived_recordings: recordings.filter((recording) => recording.status === 'archived').length,
        deleted_recordings: recordings.filter((recording) => recording.status === 'deleted').length,
        recommended_retention_action: latestPlan.summary.recommended_action
      },
      policies,
      retention_plan: latestPlan,
      recent_recordings: recordings
    };
  }
}

export function redactPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length <= 4) return digits ? '****' : '';
  return `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

export function resolveVoiceWritebackStarter(template, callSessionId) {
  const source = asJsonRecord(template);
  if (!source) return null;
  const resolvedCallSessionId = String(callSessionId || source.call_session_id || '').trim();
  const endpointTemplate = String(source.endpoint_template || '').trim();
  const endpoint = String(source.endpoint || '').trim()
    || (resolvedCallSessionId && endpointTemplate
      ? endpointTemplate.replace('{call_session_id}', resolvedCallSessionId)
      : '');
  return {
    ...source,
    call_session_id: resolvedCallSessionId,
    endpoint,
    missing_fields: asStringArray(source.missing_fields).filter((field) => field !== 'call_session_id' || !resolvedCallSessionId)
  };
}

function decodeCallSession(row) {
  return { ...row, metadata: parseJson(row.metadata) };
}

function asJsonRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function decodeCallLog(row) {
  return { ...row, result: parseJson(row.result) };
}

function decodeAgentPresence(row) {
  return {
    ...row,
    capacity: Number(row.capacity || 0),
    active_call_count: Number(row.active_call_count || 0),
    skills: parseJson(row.skills, []),
    metadata: parseJson(row.metadata)
  };
}

function decodeSkillQueue(row) {
  return {
    ...row,
    priority: Number(row.priority || 0),
    max_wait_seconds: Number(row.max_wait_seconds || 0),
    skill_tags: parseJson(row.skill_tags, []),
    metadata: parseJson(row.metadata)
  };
}

function decodeQueueMembership(row) {
  return {
    ...row,
    priority: Number(row.priority || 0),
    metadata: parseJson(row.metadata)
  };
}

function decodeRoutingSnapshot(row) {
  return {
    ...row,
    payload: parseJson(row.payload)
  };
}

function decodeWebrtcSession(row) {
  return { ...row, ice_servers: parseJson(row.ice_servers, []) };
}

function decodeVoicePolicy(row) {
  return {
    ...row,
    require_outbound_consent: Boolean(row.require_outbound_consent)
  };
}

function decodeVoiceConsent(row) {
  return {
    ...row,
    evidence: parseJson(row.evidence)
  };
}

function decodeVoiceRecording(row) {
  return {
    ...row,
    metadata: parseJson(row.metadata)
  };
}

function decodeMediaStoragePolicy(row) {
  return {
    ...row,
    retention_tiers: parseJson(row.retention_tiers, []),
    metadata: parseJson(row.metadata)
  };
}

function decodeVoiceRuntimeDeploymentSnapshot(row) {
  return {
    ...row,
    payload: parseJson(row.payload)
  };
}

function decodeVoiceCredentialRotation(row) {
  return {
    ...row,
    metadata: parseJson(row.metadata)
  };
}

function defaultVoicePolicy(tenantId, workspaceId, policyId) {
  return {
    id: null,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
    require_outbound_consent: false,
    recording_mode: 'disabled',
    recording_retention_days: 30,
    consent_ttl_days: 365,
    status: 'active'
  };
}

function defaultMediaStoragePolicy(tenantId, workspaceId, policyId) {
  return {
    id: null,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    policy_id: policyId,
    storage_provider: 'opc-native-webrtc',
    archive_url_base: '',
    retention_tiers: [],
    purge_mode: 'archive_before_delete',
    status: 'active',
    metadata: {}
  };
}

function normalizeCallDisposition(disposition) {
  const normalized = String(disposition || '').trim().toLowerCase();
  const aliases = {
    answered: 'completed',
    connected: 'completed',
    booked: 'connected_booked',
    appointment: 'connected_booked',
    callback: 'connected_callback',
    noanswer: 'no_answer',
    missed: 'no_answer',
    transfer: 'transfer_required',
    invalid: 'invalid_number',
    not_interested: 'connected_not_interested'
  };
  return aliases[normalized] || normalized || 'completed';
}

function defaultCallNextStepType(disposition) {
  if (disposition === 'connected_booked') return 'appointment';
  if (disposition === 'connected_callback' || disposition === 'no_answer') return 'callback';
  if (disposition === 'transfer_required') return 'transfer';
  if (disposition === 'completed') return 'continue_followup';
  return '';
}

function callNextAction(disposition, input) {
  if (input.next_action) return input.next_action;
  if (disposition === 'connected_booked') return input.appointment_time ? `预约已确认：${input.appointment_time}` : '已预约，按预约时间跟进';
  if (disposition === 'connected_callback') return input.callback_time ? `按客户要求回拨：${input.callback_time}` : '稍后回拨客户';
  if (disposition === 'no_answer') return '未接通，稍后重拨';
  if (disposition === 'transfer_required') return '转人工/主管继续处理';
  if (disposition === 'connected_not_interested') return '标记暂不跟进';
  if (disposition === 'invalid_number') return '号码无效，停止拨打';
  return '记录通话结果并继续下一步';
}

function defaultCallDueHours(nextStepType) {
  if (nextStepType === 'appointment') return 24;
  if (nextStepType === 'callback') return 4;
  if (nextStepType === 'transfer') return 1;
  return 24;
}

function callFollowupTitle(disposition, session) {
  const subject = session.lead_id || session.phone_redacted || session.id;
  if (disposition === 'connected_booked') return `预约后续确认：${subject}`;
  if (disposition === 'connected_callback') return `客户要求回拨：${subject}`;
  if (disposition === 'no_answer') return `未接通重拨：${subject}`;
  if (disposition === 'transfer_required') return `人工升级处理：${subject}`;
  return `通话后继续跟进：${subject}`;
}

function callDispositionLabel(disposition) {
  return {
    connected_booked: '已预约',
    connected_callback: '需回拨',
    connected_not_interested: '暂不考虑',
    transfer_required: '需升级',
    completed: '已接通',
    no_answer: '未接通',
    invalid_number: '号码无效'
  }[disposition] || '已记录通话';
}

function buildRetentionExecutionGuidance(mediaPolicy, recommendedAction) {
  if (recommendedAction === 'none') {
    return {
      next_tool: null,
      approval_required: false,
      reason: 'no_due_recordings'
    };
  }
  if (recommendedAction === 'manual_review') {
    return {
      next_tool: 'voice.recording_retention_enforce',
      approval_required: false,
      reason: 'media_storage_policy_requires_manual_review',
      suggested_action: 'archive'
    };
  }
  return {
    next_tool: 'voice.recording_retention_enforce',
    approval_required: false,
    suggested_action: recommendedAction,
    archive_url_base: mediaPolicy.archive_url_base || ''
  };
}

function resolveConsentSubject(input) {
  if (input.lead_id) return { subject_type: 'lead', subject_id: input.lead_id };
  if (input.customer_id) return { subject_type: 'customer', subject_id: input.customer_id };
  const redacted = redactPhone(input.phone || input.phone_redacted || '');
  if (redacted) return { subject_type: 'phone', subject_id: redacted };
  throw new Error('lead_id, customer_id, or phone is required for voice consent');
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function mapRustpbxStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (['queued', 'created', 'dialing'].includes(normalized)) return 'queued';
  if (['ringing'].includes(normalized)) return 'ringing';
  if (['answered', 'active', 'connected'].includes(normalized)) return 'active';
  if (['completed', 'hangup', 'ended'].includes(normalized)) return 'completed';
  if (['failed', 'error'].includes(normalized)) return 'failed';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  return 'queued';
}

function signalStatus(signalType) {
  if (signalType === 'offer') return 'offer_created';
  if (signalType === 'answer') return 'answer_received';
  if (signalType === 'ice_candidate') return 'connected';
  if (signalType === 'hangup') return 'ended';
  return null;
}

function buildIceServers(runtimeConfig: JsonRecord = {}) {
  if (Array.isArray(runtimeConfig.ice_servers) && runtimeConfig.ice_servers.length) {
    return runtimeConfig.ice_servers;
  }
  const servers = [];
  const stunUrls = normalizeUrlList(runtimeConfig.stun_urls || runtimeConfig.stun_url);
  if (stunUrls.length) servers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls });
  const turnUrls = normalizeUrlList(runtimeConfig.turn_urls || runtimeConfig.turn_url);
  if (turnUrls.length) {
    servers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: runtimeConfig.turn_username || '',
      credential: runtimeConfig.turn_password || '',
      credentialType: runtimeConfig.turn_credential_type || 'password'
    });
  }
  return servers.length ? servers : [{ urls: 'stun:stun.l.google.com:19302' }];
}

function normalizeUrlList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function resolveArchivedRecordingUrl(recording, { archive_url_base = '', archive_url = '' }) {
  if (archive_url) return archive_url;
  if (!archive_url_base) return recording.recording_url || '';
  const base = String(archive_url_base).replace(/\/+$/, '');
  const fileName = recording.provider_recording_id || recording.id;
  return `${base}/${fileName}`;
}

function deriveDeploymentStatus(statuses) {
  if (statuses.every((status) => status === 'not_configured')) return 'not_configured';
  return statuses.every((status) => status === 'ready') ? 'ready' : 'degraded';
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function hasTurnCredentialedServer(iceServers = []) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => String(url || '').startsWith('turn:')) && Boolean(server?.credential);
  });
}

function isVoiceRuntimeIntegration(integrationId) {
  return ['rustpbx', 'opc-native-webrtc'].includes(String(integrationId || ''));
}

function isVoiceRuntimeSecret(integrationId, secretKey) {
  const allowed = {
    rustpbx: ['api_token'],
    'opc-native-webrtc': ['turn_password', 'media_api_token']
  };
  return (allowed[String(integrationId || '')] || []).includes(String(secretKey || ''));
}
