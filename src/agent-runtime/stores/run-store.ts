import { all, id, json, one, parseJson, run } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { ToolCallRecord } from '../runtime-domain-types.js';

export class RunStore {
  db: unknown;

  constructor(db: unknown) {
    this.db = db;
  }

  createWorkflowRun(input: JsonRecord): JsonRecord | null {
    const workflowRun = {
      id: id('wfr'),
      tenant_id: input.tenant_id,
      created_by: input.created_by || 'system',
      source: input.source || 'api',
      goal: input.goal,
      status: 'created',
      dag: input.dag || {},
      risk_summary: input.risk_summary || {}
    };
    run(
      this.db,
      `INSERT INTO workflow_runs (id, tenant_id, created_by, source, goal, status, dag, risk_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workflowRun.id,
        workflowRun.tenant_id,
        workflowRun.created_by,
        workflowRun.source,
        workflowRun.goal,
        workflowRun.status,
        json(workflowRun.dag),
        json(workflowRun.risk_summary)
      ]
    );
    this.audit(workflowRun.tenant_id, 'workflow_run.created', 'workflow_run', workflowRun.id, workflowRun);
    return this.getWorkflowRun(workflowRun.tenant_id, workflowRun.id);
  }

  updateWorkflowRun(tenantId: string, workflowRunId: string, patch: JsonRecord): JsonRecord | null {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(tenantId, workflowRunId);
    run(this.db, `UPDATE workflow_runs SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    return this.getWorkflowRun(tenantId, workflowRunId);
  }

  recordFeedbackActions(input: JsonRecord): JsonRecord[] {
    const tenantId = String(input.tenant_id || '');
    const workflowRunId = String(input.workflow_run_id || '');
    const leadAcquisitionRunId = String(input.lead_acquisition_run_id || '');
    const sourceStage = String(input.source_stage || '');
    const recommendations = Array.isArray(input.recommendations) ? input.recommendations : [];
    if (!tenantId || !workflowRunId || !leadAcquisitionRunId || recommendations.length === 0) {
      return [];
    }

    for (const rawRecommendation of recommendations) {
      const recommendation = toRecord(rawRecommendation);
      const actionType = String(recommendation.action_type || '');
      if (!isFeedbackActionType(actionType)) continue;
      const existingPending = one(
        this.db,
        `SELECT id
           FROM feedback_actions
          WHERE tenant_id = ?
           AND workflow_run_id = ?
           AND lead_acquisition_run_id = ?
           AND action_type = ?
           AND source_stage = ?
           AND status = 'pending'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
        [tenantId, workflowRunId, leadAcquisitionRunId, actionType, sourceStage]
      );
      if (existingPending?.id) {
        run(
          this.db,
          `UPDATE feedback_actions
             SET reason = ?,
                 metrics = ?,
                 updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = ? AND id = ?`,
          [
           String(recommendation.reason || ''),
           json(recommendation.metrics || {}),
           tenantId,
           existingPending.id
          ]
        );
        continue;
      }

      run(
        this.db,
        `INSERT INTO feedback_actions
          (id, tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, status, source_stage, reason, metrics)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          id('feedback_action'),
          tenantId,
          workflowRunId,
          leadAcquisitionRunId,
          actionType,
          sourceStage,
          String(recommendation.reason || ''),
          json(recommendation.metrics || {})
        ]
      );
    }

    return all(
      this.db,
      `SELECT id, tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, status, source_stage, reason, metrics, created_at, updated_at
         FROM feedback_actions
        WHERE tenant_id = ? AND workflow_run_id = ? AND lead_acquisition_run_id = ? AND source_stage = ? AND status = 'pending'
        ORDER BY updated_at DESC, created_at DESC`,
      [tenantId, workflowRunId, leadAcquisitionRunId, sourceStage]
    ).map((row) => ({
      ...row,
      metrics: parseJson(row.metrics, {})
    }));
  }

