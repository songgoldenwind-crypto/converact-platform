import assert from 'node:assert/strict';
import { test } from 'node:test';

import { metricsRegistry } from '../src/metrics.js';
import {
  observeRealtimeAudioTapGatewayEvent,
  observeVoiceCommand,
  observeVoiceProviderEvent,
  voiceMetricDefinitions
} from '../src/agent-runtime/ivekit/voice/metrics.js';

test('Voice metrics use only bounded labels and forbid tenant or resource identities', () => {
  const forbidden = new Set([
    'tenant_id', 'call_id', 'business_ref', 'profile_id', 'flow_id', 'phone_number'
  ]);
  for (const definition of voiceMetricDefinitions) {
    assert.equal(definition.name.startsWith('opc_ivekit_voice_'), true);
    assert.equal(definition.labels.some((label) => forbidden.has(label)), false);
  }
});

test('Voice metrics collapse untrusted event and error labels to bounded values', async () => {
  observeVoiceCommand({
    adapter: 'rustpbx', kind: 'originate', result: 'failed',
    error_code: 'attacker-controlled-error-value', duration_seconds: 0.25
  });
  observeVoiceProviderEvent({
    adapter: 'rustpbx', event_type: 'attacker.event.123456789', lag_seconds: 1.5,
    result: 'processed'
  });
  observeRealtimeAudioTapGatewayEvent({
    media_source: 'livekit',
    event_type: 'tap.audio.dropped',
    reason: 'attacker-controlled-reason',
    dropped_duration_ms: 40
  });

  const output = await metricsRegistry.metrics();
  assert.match(output, /opc_ivekit_voice_commands_total\{adapter="rustpbx",kind="originate",result="failed",error_code="other"\}/);
  assert.match(output, /opc_ivekit_voice_provider_events_total\{adapter="rustpbx",event_type="other",result="processed"\}/);
  assert.match(output, /opc_ivekit_voice_audio_tap_events_total\{media_source="livekit",event_type="tap.audio.dropped",reason="other"\}/);
  assert.match(output, /opc_ivekit_voice_audio_tap_dropped_seconds_total\{media_source="livekit",reason="other"\} 0\.04/);
  assert.doesNotMatch(output, /attacker-controlled|attacker\.event/);
});
