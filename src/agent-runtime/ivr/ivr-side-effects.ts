/**
 * IVR side-effect runners — real execution of nodes that do I/O.
 *
 * The executor (ivr-executor.ts) produces actions; this module executes
 * the side effects: HTTP requests, webhooks, recording control, subflow
 * loading, and LLM/knowledge-base calls. Each function returns a result
 * that the executor uses to determine the next routing branch.
 *
 * In simulation mode (no real I/O), these return mock/success values
 * so the test trace can exercise all branches.
 */

import type { IvrFlowGraph } from './ivr-types.js';

const EGRESS_FETCH_TIMEOUT_MS = Number(process.env.EGRESS_FETCH_TIMEOUT_MS || 10_000);

async function egressFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EGRESS_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('egress request timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface HttpExecResult {
  success: boolean;
  statusCode: number;
  responseBody?: Record<string, unknown>;
  error?: string;
  /** Variables to inject from response mappings */
  mappedVariables?: Record<string, string>;
}

export interface WebhookExecResult {
  success: boolean;
  statusCode: number;
  error?: string;
}

export interface RecordingExecResult {
  success: boolean;
  egressId?: string;
  recordingUrl?: string;
  error?: string;
}

export interface SubflowExecResult {
  success: boolean;
  graph?: IvrFlowGraph;
  error?: string;
}

export interface IntentExecResult {
  score: number;
  dimension: string;
  keywords?: string[];
}

export interface KnowledgeQaExecResult {
  found: boolean;
  answer?: string;
  source?: string;
  confidence?: number;
  reason?: string;
}

// --- Execution context: injectable side-effect implementations ---
// In production, these call real services. In tests, they're mocked.

export interface TransferExecResult {
  ok: boolean;
  reason?: 'connected' | 'no_answer' | 'busy' | 'failed';
  error?: string;
}

export interface AvatarSwitchExecResult {
  status: 'success' | 'declined' | 'error';
  reason?: string;
}

export interface VoicemailSaveInput {
  tenantId: string;
  callSessionId?: string;
  fromNumber: string;
  mailbox: string;
  recordingUrl: string;
  durationSec?: number;
}

export interface VoicemailSaveResult {
  voicemailId: string;
}

export interface VoicemailNotifyInput {
  notifyWebhook?: string;
  notifyEmail?: string;
  voicemailId: string;
  recordingUrl: string;
  mailbox: string;
  fromNumber: string;
  durationSec?: number;
  variables?: Record<string, string>;
}

