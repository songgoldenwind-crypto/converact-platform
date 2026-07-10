/**
 * IvrFlowExecutor — interprets an IvrFlowGraph step by step.
 *
 * Given a graph + a DTMF input sequence + initial variables, the executor
 * walks the graph from the entry node, executing each node's logic and
 * producing a trace of actions. This is the runtime engine that will be
 * wired to the media layer (RustPBX/LiveKit) to actually play prompts,
 * collect digits, and transfer calls.
 *
 * In simulation mode (no media layer), it produces a dry-run trace that
 * the frontend test UI can display.
 */

import type { IvrFlowGraph, IvrNodeBase } from './ivr-types.js';
import { resolveEdge, getNodeExits, isNodeSessionTerminal, requireEdge } from './ivr-types.js';
import type { IvrSideEffects } from './ivr-side-effects.js';
import {
  handlePlayCompleted,
  handleWaitingResume,
  hasConsumerInput,
} from './ivr-step-lifecycle.js';
import { handleMenuStep } from './ivr-menu-handler.js';
import { advanceQueueStep } from './ivr-queue-handler.js';
import type { AcdEnqueueFn } from './ivr-acd-adapter.js';
import { isTransferTerminal } from './ivr-transfer-handler.js';
import { advanceTransferStep } from './ivr-transfer-handler.js';
import { advanceDisconnectStep } from './ivr-disconnect-handler.js';
import type { TransferAdvanceEvent } from './ivr-transfer-handler.js';
import { advanceKnowledgeQaStep } from './ivr-knowledge-handler.js';
import { advanceStartStep } from './ivr-start-handler.js';
import {
  advanceAvatarSwitchStep,
  advanceScreenShareStep,
  advanceVideoPlayStep,
} from './ivr-video-handlers.js';
import type { IvrMediaType, ScreenShareAdvanceEvent, VideoAdvanceEvent } from './ivr-video-handlers.js';
import { handleComplianceStep, resolveCompliancePrompt } from './ivr-compliance-handler.js';
import { tryEnterSubflow } from './ivr-subflow-handler.js';
import { advanceAiDialogueStep } from './ivr-ai-dialogue-handler.js';
import { handleCollectStep, formatVerifyPrompt, type CollectVerifyState } from './ivr-collect-handler.js';
import {
  buildMenuPromptQueue,
  clearAudioQueue,
  consumeQueueForFlush,
  enqueuePlayContents,
  isAudioFlushSyncPoint,
  type AudioQueueSegment,
  type PromptQueueItem,
} from './ivr-audio-queue.js';
import { resolveIntentBranch } from './ivr-intent-handler.js';
import {
  advanceVoicemailStep,
  handleRecordAudioResume,
  type RecordingCompleteEvent,
} from './ivr-voicemail-handler.js';
import { routeHttpBranch, routeWebhookBranch } from './ivr-io-branch-handler.js';
import {
  applyShortcutResult,
  shouldTryGlobalShortcut,
  tryConsumeGlobalShortcut,
} from './ivr-global-shortcuts.js';
import {
  resolvePlayContents,
  resolvePlayContentsResult,
  type PlayContentLike,
  type ResolvedPrompt,
} from './ivr-play-resolver.js';
import { handleFlushAudioStep } from './ivr-flush-handler.js';
import { tryRoutePlayResolveFailure } from './ivr-play-error.js';
import { evaluateIvrExpression } from './ivr-expression.js';
import { applyBranchRoute } from './ivr-branch-vars.js';
import { IVR_BRANCH } from './ivr-branch-handles.js';

export type IvrAction =
  | { kind: 'flush_play_queue'; promptQueue: PromptQueueItem[]; node: string }
  | { kind: 'play'; text: string; promptType?: 'tts' | 'audio'; audioUrl?: string; interruptible?: boolean; resolveError?: string; node: string }
  | { kind: 'collect_digits'; prompt: string; promptType?: 'tts' | 'audio'; audioUrl?: string; minDigits: number; maxDigits: number; storeVar: string; endMode?: 'max_digits' | 'hash_key'; inputWaitSec?: number; timeoutSec?: number; maxRetries?: number; retryPrompt?: string; promptQueue?: PromptQueueItem[]; node: string }
  | { kind: 'collect_verify'; prompt: string; node: string }
  | {
      kind: 'menu';
      prompt: string;
      promptType?: 'tts' | 'audio';
      audioUrl?: string;
      options: Array<{ digit: string; label: string }>;
      speechEnabled?: boolean;
      speechLanguage?: string;
      speechHints?: string[];
      timeoutSec?: number;
      maxRetries?: number;
      promptQueue?: PromptQueueItem[];
      node: string;
    }
  | { kind: 'transfer'; targetType: string; targetValue: string; memberSeatIds?: string[]; node: string }
  | { kind: 'voicemail'; maxDurationSec: number; mailboxId?: string; playBeep?: boolean; node: string }
  | { kind: 'sip'; sipUri: string; headers?: Record<string, string>; node: string }
  | { kind: 'set_var'; variable: string; value: string; node: string }
  | { kind: 'ai_dialogue'; role: string; maxTurns: number; node: string }
  | { kind: 'compliance'; complianceType: string; prompt: string; interruptible?: boolean; node: string }
  | { kind: 'queue'; queueName: string; strategy: string; timeoutSec: number; waitMusic?: string; node: string }
  | { kind: 'http'; method: string; url: string; node: string }
  | { kind: 'intent'; dimension: string; threshold: number; node: string }
  | { kind: 'knowledge_qa'; knowledgeBaseId: string; maxResults: number; node: string }
  | { kind: 'avatar_switch'; direction: string; avatarId: string; node: string }
  | { kind: 'video_play'; sourceType: string; videoUrl: string; loop: boolean; skippable: boolean; node: string }
  | { kind: 'screen_share'; source: string; allowRemoteControl: boolean; node: string }
  | { kind: 'visual_menu'; title: string; items: Array<{ digit: string; label: string }>; node: string }
  | { kind: 'subflow'; flowId: string; node: string }
  | { kind: 'recording'; action: string; format: string; node: string }
  | { kind: 'webhook'; url: string; eventType: string; method: string; node: string }
  | {
      kind: 'disconnect';
      phase: 'farewell' | 'hangup';
      endReason: string;
      node: string;
      text?: string;
      promptType?: 'tts' | 'audio';
      audioUrl?: string;
    }
  | { kind: 'log'; message: string; node: string };

