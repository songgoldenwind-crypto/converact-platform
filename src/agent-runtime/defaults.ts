import type { JsonRecord } from './integrations/provider-runtime-types.js';

interface AgentRegistryLike {
  registerManifest: (manifest: JsonRecord) => JsonRecord;
  registerPlaybook: (playbook: JsonRecord) => JsonRecord;
}

export function registerDefaultAgents(agentRegistry: AgentRegistryLike): JsonRecord {
  const orchestrationAgent = agentRegistry.registerManifest({
    agent_id: 'orchestration_agent',
    name: '编排 Agent',
    version: '1.0.0',
    description: 'Routes one-person-company growth work through playbooks and registered tools.',
    allowed_toolsets: ['channel', 'landing', 'lead', 'lead_acquisition', 'crm', 'analytics', 'integration', 'voice', 'knowledge', 'artifact', 'search', 'notebook', 'geo', 'skill', 'mcp', 'ops'],
    forbidden_tools: ['content.publish_external'],
    outputs: { artifacts: ['growth_loop_result', 'weekly_report', 'integration_stack_plan'] },
    memory_scope: {
      read: ['tenant_memory', 'campaign_memory'],
      write: ['operational_learnings']
    },
    quality_gates: ['tenant_scope_gate', 'artifact_presence_gate'],
    human_approval: { required_for: ['external_action', 'financial_action', 'admin_action'] }
  });

  const analyticsAgent = agentRegistry.registerManifest({
    agent_id: 'analytics_agent',
    name: '数据分析 Agent',
    version: '1.0.0',
    description: 'Computes funnels, channel reports, and weekly review artifacts.',
    allowed_toolsets: ['analytics', 'artifact', 'search', 'skill', 'mcp'],
    forbidden_tools: [],
    outputs: { artifacts: ['weekly_report'] },
    memory_scope: {
      read: ['tenant_memory', 'campaign_memory'],
      write: ['campaign_lessons']
    },
    quality_gates: ['metric_consistency_gate'],
    human_approval: { required_for: [] }
  });

  agentRegistry.registerManifest({
    agent_id: 'content_agent',
    name: '内容 Agent',
    version: '1.0.0',
    description: 'Drafts and prepares content; external publishing must go through approval.',
    allowed_toolsets: ['content', 'analytics', 'artifact'],
    forbidden_tools: [],
    outputs: { artifacts: ['content_draft', 'publish_plan'] },
    memory_scope: {
      read: ['tenant_brand_memory', 'campaign_memory'],
      write: ['content_performance_learnings']
    },
    quality_gates: ['brand_voice_gate', 'factuality_gate'],
    human_approval: { required_for: ['content.publish_external'] }
  });

  const crmAgent = agentRegistry.registerManifest({
    agent_id: 'crm_agent',
    name: 'CRM Agent',
    version: '1.0.0',
    description: 'Creates and manages internal CRM follow-up tasks through approved tools.',
    allowed_toolsets: ['crm', 'lead', 'lead_acquisition', 'analytics', 'integration', 'artifact', 'search', 'notebook', 'geo', 'skill', 'mcp'],
    forbidden_tools: ['content.publish_external'],
    outputs: { artifacts: ['crm_task_plan'] },
    memory_scope: {
      read: ['tenant_memory', 'campaign_memory', 'customer_memory'],
      write: ['customer_memory', 'operational_learnings']
    },
    quality_gates: ['tenant_scope_gate', 'artifact_presence_gate'],
    human_approval: { required_for: ['external_action', 'financial_action', 'admin_action'] }
  });

  const voiceAgent = agentRegistry.registerManifest({
    agent_id: 'voice_agent',
    name: 'Voice Agent',
    version: '1.0.0',
    description: 'Queues approval-gated lightweight RustPBX calls and ingests call outcomes.',
    allowed_toolsets: ['voice', 'crm', 'lead', 'artifact'],
    forbidden_tools: ['content.publish_external'],
    outputs: { artifacts: ['voice_call_plan', 'call_result_summary'] },
    memory_scope: {
      read: ['tenant_memory', 'customer_memory', 'lead_memory'],
      write: ['customer_memory', 'operational_learnings']
    },
    quality_gates: ['tenant_scope_gate'],
    human_approval: { required_for: ['voice.queue_call_for_approval'] }
  });

  const knowledgeAgent = agentRegistry.registerManifest({
    agent_id: 'knowledge_agent',
    name: 'Knowledge Agent',
    version: '1.0.0',
    description: 'Maintains tenant-scoped LLM-wiki style knowledge bases from immutable sources and generated pages.',
    allowed_toolsets: ['knowledge', 'artifact', 'search', 'notebook', 'skill', 'mcp'],
    forbidden_tools: ['content.publish_external', 'voice.queue_call_for_approval'],
    outputs: { artifacts: ['knowledge_ingest_result', 'wiki_lint_report', 'wiki_query_answer'] },
    memory_scope: {
      read: ['tenant_memory', 'campaign_memory', 'customer_memory'],
      write: ['operational_learnings']
    },
    quality_gates: ['tenant_scope_gate', 'artifact_presence_gate'],
    human_approval: { required_for: [] }
  });

  const geoAgent = agentRegistry.registerManifest({
    agent_id: 'geo_agent',
    name: 'Geo Agent',
    version: '1.0.0',
    description: 'Builds tenant-scoped local-business discovery sessions, review insights, and outreach drafts without sending external messages.',
    allowed_toolsets: ['geo', 'crm', 'artifact', 'search', 'notebook'],
    forbidden_tools: ['content.publish_external', 'voice.queue_call_for_approval'],
    outputs: { artifacts: ['geo_place_discovery_result', 'geo_review_import_result', 'geo_place_insight', 'geo_outreach_draft', 'geo_handoff_packet'] },
    memory_scope: {
      read: ['tenant_memory', 'campaign_memory', 'customer_memory'],
      write: ['operational_learnings']
    },
    quality_gates: ['tenant_scope_gate', 'artifact_presence_gate'],
    human_approval: { required_for: [] }
  });

  const opsAgent = agentRegistry.registerManifest({
    agent_id: 'ops_agent',
    name: 'Ops Agent',
    version: '1.0.0',
    description: 'Runs tenant-scoped maintenance and housekeeping playbooks through the same runtime, audit, and artifact paths.',
    allowed_toolsets: ['voice', 'integration', 'artifact', 'ops', 'geo'],
    forbidden_tools: ['content.publish_external', 'voice.queue_call_for_approval'],
    outputs: { artifacts: ['ops_maintenance_report'] },
    memory_scope: {
      read: ['tenant_memory'],
      write: ['operational_learnings']
    },
    quality_gates: ['tenant_scope_gate', 'artifact_presence_gate'],
    human_approval: { required_for: [] }
  });

  const growthLoopPlaybook = agentRegistry.registerPlaybook({
    playbook_id: 'orchestration_agent.growth_loop_intake.v1',
    agent_id: orchestrationAgent.agent_id,
    version: '1.0.0',
    name: '来源到商机闭环',
    description: 'Creates a channel/source/page, captures a form inquiry, computes analytics, and commits an artifact.',
    trigger_intents: ['run_growth_loop', 'capture_lead_from_source'],
    required_inputs: ['platform_code', 'entry_point', 'landing_page', 'inquiry'],
    allowed_toolsets: ['channel', 'landing', 'lead', 'analytics'],
    required_artifacts: ['growth_loop_result'],
    completion_protocol: {
      success: 'completed',
      approval: 'awaiting_human_approval',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'create_channel',
        type: 'tool',
        tool_id: 'channel.create',
        input: {
          tenant_id: '$input.tenant_id',
          platform_code: '$input.platform_code',
          target_goal: 'lead'
        }
      },
      {
        id: 'create_source_tag',
        type: 'tool',
        tool_id: 'source_tag.create',
        input: {
          tenant_id: '$input.tenant_id',
          channel_id: '$steps.create_channel.id',
          entry_point: '$input.entry_point',
          slug: '$input.landing_page.slug',
          priority_tier: '$input.priority_tier'
        }
      },
      {
        id: 'create_landing_page',
        type: 'tool',
        tool_id: 'landing_page.create',
        input: {
          tenant_id: '$input.tenant_id',
          source_tag_id: '$steps.create_source_tag.id',
          title: '$input.landing_page.title',
          slug: '$input.landing_page.slug',
          headline: '$input.landing_page.headline',
          subheadline: '$input.landing_page.subheadline',
          status: 'live'
        }
      },
      {
        id: 'capture_lead',
        type: 'tool',
        tool_id: 'lead.capture_from_form',
        input: {
          tenant_id: '$input.tenant_id',
          source_tag_id: '$steps.create_source_tag.id',
          landing_page_id: '$steps.create_landing_page.id',
          name: '$input.inquiry.name',
          email: '$input.inquiry.email',
          phone: '$input.inquiry.phone',
          message: '$input.inquiry.message'
        }
      },
      {
        id: 'weekly_report',
        type: 'tool',
        tool_id: 'analytics.weekly_report',
        input: {
          tenant_id: '$input.tenant_id'
        }
      },
      {
        id: 'commit_result',
        type: 'artifact',
        artifact_type: 'growth_loop_result',
        status: 'draft',
        payload: {
          channel: '$steps.create_channel',
          source_tag: '$steps.create_source_tag',
          landing_page: '$steps.create_landing_page',
          lead_result: '$steps.capture_lead',
          weekly_report: '$steps.weekly_report'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'analytics_agent.weekly_review.v1',
    agent_id: analyticsAgent.agent_id,
    version: '1.0.0',
    name: '每周复盘',
    description: 'Generates a weekly analytics artifact from current funnel and channel data.',
    trigger_intents: ['weekly_review', 'analyze_growth_loop'],
    required_inputs: ['tenant_id'],
    allowed_toolsets: ['analytics'],
    required_artifacts: ['weekly_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'weekly_report',
        type: 'tool',
        tool_id: 'analytics.weekly_report',
        input: { tenant_id: '$input.tenant_id' }
      },
      {
        id: 'commit_report',
        type: 'artifact',
        artifact_type: 'weekly_report',
        status: 'draft',
        payload: '$steps.weekly_report'
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'orchestration_agent.integration_stack_recommendation.v1',
    agent_id: orchestrationAgent.agent_id,
    version: '1.0.0',
    name: '开源集成栈推荐',
    description: 'Recommends stable open-source integrations, MCP servers, and reusable skills for OPC capabilities.',
    trigger_intents: ['recommend_integrations', 'open_source_stack', '开源工具', '集成方案'],
    required_inputs: ['tenant_id'],
    allowed_toolsets: ['integration'],
    required_artifacts: ['integration_stack_plan'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'recommend_stack',
        type: 'tool',
        tool_id: 'integration.recommend_stack',
        input: {
          stable_stack: true
        }
      },
      {
        id: 'adapter_status',
        type: 'tool',
        tool_id: 'integration.adapter_status',
        input: {}
      },
      {
        id: 'commit_stack_plan',
        type: 'artifact',
        artifact_type: 'integration_stack_plan',
        status: 'draft',
        payload: {
          recommendations: '$steps.recommend_stack',
          adapters: '$steps.adapter_status'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'crm_agent.create_followup_task.v1',
    agent_id: crmAgent.agent_id,
    version: '1.0.0',
    name: '创建跟进任务',
    description: 'Creates a tenant-scoped CRM task and commits a task plan artifact.',
    trigger_intents: ['create_followup_task', 'crm_followup', '跟进任务', 'crm_task'],
    required_inputs: ['object_type', 'object_id', 'title'],
    allowed_toolsets: ['crm'],
    required_artifacts: ['crm_task_plan'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'create_task',
        type: 'tool',
        tool_id: 'crm.create_task',
        input: {
          tenant_id: '$input.tenant_id',
          object_type: '$input.object_type',
          object_id: '$input.object_id',
          title: '$input.title',
          priority: '$input.priority',
          due_hours: '$input.due_hours'
        }
      },
      {
        id: 'commit_task_plan',
        type: 'artifact',
        artifact_type: 'crm_task_plan',
        status: 'draft',
        payload: {
          task: '$steps.create_task',
          next_action: '$input.title'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'voice_agent.queue_followup_call.v1',
    agent_id: voiceAgent.agent_id,
    version: '1.0.0',
    name: '审批后排队外呼',
    description: 'Checks the RustPBX route and queues a follow-up call only after approval.',
    trigger_intents: ['queue_followup_call', 'voice_followup', '外呼跟进'],
    required_inputs: ['lead_id', 'phone', 'script'],
    allowed_toolsets: ['voice'],
    required_artifacts: ['voice_call_plan'],
    completion_protocol: {
      success: 'completed',
      approval: 'awaiting_human_approval',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'test_route',
        type: 'tool',
        tool_id: 'voice.test_sip_route',
        input: {
          tenant_id: '$input.tenant_id',
          route_id: '$input.route_id'
        }
      },
      {
        id: 'queue_call',
        type: 'tool',
        tool_id: 'voice.queue_call_for_approval',
        input: {
          tenant_id: '$input.tenant_id',
          lead_id: '$input.lead_id',
          phone: '$input.phone',
          script: '$input.script',
          route_id: '$input.route_id',
          idempotency_key: '$input.idempotency_key'
        }
      },
      {
        id: 'commit_call_plan',
        type: 'artifact',
        artifact_type: 'voice_call_plan',
        status: 'draft',
        payload: {
          route: '$steps.test_route',
          call: '$steps.queue_call',
          lead_id: '$input.lead_id'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'knowledge_agent.ingest_source.v1',
    agent_id: knowledgeAgent.agent_id,
    version: '1.0.0',
    name: '资料入库并维护 Wiki',
    description: 'Ingests an immutable raw source, creates or updates a generated wiki page, rebuilds the index, and commits an ingest artifact.',
    trigger_intents: ['knowledge_ingest', 'wiki_ingest', '知识库', '资料入库', 'wiki'],
    required_inputs: ['title', 'content'],
    allowed_toolsets: ['knowledge'],
    required_artifacts: ['knowledge_ingest_result'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'ingest_source',
        type: 'tool',
        tool_id: 'knowledge.source_ingest',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          title: '$input.title',
          content: '$input.content',
          uri: '$input.uri',
          source_type: '$input.source_type',
          category: '$input.category',
          tags: '$input.tags',
          summary: '$input.summary',
          idempotency_key: '$input.idempotency_key'
        }
      },
      {
        id: 'build_index',
        type: 'tool',
        tool_id: 'wiki.index_build',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id'
        }
      },
      {
        id: 'commit_knowledge_update',
        type: 'artifact',
        artifact_type: 'knowledge_ingest_result',
        status: 'draft',
        payload: {
          ingest: '$steps.ingest_source',
          index: '$steps.build_index'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.discover_local_businesses.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '本地商家发现',
    description: 'Runs tenant-scoped place discovery through a configured geo provider and persists the resulting place candidates as reviewable artifacts.',
    trigger_intents: ['geo_discover_local_businesses', 'discover_local_businesses', '地图线索发现'],
    required_inputs: ['query'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_place_discovery_result'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'discover_places',
        type: 'tool',
        tool_id: 'geo.discover_places',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          session_id: '$input.session_id',
          name: '$input.name',
          query: '$input.query',
          business_type: '$input.business_type',
          city: '$input.city',
          region: '$input.region',
          country_code: '$input.country_code',
          area_hint: '$input.area_hint',
          limit: '$input.limit',
          filters: '$input.filters',
          provider_integration_id: '$input.provider_integration_id'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.import_place_reviews.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '商家评论导入',
    description: 'Imports reviews for a single discovered place through the selected geo provider and stores them as tenant-scoped review evidence.',
    trigger_intents: ['geo_import_place_reviews', 'sync_place_reviews', '评论导入'],
    required_inputs: ['place_id'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_review_import_result'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'import_reviews',
        type: 'tool',
        tool_id: 'geo.import_place_reviews',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          place_id: '$input.place_id',
          provider_integration_id: '$input.provider_integration_id',
          limit: '$input.limit'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.prepare_local_outreach.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '本地商家触达准备',
    description: 'Generates a review-grounded pain insight and a personalized outreach draft for a single discovered place.',
    trigger_intents: ['geo_local_outreach', 'prepare_local_outreach', '本地商家线索'],
    required_inputs: ['place_id', 'product_offer'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_place_insight', 'geo_outreach_draft'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'extract_pain_signals',
        type: 'tool',
        tool_id: 'geo.extract_place_pain_signals',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          place_id: '$input.place_id',
          offer_context: '$input.offer_context',
          review_limit: '$input.review_limit'
        }
      },
      {
        id: 'generate_outreach_draft',
        type: 'tool',
        tool_id: 'geo.generate_outreach_draft',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          place_id: '$input.place_id',
          product_offer: '$input.product_offer',
          offer_summary: '$input.offer_summary',
          channel: '$input.channel'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.route_place_followup.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '本地线索路由交接',
    description: 'Builds a structured tenant-scoped territory/routing handoff packet so geo leads can move into CRM and voice follow-up with owner/route decisions.',
    trigger_intents: ['geo_route_place_followup', 'route_local_lead', '本地线索交接'],
    required_inputs: ['place_id'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_handoff_packet'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'generate_handoff_packet',
        type: 'tool',
        tool_id: 'geo.generate_handoff_packet',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          place_id: '$input.place_id',
          insight_id: '$input.insight_id',
          draft_id: '$input.draft_id',
          territory_id: '$input.territory_id',
          coverage_id: '$input.coverage_id',
          channel: '$input.channel',
          owner_user_id: '$input.owner_user_id',
          priority_tier: '$input.priority_tier'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.execute_handoff_followup.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '执行线索交接',
    description: 'Consumes a structured geo handoff packet and drives the actual CRM task plus optional approval-gated voice follow-up through the existing harness tools.',
    trigger_intents: ['geo_execute_handoff_followup', 'execute_handoff_packet', '执行线索交接'],
    required_inputs: ['handoff_id'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_handoff_execution'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'execute_handoff_packet',
        type: 'tool',
        tool_id: 'geo.execute_handoff_packet',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          handoff_id: '$input.handoff_id',
          execute_voice_followup: '$input.execute_voice_followup',
          crm_due_hours: '$input.crm_due_hours'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.balance_territory_capacity.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '片区容量重平衡',
    description: 'Builds a territory capacity report and optionally rebalances not-yet-executed handoff packets onto available rep coverage without bypassing the geo routing layer.',
    trigger_intents: ['geo_balance_territory_capacity', 'rebalance_geo_handoffs', '片区容量平衡'],
    required_inputs: ['territory_id'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_capacity_balance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'rebalance_handoffs',
        type: 'tool',
        tool_id: 'geo.rebalance_territory_handoffs',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          territory_id: '$input.territory_id',
          dry_run: '$input.dry_run'
        }
      },
      {
        id: 'commit_capacity_report',
        type: 'artifact',
        artifact_type: 'geo_capacity_balance_report',
        status: 'draft',
        payload: {
          territory_id: '$input.territory_id',
          report: '$steps.rebalance_handoffs'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'geo_agent.sync_feedback_loops.v1',
    agent_id: geoAgent.agent_id,
    version: '1.0.0',
    name: '同步片区反馈',
    description: 'Pulls downstream CRM task, approval, and voice call state back into geo handoff packets and rep coverage load so routing suggestions stay current after execution.',
    trigger_intents: ['geo_sync_feedback_loops', 'sync_geo_feedback', '同步片区反馈'],
    required_inputs: ['territory_id'],
    allowed_toolsets: ['geo'],
    required_artifacts: ['geo_feedback_loop_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'sync_feedback',
        type: 'tool',
        tool_id: 'geo.sync_territory_feedback',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          territory_id: '$input.territory_id'
        }
      },
      {
        id: 'commit_feedback_report',
        type: 'artifact',
        artifact_type: 'geo_feedback_loop_report',
        status: 'draft',
        payload: {
          territory_id: '$input.territory_id',
          report: '$steps.sync_feedback'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_maintenance.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由运维维护',
    description: 'Runs tenant-scoped geo routing maintenance by syncing downstream feedback, rebalancing pending handoffs, and syncing the resulting territory state again through the same runtime path.',
    trigger_intents: ['geo_routing_maintenance', 'ops_geo_routing', 'Geo 路由运维'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'run_geo_routing_maintenance',
        type: 'tool',
        tool_id: 'geo.run_routing_maintenance',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          territory_id: '$input.territory_id',
          dry_run: '$input.dry_run'
        }
      },
      {
        id: 'commit_geo_maintenance_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_maintenance',
          dry_run: '$input.dry_run',
          maintenance: '$steps.run_geo_routing_maintenance'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_trigger_bootstrap.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由触发器下发',
    description: 'Bootstraps default scheduler triggers for tenant-scoped geo routing maintenance so tenants do not need to wire feedback-sync and rebalance loops by hand.',
    trigger_intents: ['geo_routing_trigger_bootstrap', 'ops_geo_trigger_bootstrap', 'Geo 路由触发器下发'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'bootstrap_geo_routing_triggers',
        type: 'tool',
        tool_id: 'geo.bootstrap_routing_triggers',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          territory_id: '$input.territory_id',
          scope: '$input.scope',
          interval_seconds: '$input.interval_seconds',
          next_run_at: '$input.next_run_at',
          dry_run: '$input.dry_run'
        }
      },
      {
        id: 'commit_geo_trigger_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_trigger_bootstrap',
          bootstrap: '$steps.bootstrap_geo_routing_triggers'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_rollout.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略下发',
    description: 'Rolls out tenant geo routing maintenance defaults by reading the stored routing policy and idempotently bootstrapping the matching scheduler triggers.',
    trigger_intents: ['geo_routing_policy_rollout', 'ops_geo_policy_rollout', 'Geo 路由策略下发'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'rollout_geo_routing_policy',
        type: 'tool',
        tool_id: 'geo.rollout_routing_policy',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          territory_id: '$input.territory_id',
          next_run_at: '$input.next_run_at'
        }
      },
      {
        id: 'commit_geo_policy_rollout_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_rollout',
          rollout: '$steps.rollout_geo_routing_policy'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_override.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略覆盖',
    description: 'Applies an approval-gated geo routing policy override, records a ledger entry, and rolls the updated policy into scheduler trigger state.',
    trigger_intents: ['geo_routing_policy_override', 'ops_geo_policy_override', 'Geo 路由策略覆盖'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'apply_geo_routing_policy_override',
        type: 'tool',
        tool_id: 'geo.override_routing_policy',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          override_patch: '$input.override_patch',
          territory_id: '$input.territory_id',
          next_run_at: '$input.next_run_at',
          reason: '$input.reason'
        }
      },
      {
        id: 'commit_geo_policy_override_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_override',
          override: '$steps.apply_geo_routing_policy_override'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_rollback.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略回滚',
    description: 'Rolls a geo routing policy back to the last known-good override snapshot through an approval-gated rollback path.',
    trigger_intents: ['geo_routing_policy_rollback', 'ops_geo_policy_rollback', 'Geo 路由策略回滚'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'rollback_geo_routing_policy_override',
        type: 'tool',
        tool_id: 'geo.rollback_routing_policy_override',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          override_id: '$input.override_id',
          territory_id: '$input.territory_id',
          next_run_at: '$input.next_run_at',
          reason: '$input.reason'
        }
      },
      {
        id: 'commit_geo_policy_rollback_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_rollback',
          rollback: '$steps.rollback_geo_routing_policy_override'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_review.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略复核',
    description: 'Builds a tenant-scoped geo routing policy review queue with drift, pending approvals, and recent override context, then commits a maintenance artifact for operator review.',
    trigger_intents: ['geo_routing_policy_review', 'ops_geo_policy_review', 'Geo 路由策略复核'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'review_geo_routing_policy',
        type: 'tool',
        tool_id: 'geo.routing_policy_review_queue',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          review_status: '$input.review_status',
          item_type: '$input.item_type',
          limit: '$input.limit',
          attention_limit: '$input.attention_limit'
        }
      },
      {
        id: 'commit_geo_policy_review_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_review',
          review_queue: '$steps.review_geo_routing_policy'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_action_workbench.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略动作台',
    description: 'Builds a tenant-scoped geo routing policy action workbench with executable rollout, approval-resume, and rollback-launch actions, then commits a maintenance artifact for operator follow-through.',
    trigger_intents: ['geo_routing_policy_action_workbench', 'ops_geo_policy_action_workbench', 'Geo 路由策略动作台'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'build_geo_routing_policy_action_workbench',
        type: 'tool',
        tool_id: 'geo.routing_policy_action_workbench',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          review_status: '$input.review_status',
          item_type: '$input.item_type',
          limit: '$input.limit',
          attention_limit: '$input.attention_limit'
        }
      },
      {
        id: 'commit_geo_policy_action_workbench_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_action_workbench',
          action_workbench: '$steps.build_geo_routing_policy_action_workbench'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_action_history.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略动作历史',
    description: 'Builds a tenant-scoped geo routing policy action history report so operators can review recent approve-resume, rollout, and rollback-launch activity through the same audited artifact path.',
    trigger_intents: ['geo_routing_policy_action_history', 'ops_geo_policy_action_history', 'Geo 路由策略动作历史'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'build_geo_routing_policy_action_history',
        type: 'tool',
        tool_id: 'geo.routing_policy_action_history',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          review_key: '$input.review_key',
          action_id: '$input.action_id',
          status: '$input.status',
          limit: '$input.limit'
        }
      },
      {
        id: 'commit_geo_policy_action_history_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_action_history',
          action_history: '$steps.build_geo_routing_policy_action_history'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_batch_planning.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略批量规划',
    description: 'Builds a tenant-scoped geo routing policy batch plan preview, including risk mix and guarded selections, then commits a maintenance artifact for operator review before execution.',
    trigger_intents: ['geo_routing_policy_batch_planning', 'ops_geo_policy_batch_planning', 'Geo 路由策略批量规划'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'build_geo_routing_policy_batch_plan',
        type: 'tool',
        tool_id: 'geo.routing_policy_batch_plan_preview',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          plan_id: '$input.plan_id',
          items: '$input.items',
          lookup_limit: '$input.lookup_limit'
        }
      },
      {
        id: 'commit_geo_policy_batch_plan_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_batch_planning',
          batch_plan_preview: '$steps.build_geo_routing_policy_batch_plan'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_refresh.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略批量计划刷新',
    description: 'Refreshes a saved geo routing policy batch plan against the current workbench state, archives the superseded plan when requested, and commits a maintenance artifact describing the rebase result.',
    trigger_intents: ['geo_routing_policy_batch_plan_refresh', 'ops_geo_policy_batch_plan_refresh', 'Geo 路由策略批量计划刷新'],
    required_inputs: ['plan_id'],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'refresh_geo_routing_policy_batch_plan',
        type: 'tool',
        tool_id: 'geo.routing_policy_batch_plan_refresh',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          plan_id: '$input.plan_id',
          plan_name: '$input.plan_name',
          notes: '$input.notes',
          refresh_mode: '$input.refresh_mode',
          adopt_strategy: '$input.adopt_strategy',
          archive_reason: '$input.archive_reason'
        }
      },
      {
        id: 'commit_geo_policy_batch_plan_refresh_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_batch_plan_refresh',
          batch_plan_refresh: '$steps.refresh_geo_routing_policy_batch_plan'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_lineage.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略批量计划谱系',
    description: 'Builds a tenant-scoped lineage/detail report for a geo routing policy batch plan so operators can inspect archived-vs-active plan evolution and identify the recommended successor before execution.',
    trigger_intents: ['geo_routing_policy_batch_plan_lineage', 'ops_geo_policy_batch_plan_lineage', 'Geo 路由策略批量计划谱系'],
    required_inputs: ['plan_id'],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'build_geo_routing_policy_batch_plan_lineage',
        type: 'tool',
        tool_id: 'geo.routing_policy_batch_plan_lineage',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          plan_id: '$input.plan_id',
          status: '$input.status',
          limit: '$input.limit'
        }
      },
      {
        id: 'commit_geo_policy_batch_plan_lineage_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_batch_plan_lineage',
          batch_plan_lineage: '$steps.build_geo_routing_policy_batch_plan_lineage'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_target.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略批量计划目标',
    description: 'Resolves the current preferred/recommended/latest-active geo routing policy batch plan target and commits a maintenance artifact so operators can execute the current default target without manually inspecting lineage first.',
    trigger_intents: ['geo_routing_policy_batch_plan_target', 'ops_geo_policy_batch_plan_target', 'Geo 路由策略批量计划目标'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'resolve_geo_routing_policy_batch_plan_target',
        type: 'tool',
        tool_id: 'geo.routing_policy_batch_plan_target',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          plan_target: '$input.plan_target',
          limit: '$input.limit'
        }
      },
      {
        id: 'commit_geo_policy_batch_plan_target_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_batch_plan_target',
          batch_plan_target: '$steps.resolve_geo_routing_policy_batch_plan_target'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_governance.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略批量计划治理',
    description: 'Applies archive, restore, or promote governance actions to a saved geo routing policy batch plan and commits a maintenance artifact describing the new execution target state.',
    trigger_intents: ['geo_routing_policy_batch_plan_governance', 'ops_geo_policy_batch_plan_governance', 'Geo 路由策略批量计划治理'],
    required_inputs: ['plan_id', 'action'],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'govern_geo_routing_policy_batch_plan',
        type: 'tool',
        tool_id: 'geo.routing_policy_batch_plan_govern',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          plan_id: '$input.plan_id',
          action: '$input.action',
          reason: '$input.reason',
          make_preferred: '$input.make_preferred'
        }
      },
      {
        id: 'commit_geo_policy_batch_plan_governance_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_batch_plan_governance',
          batch_plan_governance: '$steps.govern_geo_routing_policy_batch_plan'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.geo_routing_policy_batch_actions.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: 'Geo 路由策略批量动作',
    description: 'Executes a guarded batch of geo routing policy operator actions and commits a maintenance artifact summarizing processed, blocked, and failed items.',
    trigger_intents: ['geo_routing_policy_batch_actions', 'ops_geo_policy_batch_actions', 'Geo 路由策略批量动作'],
    required_inputs: [],
    allowed_toolsets: ['geo', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'execute_geo_routing_policy_batch_actions',
        type: 'tool',
        tool_id: 'geo.routing_policy_review_batch_execute',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          policy_id: '$input.policy_id',
          plan_id: '$input.plan_id',
          plan_target: '$input.plan_target',
          items: '$input.items',
          confirm_stale_plan: '$input.confirm_stale_plan',
          continue_on_error: '$input.continue_on_error',
          note: '$input.note'
        }
      },
      {
        id: 'commit_geo_policy_batch_actions_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'geo_routing_policy_batch_actions',
          batch_actions: '$steps.execute_geo_routing_policy_batch_actions'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.voice_recording_retention_maintenance.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: '语音录音留存维护',
    description: 'Runs tenant-scoped voice recording retention enforcement and commits a maintenance artifact for audit/review.',
    trigger_intents: ['voice_recording_retention_maintenance', 'ops_voice_retention', '录音留存维护'],
    required_inputs: [],
    allowed_toolsets: ['voice'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'enforce_retention',
        type: 'tool',
        tool_id: 'voice.recording_retention_enforce',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          action: '$input.action',
          dry_run: '$input.dry_run',
          due_before: '$input.due_before',
          limit: '$input.limit'
        }
      },
      {
        id: 'commit_maintenance_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'voice_recording_retention',
          action: '$input.action',
          dry_run: '$input.dry_run',
          enforcement: '$steps.enforce_retention'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.voice_recording_archive_maintenance.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: '语音录音归档维护',
    description: 'Archives overdue voice recordings through the same tenant-scoped retention tool path and commits a maintenance artifact.',
    trigger_intents: ['voice_recording_archive_maintenance', 'ops_voice_archive', '录音归档维护'],
    required_inputs: [],
    allowed_toolsets: ['voice'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'archive_recordings',
        type: 'tool',
        tool_id: 'voice.recording_retention_enforce',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          action: 'archive',
          dry_run: '$input.dry_run',
          due_before: '$input.due_before',
          archive_url_base: '$input.archive_url_base',
          limit: '$input.limit'
        }
      },
      {
        id: 'commit_archive_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'voice_recording_archive',
          action: 'archive',
          dry_run: '$input.dry_run',
          enforcement: '$steps.archive_recordings'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.voice_runtime_deployment_audit.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: '语音运行时部署审计',
    description: 'Captures a tenant-scoped RustPBX and WebRTC deployment snapshot and commits an ops maintenance artifact.',
    trigger_intents: ['voice_runtime_deployment_audit', 'ops_voice_deployment_audit', '语音部署审计'],
    required_inputs: [],
    allowed_toolsets: ['voice', 'artifact'],
    required_artifacts: ['ops_maintenance_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'capture_deployment_snapshot',
        type: 'tool',
        tool_id: 'voice.runtime_deployment_snapshot_create',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id'
        }
      },
      {
        id: 'commit_deployment_report',
        type: 'artifact',
        artifact_type: 'ops_maintenance_report',
        status: 'draft',
        payload: {
          maintenance_type: 'voice_runtime_deployment',
          snapshot: '$steps.capture_deployment_snapshot'
        }
      }
    ]
  });

  agentRegistry.registerPlaybook({
    playbook_id: 'ops_agent.polyglot_sidecar_health.v1',
    agent_id: opsAgent.agent_id,
    version: '1.0.0',
    name: '多语言 sidecar 健康检查',
    description: 'Checks Go/Python/Rust sidecar readiness through the TS control plane and commits a health artifact.',
    trigger_intents: ['polyglot_sidecar_health', 'sidecar_health', '多语言服务健康检查'],
    required_inputs: [],
    allowed_toolsets: ['ops', 'artifact'],
    required_artifacts: ['ops_sidecar_health_report'],
    completion_protocol: {
      success: 'completed',
      blocked: 'failed_blocked'
    },
    steps: [
      {
        id: 'check_sidecars',
        type: 'tool',
        tool_id: 'ops.sidecar_health_check',
        input: {
          tenant_id: '$input.tenant_id',
          workspace_id: '$input.workspace_id',
          timeout_ms: '$input.timeout_ms'
        }
      },
      {
        id: 'commit_sidecar_health_report',
        type: 'artifact',
        artifact_type: 'ops_sidecar_health_report',
        status: 'draft',
        payload: {
          health: '$steps.check_sidecars'
        }
      }
    ]
  });

  return { orchestrationAgent, analyticsAgent, crmAgent, voiceAgent, knowledgeAgent, geoAgent, opsAgent, growthLoopPlaybook };
}