export interface IvrSideEffects {
  executeHttp?: (nodeData: Record<string, unknown>, variables: Record<string, string>) => Promise<HttpExecResult>;
  executeVoicemailSave?: (input: VoicemailSaveInput) => Promise<VoicemailSaveResult>;
  executeVoicemailNotify?: (input: VoicemailNotifyInput) => Promise<void>;
  executeWebhook?: (nodeData: Record<string, unknown>, variables: Record<string, string>) => Promise<WebhookExecResult>;
  executeRecording?: (
    nodeData: Record<string, unknown>,
    callSessionId: string,
    roomName?: string,
    variables?: Record<string, string>
  ) => Promise<RecordingExecResult>;
  executeSubflow?: (flowId: string, tenantId: string) => Promise<SubflowExecResult>;
  executeIntent?: (nodeData: Record<string, unknown>, variables: Record<string, string>) => Promise<IntentExecResult>;
  executeKnowledgeQa?: (nodeData: Record<string, unknown>, variables: Record<string, string>) => Promise<KnowledgeQaExecResult>;
  executeTransfer?: (
    nodeData: Record<string, unknown>,
    variables: Record<string, string>,
    callSessionId: string
  ) => Promise<TransferExecResult>;
  startAiDialogue?: (opts: {
    node: { id: string; data: Record<string, unknown> };
    roomName: string;
    callSessionId: string;
    tenantId: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  executeAvatarSwitch?: (
    nodeData: Record<string, unknown>,
    variables: Record<string, string>,
    ctx: { callSessionId?: string; roomName?: string; tenantId?: string }
  ) => Promise<AvatarSwitchExecResult>;
}

import { executeHttpRequest } from './ivr-http-request.js';
import { executeWebhookRequest } from './ivr-webhook-request.js';
import { fireVoicemailNotify } from './ivr-voicemail-notify.js';

export const defaultSideEffects: IvrSideEffects = {
  async executeHttp(nodeData, variables) {
    return executeHttpRequest(nodeData, variables);
  },

  async executeWebhook(nodeData, variables) {
    return executeWebhookRequest(nodeData, variables);
  },

  async executeRecording(nodeData, _callSessionId, roomName, variables?: Record<string, string>) {
    const action = (nodeData.action as string) || 'start';
    const format = (nodeData.format as string) || 'wav';

    if (action === 'pause' || action === 'resume') {
      if (!roomName) return { success: false, error: 'no room name for recording' };
      return { success: true };
    }

    if (!roomName) {
      return { success: false, error: 'no room name for recording' };
    }

    try {
      if (action === 'start') {
        const egressUrl = process.env.EGRESS_API_URL || 'http://localhost:8093';
        const res = await egressFetch(`${egressUrl}/recordings/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room_name: roomName, format }),
        });
        const data = await res.json() as Record<string, unknown>;
        return { success: res.ok, egressId: data.egress_id as string };
      }
      if (action === 'stop') {
        const egressId = variables?.egress_id;
        if (!egressId) {
          return { success: true, recordingUrl: undefined };
        }
        const egressUrl = process.env.EGRESS_API_URL || 'http://localhost:8093';
        const res = await egressFetch(`${egressUrl}/recordings/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ egress_id: egressId }),
        });
        const data = await res.json() as Record<string, unknown>;
        return {
          success: res.ok,
          recordingUrl: (data.recording_url as string) || undefined,
        };
      }
      return { success: false, error: `unknown recording action: ${action}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async executeSubflow(flowId, _tenantId) {
    // Subflow loading requires access to the IvrFlowStore. This is injected
    // by the caller (the runtime executor) via a closure. The default
    // implementation returns a not-found error — the caller overrides it.
    return { success: false, error: 'subflow loader not configured' };
  },

  async executeTransfer(_nodeData, _variables, _callSessionId) {
    // Simulation / default path must not pretend success — that left flows
    // stuck in waiting:transfer forever. Production injects a real bridge via
    // createProductionSideEffects; tests that need success should mock explicitly.
    return {
      ok: false,
      reason: 'failed',
      error: 'transfer side effect not configured (inject createProductionSideEffects for live calls)',
    };
  },

  async executeIntent(nodeData, variables) {
    const dimension = (nodeData.dimension as string) || 'score';
    const scoreVar = variables.intent_score;
    if (scoreVar) {
      return { score: parseFloat(scoreVar), dimension };
    }
    if (dimension === 'keyword') {
      return { score: 0, dimension };
    }
    console.warn(`executeIntent: no intent_score for dimension=${dimension}, defaulting continue`);
    return { score: Number.NaN, dimension };
  },

  async executeKnowledgeQa(nodeData, variables) {
    const kbId = (nodeData.knowledgeBaseId as string) || '';
    const questionVar = (nodeData.questionVariable as string) || 'caller_question';
    const question = variables[questionVar] || '';
    if (!question.trim()) {
      return { found: false, reason: 'empty_question' };
    }
    const kbResult = variables['kb_result'];
    if (kbResult === 'found') {
      return {
        found: true,
        answer: variables[(nodeData.answerVariable as string) || 'kb_answer'] || '',
        source: 'cache',
        confidence: 1,
      };
    }
    void kbId;
    void question;
    return { found: false, reason: 'no_match' };
  },

  async executeVoicemailNotify(input) {
    await fireVoicemailNotify(input.notifyWebhook, input, input.variables ?? {});
  },
};
