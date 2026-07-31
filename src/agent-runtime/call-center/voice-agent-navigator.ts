import type { VoiceAgentSpec, VoiceAgentSpecNode } from './types.js';

export type NavigationAction = 'continued' | 'transfer_human' | 'end_call' | 'schedule_callback';

export interface NavigateVoiceAgentResult {
  previous_node_id: string;
  current_node_id: string;
  node_name: string;
  prompt: string;
  action_taken: NavigationAction;
  message_for_agent: string;
  reached_terminal: boolean;
}

const TERMINAL_TARGETS: Record<string, NavigationAction> = {
  __transfer_human__: 'transfer_human',
  __end_call__: 'end_call',
  __schedule_callback__: 'schedule_callback'
};

export function normalizeNavigationTrigger(trigger: string): string {
  const raw = String(trigger || '').trim().toLowerCase();
  if (!raw) return 'default';
  if (raw === 'start' || raw === 'init') return 'start';
  if (raw.startsWith('dtmf:')) return raw;
  if (raw.startsWith('intent:')) return raw.replace('intent:', 'intent_');
  if (raw === 'high' || raw === 'intent_high') return 'intent_high';
  if (raw === 'transfer' || raw === 'transfer_human') return 'transfer';
  if (raw === 'end' || raw === 'end_call') return 'end';
  if (raw === 'callback' || raw === 'schedule_callback') return 'callback';
  if (raw.startsWith('keyword:')) return raw;
  if (/^[0-9*#]$/.test(raw)) return `dtmf:${raw}`;
  return raw;
}

export function buildSpecNodeIndex(spec: VoiceAgentSpec): Map<string, VoiceAgentSpecNode> {
  return new Map(spec.nodes.map((node) => [node.id, node]));
}

export function getRootNodeId(spec: VoiceAgentSpec): string {
  if (spec.nodes.find((node) => node.id === 'root')) return 'root';
  return spec.nodes[0]?.id || 'root';
}

export function findSpecNode(
  spec: VoiceAgentSpec,
  nodeId: string,
  index?: Map<string, VoiceAgentSpecNode>
): VoiceAgentSpecNode | null {
  if (index) return index.get(nodeId) || null;
  return spec.nodes.find((node) => node.id === nodeId) || null;
}

function resolveTransitionTarget(
  transitions: Record<string, string>,
  trigger: string
): string | undefined {
  if (transitions[trigger]) return transitions[trigger];
  if (trigger.startsWith('dtmf:') || trigger.startsWith('keyword:')) return undefined;
  return transitions[`dtmf:${trigger}`] || transitions[`keyword:${trigger}`];
}

export function resolveNavigationTrigger(
  spec: VoiceAgentSpec,
  currentNodeId: string,
  rawTrigger: string,
  customerText?: string,
  index?: Map<string, VoiceAgentSpecNode>
): string {
  const trigger = normalizeNavigationTrigger(rawTrigger);
  if (trigger !== 'default' && trigger !== 'start') return trigger;

  const text = String(customerText || '').trim();
  if (!text) return trigger;

  const node = findSpecNode(spec, currentNodeId, index);
  if (!node?.transitions) return trigger;

  const keywordEntries = Object.entries(node.transitions)
    .filter(([key]) => key.startsWith('keyword:'))
    .sort(([a], [b]) => b.length - a.length);

  for (const [key] of keywordEntries) {
    const keyword = key.slice('keyword:'.length);
    if (keyword && text.includes(keyword)) return key;
  }

  const digit = text.match(/[0-9]/)?.[0];
  if (digit) {
    const dtmfKey = `dtmf:${digit}`;
    if (node.transitions[dtmfKey]) return dtmfKey;
  }

  return trigger;
}

export function navigateVoiceAgentNode(
  spec: VoiceAgentSpec,
  currentNodeId: string,
  rawTrigger: string,
  customerText?: string
): NavigateVoiceAgentResult {
  const index = buildSpecNodeIndex(spec);
  const rootId = getRootNodeId(spec);
  const trigger = resolveNavigationTrigger(spec, currentNodeId, rawTrigger, customerText, index);

  if (trigger === 'start') {
    const root = findSpecNode(spec, rootId, index) || {
      id: rootId,
      name: 'root',
      prompt: spec.runtime.greeting
    };
    return buildResult({
      previous: currentNodeId,
      current: rootId,
      node: root,
      action: 'continued',
      terminal: false,
      message: `从根节点「${root.name}」开始。${root.prompt || ''}`
    });
  }

  const current = findSpecNode(spec, currentNodeId, index) || findSpecNode(spec, rootId, index);
  if (!current) {
    const root = findSpecNode(spec, rootId, index)!;
    return buildResult({
      previous: currentNodeId,
      current: rootId,
      node: root,
      action: 'continued',
      terminal: false,
      message: `未知节点，已回到根节点「${root.name}」。${root.prompt || ''}`
    });
  }

  const transitions = current.transitions || {};
  let nextId =
    resolveTransitionTarget(transitions, trigger) ||
    (trigger === 'intent_high' ? transitions.intent_high : undefined) ||
    (trigger === 'transfer' ? transitions.transfer : undefined) ||
    transitions.default;

  if (!nextId) {
    return buildResult({
      previous: currentNodeId,
      current: currentNodeId,
      node: current,
      action: 'continued',
      terminal: false,
      message: `保持在节点「${current.name}」。${current.prompt || ''}`
    });
  }

  const terminalAction = TERMINAL_TARGETS[nextId];
  if (terminalAction) {
    return buildResult({
      previous: currentNodeId,
      current: currentNodeId,
      node: current,
      action: terminalAction,
      terminal: true,
      message: `节点「${current.name}」触发 ${terminalAction}。`
    });
  }

  const nextNode = findSpecNode(spec, nextId, index);
  if (!nextNode) {
    return buildResult({
      previous: currentNodeId,
      current: currentNodeId,
      node: current,
      action: 'continued',
      terminal: false,
      message: `目标节点 ${nextId} 不存在，保持当前节点。`
    });
  }

  return buildResult({
    previous: currentNodeId,
    current: nextNode.id,
    node: nextNode,
    action: 'continued',
    terminal: false,
    message: `已进入节点「${nextNode.name}」。${nextNode.prompt || ''}`
  });
}

function buildResult(args: {
  previous: string;
  current: string;
  node: VoiceAgentSpecNode;
  action: NavigationAction;
  terminal: boolean;
  message: string;
}): NavigateVoiceAgentResult {
  return {
    previous_node_id: args.previous,
    current_node_id: args.current,
    node_name: args.node.name,
    prompt: args.node.prompt || '',
    action_taken: args.action,
    message_for_agent: args.message,
    reached_terminal: args.terminal
  };
}
