/**
 * IVR Flow Graph type system — 23 node types as a discriminated union.
 *
 * 12 traditional telecom IVR nodes (from the design reference PDF)
 *  5 AI-native nodes (product differentiation)
 *  6 video / enhancement nodes
 */

// --- Edge handles (for multi-output nodes) ---
export type EdgeHandle =
  | string;  // e.g. 'true', 'false', 'digit_1', 'digit_2', 'timeout', 'success', 'fail', 'high', 'low', 'continue'

import { IVR_BRANCH } from '@converact/shared/ivr/branch-handles';

// --- Common node fields ---
export interface IvrNodeBase {
  id: string;
  name: string;
  position: { x: number; y: number };
}

// --- 1. Start ---
export interface StartNodeData {
  type: 'start';
  pushParams?: Array<{ key: string; source: string }>;
}
export type StartNode = IvrNodeBase & StartNodeData;

// --- 2. Play ---
export type PlayType = 'audio' | 'audio_var' | 'tts' | 'tts_var';
export type AudioLibrary = 'public' | 'enterprise';
export interface PlayContent {
  playType: PlayType;
  audioLibrary?: AudioLibrary;
  audioFile?: string;          // for audio / audio_var
  ttsEngine?: string;           // 'ali' | 'cosyvoice' | 'cartesia' | ...
  text?: string;                // for tts / tts_var (supports SSML)
  variable?: string;           // for audio_var / tts_var
  onError?: 'branch' | 'continue';
}
export interface PlayNodeData {
  type: 'play';
  contents: PlayContent[];      // multiple play items
  bargeIn?: boolean;
  onError?: 'branch' | 'continue';
}
export type PlayNode = IvrNodeBase & PlayNodeData;

// --- 2b. Flush Audio (Genesys sync point) ---
export interface FlushAudioNodeData {
  type: 'flush_audio';
}
export type FlushAudioNode = IvrNodeBase & FlushAudioNodeData;

// --- 3. Menu (DTMF key press) ---
export interface MenuOption {
  digit: string;                // '0'-'9', '*', '#'
  label: string;
  routeType: 'agent' | 'queue' | 'extension' | 'group_call' | 'node';
  routeTarget: string;
}
export interface MenuNodeData {
  type: 'menu';
  prompt: PlayContent[];         // voice prompt before menu
  options: MenuOption[];
  timeoutSec: number;
  maxRetries: number;
  retryPrompt?: PlayContent[];
  speechEnabled?: boolean;
  speechLanguage?: string;
  speechAliases?: Array<{ digit: string; phrases: string[] }>;
}
export type MenuNode = IvrNodeBase & MenuNodeData;

// --- 4. Collect Digits ---
export type CollectEndMode = 'max_digits' | 'hash_key';
export interface CollectNodeData {
  type: 'collect';
  prompt: PlayContent[];
  minDigits: number;
  maxDigits: number;
  endMode: CollectEndMode;
  inputWaitSec: number;
  timeoutSec: number;
  maxRetries: number;
  retryPrompt?: PlayContent[];
  storeVariable: string;
  verifyMode?: 'none' | 'digits' | 'numeric';
  verifyPromptTemplate?: string;
  validationRegex?: string;
  maskInLogs?: boolean;
  maxVerifyRetries?: number;
}
export type CollectNode = IvrNodeBase & CollectNodeData;

// --- 5. Set Variable ---
export type VariableValueType = 'string' | 'expression';
export interface SetVarNodeData {
  type: 'set_var';
  variableName: string;
  valueType: VariableValueType;
  value: string;
}
export type SetVarNode = IvrNodeBase & SetVarNodeData;

// --- 6. Condition (branch) ---
export type ConditionOp =
  | 'eq' | 'neq' | 'contains' | 'not_contains'
  | 'is_empty' | 'not_empty'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in_range' | 'not_in_range' | 'in_region_group' | 'matches_regex';
