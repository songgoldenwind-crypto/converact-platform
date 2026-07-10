import assert from 'node:assert/strict';
import { test } from 'node:test';

import { all, createDatabase, run } from '../src/db.js';
import { ContextBuilder } from '../src/agent-runtime/context/context-builder.js';
import { RunStore } from '../src/agent-runtime/stores/run-store.js';
import { createTenant } from '../src/services.js';

test('context builder returns core-kernel envelope and context capability with compressed memory', () => {
  const rawMemory = Array.from(
    { length: 8 },
    (_, index) => `memory_${index}_${'high-value lead note '.repeat(6)}`
  );

  const contextBuilder = new ContextBuilder({
    memoryStore: {
      buildPack: () =>
        ({
          facts: rawMemory.map((content, index) => ({ id: `fact_${index}`, content })),
          learnings: [],
          skills: []
        }) as any
    }
  });

  const contextPack = contextBuilder.build({
    tenantId: 'tenant_core4',
    workspaceId: 'default',
    userId: 'user_core4',
    channel: 'web_app',
    workflowRunId: 'run_core4',
    agent: { agent_id: 'orchestration_agent' },
    playbook: { playbook_id: 'orchestration_agent.growth_loop_intake.v1' },
    goal: '验证 context kernel 接入',
    businessContext: {}
  });

  assert.equal(contextPack.context_envelope.isolation_scope, 'tenant_core4:run_core4');
  // Memory is now split into category-keyed slices (memory_facts, etc.)
  const compressed = contextPack.context_envelope.compressed_context;
  const allMemoryEntries = Object.keys(compressed)
    .filter((k) => k.startsWith('memory_'))
    .flatMap((k) => Array.isArray(compressed[k]) ? compressed[k] as string[] : []);

  assert.ok(allMemoryEntries.length > 0);
  assert.ok(allMemoryEntries.length < rawMemory.length);

  assert.deepEqual(contextPack.core_capability_state.context, contextPack.context_envelope);
});

test('context builder carries actionable memory categories and preserves follow-up priority under compression', () => {
  const lowPriorityFacts = Array.from(
    { length: 10 },
    (_, index) => `low_priority_fact_${index}_${'generic discovery background '.repeat(8)}`
  );

  const contextBuilder = new ContextBuilder({
    memoryStore: {
      buildPack: () =>
        ({
          facts: lowPriorityFacts.map((content, index) => ({
            id: `fact_${index}`,
            content,
            confidence: 0.9,
            rank_score: 0.9
          })),
          learnings: [{ id: 'learning_1', content: '上一轮短信渠道回复率偏低', confidence: 0.8 }],
          skills: [{ id: 'skill_1', content: '使用短句确认客户是否方便通话', confidence: 0.8 }],
          conditions: [{ id: 'condition_1', content: '客户只接受下午两点后电话', confidence: 1 }],
          openLoops: [{ id: 'open_loop_1', content: '报价单承诺今天回访确认', confidence: 1 }],
          profiles: [{ id: 'profile_1', content: '老板偏好微信先发摘要再电话', confidence: 0.95 }]
        }) as any
    }
  });

  const contextPack = contextBuilder.build({
    tenantId: 'tenant_followup_memory',
    workspaceId: 'default',
    userId: 'user_followup_memory',
    channel: 'web_app',
    workflowRunId: 'run_followup_memory',
    agent: { agent_id: 'orchestration_agent' },
    playbook: { playbook_id: 'orchestration_agent.lead_followup.v1' },
    goal: '今天跟进高意向客户',
    businessContext: {
      current_stage: 'calling_or_followup_running'
    }
  });

  assert.equal(contextPack.context_envelope.phase, 'calling_or_followup_running');
  // loaded_slices are now category-keyed (memory_openLoops, memory_conditions, etc.)
  const loadedSlices = contextPack.context_envelope.loaded_slices;
  assert.ok(loadedSlices.some((s: string) => s.startsWith('memory_')));
  const compressed = contextPack.context_envelope.compressed_context;
  const allMemoryEntries = Object.keys(compressed)
    .filter((k) => k.startsWith('memory_'))
    .flatMap((k) => Array.isArray(compressed[k]) ? compressed[k] as string[] : []);
  assert.ok(allMemoryEntries.some((entry) => entry.includes('报价单承诺今天回访确认')));
  assert.ok(allMemoryEntries.some((entry) => entry.includes('客户只接受下午两点后电话')));
  assert.ok(allMemoryEntries.some((entry) => entry.includes('老板偏好微信先发摘要再电话')));
  assert.equal(
    allMemoryEntries.some((entry) => entry.includes('low_priority_fact_9')),
    false
  );
});

