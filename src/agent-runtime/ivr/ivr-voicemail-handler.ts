/**
 * Voicemail record_audio two-phase flow (VC-5 / VM-1).
 */
import type { IvrAction, IvrRuntimeContext, IvrStepInput } from './ivr-executor.js';
import { isVoicemailRecordAudioProductionEnabled } from './ivr-production-gates.js';
import { fireVoicemailNotify } from './ivr-voicemail-notify.js';

export type RecordingCompleteEvent = {
  recordingUrl: string;
  voicemailId?: string;
  durationSec?: number;
};

export interface VoicemailSaveResult {
  voicemailId: string;
}

export interface VoicemailStepOutcome {
  action: IvrAction;
  context: IvrRuntimeContext;
  nextNodeId: string | null;
  terminated: boolean;
}

export function advanceVoicemailStep(
  nodeId: string,
  context: IvrRuntimeContext,
  action: IvrAction,
  variables: Record<string, string>
): VoicemailStepOutcome | null {
  if (action.kind !== 'voicemail' || !isVoicemailRecordAudioProductionEnabled()) {
    return null;
  }
  if (context.waiting?.kind === 'record_audio') {
    return null;
  }
  return {
    action,
    context: {
      ...context,
      variables,
      waiting: {
        kind: 'record_audio',
        nodeId,
        mailboxId: action.mailboxId ?? 'default',
        since: new Date().toISOString(),
      },
      currentNodeId: nodeId,
    },
    nextNodeId: nodeId,
    terminated: false,
  };
}

export async function handleRecordAudioResume(
  context: IvrRuntimeContext,
  input: IvrStepInput
): Promise<VoicemailStepOutcome | null> {
  if (context.waiting?.kind !== 'record_audio' || !input.recordingEvent) {
    return null;
  }

  const variables = { ...context.variables };
  const event = input.recordingEvent;
  let voicemailId = event.voicemailId;

  if (!voicemailId && input.sideEffects?.executeVoicemailSave) {
    const saved = await input.sideEffects.executeVoicemailSave({
      tenantId: input.tenantId ?? '',
      callSessionId: input.callSessionId,
      fromNumber: variables.caller_phone ?? variables.caller_id ?? '',
      mailbox: context.waiting.mailboxId ?? 'default',
      recordingUrl: event.recordingUrl,
      durationSec: event.durationSec,
    });
    voicemailId = saved.voicemailId;
  }

  if (voicemailId) variables.voicemail_id = voicemailId;
  if (event.recordingUrl) variables.recording_url = event.recordingUrl;
  if (event.durationSec != null) variables.voicemail_duration_sec = String(event.durationSec);

  const vmNode = context.graph.nodes.find((n) => n.id === context.waiting!.nodeId);
  const notifyWebhook = vmNode?.data.notifyWebhook as string | undefined;
  const notifyEmail = vmNode?.data.notifyEmail as string | undefined;
  if (voicemailId && (notifyWebhook || notifyEmail)) {
    const notifyInput = {
      notifyWebhook,
      notifyEmail,
      voicemailId,
      recordingUrl: event.recordingUrl,
      mailbox: context.waiting.mailboxId ?? 'default',
      fromNumber: variables.caller_phone ?? variables.caller_id ?? '',
      durationSec: event.durationSec,
      variables,
    };
    if (input.sideEffects?.executeVoicemailNotify) {
      void input.sideEffects.executeVoicemailNotify(notifyInput);
    } else {
      void fireVoicemailNotify(notifyWebhook, notifyInput, variables).catch((err) => {
        console.warn(
          `voicemail notify failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  return {
    action: {
      kind: 'log',
      message: `voicemail saved ${voicemailId ?? 'unknown'}`,
      node: context.waiting.nodeId,
    },
    context: {
      ...context,
      variables,
      waiting: undefined,
      currentNodeId: null,
    },
    nextNodeId: null,
    terminated: true,
  };
}