export type ConditionLogic = 'and' | 'or';
export interface ConditionRule {
  field: string;
  op: ConditionOp;
  value: string;
}
export interface ConditionNodeData {
  type: 'condition';
  logic: ConditionLogic;
  rules: ConditionRule[];
}
export type ConditionNode = IvrNodeBase & ConditionNodeData;

// --- 7. Time Condition ---
export interface TimeConditionNodeData {
  type: 'time_condition';
  scheduleId: string;          // references a time-group setting
  scheduleName?: string;
}
export type TimeConditionNode = IvrNodeBase & TimeConditionNodeData;

// --- 8. Queue ---
export type QueueStrategy = 'fifo' | 'ring_all' | 'random' | 'round_robin';
export interface QueueNodeData {
  type: 'queue';
  queueName: string;
  strategy: QueueStrategy;
  waitMusic?: string;
  timeoutSec: number;
  timeoutAction: 'transfer' | 'voicemail' | 'hangup';
  timeoutTarget?: string;
}
export type QueueNode = IvrNodeBase & QueueNodeData;

// --- 9. HTTP Interaction ---
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface HttpParam {
  key: string;
  source: string;               // variable or literal
  path?: string;                // for nested JSON: 'z/y' → { z: { y: val } }
}
export interface HttpNodeData {
  type: 'http';
  method: HttpMethod;
  url: string;
  headers?: Array<{ key: string; value: string }>;
  requestParams?: HttpParam[];
  responseMappings?: Array<{ responsePath: string; targetVariable: string }>;
  timeoutSec: number;
}
export type HttpNode = IvrNodeBase & HttpNodeData;

// --- 10. Transfer (direct call) ---
/** Production bridge currently supports seat_id + single-member group_call; others fail loud. */
export type TransferTargetType =
  | 'seat_id'
  | 'group_call'
  | 'agent_ring_all'
  | 'agent_random'
  | 'agent_round_robin'
  | 'extension'
  | 'queue'
  | 'phone';
export interface TransferNodeData {
  type: 'transfer';
  targetType: TransferTargetType;
  targetValue: string;         // seat_id, extension, queue name, phone number, group_id
  /** Required for production seat bridge when variables.from_seat_id is absent */
  fromSeatId?: string;
  /** For group_call: explicit member seats (production needs exactly one today) */
  memberSeatIds?: string[];
  callerId?: string;
  timeoutSec?: number;
  connectTimeoutSec?: number;
  onFailure?: 'voicemail' | 'queue' | 'hangup' | 'branch';
  preTransferPrompt?: PlayContent[];
  failedTransferPrompt?: PlayContent[];
}
export type TransferNode = IvrNodeBase & TransferNodeData;

// --- 11. Voicemail ---
export interface VoicemailNodeData {
  type: 'voicemail';
  prompt?: PlayContent[];
  maxDurationSec: number;
  mailboxId?: string;
  playBeep?: boolean;
  notifyWebhook?: string;
  notifyEmail?: string;
}
export type VoicemailNode = IvrNodeBase & VoicemailNodeData;

// --- 12. SIP ---
export interface SipNodeData {
  type: 'sip';
  sipUri: string;
  headers?: Array<{ key: string; value: string }>;
}
export type SipNode = IvrNodeBase & SipNodeData;

// --- 13. Disconnect ---
export interface DisconnectNodeData {
  type: 'disconnect';
  contents?: PlayContent[];
  endReason?: 'completed' | 'abandoned';
  /** Subflow return: ok → parent out edge, error → parent error edge */
  returnCode?: 'ok' | 'error';
}
export type DisconnectNode = IvrNodeBase & DisconnectNodeData;

// === AI-native nodes (14-18) ===

// --- 13. AI Dialogue ---
export type AiDialogueRole = 'outbound' | 'inbound_support';
export interface AiDialogueNodeData {
  type: 'ai_dialogue';
  role: AiDialogueRole;
  scriptId?: string;           // references a voice-agent spec / script
  agentSpecId?: string;
  maxTurns: number;
  timeoutSec: number;
  systemPrompt?: string;
  handoffTriggers?: string[];
  onHandoffAction?: 'out' | 'transfer_queue';
  handoffQueueName?: string;
}
export type AiDialogueNode = IvrNodeBase & AiDialogueNodeData;

