/**
 * LiveKit Agent dispatch for IVR ai_dialogue nodes (不一致-5 AI-H2).
 */

import { dispatchAiAgent } from '../livekit/agent-dispatch-service.js';
import type { IvrNodeBase } from './ivr-types.js';

export async function startAiDialogue(opts: {
  node: IvrNodeBase;
  roomName: string;
  callSessionId: string;
  tenantId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const d = opts.node.data;
  const agentSpecId = (d.agentSpecId as string) || (d.scriptId as string);
  if (!agentSpecId?.trim()) {
    return { ok: false, reason: 'missing_agent_spec' };
  }
  if (!opts.roomName?.trim()) {
    return { ok: false, reason: 'missing_room' };
  }

  const dispatched = await dispatchAiAgent(opts.roomName, {
    call_session_id: opts.callSessionId,
    tenant_id: opts.tenantId,
    agent_spec_id: agentSpecId,
    ivr_node_id: opts.node.id,
    max_turns: (d.maxTurns as number) ?? 10,
    timeout_sec: (d.timeoutSec as number) ?? 30,
    handoff_triggers: (d.handoffTriggers as string[]) ?? [],
    mode: 'ivr_embedded',
  });

  if (!dispatched) return { ok: false, reason: 'dispatch_failed' };
  return { ok: true };
}
