/**
 * Shared production step-input factory for live IVR sessions.
 */

import { resolvePlayContents, type PlayContentLike } from './ivr-play-resolver.js';
import type { IvrStepInput } from './ivr-executor.js';
import { IvrSettingsStore } from './ivr-settings-store.js';
import { AudioLibraryStore } from './audio-library-store.js';
import { createProductionSideEffects } from './ivr-production-effects.js';
import { createAcdEnqueue } from './ivr-acd-adapter.js';
import { startAiDialogue } from './ivr-ai-dialogue-bridge.js';

export function buildLiveIvrStepInput(
  db: unknown,
  tenantId: string,
  opts: {
    dtmf?: string;
    speechResult?: string | null;
    timedOut?: boolean;
    playCompleted?: boolean;
    flushCompleted?: boolean;
    bargeInDigits?: string;
    queueEvent?: import('./ivr-executor.js').QueueAdvanceEvent;
    transferEvent?: import('./ivr-executor.js').TransferAdvanceEvent;
    aiDialogueResult?: import('./ivr-executor.js').AiDialogueResult;
    videoEvent?: import('./ivr-video-handlers.js').VideoAdvanceEvent;
    screenShareEvent?: import('./ivr-video-handlers.js').ScreenShareAdvanceEvent;
    visualSelection?: string;
    mediaType?: import('./ivr-video-handlers.js').IvrMediaType;
    channelVariables?: Record<string, string>;
    callSessionId?: string;
    roomName?: string;
    recordingEvent?: import('./ivr-voicemail-handler.js').RecordingCompleteEvent;
  } = {}
): IvrStepInput {
  const settings = new IvrSettingsStore(db);
  const audioStore = new AudioLibraryStore(db);

  return {
    dtmf: opts.dtmf,
    speechResult: opts.speechResult,
    timedOut: opts.timedOut,
    playCompleted: opts.playCompleted,
    flushCompleted: opts.flushCompleted,
    bargeInDigits: opts.bargeInDigits,
    queueEvent: opts.queueEvent,
    transferEvent: opts.transferEvent,
    deferTransferToProvider: true,
    aiDialogueResult: opts.aiDialogueResult,
    mediaType: opts.mediaType,
    videoEvent: opts.videoEvent,
    screenShareEvent: opts.screenShareEvent,
    visualSelection: opts.visualSelection,
    channelVariables: opts.channelVariables,
    tenantId,
    callSessionId: opts.callSessionId,
    roomName: opts.roomName,
    recordingEvent: opts.recordingEvent,
    sideEffects: {
      ...createProductionSideEffects(db, tenantId),
      startAiDialogue: async (startOpts) =>
        startAiDialogue({
          ...startOpts,
          node: {
            id: startOpts.node.id,
            type: 'ai_dialogue',
            name: '',
            position: { x: 0, y: 0 },
            data: startOpts.node.data,
          },
        }),
    },
    timeGroupChecker: (scheduleId) => settings.checkTimeGroupActive(scheduleId, tenantId),
    regionGroupChecker: (groupId, areaCode) => settings.matchRegionGroup(groupId, tenantId, areaCode),
    groupCallResolver: (groupId) => settings.resolveGroupCallMembers(groupId, tenantId),
    acdEnqueue: createAcdEnqueue(db, tenantId),
    resolvePrompt: (contents: PlayContentLike[], variables) =>
      resolvePlayContents(contents, variables, (id) => audioStore.get(id)),
  };
}