// --- 14. Intent Judgment ---
export type IntentDimension = 'score' | 'keyword' | 'emotion';
export interface IntentNodeData {
  type: 'intent';
  dimension: IntentDimension;
  threshold: number;           // 0-1 for score/emotion, keyword list for keyword
  keywords?: string[];
  lowKeywords?: string[];
  highLabel?: string;
  lowLabel?: string;
}
export type IntentNode = IvrNodeBase & IntentNodeData;

// --- 15. Knowledge Base QA ---
export interface KnowledgeQaNodeData {
  type: 'knowledge_qa';
  knowledgeBaseId: string;
  maxResults: number;
  noAnswerAction: 'transfer' | 'continue' | 'voicemail';
  noAnswerTarget?: string;
  questionVariable?: string;
  confidenceThreshold?: number;
  answerPlayMode?: 'none' | 'tts' | 'summary';
  answerVariable?: string;
}
export type KnowledgeQaNode = IvrNodeBase & KnowledgeQaNodeData;

// --- 16. Avatar Switch ---
export type AvatarSwitchDirection = 'voice_to_video' | 'video_to_voice';
export interface AvatarSwitchNodeData {
  type: 'avatar_switch';
  direction: AvatarSwitchDirection;
  avatarId?: string;
}
export type AvatarSwitchNode = IvrNodeBase & AvatarSwitchNodeData;

// --- 17. Compliance Announcement ---
export type ComplianceType = 'ai_disclosure' | 'recording_consent' | 'privacy_notice';
export interface ComplianceNodeData {
  type: 'compliance';
  complianceType: ComplianceType;
  language: string;
}
export type ComplianceNode = IvrNodeBase & ComplianceNodeData;

// === Video / Enhancement nodes (18-23) ===

// --- 18. Video Play ---
export type VideoSourceType = 'prerecorded' | 'screen_share' | 'avatar';
export interface VideoPlayNodeData {
  type: 'video_play';
  sourceType: VideoSourceType;
  videoUrl?: string;
  loop: boolean;
  skippable: boolean;
}
export type VideoPlayNode = IvrNodeBase & VideoPlayNodeData;

// --- 19. Screen Share ---
export type ScreenShareSource = 'agent' | 'ai';
export interface ScreenShareNodeData {
  type: 'screen_share';
  source: ScreenShareSource;
  allowRemoteControl: boolean;
}
export type ScreenShareNode = IvrNodeBase & ScreenShareNodeData;

// --- 20. Visual Menu ---
export interface VisualMenuItem {
  id: string;
  icon?: string;
  label: string;
  digit: string;               // linked to DTMF menu — branch handle derives as digit_<digit>
}
export interface VisualMenuNodeData {
  type: 'visual_menu';
  title: string;
  items: VisualMenuItem[];
  linkedMenuNodeId?: string;
  timeoutSec?: number;
  maxRetries?: number;
}
export type VisualMenuNode = IvrNodeBase & VisualMenuNodeData;

// --- 21. Sub-flow ---
export interface SubflowNodeData {
  type: 'subflow';
  flowId: string;              // references another IvrFlowGraph
  flowName?: string;
  params?: Array<{ key: string; source: string }>;
}
export type SubflowNode = IvrNodeBase & SubflowNodeData;

// --- 22. Recording Control ---
export type RecordingAction = 'start' | 'stop';
export interface RecordingNodeData {
  type: 'recording';
  action: RecordingAction;
  format: 'wav' | 'mp3' | 'ogg';
}
export type RecordingNode = IvrNodeBase & RecordingNodeData;