  listFeedbackActions(input: JsonRecord): JsonRecord[] {
    const tenantId = String(input.tenant_id || '');
    const leadAcquisitionRunId = String(input.lead_acquisition_run_id || '');
    const status = String(input.status || '');
    if (!tenantId || !leadAcquisitionRunId) return [];

    const statusFilter = status ? 'AND status = ?' : '';
    const params = status
      ? [tenantId, leadAcquisitionRunId, status]
      : [tenantId, leadAcquisitionRunId];
    return all(
      this.db,
      `SELECT id, tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, status, source_stage,
              reason, metrics, applied_by, application_result, applied_at,
              verification_result, verification_metrics, verified_at, created_at, updated_at
         FROM feedback_actions
        WHERE tenant_id = ? AND lead_acquisition_run_id = ? ${statusFilter}
        ORDER BY updated_at DESC, created_at DESC`,
      params
    ).map(decodeFeedbackAction);
  }

  applyFeedbackAction(input: JsonRecord): JsonRecord | null {
    const tenantId = String(input.tenant_id || '');
    const feedbackActionId = String(input.feedback_action_id || '');
    if (!tenantId || !feedbackActionId) return null;
    const pending = this.getFeedbackAction(tenantId, feedbackActionId);
    if (!pending || pending.status !== 'pending') return pending;

    run(
      this.db,
      `UPDATE feedback_actions
          SET status = 'superseded',
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ?
          AND workflow_run_id = ?
          AND lead_acquisition_run_id = ?
          AND action_type = ?
          AND source_stage = ?
          AND status IN ('applied', 'verified')`,
      [
        tenantId,
        pending.workflow_run_id,
        pending.lead_acquisition_run_id,
        pending.action_type,
        pending.source_stage
      ]
    );

    run(
      this.db,
      `UPDATE feedback_actions
          SET status = 'applied',
              applied_by = ?,
              application_result = ?,
              applied_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
      [
        String(input.applied_by || 'system'),
        json(input.application_result || {}),
        tenantId,
        feedbackActionId
      ]
    );
    return this.getFeedbackAction(tenantId, feedbackActionId);
  }

  verifyFeedbackAction(input: JsonRecord): JsonRecord | null {
    const tenantId = String(input.tenant_id || '');
    const feedbackActionId = String(input.feedback_action_id || '');
    if (!tenantId || !feedbackActionId) return null;

    run(
      this.db,
      `UPDATE feedback_actions
          SET status = 'verified',
              verification_result = ?,
              verification_metrics = ?,
              verified_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND id = ? AND status = 'applied'`,
      [
        String(input.verification_result || 'inconclusive'),
        json(input.verification_metrics || {}),
        tenantId,
        feedbackActionId
      ]
    );
    return this.getFeedbackAction(tenantId, feedbackActionId);
  }

  getFeedbackAction(tenantId: string, feedbackActionId: string): JsonRecord | null {
    const row = one(
      this.db,
      `SELECT id, tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, status, source_stage,
              reason, metrics, applied_by, application_result, applied_at,
              verification_result, verification_metrics, verified_at, created_at, updated_at
         FROM feedback_actions
        WHERE tenant_id = ? AND id = ?`,
      [tenantId, feedbackActionId]
    );
    return row ? decodeFeedbackAction(row) : null;
  }

  recordContextCompressionTrace(input: JsonRecord): JsonRecord | null {
    const tenantId = String(input.tenant_id || '');
    if (!tenantId) return null;

    const trace = {
      id: id('context_compression_trace'),
      tenant_id: tenantId,
      workflow_run_id: String(input.workflow_run_id || ''),
      lead_acquisition_run_id: String(input.lead_acquisition_run_id || ''),
      phase: String(input.phase || 'goal_created'),
      max_chars: Number(input.max_chars || 0),
      total_before_chars: Number(input.total_before_chars || 0),
      total_after_chars: Number(input.total_after_chars || 0),
      retained_count: Number(input.retained_count || 0),
      discarded_count: Number(input.discarded_count || 0),
      retained_categories: Array.isArray(input.retained_categories) ? input.retained_categories : [],
      discarded_categories: Array.isArray(input.discarded_categories) ? input.discarded_categories : [],
      retained_ids: Array.isArray(input.retained_ids) ? input.retained_ids : [],
      discarded_ids: Array.isArray(input.discarded_ids) ? input.discarded_ids : [],
      critical_open_loops_retained: input.critical_open_loops_retained === false ? 0 : 1
    };

    run(
      this.db,
      `INSERT INTO context_compression_traces
        (id, tenant_id, workflow_run_id, lead_acquisition_run_id, phase, max_chars,
         total_before_chars, total_after_chars, retained_count, discarded_count,
         retained_categories, discarded_categories, retained_ids, discarded_ids, critical_open_loops_retained)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trace.id,
        trace.tenant_id,
        trace.workflow_run_id,
        trace.lead_acquisition_run_id,
        trace.phase,
        trace.max_chars,
        trace.total_before_chars,
        trace.total_after_chars,
        trace.retained_count,
        trace.discarded_count,
        json(trace.retained_categories),
        json(trace.discarded_categories),
        json(trace.retained_ids),
        json(trace.discarded_ids),
        trace.critical_open_loops_retained
      ]
    );

