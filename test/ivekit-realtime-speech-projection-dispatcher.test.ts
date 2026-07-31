import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RealtimeSpeechProjectionDispatcher,
  type RealtimeSpeechProjectionDispatchEvent
} from '../src/agent-runtime/converact/voice/realtime-speech-projection-dispatcher.js';
import type {
  RealtimeSpeechProjectionContext
} from '../src/agent-runtime/converact/voice/realtime-speech-projection.js';
import type {
  RealtimeSpeechTranslationEvent
} from '../src/agent-runtime/converact/voice/realtime-speech-translation.js';

test('projection dispatcher retries a final after a short database outage', async () => {
  let available = false;
  const projected: number[] = [];
  const observed: RealtimeSpeechProjectionDispatchEvent[] = [];
  const dispatcher = new RealtimeSpeechProjectionDispatcher({
    projection: {
      async project(_context, event) {
        projected.push(event.sequence);
        if (!available) {
          available = true;
          throw new Error('database unavailable password=private');
        }
        return { status: 'persisted', projection: null, replayed: false };
      }
    },
    max_queue_items: 8,
    retry_delays_ms: [0],
    on_event: (event) => { observed.push(event); }
  });

  assert.equal(dispatcher.offer(context(), translationEvent(1, true)), 'accepted');
  await waitFor(() => projected.length === 2);
  await dispatcher.close();

  assert.deepEqual(projected, [1, 1]);
  assert.deepEqual(observed.map((event) => ({
    type: event.type,
    reason: event.reason,
    final: event.final
  })), [
    {
      type: 'projection.retrying',
      reason: 'projection_failed',
      final: true
    },
    {
      type: 'projection.succeeded',
      reason: '',
      final: true
    }
  ]);
  assert.doesNotMatch(JSON.stringify(observed), /password|private|database unavailable/i);
});

test('projection dispatcher bounds work and preserves finals ahead of partials', async () => {
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const projected: number[] = [];
  const observed: RealtimeSpeechProjectionDispatchEvent[] = [];
  const dispatcher = new RealtimeSpeechProjectionDispatcher({
    projection: {
      async project(_context, event) {
        projected.push(event.sequence);
        if (projected.length === 1) await firstBlocked;
        return {
          status: event.final ? 'persisted' : 'ephemeral',
          projection: null,
          replayed: false
        };
      }
    },
    max_queue_items: 2,
    retry_delays_ms: [],
    on_event: (event) => { observed.push(event); }
  });

  assert.equal(dispatcher.offer(context(), translationEvent(1, false)), 'accepted');
  await waitFor(() => projected.length === 1);
  assert.equal(dispatcher.offer(context(), translationEvent(2, false)), 'accepted');
  assert.equal(dispatcher.offer(context(), translationEvent(3, false)), 'accepted');
  assert.equal(dispatcher.offer(context(), translationEvent(4, true)), 'accepted');
  assert.equal(
    dispatcher.offer(context(), translationEvent(5, false)),
    'dropped_overflow'
  );

  releaseFirst?.();
  await waitFor(() => projected.length === 3);
  await dispatcher.close();

  assert.deepEqual(projected, [1, 3, 4]);
  assert.deepEqual(observed.filter(
    (event) => event.type === 'projection.dropped'
  ).map((event) => ({
    reason: event.reason,
    final: event.final
  })), [
    { reason: 'projection_queue_overflow', final: false },
    { reason: 'projection_queue_overflow', final: false }
  ]);
});

test('projection dispatcher bounds shutdown while a projection is stuck', async () => {
  let releaseCurrent: (() => void) | undefined;
  const currentBlocked = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  let currentStarted = false;
  const observed: RealtimeSpeechProjectionDispatchEvent[] = [];
  const dispatcher = new RealtimeSpeechProjectionDispatcher({
    projection: {
      async project() {
        currentStarted = true;
        await currentBlocked;
        return { status: 'persisted', projection: null, replayed: false };
      }
    },
    max_queue_items: 2,
    retry_delays_ms: [],
    shutdown_timeout_ms: 20,
    on_event: (event) => { observed.push(event); }
  });

  assert.equal(dispatcher.offer(context(), translationEvent(1, true)), 'accepted');
  await waitFor(() => currentStarted);
  assert.equal(dispatcher.offer(context(), translationEvent(2, true)), 'accepted');

  const startedAt = Date.now();
  await dispatcher.close();
  const closeElapsedMs = Date.now() - startedAt;
  releaseCurrent?.();

  assert.ok(closeElapsedMs >= 10 && closeElapsedMs < 250);
  assert.deepEqual(observed.filter(
    (event) => event.reason === 'projection_shutdown_timeout'
  ).map((event) => ({
    type: event.type,
    reason: event.reason,
    final: event.final
  })), [{
    type: 'projection.dropped',
    reason: 'projection_shutdown_timeout',
    final: true
  }]);
});

function context(): RealtimeSpeechProjectionContext {
  return {
    tenant_id: 'tenant-a',
    interaction_id: 'interaction-a',
    media_session_id: 'room-a',
    media_source: 'livekit',
    participant_id: 'customer-a',
    track_id: 'track-a',
    purpose: 'live_translation',
    consent_ref: 'consent-a',
    provider_profile_id: 'speech-primary',
    provider: 'speech-provider',
    provider_version: '2026-07',
    retention_until: '2026-08-22T00:00:00.000Z',
    audience_user_ids: ['agent-a', 'customer-a']
  };
}

function translationEvent(
  sequence: number,
  final: boolean
): RealtimeSpeechTranslationEvent {
  return {
    event_id: `event-${sequence}`,
    type: final ? 'translation.final' : 'translation.partial',
    provider_session_id: 'provider-session-a',
    sequence,
    occurred_at: '2026-07-23T09:30:00.000Z',
    segment_id: `segment-${sequence}`,
    speaker_id: 'customer-a',
    source_language: 'en',
    target_language: 'zh-CN',
    source_text: 'hello',
    translated_text: '你好',
    provider_request_id: `request-${sequence}`,
    latency_ms: { final: 100 },
    safe_metadata: {},
    final
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for projection dispatcher');
}