// --- 23. Webhook Push ---
export interface WebhookNodeData {
  type: 'webhook';
  url: string;
  eventType: string;
  payload?: Record<string, unknown>;
  method: HttpMethod;
}
export type WebhookNode = IvrNodeBase & WebhookNodeData;

// === Discriminated union of all 23 node types ===
export type IvrNode =
  | StartNode | PlayNode | FlushAudioNode | MenuNode | CollectNode | SetVarNode
  | ConditionNode | TimeConditionNode | QueueNode | HttpNode
  | TransferNode | VoicemailNode | SipNode | DisconnectNode
  // AI-native
  | AiDialogueNode | IntentNode | KnowledgeQaNode | AvatarSwitchNode | ComplianceNode
  // Video / enhancement
  | VideoPlayNode | ScreenShareNode | VisualMenuNode | SubflowNode | RecordingNode | WebhookNode;

export type IvrNodeType = IvrNode['type'];

// === Edge ===
export interface IvrEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: EdgeHandle;
  label?: string;
}

// === Flow Graph ===
export interface IvrVariable {
  name: string;
  defaultValue?: string;
  description?: string;
}

export type GlobalShortcut =
  | { digit: string; action: 'transfer_queue'; queueName: string }
  | { digit: string; action: 'repeat_last' }
  | { digit: string; action: 'goto_node'; targetNodeId: string; popSubflow?: boolean };

export interface IvrFlowGraph {
  version: number;
  entryNodeId: string;
  nodes: IvrNode[];
  edges: IvrEdge[];
  variables: IvrVariable[];
  globalShortcuts?: GlobalShortcut[];
}

// === Node metadata (for palette + rendering) ===
export interface IvrNodeMeta {
  type: IvrNodeType;
  label: string;
  icon: string;                 // emoji or icon name
  category: 'traditional' | 'ai' | 'video';
  color: string;                 // tailwind color class
  description: string;
  isTerminal: boolean;
  outputHandles: string[];       // handle ids for multi-output nodes
}