    return {
      ...trace,
      critical_open_loops_retained: Boolean(trace.critical_open_loops_retained)
    };
  }

  listContextCompressionTraces(input: JsonRecord): JsonRecord[] {
    const tenantId = String(input.tenant_id || '');
    const leadAcquisitionRunId = String(input.lead_acquisition_run_id || '');
    if (!tenantId) return [];
    const clauses = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];
    if (leadAcquisitionRunId) {
      clauses.push('lead_acquisition_run_id = ?');
      params.push(leadAcquisitionRunId);
    }
    const rows = all(
      this.db,
      `SELECT id, tenant_id, workflow_run_id, lead_acquisition_run_id, phase, max_chars,
              total_before_chars, total_after_chars, retained_count, discarded_count,
              retained_categories, discarded_categories, retained_ids, discarded_ids,
              critical_open_loops_retained, created_at
         FROM context_compression_traces
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 50`,
      params
    );
    return rows.map((row) => ({
      ...row,
      retained_categories: parseJson(String(row.retained_categories || ''), []),
      discarded_categories: parseJson(String(row.discarded_categories || ''), []),
      retained_ids: parseJson(String(row.retained_ids || ''), []),
      discarded_ids: parseJson(String(row.discarded_ids || ''), []),
      critical_open_loops_retained: Boolean(row.critical_open_loops_retained)
    }));
  }

  recordLeadRunParticleSnapshot(input: JsonRecord): JsonRecord | null {
    const tenantId = String(input.tenant_id || '');
    const leadAcquisitionRunId = String(input.lead_acquisition_run_id || '');
    const particleKey = String(input.particle_key || '');
    const payloadHash = String(input.payload_hash || '');
    const sourceStage = String(input.source_stage || '');
    const sourceRef = String(input.source_ref || '');
    if (!tenantId || !leadAcquisitionRunId || !particleKey || !payloadHash) return null;
    const nextWriteOrder = Number(one(
      this.db,
      `SELECT COALESCE(MAX(write_order), 0) + 1 AS next_write_order
         FROM lead_run_particle_snapshots
        WHERE tenant_id = ? AND lead_acquisition_run_id = ?`,
      [tenantId, leadAcquisitionRunId]
    )?.next_write_order || 1);

    run(
      this.db,
      `INSERT INTO lead_run_particle_snapshots
        (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
         quality_status, writeback_status, payload_hash, payload, write_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
       DO UPDATE SET
         particle_version = excluded.particle_version,
         quality_status = excluded.quality_status,
         writeback_status = excluded.writeback_status,
         payload = excluded.payload,
         write_order = excluded.write_order,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('particle_snapshot'),
        tenantId,
        leadAcquisitionRunId,
        particleKey,
        String(input.particle_version || 'v1'),
        sourceStage,
        sourceRef,
        normalizeParticleQualityStatus(input.quality_status),
        normalizeParticleWritebackStatus(input.writeback_status),
        payloadHash,
        json(input.payload || {}),
        nextWriteOrder
      ]
    );

    const row = one(
      this.db,
      `SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
              quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at
         FROM lead_run_particle_snapshots
        WHERE tenant_id = ? AND lead_acquisition_run_id = ? AND particle_key = ? AND source_stage = ? AND source_ref = ? AND payload_hash = ?
        LIMIT 1`,
      [tenantId, leadAcquisitionRunId, particleKey, sourceStage, sourceRef, payloadHash]
    );
    return row ? decodeParticleSnapshot(row) : null;
  }

  listLeadRunParticleSnapshots(input: JsonRecord): JsonRecord[] {
    const tenantId = String(input.tenant_id || '');
    const leadAcquisitionRunId = String(input.lead_acquisition_run_id || '');
    const particleKey = String(input.particle_key || '');
    if (!tenantId || !leadAcquisitionRunId) return [];

    const keyFilter = particleKey ? 'AND particle_key = ?' : '';
    const params = particleKey
      ? [tenantId, leadAcquisitionRunId, particleKey]
      : [tenantId, leadAcquisitionRunId];
    return all(
      this.db,
      `SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
              quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at
         FROM lead_run_particle_snapshots
        WHERE tenant_id = ? AND lead_acquisition_run_id = ? ${keyFilter}
         ORDER BY write_order DESC, updated_at DESC, created_at DESC, rowid DESC`,
      params
    ).map(decodeParticleSnapshot);
  }

  latestLeadRunParticleSnapshot(input: JsonRecord): JsonRecord | null {
    return this.listLeadRunParticleSnapshots(input)[0] || null;
  }

  getWorkflowRun(tenantId: string, workflowRunId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM workflow_runs WHERE tenant_id = ? AND id = ?', [tenantId, workflowRunId]);
    return row ? decodeJsonFields(row, ['dag', 'cost_summary', 'risk_summary']) : null;
  }

  ensureAgentSession(input: JsonRecord): JsonRecord | null {
    run(
      this.db,
      `INSERT INTO agent_sessions
        (id, tenant_id, workspace_id, session_key, channel, sandbox_scope, dm_scope, business_object_type, business_object_id, agent_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT(tenant_id, session_key) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        channel = excluded.channel,
        sandbox_scope = excluded.sandbox_scope,
        dm_scope = excluded.dm_scope,
        business_object_type = excluded.business_object_type,
        business_object_id = excluded.business_object_id,
        agent_id = excluded.agent_id,
        status = 'active',
        updated_at = CURRENT_TIMESTAMP`,
      [
        id('session'),
        input.tenant_id,
        input.workspace_id || 'default',
        input.session_key,
        input.channel || 'web_app',
        input.sandbox_scope,
        input.dm_scope,
        input.business_object_type || 'tenant',
        input.business_object_id || '',
        input.agent_id || ''
      ]
    );
    return this.getAgentSession(input.tenant_id, input.session_key);
  }

  getAgentSession(tenantId: string, sessionKey: string): JsonRecord | null {
    return one(this.db, 'SELECT * FROM agent_sessions WHERE tenant_id = ? AND session_key = ?', [tenantId, sessionKey]);
  }

  createAgentRun(input: JsonRecord): JsonRecord | null {
    const agentRun = {
      id: id('arun'),
      tenant_id: input.tenant_id,
      workflow_run_id: input.workflow_run_id || null,
      agent_id: input.agent_id,
      agent_version: input.agent_version,
      playbook_id: input.playbook_id,
      status: 'created',
      input: input.input || {},
      context_pack: input.context_pack || {}
    };
    run(
      this.db,
      `INSERT INTO agent_runs
        (id, tenant_id, workflow_run_id, agent_id, agent_version, playbook_id, status, input, context_pack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentRun.id,
        agentRun.tenant_id,
        agentRun.workflow_run_id,
        agentRun.agent_id,
        agentRun.agent_version,
        agentRun.playbook_id,
        agentRun.status,
        json(agentRun.input),
        json(agentRun.context_pack)
      ]
    );
    this.audit(agentRun.tenant_id, 'agent_run.created', 'agent_run', agentRun.id, agentRun);
    return this.getAgentRun(agentRun.tenant_id, agentRun.id);
  }

  updateAgentRun(tenantId: string, agentRunId: string, patch: JsonRecord): JsonRecord | null {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(tenantId, agentRunId);
    run(this.db, `UPDATE agent_runs SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    return this.getAgentRun(tenantId, agentRunId);
  }

  getAgentRun(tenantId: string, agentRunId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM agent_runs WHERE tenant_id = ? AND id = ?', [tenantId, agentRunId]);
    return row ? decodeJsonFields(row, ['input', 'context_pack', 'cost', 'error']) : null;
  }

  recordToolCall(input: JsonRecord): ToolCallRecord {
    const toolCall = {
      id: input.id || id('tcall'),
      tenant_id: input.tenant_id,
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      tool_id: input.tool_id,
      status: input.status || 'created',
      risk_level: input.risk_level,
      approval_request_id: input.approval_request_id || null,
      input: input.input || {},
      output: input.output || {},
      error: input.error ? json(input.error) : null,
      idempotency_key: input.idempotency_key || '',
      started_at: input.started_at || null,
      finished_at: input.finished_at || null
    };
    run(
      this.db,
      `INSERT INTO tool_calls
        (id, tenant_id, workflow_run_id, agent_run_id, tool_id, status, risk_level, approval_request_id, input, output, error, idempotency_key, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toolCall.id,
        toolCall.tenant_id,
        toolCall.workflow_run_id,
        toolCall.agent_run_id,
        toolCall.tool_id,
        toolCall.status,
        toolCall.risk_level,
        toolCall.approval_request_id,
        json(toolCall.input),
        json(toolCall.output),
        toolCall.error,
        toolCall.idempotency_key,
        toolCall.started_at,
        toolCall.finished_at
      ]
    );
    const persisted = this.getToolCall(toolCall.tenant_id, toolCall.id);
    if (!persisted) throw new Error(`tool call was not persisted: ${toolCall.id}`);
    return persisted;
  }

  updateToolCall(tenantId: string, toolCallId: string, patch: JsonRecord): ToolCallRecord {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    params.push(tenantId, toolCallId);
    run(this.db, `UPDATE tool_calls SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    const updated = this.getToolCall(tenantId, toolCallId);
    if (!updated) throw new Error(`tool call not found after update: ${toolCallId}`);
    return updated;
  }

  getToolCall(tenantId: string, toolCallId: string): ToolCallRecord | null {
    const row = one(this.db, 'SELECT * FROM tool_calls WHERE tenant_id = ? AND id = ?', [tenantId, toolCallId]);
    return row ? decodeToolCall(row) : null;
  }

  listToolCallsForRun(tenantId: string, agentRunId: string): JsonRecord[] {
    return all(this.db, 'SELECT * FROM tool_calls WHERE tenant_id = ? AND agent_run_id = ? ORDER BY created_at ASC', [
      tenantId,
      agentRunId
    ]).map((row) => decodeJsonFields(row, ['input', 'output', 'error']));
  }

  recordModelCall(input: JsonRecord): JsonRecord | null {
    const modelCall = {
      id: input.id || id('mcall'),
      tenant_id: input.tenant_id,
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      provider: input.provider,
      model: input.model,
      purpose: input.purpose || 'default',
      status: input.status || 'created',
      prompt_hash: input.prompt_hash || '',
      input: input.input || {},
      output: input.output || {},
      usage: input.usage || {},
      cost: input.cost || {},
      error: input.error || null,
      started_at: input.started_at || null,
      finished_at: input.finished_at || null
    };
    run(
      this.db,
      `INSERT INTO model_calls
        (id, tenant_id, workflow_run_id, agent_run_id, provider, model, purpose, status, prompt_hash, input, output, usage, cost, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        modelCall.id,
        modelCall.tenant_id,
        modelCall.workflow_run_id,
        modelCall.agent_run_id,
        modelCall.provider,
        modelCall.model,
        modelCall.purpose,
        modelCall.status,
        modelCall.prompt_hash,
        json(modelCall.input),
        json(modelCall.output),
        json(modelCall.usage),
        json(modelCall.cost),
        modelCall.error ? json(modelCall.error) : null,
        modelCall.started_at,
        modelCall.finished_at
      ]
    );
    return this.getModelCall(modelCall.tenant_id, modelCall.id);
  }

  updateModelCall(tenantId: string, modelCallId: string, patch: JsonRecord): JsonRecord | null {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    params.push(tenantId, modelCallId);
    run(this.db, `UPDATE model_calls SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, params);
    return this.getModelCall(tenantId, modelCallId);
  }

  getModelCall(tenantId: string, modelCallId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM model_calls WHERE tenant_id = ? AND id = ?', [tenantId, modelCallId]);
    return row ? decodeJsonFields(row, ['input', 'output', 'usage', 'cost', 'error']) : null;
  }

  persistDag(input: JsonRecord): void {
    const nodes = input.nodes || [];
    const edges = input.edges || [];
    for (const node of nodes) {
      run(
        this.db,
        `INSERT OR IGNORE INTO workflow_dag_nodes
          (id, tenant_id, workflow_run_id, node_id, node_type, status, definition, input, output, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id('dagnode'),
          input.tenant_id,
          input.workflow_run_id,
          node.id,
          node.type,
          'pending',
          json(node),
          json(node.input || {}),
          json({}),
          node.max_attempts || node.retry_policy?.max_attempts || 1
        ]
      );
    }
    for (const edge of edges) {
      run(
        this.db,
        `INSERT OR IGNORE INTO workflow_dag_edges
          (id, tenant_id, workflow_run_id, from_node_id, to_node_id, condition, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id('dagedge'),
          input.tenant_id,
          input.workflow_run_id,
          edge.from,
          edge.to,
          edge.condition || 'success',
          json({ when: edge.when, label: edge.label || '' })
        ]
      );
    }
    this.audit(input.tenant_id, 'workflow_dag.persisted', 'workflow_run', input.workflow_run_id, {
      nodes: nodes.length,
      edges: edges.length
    });
  }

  listDagNodes(tenantId: string, workflowRunId: string): JsonRecord[] {
    return all(
      this.db,
      'SELECT * FROM workflow_dag_nodes WHERE tenant_id = ? AND workflow_run_id = ? ORDER BY created_at ASC',
      [tenantId, workflowRunId]
    ).map((row) => decodeJsonFields(row, ['definition', 'input', 'output', 'error']));
  }

  listDagEdges(tenantId: string, workflowRunId: string): JsonRecord[] {
    return all(
      this.db,
      'SELECT * FROM workflow_dag_edges WHERE tenant_id = ? AND workflow_run_id = ? ORDER BY created_at ASC',
      [tenantId, workflowRunId]
    ).map((row) => decodeJsonFields(row, ['metadata']));
  }

  getDagNode(tenantId: string, workflowRunId: string, nodeId: string): JsonRecord | null {
    const row = one(
      this.db,
      'SELECT * FROM workflow_dag_nodes WHERE tenant_id = ? AND workflow_run_id = ? AND node_id = ?',
      [tenantId, workflowRunId, nodeId]
    );
    return row ? decodeJsonFields(row, ['definition', 'input', 'output', 'error']) : null;
  }

  updateDagNode(tenantId: string, workflowRunId: string, nodeId: string, patch: JsonRecord): JsonRecord | null {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      params.push(typeof value === 'object' && value !== null ? json(value) : value);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(tenantId, workflowRunId, nodeId);
    run(
      this.db,
      `UPDATE workflow_dag_nodes SET ${fields.join(', ')}
       WHERE tenant_id = ? AND workflow_run_id = ? AND node_id = ?`,
      params
    );
    return this.getDagNode(tenantId, workflowRunId, nodeId);
  }

  getDagGraph(tenantId: string, workflowRunId: string): { nodes: JsonRecord[]; edges: JsonRecord[] } {
    return {
      nodes: this.listDagNodes(tenantId, workflowRunId),
      edges: this.listDagEdges(tenantId, workflowRunId)
    };
  }

  recordCompletionReport(input: JsonRecord): JsonRecord {
    const report = {
      id: id('completion'),
      tenant_id: input.tenant_id,
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      playbook_id: input.playbook_id,
      status: input.status,
      summary: input.summary || '',
      required_artifacts: input.required_artifacts || [],
      produced_artifacts: input.produced_artifacts || [],
      quality_results: input.quality_results || [],
      concerns: input.concerns || []
    };
    run(
      this.db,
      `INSERT INTO completion_reports
        (id, tenant_id, workflow_run_id, agent_run_id, playbook_id, status, summary, required_artifacts, produced_artifacts, quality_results, concerns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.id,
        report.tenant_id,
        report.workflow_run_id,
        report.agent_run_id,
        report.playbook_id,
        report.status,
        report.summary,
        json(report.required_artifacts),
        json(report.produced_artifacts),
        json(report.quality_results),
        json(report.concerns)
      ]
    );
    this.audit(report.tenant_id, 'completion_report.created', 'completion_report', report.id, report);
    return report;
  }

  audit(tenantId: string, action: string, objectType: string, objectId: string, metadata: JsonRecord = {}, actorId = 'system'): void {
    run(
      this.db,
      `INSERT INTO audit_logs (id, tenant_id, actor_id, action, object_type, object_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id('audit'), tenantId, actorId, action, objectType, objectId, json(metadata)]
    );
  }
}

export function decodeJsonFields(row: JsonRecord, fields: string[]): JsonRecord {
  const decoded = { ...row };
  for (const field of fields) decoded[field] = parseJson(decoded[field], field === 'error' ? null : {});
  return decoded;
}

function isFeedbackActionType(actionType: string): boolean {
  return [
    'tighten_lead_scoring',
    'refresh_script_angles',
    'prioritize_verified_channels',
    'prepare_next_batch'
  ].includes(actionType);
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function decodeFeedbackAction(row: JsonRecord): JsonRecord {
  return {
    ...row,
    metrics: parseJson(row.metrics, {}),
    application_result: parseJson(row.application_result, {}),
    verification_metrics: parseJson(row.verification_metrics, {})
  };
}

function decodeParticleSnapshot(row: JsonRecord): JsonRecord {
  return {
    ...row,
    payload: parseJson(String(row.payload || ''), {})
  };
}

function normalizeParticleQualityStatus(value: unknown): string {
  const status = String(value || '').trim();
  return ['pass', 'warn', 'fail', 'info'].includes(status) ? status : 'info';
}

function normalizeParticleWritebackStatus(value: unknown): string {
  const status = String(value || '').trim();
  return ['generated', 'applied', 'verified', 'captured'].includes(status) ? status : 'generated';
}

function decodeToolCall(row: JsonRecord): ToolCallRecord {
  const decoded = decodeJsonFields(row, ['input', 'output', 'error']);
  return {
    id: decoded.id,
    tenant_id: decoded.tenant_id,
    workflow_run_id: decoded.workflow_run_id,
    agent_run_id: decoded.agent_run_id,
    tool_id: decoded.tool_id,
    status: decoded.status,
    risk_level: decoded.risk_level,
    approval_request_id: decoded.approval_request_id,
    input: decoded.input,
    output: decoded.output,
    error: decoded.error,
    idempotency_key: decoded.idempotency_key,
    started_at: decoded.started_at,
    finished_at: decoded.finished_at
  };
}
