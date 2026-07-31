import type { VoiceStore } from '../voice/voice-store.js';
import type { VoiceAgentSpec } from './types.js';
import {
  getRootNodeId,
  navigateVoiceAgentNode,
  type NavigateVoiceAgentResult
} from './voice-agent-navigator.js';

export const NAVIGATION_MERGE_MAX_RETRIES = 3;

export function asCallSessionMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function buildNavigationMetadataPatch(
  meta: Record<string, unknown>,
  args: {
    agentSpecId: string;
    navigation: NavigateVoiceAgentResult;
    trigger: string;
  }
): Record<string, unknown> {
  const nodeHistory = Array.isArray(meta.node_history)
    ? [...meta.node_history.map(String), args.navigation.current_node_id]
    : [args.navigation.current_node_id];
  return {
    ...meta,
    agent_spec_id: args.agentSpecId,
    current_node_id: args.navigation.current_node_id,
    previous_node_id: args.navigation.previous_node_id,
    node_history: nodeHistory.slice(-20),
    last_navigation: {
      trigger: args.trigger,
      action_taken: args.navigation.action_taken,
      at: new Date().toISOString()
    }
  };
}

export function persistNavigationResult(
  voiceStore: VoiceStore,
  tenantId: string,
  callSessionId: string,
  spec: VoiceAgentSpec,
  args: {
    agentSpecId: string;
    trigger: string;
    customerText?: string;
  }
): NavigateVoiceAgentResult {
  for (let attempt = 0; attempt < NAVIGATION_MERGE_MAX_RETRIES; attempt++) {
    const session = voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const meta = asCallSessionMetadata(session.metadata);
    const version = Number(meta.navigation_version || 0);
    const currentNodeId = String(meta.current_node_id || getRootNodeId(spec));
    const navigation = navigateVoiceAgentNode(spec, currentNodeId, args.trigger, args.customerText);

    const merged = voiceStore.mergeCallSessionMetadataIf(tenantId, callSessionId, version, (existing) =>
      buildNavigationMetadataPatch(existing, {
        agentSpecId: args.agentSpecId,
        navigation,
        trigger: args.trigger
      })
    );

    if (merged?.ok) return navigation;
  }

  throw Object.assign(new Error('navigation state conflict, retry later'), { status: 409 });
}
