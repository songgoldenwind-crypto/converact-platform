/**
 * Genesys-style audio queue — play enqueues, sync points flush (ADR-4).
 */
import type { ResolvedPrompt } from './ivr-play-resolver.js';

export interface AudioQueueSegment extends ResolvedPrompt {
  interruptible?: boolean;
  sourceNodeId: string;
}

export function enqueuePlayContents(
  queue: AudioQueueSegment[] | undefined,
  segments: AudioQueueSegment[]
): AudioQueueSegment[] {
  return [...(queue ?? []), ...segments];
}

export function clearAudioQueue(): AudioQueueSegment[] {
  return [];
}

export function consumeQueueForFlush(queue: AudioQueueSegment[] | undefined): AudioQueueSegment[] {
  return queue ?? [];
}

export type PromptQueueItem = {
  text: string;
  promptType?: 'tts' | 'audio';
  audioUrl?: string;
  interruptible?: boolean;
};

/** Menu / collect sync point — flush audioQueue into prompt_queue (ADR-4). */
export function isAudioFlushSyncPoint(nodeType: string): boolean {
  return (
    nodeType === 'menu' ||
    nodeType === 'visual_menu' ||
    nodeType === 'collect' ||
    nodeType === 'compliance' ||
    nodeType === 'transfer' ||
    nodeType === 'disconnect'
  );
}

export function segmentsToPromptQueue(queue: AudioQueueSegment[]): PromptQueueItem[] {
  return queue.map((s) => ({
    text: s.text,
    promptType: s.promptType,
    audioUrl: s.audioUrl,
    interruptible: s.interruptible,
  }));
}

export function buildMenuPromptQueue(
  flushQueue: AudioQueueSegment[],
  menuPrompt: ResolvedPrompt
): PromptQueueItem[] {
  return [
    ...flushQueue.map((s) => ({
      text: s.text,
      promptType: s.promptType,
      audioUrl: s.audioUrl,
      interruptible: s.interruptible,
    })),
    {
      text: menuPrompt.text,
      promptType: menuPrompt.promptType,
      audioUrl: menuPrompt.audioUrl,
      interruptible: false,
    },
  ];
}
