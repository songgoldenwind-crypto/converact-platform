import type { ConveractFabricChatMessage } from '@converact/sdk';

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
  messages: ConveractFabricChatMessage[];
  changedMessages: ConveractFabricChatMessage[];
  cursor: string | null;
  generation: number;
}

export interface ChatScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
