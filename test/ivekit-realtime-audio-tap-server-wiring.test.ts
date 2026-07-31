import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/ivekit-server.ts', import.meta.url),
  'utf8'
);

test('iveKit server starts realtime audio tap before accepting traffic', () => {
  assert.match(source, /createConfiguredRealtimeAudioTapRuntime/);
  assert.match(source, /projection:\s*application\.realtimeSpeechProjection/);

  const application = source.indexOf('application = startIveKitApplication');
  const runtime = source.indexOf('realtimeAudioTap = createConfiguredRealtimeAudioTapRuntime');
  const tapStart = source.indexOf('await realtimeAudioTap.start()');
  const listen = source.indexOf('await listenHttpServer(server, port)');
  assert.ok(application >= 0);
  assert.ok(runtime > application);
  assert.ok(tapStart > runtime);
  assert.ok(listen > tapStart);
});

test('iveKit server exposes grants and injects an authorizer only when available', () => {
  assert.match(
    source,
    /mediaOptions:\s*\{[\s\S]*realtime_audio_tap_grants:\s*realtimeAudioTap\.grants/
  );
  assert.match(
    source,
    /livekit_realtime_audio_tap_authorizer:\s*realtimeAudioTap\.livekit_authorizer/
  );
  assert.match(
    source,
    /livekit_realtime_audio_tap_gateway_url:\s*process\.env\.OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL/
  );
  assert.match(
    source,
    /realtime_audio_tap_grants:\s*realtimeAudioTap\.grants/
  );
  assert.match(
    source,
    /realtime_audio_tap_authorizer:\s*realtimeAudioTap\.authorizer/
  );
});

test('iveKit shutdown drains realtime audio tap before application workers', () => {
  const tapStop = source.indexOf('await realtimeAudioTap.stop()');
  const applicationStop = source.indexOf('await application.stop()');
  assert.ok(tapStop >= 0);
  assert.ok(applicationStop > tapStop);
});