export const IVR_NODE_METADATA: Record<IvrNodeType, IvrNodeMeta> = {
  start: { type: 'start', label: '开始', icon: '▶', category: 'traditional', color: 'bg-green-500', description: '流程入口', isTerminal: false, outputHandles: [IVR_BRANCH.OUT] },
  play: { type: 'play', label: '播放', icon: '🔊', category: 'traditional', color: 'bg-blue-500', description: '播放语音/TTS', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.ERROR] },
  flush_audio: { type: 'flush_audio', label: '刷新音频', icon: '⏵', category: 'traditional', color: 'bg-blue-700', description: '播完队列再继续', isTerminal: false, outputHandles: [IVR_BRANCH.OUT] },
  menu: { type: 'menu', label: '按键菜单', icon: '🔢', category: 'traditional', color: 'bg-indigo-500', description: 'DTMF 按键选择', isTerminal: false, outputHandles: [] },
  collect: { type: 'collect', label: '收号', icon: '⌨️', category: 'traditional', color: 'bg-cyan-500', description: '采集多位号码', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.TIMEOUT, IVR_BRANCH.INVALID] },
  set_var: { type: 'set_var', label: '设置变量', icon: '📝', category: 'traditional', color: 'bg-slate-500', description: '变量赋值', isTerminal: false, outputHandles: [IVR_BRANCH.OUT] },
  condition: { type: 'condition', label: '分支判断', icon: '🔀', category: 'traditional', color: 'bg-amber-500', description: '条件路由', isTerminal: false, outputHandles: [IVR_BRANCH.TRUE, IVR_BRANCH.FALSE] },
  time_condition: { type: 'time_condition', label: '时间条件', icon: '🕐', category: 'traditional', color: 'bg-orange-500', description: '按时间路由', isTerminal: false, outputHandles: [IVR_BRANCH.TRUE, IVR_BRANCH.FALSE] },
  queue: { type: 'queue', label: '队列', icon: '📋', category: 'traditional', color: 'bg-purple-500', description: '排队等待', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.TIMEOUT, IVR_BRANCH.AT_CAPACITY, IVR_BRANCH.ERROR] },
  http: { type: 'http', label: 'HTTP 交互', icon: '🌐', category: 'traditional', color: 'bg-teal-500', description: 'API 请求', isTerminal: false, outputHandles: [IVR_BRANCH.SUCCESS, IVR_BRANCH.FAIL, IVR_BRANCH.TIMEOUT] },
  transfer: { type: 'transfer', label: '直呼', icon: '📞', category: 'traditional', color: 'bg-red-500', description: '转接呼叫', isTerminal: false,
    // 'out' = connected (IVR_BRANCH.OUT); failure handles mirror TRANSFER_BRANCH.
    outputHandles: [IVR_BRANCH.OUT, 'no_answer', 'busy', 'failed'] },
  voicemail: { type: 'voicemail', label: '留言', icon: '📭', category: 'traditional', color: 'bg-gray-500', description: '语音信箱', isTerminal: true, outputHandles: [] },
  sip: { type: 'sip', label: 'SIP', icon: '📡', category: 'traditional', color: 'bg-pink-500', description: 'SIP 外呼', isTerminal: true, outputHandles: [] },
  disconnect: { type: 'disconnect', label: '挂断', icon: '📴', category: 'traditional', color: 'bg-neutral-600', description: '结束通话', isTerminal: true, outputHandles: [] },
  // AI-native
  ai_dialogue: { type: 'ai_dialogue', label: 'AI 对话', icon: '🤖', category: 'ai', color: 'bg-emerald-600', description: 'AI 自由对话', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.TIMEOUT, IVR_BRANCH.ERROR] },
  intent: { type: 'intent', label: '意图判断', icon: '🎯', category: 'ai', color: 'bg-lime-600', description: 'AI 意向分析', isTerminal: false, outputHandles: [IVR_BRANCH.HIGH, IVR_BRANCH.LOW, IVR_BRANCH.CONTINUE] },
  knowledge_qa: { type: 'knowledge_qa', label: '知识库问答', icon: '📚', category: 'ai', color: 'bg-green-600', description: 'AI 知识检索', isTerminal: false, outputHandles: [IVR_BRANCH.FOUND, IVR_BRANCH.NOT_FOUND] },
  avatar_switch: { type: 'avatar_switch', label: '数字人切换', icon: '🎭', category: 'ai', color: 'bg-violet-600', description: '语音↔视频切换', isTerminal: false, outputHandles: [IVR_BRANCH.SUCCESS, IVR_BRANCH.DECLINED, IVR_BRANCH.ERROR] },
  compliance: { type: 'compliance', label: '合规播报', icon: '⚖️', category: 'ai', color: 'bg-yellow-600', description: '法定披露', isTerminal: false,
    // 'acknowledged' is not in IVR_BRANCH; this literal mirrors backend usage (branch-handles.ts:84).
    outputHandles: [IVR_BRANCH.OUT, 'acknowledged', IVR_BRANCH.DECLINED, IVR_BRANCH.TIMEOUT] },
  // Video / enhancement
  video_play: { type: 'video_play', label: '视频播放', icon: '🎬', category: 'video', color: 'bg-rose-500', description: '播放视频', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.SKIPPED, IVR_BRANCH.ERROR] },
  screen_share: { type: 'screen_share', label: '屏幕共享', icon: '🖥️', category: 'video', color: 'bg-sky-500', description: '共享屏幕', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.DENIED, IVR_BRANCH.ERROR] },
  visual_menu: { type: 'visual_menu', label: '可视化菜单', icon: '📱', category: 'video', color: 'bg-fuchsia-500', description: '画面菜单', isTerminal: false, outputHandles: [] },
  subflow: { type: 'subflow', label: '子流程', icon: '📦', category: 'video', color: 'bg-stone-500', description: '嵌套流程', isTerminal: false, outputHandles: [IVR_BRANCH.OUT, IVR_BRANCH.ERROR] },
  recording: { type: 'recording', label: '录音控制', icon: '🔴', category: 'video', color: 'bg-red-400', description: '开始/停止录音', isTerminal: false, outputHandles: [IVR_BRANCH.OUT] },
  webhook: { type: 'webhook', label: 'Webhook 推送', icon: '🔗', category: 'video', color: 'bg-blue-400', description: '事件推送', isTerminal: false, outputHandles: [IVR_BRANCH.SUCCESS, IVR_BRANCH.FAIL, IVR_BRANCH.TIMEOUT] },
};

