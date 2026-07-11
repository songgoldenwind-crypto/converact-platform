import type { IveKitChatMessage } from '@opc/ivekit-sdk';

export type ChatConnectionState =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'closed'
  | 'fatal';

export type ChatConvergenceTrigger =
  | 'initial'
  | 'tinode_data'
  | 'ivekit_event'
  | 'reconnect'
  | 'visibility';

export interface ChatConvergenceProjection {
  messages: IveKitChatMessage[];
  cursor: string | null;
  generation: number;
}

export interface ChatScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
