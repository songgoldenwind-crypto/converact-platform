/**
 * Dynamic output handles per node — mirrors REQUIRED_HANDLES_BY_TYPE for designer / docs.
 */
import { menuRequiredDigitHandles, REQUIRED_HANDLES_BY_TYPE } from './ivr-branch-handles.js';

export interface NodeHandleSource {
  type: string;
  data: Record<string, unknown>;
}

export function getNodeOutputHandles(node: NodeHandleSource): string[] {
  if (node.type === 'transfer') {
    // Success uses IVR_BRANCH.OUT (ivr-transfer-handler); failure handles mirror TRANSFER_BRANCH.
    return ['out', 'no_answer', 'busy', 'failed'];
  }
  if (node.type === 'play') {
    return ['out', 'error'];
  }

  const rule = REQUIRED_HANDLES_BY_TYPE[node.type];
  if (!rule) return [];

  const dynamic = rule.dynamic?.(node) ?? [];
  return [...rule.required, ...dynamic];
}

export function nodeAcceptsInboundEdge(node: NodeHandleSource): boolean {
  if (node.type === 'start') return false;
  return !['voicemail', 'sip', 'disconnect'].includes(node.type);
}

export function menuDigitHandles(node: NodeHandleSource): string[] {
  return menuRequiredDigitHandles(node);
}