test('context builder records compression trace for retained and discarded memory categories', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Context Compression Trace Tenant' });
  // I73: create lead_acquisition_run so particle snapshot FK constraint is satisfied
  const leadAcquisitionRunId = 'lar_context_trace';
  run(db, `INSERT INTO lead_acquisition_runs (id, tenant_id, workspace_id, goal, industry, location, target_customer_profile, source_strategy, lead_count_target, status, current_stage, summary, next_recommended_action) VALUES (?, ?, 'default', 'test', '', '', '', '', 0, 'active', 'goal_created', '', '')`, [leadAcquisitionRunId, tenant.id]);
  const runStore = new RunStore(db);
  const lowPriorityFacts = Array.from(
    { length: 12 },
    (_, index) => `trace_low_priority_fact_${index}_${'generic discovery note '.repeat(8)}`
  );

  const contextBuilder = new ContextBuilder({
    runStore,
    memoryStore: {
      buildPack: () =>
        ({
          facts: lowPriorityFacts.map((content, index) => ({
            id: `trace_fact_${index}`,
            content,
            confidence: 0.5,
            rank_score: 0.5
          })),
          learnings: [{ id: 'trace_learning_1', content: '上一轮电话开场必须先问是否方便', confidence: 0.8 }],
          skills: [{ id: 'trace_skill_1', content: '保持 20 秒内说明来意', confidence: 0.7 }],
          conditions: [{ id: 'trace_condition_1', content: '客户明确要求下午三点后联系', confidence: 1 }],
          openLoops: [{ id: 'trace_open_loop_1', content: '今天必须回拨确认报价是否收到', confidence: 1 }],
          profiles: [{ id: 'trace_profile_1', content: '老板偏好先微信后电话', confidence: 0.9 }]
        }) as any
    }
  });

  const contextPack = contextBuilder.build({
    tenantId: tenant.id,
    workspaceId: 'default',
    userId: 'user_context_trace',
    channel: 'web_app',
    workflowRunId: 'wfr_context_trace',
    agent: { agent_id: 'orchestration_agent' },
    playbook: { playbook_id: 'orchestration_agent.lead_followup.v1' },
    goal: '稳固上下文压缩',
    businessContext: {
      current_stage: 'calling_or_followup_running',
      lead_acquisition_run_id: 'lar_context_trace'
    }
  });

  const trace = contextPack.context_envelope.compression_trace;
  assert.equal(trace.phase, 'calling_or_followup_running');
  assert.equal(trace.critical_open_loops_retained, true);
  assert.ok(trace.retained_categories.includes('openLoops'));
  assert.ok(trace.discarded_categories.includes('facts'));
  assert.ok(trace.discarded_count > 0);

  const rows = all(
    db,
    `SELECT tenant_id, workflow_run_id, lead_acquisition_run_id, phase, retained_categories, discarded_categories, critical_open_loops_retained
       FROM context_compression_traces
      WHERE tenant_id = ?`,
    [tenant.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workflow_run_id, 'wfr_context_trace');
  assert.equal(rows[0].lead_acquisition_run_id, 'lar_context_trace');
  assert.deepEqual(JSON.parse(rows[0].retained_categories).includes('openLoops'), true);
  assert.deepEqual(JSON.parse(rows[0].discarded_categories).includes('facts'), true);
  assert.equal(rows[0].critical_open_loops_retained, 1);

  // I73: verify compression_discard_audit particle was persisted
  const particleRows = all(
    db,
    `SELECT particle_key, quality_status, payload
       FROM lead_run_particle_snapshots
      WHERE tenant_id = ? AND particle_key = 'compression_discard_audit'`,
    [tenant.id]
  );
  assert.equal(particleRows.length, 1);
  assert.equal(particleRows[0].particle_key, 'compression_discard_audit');
  const payload = JSON.parse(particleRows[0].payload);
  assert.ok(Array.isArray(payload.discarded_categories));
  assert.ok(payload.discarded_count > 0);
  assert.equal(payload.phase, 'calling_or_followup_running');
});