export interface IvrExecutionStep {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  action: IvrAction;
  nextNodeId: string | null;
  variables: Record<string, string>;
}

export interface IvrExecutionResult {
  steps: IvrExecutionStep[];
  finalNodeId: string | null;
  finalAction: IvrAction | null;
  variables: Record<string, string>;
  terminated: boolean;
  error?: string;
}

export interface IvrFlowFrame {
  graph: IvrFlowGraph;
  subflowNodeId: string;
  returnNodeId: string | null;
  errorReturnNodeId: string | null;
}

export interface IvrInteractionState {
  nodeId: string;
  kind: 'menu' | 'collect' | 'collect_verify';
  awaiting: true;
}

export interface IvrWaitingState {
  kind: 'queue' | 'ai_dialogue' | 'video' | 'transfer' | 'record_audio';
  nodeId: string;
  since: string;
  mailboxId?: string;
  maxTurns?: number;
  timeoutSec?: number;
  agentSpecId?: string;
  turnCount?: number;
  queueEntryId?: string;
  queueName?: string;
}

export interface IvrRuntimeContext {
  graph: IvrFlowGraph;
  currentNodeId: string | null;
  variables: Record<string, string>;
  flowStack: IvrFlowFrame[];
  subflowDepth?: number;
  interaction?: IvrInteractionState;
  pendingAdvanceNodeId?: string | null;
  /** disconnect 隐式 flush 播完前保持在该节点（ADR-4 Task 9） */
  pendingDisconnectFlush?: string;
  disconnectFarewellEnqueued?: string;
  /** transfer preTransferPrompt 已入队（ADR-4 Task 8） */
  preTransferPromptEnqueued?: string;
  /** transfer 隐式 flush 播完前保持在该节点 */
  pendingTransferFlush?: string;
  /** flush_audio 播完前保持在该节点（ADR-4 F2） */
  pendingFlushAudio?: string;
  preTransferPromptPlayed?: string;
  pendingDigits?: string;
  waiting?: IvrWaitingState;
  retryCounters?: Record<string, { invalid?: number; timeout?: number; verify?: number }>;
  lastPromptNodeId?: string;
  playQueueIndex?: number;
  /** Genesys-style queue — flushed at menu/collect/transfer/disconnect (ADR-4) */
  audioQueue?: AudioQueueSegment[];
  collectVerify?: CollectVerifyState;
  /** recording_consent: disclosure → consent key gather */
  compliancePhase?: 'disclosure' | 'consent';
}

export type QueueAdvanceEvent =
  | { kind: 'connected'; agentId: string }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string };

export type { TransferAdvanceEvent };

export type AiDialogueEndReason = 'completed' | 'handoff' | 'timeout' | 'error';

export interface AiDialogueResult {
  reason: AiDialogueEndReason;
  turnCount?: number;
  intentScore?: number;
  customerSummary?: string;
  variables?: Record<string, string>;
}

export interface IvrStepInput {
  dtmf?: string;
  speechResult?: string | null;
  timedOut?: boolean;
  playCompleted?: boolean;
  flushCompleted?: boolean;
  bargeInDigits?: string;
  queueEvent?: QueueAdvanceEvent;
  transferEvent?: TransferAdvanceEvent;
  aiDialogueResult?: AiDialogueResult;
  /** Phase C — voice sessions cannot enter video nodes */
  mediaType?: IvrMediaType;
  videoEvent?: VideoAdvanceEvent;
  screenShareEvent?: ScreenShareAdvanceEvent;
  /** visual_menu DataChannel click → digit (VMN-1) */
  visualSelection?: string;
  /** record_audio completion callback (VC-5) */
  recordingEvent?: RecordingCompleteEvent;
  /** Channel metadata for start.pushParams (SU-1) */
  channelVariables?: Record<string, string>;
  sideEffects?: IvrSideEffects;
  timeGroupChecker?: (scheduleId: string) => boolean;
  regionGroupChecker?: (groupId: string, areaCode: string) => boolean;
  groupCallResolver?: (groupId: string) => string[];
  resolvePrompt?: (contents: PlayContentLike[], variables: Record<string, string>) => ResolvedPrompt | Promise<ResolvedPrompt>;
  callSessionId?: string;
  roomName?: string;
  tenantId?: string;
  acdEnqueue?: AcdEnqueueFn;
}

export interface IvrSimulationInput extends IvrStepInput {
  /** DTMF digits to feed, in order. e.g. ['1', '2', '0'] */
  dtmfSequence: string[];
  /** Initial variables */
  variables?: Record<string, string>;
  /** Max steps to prevent infinite loops */
  maxSteps?: number;
}

export function createRuntimeContext(
  graph: IvrFlowGraph,
  variables: Record<string, string> = {}
): IvrRuntimeContext {
  return {
    graph,
    currentNodeId: graph.entryNodeId,
    variables: { ...variables },
    flowStack: [],
    subflowDepth: 0,
    retryCounters: {},
  };
}

const TERMINAL_ACTIONS = new Set(['transfer', 'voicemail', 'sip']);

export function actionTerminatesSession(action: IvrAction): boolean {
  return TERMINAL_ACTIONS.has(action.kind);
}

