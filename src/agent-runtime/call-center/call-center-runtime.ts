import { VoiceStore } from '../voice/voice-store.js';
import { LiveKitRoomStore } from '../livekit/room-store.js';
import { OutboundTaskStore } from './outbound-task-store.js';
import { createOutboundDialer, type OutboundDialer } from './outbound-dialer.js';
import { MemoryRedis, setRedisClientForTests } from './redis-client.js';
import { resetRedisPubSubForTests } from '../../redis-pubsub.js';
import { createTaskLockStore } from './task-lock.js';
import { startIvrRwiRuntime, stopIvrRwiRuntime } from '../ivr/ivr-rwi-runtime.js';

let dialerInstance: OutboundDialer | null = null;

export async function startCallCenterRuntime(db: unknown, harness: { voiceStore?: VoiceStore }): Promise<void> {
  const voiceStore = harness.voiceStore || new VoiceStore(db);
  void startIvrRwiRuntime(db, voiceStore).catch((error) => {
    console.warn('[ivr-rwi] runtime failed to start:', error instanceof Error ? error.message : error);
  });

  if (process.env.OPC_DISABLE_DIALER === '1') return;
  dialerInstance = await createOutboundDialer({
    db,
    voiceStore,
    outboundTaskStore: new OutboundTaskStore(db),
    roomStore: new LiveKitRoomStore(db),
    taskLock: await createTaskLockStore()
  });
  dialerInstance.start();
}

export function stopCallCenterRuntime(): void {
  dialerInstance?.stop();
  dialerInstance = null;
  stopIvrRwiRuntime();
}

export function getOutboundDialerForTests(): OutboundDialer | null {
  return dialerInstance;
}

export function getSharedRwiClientFromRuntime(): import('./rwi-client.js').RWIClientLike | null {
  return dialerInstance?.getRwiClient() ?? null;
}

export function useMemoryRedisForTests(): void {
  // Force BOTH Redis singletons into in-memory mode.
  // getRedisPubSub() independently checks OPC_USE_MEMORY_REDIS, so the env
  // flag must be set here too — otherwise it creates a REAL ioredis client.
  // With no Redis running, that client emits unhandled ECONNREFUSED errors on
  // a retry loop, keeping the event loop alive and hanging the test runner
  // whenever a path triggers wsBroadcast (e.g. omni chat escalation).
  // Drop any previously-created (possibly real) pubsub client so the next
  // getRedisPubSub() call rebuilds it under memory mode.
  process.env.OPC_USE_MEMORY_REDIS = '1';
  resetRedisPubSubForTests(null);
  setRedisClientForTests(new MemoryRedis());
}
