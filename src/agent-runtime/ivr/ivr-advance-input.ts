/**
 * Parse POST /api/ivr/sessions/:id/advance body into IvrStepInput fields.
 */
import type {
  AiDialogueResult,
  IvrStepInput,
  QueueAdvanceEvent,
  TransferAdvanceEvent,
} from './ivr-executor.js';
import type { ScreenShareAdvanceEvent, VideoAdvanceEvent } from './ivr-video-handlers.js';
import type { IvrMediaType } from './ivr-video-handlers.js';

export function parseIvrAdvanceBody(input: Record<string, unknown>): IvrStepInput {
  return {
    dtmf: input.dtmf as string | undefined,
    speechResult: (input.speechResult as string | null | undefined) ?? undefined,
    timedOut: input.timedOut === true,
    playCompleted: input.playCompleted === true,
    flushCompleted: input.flushCompleted === true,
    bargeInDigits: input.bargeInDigits as string | undefined,
    queueEvent: input.queueEvent as QueueAdvanceEvent | undefined,
    transferEvent: input.transferEvent as TransferAdvanceEvent | undefined,
    aiDialogueResult: input.aiDialogueResult as AiDialogueResult | undefined,
    mediaType: input.mediaType as IvrMediaType | undefined,
    videoEvent: input.videoEvent as VideoAdvanceEvent | undefined,
    screenShareEvent: input.screenShareEvent as ScreenShareAdvanceEvent | undefined,
    visualSelection: input.visualSelection as string | undefined,
    channelVariables: input.channelVariables as Record<string, string> | undefined,
    roomName: input.roomName as string | undefined,
    recordingEvent: input.recordingEvent as import('./ivr-voicemail-handler.js').RecordingCompleteEvent | undefined,
  };
}

export function parseAiDialogueResultBody(input: Record<string, unknown>): AiDialogueResult | null {
  const reason = input.reason as AiDialogueResult['reason'] | undefined;
  if (!reason || !['completed', 'handoff', 'timeout', 'error'].includes(reason)) {
    return null;
  }
  return {
    reason,
    turnCount: typeof input.turnCount === 'number' ? input.turnCount : undefined,
    intentScore: typeof input.intentScore === 'number' ? input.intentScore : undefined,
    customerSummary: typeof input.customerSummary === 'string' ? input.customerSummary : undefined,
    variables:
      input.variables && typeof input.variables === 'object' && !Array.isArray(input.variables)
        ? (input.variables as Record<string, string>)
        : undefined,
  };
}
