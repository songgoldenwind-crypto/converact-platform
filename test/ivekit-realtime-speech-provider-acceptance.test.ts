import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  runIveKitRealtimeSpeechProviderAcceptance
} from '../scripts/ivekit-realtime-speech-provider-acceptance.js';

test('controlled realtime speech acceptance covers transport and routing failure modes', async () => {
  const report = await runIveKitRealtimeSpeechProviderAcceptance();

  assert.equal(report.status, 'passed');
  assert.equal(report.verification_scope, 'controlled_loopback_realtime_provider');
  assert.equal(report.real_vendor_evidence, false);
  assert.deepEqual(report.checks.map((check) => check.name), [
    'success_binary_audio',
    'rate_limited_429',
    'transient_5xx',
    'terminal_rejected',
    'auth_failed',
    'protocol_mismatch',
    'startup_timeout',
    'bounded_audio_overflow',
    'startup_failover',
    'terminal_no_failover',
    'established_disconnect_no_failover'
  ]);
  assert.equal(report.checks.every((check) => check.status === 'passed'), true);
  assert.doesNotMatch(
    JSON.stringify(report),
    /controlled-realtime-token|private provider detail|https?:\/\/|authorization|endpoint/i
  );

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts['ivekit:realtime-speech-provider-acceptance'],
    'node --import tsx scripts/ivekit-realtime-speech-provider-acceptance.ts'
  );
});
