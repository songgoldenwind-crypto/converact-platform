import type { JsonRecord } from '../integrations/provider-runtime-types.js';

interface AgentRegistryLike {
  playbooks: Map<string, JsonRecord>;
  getPlaybook: (playbookId: string) => JsonRecord;
}

interface RouteInput {
  intent?: string;
  goal?: string;
  preferred_agent_id?: string | null;
}

interface RouteError extends Error {
  status: number;
}

export class PlaybookRouter {
  agentRegistry: AgentRegistryLike;

  constructor(agentRegistry: AgentRegistryLike) {
    this.agentRegistry = agentRegistry;
  }

  route({ intent = '', goal = '', preferred_agent_id = null }: RouteInput): JsonRecord {
    const normalized = `${intent} ${goal}`.toLowerCase();
    const candidates = [...this.agentRegistry.playbooks.values()].filter((playbook) => {
      if (preferred_agent_id && playbook.agent_id !== preferred_agent_id) return false;
      return playbook.trigger_intents.some((trigger) => normalized.includes(trigger.toLowerCase()));
    });

    if (candidates.length) return candidates[0];

    if (/weekly|复盘|分析|report|analytics/.test(normalized)) {
      return this.agentRegistry.getPlaybook('analytics_agent.weekly_review.v1');
    }

    if (/voice|call|phone|pbx|rustpbx|外呼|电话|呼叫/.test(normalized)) {
      return this.agentRegistry.getPlaybook('voice_agent.queue_followup_call.v1');
    }

    if (/crm|follow.?up|task|跟进|任务/.test(normalized)) {
      return this.agentRegistry.getPlaybook('crm_agent.create_followup_task.v1');
    }

    if (/open.?source|integration|connector|mcp|skill|开源|集成|工具|rustpbx|crm|pbx/.test(normalized)) {
      return this.agentRegistry.getPlaybook('orchestration_agent.integration_stack_recommendation.v1');
    }

    if (/lead|线索|获客|咨询|growth|source|landing/.test(normalized)) {
      return this.agentRegistry.getPlaybook('orchestration_agent.growth_loop_intake.v1');
    }

    const error: RouteError = Object.assign(new Error('no matching playbook'), { status: 422 });
    throw error;
  }
}