export async function advanceSingleStep(
  context: IvrRuntimeContext,
  input: IvrStepInput = {}
): Promise<{
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
}> {
  const nodeId = context.currentNodeId;
  if (!nodeId) {
    return {
      action: { kind: 'log', message: 'session ended', node: '' },
      context,
      nextNodeId: null,
      terminated: true,
    };
  }

  const node = context.graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return {
      action: { kind: 'log', message: `node not found: ${nodeId}`, node: nodeId },
      context: { ...context, currentNodeId: null },
      nextNodeId: null,
      terminated: true,
    };
  }

  const variables = { ...context.variables };
  const playQueueIndex = context.playQueueIndex ?? 0;
  let action = await enrichNodeAction(
    node,
    executeNode(node, variables, playQueueIndex),
    variables,
    input,
    playQueueIndex
  );
  if (node.type === 'set_var' && action.kind === 'set_var') {
    const valueType = (node.data.valueType as string) ?? 'string';
    try {
      if (valueType === 'expression') {
        variables[action.variable] = evaluateIvrExpression(action.value, variables);
      } else {
        variables[action.variable] = substituteVars(action.value, variables);
      }
    } catch (err) {
      variables.last_error = err instanceof Error ? err.message : String(err);
    }
  }

  const recordAudioResume = await handleRecordAudioResume(context, input);
  if (recordAudioResume) {
    return recordAudioResume;
  }

  const waitingResume = handleWaitingResume(context, input);
  if (waitingResume) {
    return waitingResume;
  }

  if (node.type === 'compliance') {
    return handleComplianceStep(context.graph, node, context, action, variables, input);
  }

  if (node.type === 'start') {
    return advanceStartStep(
      context.graph,
      node,
      context,
      action,
      variables,
      input.channelVariables ?? {}
    );
  }

  if (node.type === 'flush_audio') {
    const flushStep = handleFlushAudioStep(context.graph, node, context, variables, input);
    if (flushStep.walkToSyncPoint && flushStep.nextNodeId) {
      return advanceSingleStep(flushStep.context, input);
    }
    return flushStep;
  }

  const playResume = handlePlayCompleted(context, node, input);
  if (playResume) {
    return playResume;
  }

  if (shouldTryGlobalShortcut(context, node, input)) {
    const shortcutDtmf = input.dtmf ?? context.pendingDigits;
    const shortcut = tryConsumeGlobalShortcut(context.graph, context, shortcutDtmf);
    if (shortcut.handled) {
      const applied = applyShortcutResult(shortcut, context, variables);
      if (applied.action.kind === 'queue' && nodeId) {
        const queueStep = await advanceQueueStep(
          context.graph,
          nodeId,
          applied.action,
          applied.context,
          variables,
          input
        );
        if (queueStep) return queueStep;
      }
      return applied;
    }
  }

  if (
    input.bargeInDigits &&
    !context.pendingFlushAudio &&
    !context.pendingTransferFlush &&
    !context.pendingDisconnectFlush
  ) {
    const gatherBarge =
      (context.interaction?.awaiting === true &&
        (node.type === 'menu' || node.type === 'visual_menu' || node.type === 'collect')) ||
      (context.audioQueue?.length ?? 0) > 0;

    if (gatherBarge) {
      const clearedCtx: IvrRuntimeContext = {
        ...context,
        audioQueue: clearAudioQueue(),
        pendingDigits: input.bargeInDigits,
      };
      if (node.type === 'menu' || node.type === 'visual_menu') {
        const menuAction = await enrichNodeAction(
          node,
          executeNode(node, clearedCtx.variables),
          clearedCtx.variables,
          input
        );
        if (menuAction.kind === 'menu') {
          const promptQueue = buildMenuPromptQueue([], {
            text: menuAction.prompt,
            promptType: menuAction.promptType ?? 'tts',
            audioUrl: menuAction.audioUrl,
          });
          return {
            action: { ...menuAction, promptQueue },
            context: {
              ...clearedCtx,
              lastPromptNodeId: node.id,
              interaction: { nodeId: node.id, kind: 'menu', awaiting: true },
            },
            nextNodeId: node.id,
            terminated: false,
          };
        }
      }
      if (node.type === 'collect') {
        const collectAction = await enrichNodeAction(
          node,
          executeNode(node, clearedCtx.variables),
          clearedCtx.variables,
          input
        );
        if (collectAction.kind === 'collect_digits') {
          const promptQueue = buildMenuPromptQueue([], {
            text: collectAction.prompt,
            promptType: collectAction.promptType ?? 'tts',
            audioUrl: collectAction.audioUrl,
          });
          return {
            action: { ...collectAction, promptQueue },
            context: {
              ...clearedCtx,
              lastPromptNodeId: node.id,
              interaction: { nodeId: node.id, kind: 'collect', awaiting: true },
            },
            nextNodeId: node.id,
            terminated: false,
          };
        }
      }
      return {
        action: { kind: 'log', message: 'barge-in cleared audio queue', node: node.id },
        context: clearedCtx,
        nextNodeId: nodeId,
        terminated: false,
      };
    }
  }

  if (node.type === 'play' && !input.playCompleted) {
    const contents = (node.data.contents as PlayContentLike[]) ?? [];
    for (const content of contents) {
      if (!input.resolvePrompt) {
        const result = resolvePlayContentsResult([content], variables);
        if (result.ok === false) {
          const failAction = {
            kind: 'play' as const,
            text: result.fallback.text,
            promptType: 'tts' as const,
            resolveError: result.reason,
            node: node.id,
          };
          const playFailure = tryRoutePlayResolveFailure(
            context.graph,
            node,
            failAction,
            context,
            variables
          );
          if (playFailure) return playFailure;
          if ((node.data.onError as string) === 'branch') {
            return {
              action: { kind: 'log', message: `play resolve error: ${result.reason}`, node: node.id },
              context: { ...context, variables, currentNodeId: node.id },
              nextNodeId: node.id,
              terminated: false,
            };
          }
        }
      }
    }

    const segments = await resolvePlayNodeSegments(node, variables, input);
    const audioQueue = enqueuePlayContents(context.audioQueue, segments);
    const edge = requireEdge(context.graph, node.id, IVR_BRANCH.OUT);
    const nextId = edge.ok ? edge.target : null;
    const nextCtx: IvrRuntimeContext = {
      ...context,
      variables,
      audioQueue,
      currentNodeId: nextId,
      playQueueIndex: undefined,
      pendingAdvanceNodeId: undefined,
    };

    if (!nextId) {
      return {
        action: { kind: 'log', message: 'play enqueued (no out edge)', node: node.id },
        context: { ...nextCtx, currentNodeId: node.id },
        nextNodeId: node.id,
        terminated: false,
      };
    }

    const nextNode = context.graph.nodes.find((n) => n.id === nextId);
    if (nextNode && isAudioFlushSyncPoint(nextNode.type)) {
      return advanceSingleStep(nextCtx, input);
    }

    return {
      action: { kind: 'log', message: 'play enqueued', node: node.id },
      context: nextCtx,
      nextNodeId: nextId,
      terminated: false,
    };
  }

  if (node.type === 'menu' || node.type === 'visual_menu') {
    const menuInputDtmf = input.dtmf ?? input.visualSelection ?? context.pendingDigits;
    const consuming =
      hasConsumerInput(input, context) || !!input.timedOut || !!input.visualSelection;
    if (!consuming) {
      let menuAction = action;
      if (action.kind === 'menu') {
        const flushQueue = consumeQueueForFlush(context.audioQueue);
        const promptQueue = buildMenuPromptQueue(flushQueue, {
          text: action.prompt,
          promptType: action.promptType ?? 'tts',
          audioUrl: action.audioUrl,
        });
        menuAction = { ...action, promptQueue };
      }
      return {
        action: menuAction,
        context: {
          ...context,
          variables,
          audioQueue: clearAudioQueue(),
          lastPromptNodeId: node.id,
          interaction: { nodeId: node.id, kind: 'menu', awaiting: true },
        },
        nextNodeId: node.id,
        terminated: false,
      };
    }
    const menuResult = handleMenuStep(context.graph, node, context, {
      dtmf: menuInputDtmf,
      visualSelection: input.visualSelection,
      speechResult: input.speechResult ?? undefined,
      timedOut: input.timedOut,
      groupCallResolver: input.groupCallResolver,
    });
    const nextAction = menuResult.action ?? action;
    if (nextAction.kind === 'queue') {
      const queueStep = await advanceQueueStep(
        context.graph,
        node.id,
        nextAction,
        {
          ...context,
          variables: menuResult.variables,
          retryCounters: menuResult.retryCounters,
          interaction: undefined,
          pendingDigits: undefined,
        },
        menuResult.variables,
        input
      );
      if (queueStep) return queueStep;
    }
    return {
      action: nextAction,
      context: {
        ...context,
        variables: applyBranchRoute(menuResult.variables, node.id, menuResult.branch, menuResult.nextNodeId),
        retryCounters: menuResult.retryCounters,
        interaction: undefined,
        pendingDigits: undefined,
        currentNodeId: menuResult.nextNodeId,
      },
      nextNodeId: menuResult.nextNodeId,
      terminated: menuResult.action ? actionTerminatesSession(menuResult.action) : false,
    };
  }

  if (node.type === 'collect') {
    const consuming = hasConsumerInput(input, context) || !!input.timedOut;
    const verify = context.collectVerify;

    if (verify?.phase === 'verifying' && verify.nodeId === node.id && !consuming) {
      const data = node.data;
      const verifyMode = data.verifyMode === 'digits' ? 'digits' : 'numeric';
      const prompt = formatVerifyPrompt(
        verify.stagingValue,
        verifyMode,
        (data.verifyPromptTemplate as string) || undefined
      );
      return {
        action: { kind: 'collect_verify', prompt, node: node.id },
        context: {
          ...context,
          variables,
          lastPromptNodeId: node.id,
          interaction: { nodeId: node.id, kind: 'collect_verify', awaiting: true },
        },
        nextNodeId: node.id,
        terminated: false,
      };
    }

    if (!consuming) {
      let collectAction = action;
      if (action.kind === 'collect_digits') {
        const flushQueue = consumeQueueForFlush(context.audioQueue);
        const promptQueue = buildMenuPromptQueue(flushQueue, {
          text: action.prompt,
          promptType: action.promptType ?? 'tts',
          audioUrl: action.audioUrl,
        });
        collectAction = { ...action, promptQueue };
      }
      return {
        action: collectAction,
        context: {
          ...context,
          variables,
          audioQueue: clearAudioQueue(),
          lastPromptNodeId: node.id,
          interaction: { nodeId: node.id, kind: 'collect', awaiting: true },
        },
        nextNodeId: node.id,
        terminated: false,
      };
    }

    const collectResult = handleCollectStep(context.graph, node, context, {
      dtmf: input.dtmf ?? context.pendingDigits,
      timedOut: input.timedOut,
    });

    switch (collectResult.type) {
      case 'emit_verify':
        return {
          action: collectResult.action,
          context: {
            ...collectResult.context,
            variables,
            interaction: { nodeId: node.id, kind: 'collect_verify', awaiting: true },
            pendingDigits: undefined,
          },
          nextNodeId: node.id,
          terminated: false,
        };
      case 'emit_collect':
        return {
          action: collectResult.action,
          context: {
            ...collectResult.context,
            variables,
            interaction: { nodeId: node.id, kind: 'collect', awaiting: true },
            pendingDigits: undefined,
          },
          nextNodeId: node.id,
          terminated: false,
        };
      case 'advance':
        return {
          action,
          context: {
            ...collectResult.context,
            variables: applyBranchRoute(
              collectResult.context.variables,
              node.id,
              collectResult.branch,
              collectResult.nextNodeId
            ),
            interaction: undefined,
            pendingDigits: undefined,
            currentNodeId: collectResult.nextNodeId,
          },
          nextNodeId: collectResult.nextNodeId,
          terminated: false,
        };
      default:
        break;
    }
  }

  if (node.type === 'queue' && action.kind === 'queue') {
    const queueStep = await advanceQueueStep(
      context.graph,
      node.id,
      action,
      context,
      variables,
      input
    );
    if (queueStep) return queueStep;
  }

  if (node.type === 'transfer' && action.kind === 'transfer') {
    const transferStep = await advanceTransferStep(
      context.graph,
      node.id,
      action,
      context,
      variables,
      input
    );
    if (transferStep) return transferStep;
  }

  if (node.type === 'avatar_switch' && action.kind === 'avatar_switch') {
    return advanceAvatarSwitchStep(context.graph, node, context, action, variables, input);
  }

  if (node.type === 'video_play' && action.kind === 'video_play') {
    const videoStep = advanceVideoPlayStep(context.graph, node, context, action, variables, input);
    if (videoStep) return videoStep;
  }

  if (node.type === 'screen_share' && action.kind === 'screen_share') {
    const ssStep = advanceScreenShareStep(context.graph, node, context, action, variables, input);
    if (ssStep) return ssStep;
  }

  if (node.type === 'knowledge_qa') {
    const kq = await advanceKnowledgeQaStep(
      context.graph,
      node,
      variables,
      input.sideEffects?.executeKnowledgeQa
    );
    if (kq.mode === 'action') {
      return {
        action: kq.action,
        context: { ...context, variables: kq.variables, currentNodeId: null },
        nextNodeId: null,
        terminated: actionTerminatesSession(kq.action),
      };
    }
    const actionOut = kq.action ?? action;
    return {
      action: actionOut,
      context: {
        ...context,
        variables: applyBranchRoute(
          kq.variables,
          node.id,
          kq.branch,
          kq.pendingAdvanceNodeId ? node.id : kq.nextNodeId
        ),
        currentNodeId: kq.pendingAdvanceNodeId ? node.id : kq.nextNodeId,
        pendingAdvanceNodeId: kq.pendingAdvanceNodeId ?? undefined,
      },
      nextNodeId: kq.pendingAdvanceNodeId ? node.id : kq.nextNodeId,
      terminated: false,
    };
  }

  if (node.type === 'ai_dialogue' && action.kind === 'ai_dialogue') {
    return advanceAiDialogueStep(context.graph, node, context, variables, action, input);
  }

  if (node.type === 'voicemail' && action.kind === 'voicemail') {
    const vmStep = advanceVoicemailStep(node.id, context, action, variables);
    if (vmStep) return vmStep;
  }

  if (node.type === 'subflow') {
    const sub = await tryEnterSubflow(context.graph, node, context, variables, {
      tenantId: input.tenantId,
      executeSubflow: input.sideEffects?.executeSubflow,
    });
    if (sub.mode === 'entered') {
      return {
        action: sub.action,
        context: sub.context,
        nextNodeId: sub.nextNodeId,
        terminated: false,
      };
    }
    return {
      action,
      context: {
        ...context,
        variables: applyBranchRoute(sub.variables, node.id, IVR_BRANCH.ERROR, sub.nextNodeId),
        currentNodeId: sub.nextNodeId,
      },
      nextNodeId: sub.nextNodeId,
      terminated: false,
    };
  }

  const disconnectStep = await advanceDisconnectStep(
    context.graph,
    node,
    action,
    context,
    variables,
    input
  );
  if (disconnectStep) {
    return disconnectStep;
  }

  const exits = getNodeExits(context.graph, node.id);
  let nextNodeId: string | null = null;
  let branchHandle: string | undefined;

  switch (node.type) {
    case 'condition': {
      const result = evaluateCondition(node.data, variables, input);
      branchHandle = result ? IVR_BRANCH.TRUE : IVR_BRANCH.FALSE;
      const edge = requireEdge(context.graph, node.id, branchHandle);
      nextNodeId = edge.ok ? edge.target : null;
      break;
    }
    case 'time_condition': {
      const scheduleId = (node.data.scheduleId as string) || '';
      const active = input.timeGroupChecker ? input.timeGroupChecker(scheduleId) : true;
      branchHandle = active ? IVR_BRANCH.TRUE : IVR_BRANCH.FALSE;
      const edge = requireEdge(context.graph, node.id, branchHandle);
      nextNodeId = edge.ok ? edge.target : null;
      break;
    }
    case 'intent': {
      let execResult: import('./ivr-side-effects.js').IntentExecResult | undefined;
      const dimension = (node.data.dimension as string) || 'score';
      if (dimension !== 'keyword' && input.sideEffects?.executeIntent) {
        execResult = await input.sideEffects.executeIntent(node.data, variables);
      }
      const routed = resolveIntentBranch(context.graph, node.id, node.data, variables, execResult);
      branchHandle = routed.branch;
      nextNodeId = exits.get(routed.branch) ?? null;
      break;
    }
    case 'http': {
      let result: import('./ivr-side-effects.js').HttpExecResult = { success: true, statusCode: 200 };
      if (input.sideEffects?.executeHttp) {
        result = await input.sideEffects.executeHttp(node.data, variables);
        if (result.mappedVariables) Object.assign(variables, result.mappedVariables);
      }
      const routed = routeHttpBranch(context.graph, node.id, result, variables);
      branchHandle = routed.branch;
      nextNodeId = routed.target;
      break;
    }
    case 'webhook': {
      let result: import('./ivr-side-effects.js').WebhookExecResult = { success: true, statusCode: 200 };
      if (input.sideEffects?.executeWebhook) {
        result = await input.sideEffects.executeWebhook(node.data, variables);
      }
      const routed = routeWebhookBranch(context.graph, node.id, result, variables);
      branchHandle = routed.branch;
      nextNodeId = routed.target;
      break;
    }
    case 'recording': {
      const recAction = (node.data.action as string) || 'start';
      const consentDeclined = variables.compliance_ack === 'false';
      if (recAction === 'start' && consentDeclined) {
        variables.recording_skipped = 'consent_declined';
        variables.recording_paused = 'true';
      } else if (input.sideEffects?.executeRecording) {
        const result = await input.sideEffects.executeRecording(
          node.data,
          input.callSessionId || '',
          input.roomName,
          variables
        );
        if (result.egressId) variables.egress_id = result.egressId;
        if (result.recordingUrl) variables.recording_url = result.recordingUrl;
        if (recAction === 'pause') variables.recording_paused = 'true';
        if (recAction === 'resume') variables.recording_paused = 'false';
      }
      branchHandle = IVR_BRANCH.OUT;
      nextNodeId = exits.get(IVR_BRANCH.OUT) ?? null;
      break;
    }
    default:
      branchHandle = IVR_BRANCH.OUT;
      nextNodeId = exits.get(IVR_BRANCH.OUT) ?? exits.values().next().value ?? null;
  }

  if (isNodeSessionTerminal(context.graph, node)) {
    if (node.type !== 'disconnect' && context.flowStack.length > 0) {
      const frame = context.flowStack[context.flowStack.length - 1];
      const newStack = context.flowStack.slice(0, -1);
      const restored: IvrRuntimeContext = {
        graph: frame.graph,
        currentNodeId: frame.returnNodeId,
        variables,
        flowStack: newStack,
        subflowDepth: Math.max(0, (context.subflowDepth ?? 1) - 1),
      };
      return { action, context: restored, nextNodeId: frame.returnNodeId, terminated: false };
    }
    return {
      action,
      context: { ...context, variables, currentNodeId: null },
      nextNodeId: null,
      terminated: true,
    };
  }

  return {
    action,
    context: { ...context, variables: applyBranchRoute(variables, node.id, branchHandle, nextNodeId), currentNodeId: nextNodeId },
    nextNodeId,
    terminated: false,
  };
}

