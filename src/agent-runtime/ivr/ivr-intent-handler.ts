/**
 * Intent node routing — keyword dimension (IN-1) + score dimension (IN-2).
 */
import { IVR_BRANCH } from './ivr-branch-handles.js';
import type { IvrFlowGraph } from './ivr-types.js';
import type { IntentExecResult } from './ivr-side-effects.js';

export function evaluateIntentKeyword(text: string, keywords: string[]): boolean {
  const hay = text.toLowerCase();
  return keywords.some((kw) => kw.trim() && hay.includes(kw.trim().toLowerCase()));
}

export function resolveIntentBranch(
  graph: IvrFlowGraph,
  nodeId: string,
  nodeData: Record<string, unknown>,
  variables: Record<string, string>,
  execResult?: IntentExecResult
): { branch: string; score?: number } {
  const dimension = (nodeData.dimension as string) || 'score';
  const threshold = (nodeData.threshold as number) ?? 0.7;

  if (dimension === 'keyword') {
    const utterance =
      variables.last_utterance || variables.caller_question || variables.speech_result || '';
    const highKeywords = (nodeData.keywords as string[]) || [];
    const lowKeywords = (nodeData.lowKeywords as string[]) || [];
    if (evaluateIntentKeyword(utterance, highKeywords)) {
      variables.intent_dimension = 'keyword';
      return { branch: IVR_BRANCH.HIGH };
    }
    if (evaluateIntentKeyword(utterance, lowKeywords)) {
      variables.intent_dimension = 'keyword';
      return { branch: IVR_BRANCH.LOW };
    }
    variables.intent_dimension = 'keyword';
    return { branch: IVR_BRANCH.CONTINUE };
  }

  let score = variables.intent_score ? parseFloat(variables.intent_score) : NaN;
  if (execResult?.score != null) {
    score = execResult.score;
    variables.intent_score = String(score);
  }
  variables.intent_dimension = dimension;

  if (Number.isNaN(score)) {
    console.warn(`intent node ${nodeId}: no intent_score for dimension=${dimension}, routing continue`);
    return { branch: IVR_BRANCH.CONTINUE };
  }

  if (score >= threshold) {
    return { branch: IVR_BRANCH.HIGH, score };
  }
  if (score < threshold * 0.5) {
    return { branch: IVR_BRANCH.LOW, score };
  }
  return { branch: IVR_BRANCH.CONTINUE, score };
}
