import { voiceAgentDefaults } from './voice-agent-defaults.js';
import type {
  CreateVoiceAgentSpecInput,
  ImportIvrVoiceAgentInput,
  IvrMenuNode,
  VoiceAgentSpecNode,
  VoiceAgentSpecRuntime
} from './types.js';

export function importIvrToVoiceAgentSpec(input: ImportIvrVoiceAgentInput): CreateVoiceAgentSpecInput {
  if (!input.tenant_id || !input.menus?.length) {
    throw Object.assign(new Error('tenant_id and menus are required'), { status: 400 });
  }

  const language = input.language || 'zh';
  const defaults = voiceAgentDefaults(language);
  const rootId = input.root_id || input.menus.find((m) => m.id === 'root')?.id || input.menus[0].id;
  const nodes = input.menus.map((menu) => menuToSpecNode(menu));
  const rootMenu = input.menus.find((m) => m.id === rootId) || input.menus[0];
  const disclosure = input.brand_name
    ? `本次为 ${input.brand_name} AI 智能外呼服务`
    : defaults.ai_disclosure;

  const runtime: VoiceAgentSpecRuntime = {
    system_prompt: buildNavigationSystemPrompt({
      goal: input.goal || rootMenu.name,
      rootId,
      nodes,
      disclosure,
      language
    }),
    greeting: `${rootMenu.prompt}\n（${disclosure}）`,
    transfer_message: defaults.transfer_message,
    end_message: defaults.end_message
  };

  return {
    tenant_id: input.tenant_id,
    language,
    goal: input.goal || `IVR 导航：${rootMenu.name}`,
    status: input.publish ? 'published' : 'draft',
    tools: ['check_intent', 'transfer_human', 'schedule_callback', 'navigate_flow'],
    compliance: {
      ai_disclosure: disclosure,
      forbidden_topics: []
    },
    runtime,
    nodes
  };
}

function menuToSpecNode(menu: IvrMenuNode): VoiceAgentSpecNode {
  const transitions: Record<string, string> = { ...(menu.transitions || {}) };

  for (const option of menu.options || []) {
    const key = String(option.key || '').trim();
    if (!key) continue;
    transitions[`dtmf:${key}`] = option.target;
    if (option.label) {
      transitions[`keyword:${option.label}`] = option.target;
    }
  }

  if (menu.action === 'transfer_human') {
    transitions.intent_high = '__transfer_human__';
    transitions.transfer = '__transfer_human__';
  }
  if (menu.action === 'end_call') {
    transitions.end = '__end_call__';
  }
  if (menu.action === 'schedule_callback') {
    transitions.callback = '__schedule_callback__';
  }

  return {
    id: menu.id,
    name: menu.name,
    prompt: menu.prompt,
    transitions
  };
}

function buildNavigationSystemPrompt(args: {
  goal: string;
  rootId: string;
  nodes: VoiceAgentSpecNode[];
  disclosure: string;
  language: string;
}): string {
  const nodeSummary = args.nodes
    .map((node) => {
      const routes = Object.entries(node.transitions || {})
        .map(([key, target]) => `${key}→${target}`)
        .join(', ');
      return `- [${node.id}] ${node.name}: ${node.prompt || ''}${routes ? ` (路由: ${routes})` : ''}`;
    })
    .join('\n');

  return `你是语音导航 AI 客服。目标：${args.goal}。合规披露：${args.disclosure}。

你在一套对话节点图中工作，根节点为「${args.rootId}」。根据客户说的话或意图，使用 navigate_flow 工具切换到合适节点。

节点图：
${nodeSummary}

规则：
1. 每次只推进一个节点，切换后用该节点的 prompt 引导对话
2. 客户说出选项关键词或数字时，用 navigate_flow(trigger=dtmf:键 或 keyword:词)
3. 客户意向高时先 check_intent，若 recommendation=transfer 再 navigate_flow(trigger=intent_high)
4. 切换到 __transfer_human__ / __end_call__ / __schedule_callback__ 时执行对应 tool
5. 单次回复不超过 3 句话，使用${args.language === 'zh' ? '普通话' : args.language}`;
}