/**
 * Execute a flow graph with simulated DTMF input.
 * Produces a step-by-step trace for the test UI.
 */
/**
 * Simulate one step input for menu/collect/play lifecycle (Task -1).
 */
export function buildSimulationStepInput(
  context: IvrRuntimeContext,
  nodeType: string,
  dtmfQueue: string[],
  base: IvrStepInput
): IvrStepInput {
  if (nodeType === 'disconnect' && context.pendingDisconnectFlush) {
    return { ...base, flushCompleted: true };
  }

  if (context.pendingFlushAudio && nodeType === 'flush_audio') {
    return { ...base, flushCompleted: true };
  }

  if (context.pendingTransferFlush && nodeType === 'transfer') {
    return { ...base, flushCompleted: true };
  }

  // Simulation has no live CallTransferService: complete waiting transfers so the
  // trace does not stick until maxSteps. Prefer connected when an out edge exists.
  if (nodeType === 'transfer' && context.waiting?.kind === 'transfer' && !base.sideEffects?.executeTransfer) {
    const exits = new Set(
      context.graph.edges.filter((e) => e.source === context.waiting?.nodeId).map((e) => e.sourceHandle || 'out')
    );
    if (exits.has('out')) {
      return { ...base, transferEvent: { kind: 'connected' } };
    }
    if (exits.has('failed')) {
      return { ...base, transferEvent: { kind: 'failed', reason: 'simulation_no_live_transfer' } };
    }
    if (exits.has('no_answer')) {
      return { ...base, transferEvent: { kind: 'no_answer' } };
    }
    if (exits.has('busy')) {
      return { ...base, transferEvent: { kind: 'busy' } };
    }
  }

  const interactive =
    nodeType === 'menu' || nodeType === 'visual_menu' || nodeType === 'collect';

  if (interactive) {
    if (context.interaction?.awaiting) {
      if ((context.audioQueue?.length ?? 0) > 0 && dtmfQueue.length > 0) {
        return { ...base, bargeInDigits: dtmfQueue.shift() };
      }
      const digit = context.pendingDigits ?? dtmfQueue.shift();
      if (digit != null && digit !== '') {
        return { ...base, dtmf: digit };
      }
      return { ...base, timedOut: true };
    }
    return { ...base };
  }

  return { ...base };
}

