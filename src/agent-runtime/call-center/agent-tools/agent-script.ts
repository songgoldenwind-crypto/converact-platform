import { all, id, json, one, parseJson, run } from '../../../db.js';
import type { VoiceStore } from '../../voice/voice-store.js';

export interface ScriptStep {
  id: string;
  title: string;
  prompt: string;
}

export interface AgentScriptTemplate {
  id: string;
  tenant_id: string;
  name: string;
  steps: ScriptStep[];
  is_active: boolean;
  created_at: string;
}

export class AgentScriptStore {
  constructor(private readonly db: unknown) {}

  seedDefault(tenantId: string): AgentScriptTemplate {
    const existing = one(
      this.db,
      `SELECT id FROM agent_script_templates WHERE tenant_id = ? AND name = '默认外呼脚本'`,
      [tenantId]
    );
    if (existing) return this.getTemplate(String(existing.id))!;

    return this.createTemplate({
      tenant_id: tenantId,
      name: '默认外呼脚本',
      steps: [
        { id: 'greet', title: '开场问候', prompt: '自我介绍并确认对方是否方便接听' },
        { id: 'disclose', title: 'AI 披露', prompt: '说明本次为 AI 智能外呼服务' },
        { id: 'discover', title: '需求了解', prompt: '询问客户当前需求或痛点' },
        { id: 'offer', title: '方案推荐', prompt: '根据需求推荐合适方案' },
        { id: 'close', title: '收尾约定', prompt: '确认下一步行动或预约回呼' }
      ]
    });
  }

  createTemplate(input: {
    tenant_id: string;
    name: string;
    steps: ScriptStep[];
  }): AgentScriptTemplate {
    const templateId = id('ascript');
    run(
      this.db,
      `INSERT INTO agent_script_templates (id, tenant_id, name, steps, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [templateId, input.tenant_id, input.name, json(input.steps)]
    );
    return this.getTemplate(templateId)!;
  }

  getTemplate(templateId: string): AgentScriptTemplate | null {
    const row = one(this.db, 'SELECT * FROM agent_script_templates WHERE id = ?', [templateId]);
    if (!row) return null;
    return {
      id: String(row.id),
      tenant_id: String(row.tenant_id),
      name: String(row.name),
      steps: parseJson<ScriptStep[]>(String(row.steps), []),
      is_active: Boolean(row.is_active),
      created_at: String(row.created_at)
    };
  }

  listTemplates(tenantId: string): AgentScriptTemplate[] {
    return all(
      this.db,
      `SELECT * FROM agent_script_templates WHERE tenant_id = ? AND is_active = 1 ORDER BY created_at DESC`,
      [tenantId]
    ).map((row) => ({
      id: String((row as { id: string }).id),
      tenant_id: String((row as { tenant_id: string }).tenant_id),
      name: String((row as { name: string }).name),
      steps: parseJson<ScriptStep[]>(String((row as { steps: string }).steps), []),
      is_active: Boolean((row as { is_active: number }).is_active),
      created_at: String((row as { created_at: string }).created_at)
    }));
  }
}

export class AgentScriptTracker {
  constructor(private readonly voiceStore: VoiceStore) {}

  getProgress(tenantId: string, callSessionId: string, template: AgentScriptTemplate) {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) console.warn('[agent-script] session not found:', callSessionId);
    const metadata =
      session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    const currentStepId = String(metadata.script_step_id || template.steps[0]?.id || '');
    const index = template.steps.findIndex((step) => step.id === currentStepId);
    return {
      template_id: template.id,
      template_name: template.name,
      current_step_id: currentStepId,
      current_step_index: index >= 0 ? index : 0,
      steps: template.steps,
      completed: index >= template.steps.length - 1
    };
  }

  advanceStep(tenantId: string, callSessionId: string, template: AgentScriptTemplate) {
    const progress = this.getProgress(tenantId, callSessionId, template);
    const next = template.steps[progress.current_step_index + 1] || null;
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) console.warn('[agent-script] session not found:', callSessionId);
    const metadata =
      session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? { ...(session.metadata as Record<string, unknown>) }
        : {};
    if (next) {
      this.voiceStore.updateCallSession(tenantId, callSessionId, {
        metadata: { ...metadata, script_step_id: next.id, script_template_id: template.id }
      });
    }
    return { ...progress, advanced_to: next?.id || null };
  }
}