/** Dynamic output handles — aligned with backend REQUIRED_HANDLES_BY_TYPE. */
export function getNodeOutputHandles(node: IvrNode): string[] {
  const meta = IVR_NODE_METADATA[node.type];
  if (!meta) return [];

  switch (node.type) {
    case 'menu': {
      const digits = node.options
        .filter((o) => !o.routeType || o.routeType === 'node')
        .map((o) => IVR_BRANCH.digit(o.digit));
      return [IVR_BRANCH.TIMEOUT, IVR_BRANCH.INVALID, IVR_BRANCH.MAX_RETRIES, ...digits];
    }
    case 'visual_menu': {
      const digits = node.items.map((i) => IVR_BRANCH.digit(i.digit));
      return [IVR_BRANCH.TIMEOUT, IVR_BRANCH.INVALID, ...digits];
    }
    case 'compliance':
      if (node.complianceType === 'recording_consent') {
        // 'acknowledged' mirrors backend branch-handles.ts:84 (not in IVR_BRANCH).
        return [IVR_BRANCH.OUT, 'acknowledged', IVR_BRANCH.DECLINED, IVR_BRANCH.TIMEOUT];
      }
      return [IVR_BRANCH.OUT];
    case 'knowledge_qa':
      return node.noAnswerAction === 'continue' ? [IVR_BRANCH.FOUND, IVR_BRANCH.NOT_FOUND] : [IVR_BRANCH.FOUND];
    default:
      return meta.outputHandles;
  }
}

export function nodeAcceptsInboundEdge(node: IvrNode): boolean {
  if (node.type === 'start') return false;
  return !['voicemail', 'sip', 'disconnect'].includes(node.type);
}

// === Node summary (for canvas display) ===
export function getNodeSummary(node: IvrNode): string {
  switch (node.type) {
    case 'start': return node.pushParams?.length ? `${node.pushParams.length} 个推送参数` : '流程入口';
    case 'play': return `${node.contents.length} 条播放`;
    case 'flush_audio': return '播完队列';
    case 'menu': return `${node.options.length} 个按键`;
    case 'collect': return `${node.minDigits}-${node.maxDigits} 位`;
    case 'set_var': return `${node.variableName} = ${node.value}`;
    case 'condition': return `${node.rules.length} 个条件 (${node.logic})`;
    case 'time_condition': return node.scheduleName || node.scheduleId;
    case 'queue': return node.queueName;
    case 'http': return `${node.method} ${node.url.slice(0, 30)}`;
    case 'transfer': return `${node.targetType}: ${node.targetValue}`;
    case 'voicemail': return `${node.maxDurationSec}s`;
    case 'sip': return node.sipUri;
    case 'disconnect': {
      const n = (node.contents?.length ?? 0);
      return n > 0 ? `告别音 ${n} 条` : '直接挂断';
    }
    case 'ai_dialogue': return `${node.role} · ${node.maxTurns} 轮`;
    case 'intent': return `${node.dimension} ≥ ${node.threshold}`;
    case 'knowledge_qa': return node.knowledgeBaseId;
    case 'avatar_switch': return node.direction;
    case 'compliance': return node.complianceType;
    case 'video_play': return node.sourceType;
    case 'screen_share': return node.source;
    case 'visual_menu': return `${node.items.length} 项`;
    case 'subflow': return node.flowName || node.flowId;
    case 'recording': return node.action;
    case 'webhook': return node.eventType;
    default: return '';
  }
}