export async function simulateIvrFlow(
  graph: IvrFlowGraph,
  input: IvrSimulationInput
): Promise<IvrExecutionResult> {
  const steps: IvrExecutionStep[] = [];
  const maxSteps = input.maxSteps ?? 50;
  const dtmfQueue = [...input.dtmfSequence];
  let context = createRuntimeContext(graph, input.variables);

  while (context.currentNodeId && steps.length < maxSteps) {
    const node = context.graph.nodes.find((n) => n.id === context.currentNodeId);
    if (!node) {
      return {
        steps,
        finalNodeId: null,
        finalAction: null,
        variables: context.variables,
        terminated: true,
        error: `node not found: ${context.currentNodeId}`,
      };
    }

    const stepInput = buildSimulationStepInput(context, node.type, dtmfQueue, {
      sideEffects: input.sideEffects,
      timeGroupChecker: input.timeGroupChecker,
      callSessionId: input.callSessionId,
      roomName: input.roomName,
      tenantId: input.tenantId,
    });

    let step = await advanceSingleStep(context, stepInput);

    if (
      step.action.kind === 'flush_play_queue' &&
      (step.context.pendingTransferFlush ||
        step.context.pendingFlushAudio ||
        step.context.pendingDisconnectFlush) &&
      !step.terminated
    ) {
      step = await advanceSingleStep(step.context, {
        ...stepInput,
        flushCompleted: true,
        playCompleted: false,
        dtmf: undefined,
        bargeInDigits: undefined,
        timedOut: false,
      });
    }

    context = step.context;
    steps.push({
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      action: step.action,
      nextNodeId: step.nextNodeId,
      variables: { ...context.variables },
    });

    if (step.terminated) {
      const finalNodeId =
        'node' in step.action && step.action.node ? step.action.node : node.id;
      return {
        steps,
        finalNodeId,
        finalAction: step.action,
        variables: context.variables,
        terminated: true,
      };
    }
  }

  return {
    steps,
    finalNodeId: context.currentNodeId,
    finalAction: steps[steps.length - 1]?.action ?? null,
    variables: context.variables,
    terminated: false,
    error: steps.length >= maxSteps ? 'max steps exceeded (possible infinite loop)' : undefined,
  };
}

