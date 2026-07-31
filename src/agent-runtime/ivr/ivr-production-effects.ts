import { resolveConveractEnv } from '../../config/converact-env.js';
/**
 * Production side-effect factory for live IVR sessions.
 *
 * Instances are cached per (db, tenantId) so hot step paths do not allocate
 * VoiceStore / CallTransferService / KnowledgeStore on every advance.
 */

import { VoicemailStore } from '../call-center/agent-tools/voicemail.js';
import { CallTransferService } from '../call-center/agent-tools/call-transfer.js';
import { VoiceStore } from '../voice/voice-store.js';
import { AgentSeatStore } from '../call-center/seat-store.js';
import { LiveKitRoomStore } from '../livekit/room-store.js';
import { readEgressConfigFromEnv } from '../../recording-policy.js';
import { EgressManager } from '../call-center/egress-manager.js';
import { KnowledgeStore } from '../call-center/knowledge/knowledge-store.js';
import { IntegrationConfigStore } from '../integrations/integration-config-store.js';
import { IvrFlowStore } from './ivr-flow-store.js';
import { knowledgeSearchQuery, lexicalKnowledgeConfidence } from './ivr-knowledge-handler.js';
import { defaultSideEffects, type IvrSideEffects } from './ivr-side-effects.js';
import { executeWebhookRequest } from './ivr-webhook-request.js';

const cache = new WeakMap<object, Map<string, IvrSideEffects>>();
/** Strong refs for test cleanup when the same db object is reused across cases. */
const strongCaches = new Set<Map<string, IvrSideEffects>>();

function cacheFor(db: unknown): Map<string, IvrSideEffects> {
  const key = db as object;
  let map = cache.get(key);
  if (!map) {
    map = new Map();
    cache.set(key, map);
    strongCaches.add(map);
  }
  return map;
}

/** Drop all cached production side-effect factories (tests). */
export function clearProductionSideEffectsCache(): void {
  for (const map of strongCaches) map.clear();
}

export function createProductionSideEffects(db: unknown, tenantId: string): IvrSideEffects {
  const map = cacheFor(db);
  const hit = map.get(tenantId);
  if (hit) return hit;

  const flowStore = new IvrFlowStore(db);
  const knowledgeStore = new KnowledgeStore(db);
  const integrationStore = new IntegrationConfigStore(db);
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const transferService = new CallTransferService(voiceStore, seatStore, roomStore);
  const egress = new EgressManager(db, readEgressConfigFromEnv());
  const voicemailStore = new VoicemailStore(db);

  const effects: IvrSideEffects = {
    ...defaultSideEffects,
    async executeWebhook(nodeData, variables) {
      return executeWebhookRequest(nodeData, variables, {
        resolveSecretRef: (refId) => {
          const ref = integrationStore.getSecretRefById(tenantId, refId);
          return ref?.env_var_name ? resolveConveractEnv(process.env, ref.env_var_name) : undefined;
        },
      });
    },
    async executeSubflow(flowId, tid) {
      const flow = flowStore.getFlow(tid, flowId);
      if (!flow) return { success: false, error: 'subflow not found' };
      return { success: true, graph: flow.graph };
    },
    async executeKnowledgeQa(nodeData, variables) {
      const kbId = (nodeData.knowledgeBaseId as string) || '';
      const questionVar = (nodeData.questionVariable as string) || 'caller_question';
      const question = variables[questionVar] || variables.caller_question || '';
      if (!question.trim()) {
        return { found: false, reason: 'empty_question' };
      }

      const searchQ = knowledgeSearchQuery(question);
      const hits = knowledgeStore.searchDocuments(tenantId, searchQ, {
        knowledgeBaseId: kbId || undefined,
        limit: (nodeData.maxResults as number) || 1,
      });
      if (!hits.length) return { found: false, reason: 'no_match' };

      const hit = hits[0];
      const threshold = (nodeData.confidenceThreshold as number) ?? 0.3;
      const confidence = lexicalKnowledgeConfidence(question, hit.title, hit.content);
      if (confidence < threshold) {
        return { found: false, reason: 'low_confidence', confidence };
      }

      return {
        found: true,
        answer: hit.content.slice(0, 500),
        source: hit.title,
        confidence,
      };
    },
    async executeRecording(nodeData, callSessionId, roomName) {
      const action = (nodeData.action as string) || 'start';
      const format = ((nodeData.format as string) || 'wav') as 'wav' | 'mp4' | 'webm' | 'ogg';
      if (!callSessionId || !roomName) {
        return { success: false, error: 'missing call session or room' };
      }
      try {
        if (action === 'start') {
          const record = await egress.startRecording(tenantId, callSessionId, roomName, { format });
          return { success: true, egressId: record.egress_id };
        }
        const existing = egress.getRecordingBySession(callSessionId);
        if (existing?.egress_id) {
          await egress.stopRecording(existing.egress_id);
        }
        return { success: true, egressId: existing?.egress_id };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    /**
     * Real seat-bridge transfer.
     *
     * Sync blind transfer outcomes are only `connected` or `failed`.
     * `busy` / `no_answer` are reserved for async `transferEvent` from a dial
     * path with real call-leg state — production executeTransfer never emits them.
     */
    async executeTransfer(nodeData, variables, callSessionId) {
      const targetType = nodeData.targetType as string | undefined;
      const targetValue = String(nodeData.targetValue ?? '');
      const memberSeatIds = nodeData.memberSeatIds as string[] | undefined;

      if (!callSessionId) {
        return { ok: false, reason: 'failed', error: 'transfer requires a call session' };
      }

      let targetSeatId: string | null = null;
      if (targetType === 'seat_id') {
        if (!targetValue) return { ok: false, reason: 'failed', error: 'transfer target seat_id is empty' };
        targetSeatId = targetValue;
      } else if (targetType === 'group_call') {
        if (Array.isArray(memberSeatIds) && memberSeatIds.length === 1) {
          targetSeatId = memberSeatIds[0];
        } else {
          return {
            ok: false,
            reason: 'failed',
            error: 'group_call needs exactly one resolved member seat; multi-seat dial not implemented',
          };
        }
      } else if (targetType === 'extension' || targetType === 'queue' || targetType === 'phone') {
        return {
          ok: false,
          reason: 'failed',
          error: `transfer targetType '${targetType}' not yet supported via call transfer service`,
        };
      } else {
        return { ok: false, reason: 'failed', error: `transfer targetType '${targetType ?? ''}' not supported` };
      }

      const fromSeatId = String(nodeData.fromSeatId ?? variables.from_seat_id ?? variables.current_seat_id ?? '');
      if (!fromSeatId) {
        return {
          ok: false,
          reason: 'failed',
          error:
            'IVR transfer requires a source seat (nodeData.fromSeatId or variable from_seat_id/current_seat_id); AI-only sessions without a seat are not yet bridgable',
        };
      }

      try {
        const result = transferService.transfer({
          tenantId,
          callSessionId,
          fromSeatId,
          targetSeatId,
          mode: 'blind',
        });
        if (result.status === 'completed') return { ok: true, reason: 'connected' };
        return { ok: false, reason: 'failed', error: `transfer did not complete (status=${result.status})` };
      } catch (err) {
        return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
    async executeVoicemailSave(input) {
      const row = voicemailStore.createVoicemail({
        tenant_id: input.tenantId,
        call_session_id: input.callSessionId ?? null,
        from_number: input.fromNumber,
        mailbox: input.mailbox,
        recording_url: input.recordingUrl,
        duration_sec: input.durationSec ?? null,
      });
      return { voicemailId: row.id };
    },
  };

  map.set(tenantId, effects);
  return effects;
}