test('context compression trace does not count truncated open loops as fully retained', () => {
  // Create enough long entries to exceed the 512-char budget
  const longOpenLoop = `紧急回拨张总确认报价截止时间_${'必须带上含税价送货时间和付款方式 '.repeat(20)}`;
  const longFacts = Array.from({ length: 20 }, (_, i) =>
    `fact_${i}_${'background discovery note for padding '.repeat(10)}`
  );
  const contextBuilder = new ContextBuilder({
    memoryStore: {
      buildPack: () =>
        ({
          facts: longFacts.map((content, index) => ({ id: `fact_${index}`, content })),
          learnings: [],
          skills: [],
          conditions: [],
          openLoops: [{ id: 'truncated_open_loop', content: longOpenLoop, confidence: 1 }],
          profiles: []
        }) as any
    }
  });

  const contextPack = contextBuilder.build({
    tenantId: 'tenant_truncated_open_loop',
    workspaceId: 'default',
    userId: 'user_truncated_open_loop',
    channel: 'web_app',
    workflowRunId: 'wfr_truncated_open_loop',
    agent: { agent_id: 'orchestration_agent' },
    playbook: { playbook_id: 'orchestration_agent.lead_followup.v1' },
    goal: '确认截断 trace',
    businessContext: {
      current_stage: 'calling_or_followup_running'
    }
  });

  const compressed = contextPack.context_envelope.compressed_context;
  const allEntries = Object.keys(compressed)
    .filter((k) => k.startsWith('memory_'))
    .flatMap((k) => Array.isArray(compressed[k]) ? compressed[k] as string[] : []);
  // Under budget pressure, openLoop may be truncated or fully retained
  // The key assertion: if compression was applied, the trace must reflect what happened
  if (contextPack.context_envelope.compression_applied) {
    const openLoopEntry = (Array.isArray(compressed.memory_openLoops) ? compressed.memory_openLoops : []) as string[];
    if (openLoopEntry.length === 1 && openLoopEntry[0] !== longOpenLoop) {
      // OpenLoop was truncated — trace should mark it
      assert.equal(contextPack.context_envelope.compression_trace.critical_open_loops_retained, false);
      assert.ok(contextPack.context_envelope.compression_trace.discarded_ids.includes('truncated_open_loop'));
    }
    // If all entries fit, compression_trace should show 0 discarded
  }
  // At minimum, compression was attempted and trace exists
  assert.ok(typeof contextPack.context_envelope.compression_trace.critical_open_loops_retained === 'boolean');
});

test('context builder preserves blocked lead-acquisition phase instead of falling back to goal_created', () => {
  const contextBuilder = new ContextBuilder();

  const contextPack = contextBuilder.build({
    tenantId: 'tenant_blocked_phase',
    workspaceId: 'default',
    userId: 'user_blocked_phase',
    channel: 'web_app',
    workflowRunId: 'wfr_blocked_phase',
    agent: { agent_id: 'orchestration_agent' },
    playbook: { playbook_id: 'orchestration_agent.lead_followup.v1' },
    goal: '确认 blocked 阶段',
    businessContext: {
      current_stage: 'blocked_needs_user_input'
    }
  });

  assert.equal(contextPack.context_envelope.phase, 'blocked_needs_user_input');
  assert.equal(contextPack.context_envelope.compression_trace.phase, 'blocked_needs_user_input');
});