function executeNode(
  node: IvrNodeBase,
  variables: Record<string, string>,
  playQueueIndex = 0
): IvrAction {
  const d = node.data;
  switch (node.type) {
    case 'start':
      return { kind: 'log', message: '流程开始', node: node.id };
    case 'play': {
      const contents = (d.contents as Array<{ text?: string }>) || [];
      const text = contents[playQueueIndex]?.text || contents[0]?.text || '(播放)';
      const bargeIn = d.bargeIn === true || d.interruptible === true;
      return {
        kind: 'play',
        text: substituteVars(text, variables),
        interruptible: bargeIn,
        node: node.id,
      };
    }
    case 'menu': {
      const promptArr = (d.prompt as Array<{ text?: string }>) || [];
      const prompt = promptArr[0]?.text || '请选择';
      const options = (d.options as Array<{ digit: string; label: string }>) || [];
      const aliases = (d.speechAliases as Array<{ digit: string; phrases: string[] }>) ?? [];
      return {
        kind: 'menu',
        prompt: substituteVars(prompt, variables),
        options,
        speechEnabled: d.speechEnabled === true,
        speechLanguage: (d.speechLanguage as string) || 'zh-CN',
        speechHints: aliases.flatMap((a) => a.phrases),
        timeoutSec: (d.timeoutSec as number) ?? 10,
        maxRetries: (d.maxRetries as number) ?? 3,
        node: node.id,
      };
    }
    case 'collect': {
      const promptArr = (d.prompt as Array<{ text?: string }>) || [];
      const prompt = promptArr[0]?.text || '请输入';
      return {
        kind: 'collect_digits',
        prompt: substituteVars(prompt, variables),
        minDigits: (d.minDigits as number) ?? 1,
        maxDigits: (d.maxDigits as number) ?? 6,
        storeVar: (d.storeVariable as string) ?? 'collected',
        endMode: (d.endMode as 'max_digits' | 'hash_key') ?? 'hash_key',
        inputWaitSec: (d.inputWaitSec as number) ?? 5,
        timeoutSec: (d.timeoutSec as number) ?? 10,
        maxRetries: (d.maxRetries as number) ?? 1,
        node: node.id,
      };
    }
    case 'set_var': {
      const value = d.value as string;
      return { kind: 'set_var', variable: d.variableName as string, value, node: node.id };
    }
    case 'transfer':
      return { kind: 'transfer', targetType: d.targetType as string, targetValue: d.targetValue as string, node: node.id };
    case 'voicemail':
      return {
        kind: 'voicemail',
        maxDurationSec: (d.maxDurationSec as number) ?? 60,
        mailboxId: (d.mailboxId as string) || undefined,
        playBeep: (d.playBeep as boolean) ?? true,
        node: node.id,
      };
    case 'sip': {
      const sipUri = substituteVars((d.sipUri as string) ?? '', variables);
      const headers: Record<string, string> = {};
      for (const h of (d.headers as Array<{ key: string; value: string }>) || []) {
        if (h.key) headers[h.key] = substituteVars(h.value, variables);
      }
      return {
        kind: 'sip',
        sipUri,
        headers: Object.keys(headers).length ? headers : undefined,
        node: node.id,
      };
    }
    case 'ai_dialogue':
      return { kind: 'ai_dialogue', role: (d.role as string) ?? 'outbound', maxTurns: (d.maxTurns as number) ?? 10, node: node.id };
    case 'compliance': {
      const complianceType = (d.complianceType as string) ?? 'ai_disclosure';
      const language = (d.language as string) ?? 'zh';
      return {
        kind: 'compliance',
        complianceType,
        prompt: resolveCompliancePrompt(complianceType, language, d as Record<string, unknown>),
        interruptible: complianceType === 'recording_consent' ? false : (d.bargeIn as boolean) ?? false,
        node: node.id,
      };
    }
    case 'queue':
      return {
        kind: 'queue',
        queueName: (d.queueName as string) ?? '',
        strategy: (d.strategy as string) ?? 'fifo',
        timeoutSec: (d.timeoutSec as number) ?? 300,
        waitMusic: (d.waitMusic as string) || undefined,
        node: node.id,
      };
    case 'http':
      return {
        kind: 'http',
        method: (d.method as string) ?? 'GET',
        url: (d.url as string) ?? '',
        node: node.id,
      };
    case 'intent':
      return {
        kind: 'intent',
        dimension: (d.dimension as string) ?? 'score',
        threshold: (d.threshold as number) ?? 0.7,
        node: node.id,
      };
    case 'knowledge_qa':
      return {
        kind: 'knowledge_qa',
        knowledgeBaseId: (d.knowledgeBaseId as string) ?? '',
        maxResults: (d.maxResults as number) ?? 3,
        node: node.id,
      };
    case 'avatar_switch':
      return {
        kind: 'avatar_switch',
        direction: (d.direction as string) ?? 'voice_to_video',
        avatarId: (d.avatarId as string) ?? '',
        node: node.id,
      };
    case 'video_play':
      return {
        kind: 'video_play',
        sourceType: (d.sourceType as string) ?? 'prerecorded',
        videoUrl: (d.videoUrl as string) ?? '',
        loop: (d.loop as boolean) ?? false,
        skippable: (d.skippable as boolean) ?? true,
        node: node.id,
      };
    case 'screen_share':
      return {
        kind: 'screen_share',
        source: (d.source as string) ?? 'agent',
        allowRemoteControl: (d.allowRemoteControl as boolean) ?? false,
        node: node.id,
      };
    case 'visual_menu': {
      const items = (d.items as Array<{ digit: string; label: string }>) || [];
      return {
        kind: 'visual_menu',
        title: (d.title as string) ?? '',
        items: items.map((i) => ({ digit: i.digit, label: i.label })),
        node: node.id,
      };
    }
    case 'subflow':
      return {
        kind: 'subflow',
        flowId: (d.flowId as string) ?? '',
        node: node.id,
      };
    case 'recording':
      return {
        kind: 'recording',
        action: (d.action as string) ?? 'start',
        format: (d.format as string) ?? 'wav',
        node: node.id,
      };
    case 'webhook':
      return {
        kind: 'webhook',
        url: (d.url as string) ?? '',
        eventType: (d.eventType as string) ?? '',
        method: (d.method as string) ?? 'POST',
        node: node.id,
      };
    case 'flush_audio':
      return { kind: 'log', message: 'flush audio', node: node.id };
    case 'disconnect':
      return {
        kind: 'disconnect',
        phase: 'hangup',
        endReason: (d.endReason as string) ?? 'completed',
        node: node.id,
      };
    default:
      return { kind: 'log', message: `执行 ${node.type} 节点`, node: node.id };
  }
}

