/**
 * Compliance node — CP-1 disclosure / CP-2 recording_consent consent keys.
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import { voiceAgentDefaults } from '../call-center/voice-agent-defaults.js';
import type { VoiceAgentSpecLanguage } from '../call-center/types.js';
import { requireEdge, type IvrFlowGraph, type IvrNodeBase } from './ivr-types.js';
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';

export const COMPLIANCE_CONSENT_BRANCH = {
  ACKNOWLEDGED: 'acknowledged',
  DECLINED: 'declined',
} as const;

function edgeTarget(graph: IvrFlowGraph, nodeId: string, handle: string): string | null {
  const edge = requireEdge(graph, nodeId, handle);
  return edge.ok ? edge.target : null;
}

export function resolveCompliancePrompt(
  complianceType: string,
  language: string,
  nodeData?: Record<string, unknown>
): string {
  const lang = (language || 'zh') as VoiceAgentSpecLanguage;
  const defaults = voiceAgentDefaults(lang);
  const custom = nodeData?.prompt as string | undefined;
  if (custom?.trim()) return custom.trim();
  switch (complianceType) {
    case 'recording_consent':
      return defaults.recording_consent;
    case 'privacy_notice':
      return defaults.privacy_notice;
    default:
      return defaults.ai_disclosure;
  }
}

export function handleComplianceDisclosureComplete(
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  variables: Record<string, string>
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} {
  const consentPrompt =
    (node.data.consentPrompt as string)?.trim() ||
    voiceAgentDefaults((node.data.language as VoiceAgentSpecLanguage) || 'zh').recording_consent_keys;

  return {
    action: {
      kind: 'collect_digits',
      prompt: consentPrompt,
      promptType: 'tts',
      minDigits: 1,
      maxDigits: 1,
      storeVar: '_compliance_key',
      node: node.id,
    },
    context: {
      ...context,
      variables,
      compliancePhase: 'consent',
      interaction: { nodeId: node.id, kind: 'collect', awaiting: true },
      lastPromptNodeId: node.id,
      currentNodeId: node.id,
      pendingAdvanceNodeId: undefined,
    },
    nextNodeId: node.id,
    terminated: false,
  };
}

export function handleComplianceStep(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>,
  input: IvrStepInput
): {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
} {
  const complianceType = (node.data.complianceType as string) || 'ai_disclosure';

  if (complianceType === 'recording_consent') {
    if (context.compliancePhase === 'consent') {
      const consuming = !!(input.dtmf ?? context.pendingDigits) || !!input.timedOut;
      if (!consuming) {
        return {
          action,
          context: {
            ...context,
            variables,
            interaction: { nodeId: node.id, kind: 'collect', awaiting: true },
            currentNodeId: node.id,
          },
          nextNodeId: node.id,
          terminated: false,
        };
      }

      let branch: string;
      const digit = (input.dtmf ?? context.pendingDigits ?? '').replace(/#$/u, '');
      if (input.timedOut) {
        branch = IVR_BRANCH.TIMEOUT;
      } else if (digit === '1') {
        branch = COMPLIANCE_CONSENT_BRANCH.ACKNOWLEDGED;
        variables.compliance_ack = 'true';
      } else if (digit === '2') {
        branch = COMPLIANCE_CONSENT_BRANCH.DECLINED;
        variables.compliance_ack = 'false';
      } else {
        branch = IVR_BRANCH.INVALID;
      }

      if (branch === IVR_BRANCH.INVALID) {
        return {
          action,
          context: {
            ...context,
            variables,
            interaction: { nodeId: node.id, kind: 'collect', awaiting: true },
            currentNodeId: node.id,
          },
          nextNodeId: node.id,
          terminated: false,
        };
      }

      const nextNodeId = edgeTarget(graph, node.id, branch);
      const routed = applyBranchRoute(variables, node.id, branch, nextNodeId);
      return {
        action: { kind: 'log', message: `compliance ${branch}`, node: node.id },
        context: {
          ...context,
          variables: routed,
          compliancePhase: undefined,
          interaction: undefined,
          pendingDigits: undefined,
          currentNodeId: nextNodeId,
        },
        nextNodeId,
        terminated: false,
      };
    }

    if (input.playCompleted && context.compliancePhase === 'disclosure') {
      return handleComplianceDisclosureComplete(node, context, variables);
    }

    return {
      action,
      context: {
        ...context,
        variables,
        compliancePhase: 'disclosure',
        currentNodeId: node.id,
        lastPromptNodeId: node.id,
      },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  if (!input.playCompleted) {
    return {
      action,
      context: {
        ...context,
        variables,
        currentNodeId: node.id,
        lastPromptNodeId: node.id,
      },
      nextNodeId: node.id,
      terminated: false,
    };
  }

  const nextNodeId = edgeTarget(graph, node.id, IVR_BRANCH.OUT);
  const routed = applyBranchRoute(variables, node.id, IVR_BRANCH.OUT, nextNodeId);
  return {
    action: { kind: 'log', message: 'compliance out', node: node.id },
    context: {
      ...context,
      variables: routed,
      pendingAdvanceNodeId: undefined,
      currentNodeId: nextNodeId,
    },
    nextNodeId,
    terminated: false,
  };
}