function evaluateCondition(
  data: Record<string, unknown>,
  variables: Record<string, string>,
  input: IvrStepInput = {}
): boolean {
  const rules = (data.rules as Array<{ field: string; op: string; value: string }>) || [];
  const logic = (data.logic as string) ?? 'and';
  if (!rules.length) return false;

  const results = rules.map((rule) => {
    if (rule.op === 'in_region_group') {
      const area = variables.caller_area_code || variables.caller_phone || variables.caller_region || '';
      return input.regionGroupChecker?.(rule.value, area) ?? false;
    }
    const actual = variables[rule.field] ?? '';
    const expected = rule.value;
    switch (rule.op) {
      case 'eq': return actual === expected;
      case 'neq': return actual !== expected;
      case 'contains': return actual.includes(expected);
      case 'not_contains': return !actual.includes(expected);
      case 'is_empty': return !actual;
      case 'not_empty': return !!actual;
      case 'gt': return parseFloat(actual) > parseFloat(expected);
      case 'gte': return parseFloat(actual) >= parseFloat(expected);
      case 'lt': return parseFloat(actual) < parseFloat(expected);
      case 'lte': return parseFloat(actual) <= parseFloat(expected);
      case 'in_range': {
        const [min, max] = expected.split(',').map((s) => parseFloat(s.trim()));
        const v = parseFloat(actual);
        return v >= min && v <= max;
      }
      case 'not_in_range': {
        const [min, max] = expected.split(',').map((s) => parseFloat(s.trim()));
        const v = parseFloat(actual);
        return v < min || v > max;
      }
      case 'matches_regex': {
        try {
          return new RegExp(expected).test(actual);
        } catch {
          return false;
        }
      }
      default: return false;
    }
  });

  return logic === 'and' ? results.every(Boolean) : results.some(Boolean);
}

async function resolvePlayNodeSegments(
  node: IvrNodeBase,
  variables: Record<string, string>,
  input: IvrStepInput
): Promise<AudioQueueSegment[]> {
  const contents = (node.data.contents as PlayContentLike[]) ?? [];
  const bargeIn = node.data.bargeIn === true || node.data.interruptible === true;
  const segments: AudioQueueSegment[] = [];

  for (const content of contents) {
    let resolved: ResolvedPrompt;
    if (input.resolvePrompt) {
      resolved = await input.resolvePrompt([content], variables);
    } else {
      const result = resolvePlayContentsResult([content], variables);
      resolved = result.ok === false ? result.fallback : result.prompt;
    }
    segments.push({
      ...resolved,
      interruptible: bargeIn,
      sourceNodeId: node.id,
    });
  }

  return segments;
}

async function enrichNodeAction(
  node: IvrNodeBase,
  action: IvrAction,
  variables: Record<string, string>,
  input: IvrStepInput,
  playQueueIndex = 0
): Promise<IvrAction> {
  const resolver = input.resolvePrompt ?? ((contents, vars) => resolvePlayContents(contents, vars));

  if (action.kind === 'play') {
    const allContents = (node.data.contents as PlayContentLike[]) || [];
    const contents =
      allContents.length > 1 ? [allContents[playQueueIndex] ?? allContents[0]] : allContents;
    const resolved = input.resolvePrompt
      ? await input.resolvePrompt(contents, variables)
      : resolvePlayContentsResult(contents, variables);
    if (!input.resolvePrompt && 'ok' in resolved && resolved.ok === false) {
      return {
        ...action,
        text: resolved.fallback.text,
        promptType: resolved.fallback.promptType,
        audioUrl: resolved.fallback.audioUrl,
        resolveError: resolved.reason,
      };
    }
    const prompt =
      !input.resolvePrompt && 'ok' in resolved && resolved.ok === true
        ? resolved.prompt
        : (resolved as ResolvedPrompt);
    return { ...action, text: prompt.text, promptType: prompt.promptType, audioUrl: prompt.audioUrl };
  }

  if (action.kind === 'menu') {
    const contents = (node.data.prompt as PlayContentLike[]) || [];
    const resolved = await resolver(contents, variables);
    return { ...action, prompt: resolved.text, promptType: resolved.promptType, audioUrl: resolved.audioUrl };
  }

  if (action.kind === 'collect_digits') {
    const contents = (node.data.prompt as PlayContentLike[]) || [];
    const resolved = await resolver(contents, variables);
    let retryPrompt: string | undefined;
    const retryContents = (node.data.retryPrompt as PlayContentLike[]) || [];
    if (retryContents.length) {
      const retryResolved = await resolver(retryContents, variables);
      retryPrompt = retryResolved.text;
    }
    return {
      ...action,
      prompt: resolved.text,
      promptType: resolved.promptType,
      audioUrl: resolved.audioUrl,
      retryPrompt,
    };
  }

  if (action.kind === 'disconnect') {
    const contents = (node.data.contents as PlayContentLike[]) || [];
    if (contents.some((c) => (c.text && c.text.trim().length > 0) || !!c.audioFile)) {
      const resolved = await resolver(contents, variables);
      return {
        ...action,
        text: resolved.text,
        promptType: resolved.promptType,
        audioUrl: resolved.audioUrl,
      };
    }
  }

  if (action.kind === 'compliance') {
    const d = node.data;
    const complianceType = (d.complianceType as string) ?? 'ai_disclosure';
    const language = (d.language as string) ?? 'zh';
    return {
      ...action,
      prompt: resolveCompliancePrompt(complianceType, language, d as Record<string, unknown>),
    };
  }

  if (action.kind === 'transfer' && action.targetType === 'group_call' && input.groupCallResolver) {
    return {
      ...action,
      memberSeatIds: input.groupCallResolver(action.targetValue),
    };
  }

  return action;
}

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return variables[trimmed] ?? `{{${trimmed}}}`;
  });
}
