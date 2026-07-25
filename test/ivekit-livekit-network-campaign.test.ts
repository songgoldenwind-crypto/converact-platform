import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveKitNetworkCampaignPaths,
  parseLiveKitNetworkCampaignArgs
} from '../scripts/ivekit-livekit-network-campaign.js';

test('parses the fixed LiveKit network campaign contract', () => {
  assert.deepEqual(parseLiveKitNetworkCampaignArgs([
    '--input', '/runtime/input.json',
    '--profile', '/runtime/profile.json',
    '--result-dir', '/runtime/results',
    '--namespace-ordinal', '7',
    '--livekit-port', '7880',
    '--binary-version', 'ivekit-browser-capacity@1.5.0'
  ]), {
    input_path: '/runtime/input.json',
    profile_path: '/runtime/profile.json',
    result_directory: '/runtime/results',
    namespace_ordinal: 7,
    livekit_port: 7880,
    binary_version: 'ivekit-browser-capacity@1.5.0'
  });
});

test('reserves a private namespace attestation artifact in every campaign bundle', () => {
  assert.equal(
    buildLiveKitNetworkCampaignPaths('/runtime/results').networkPathAttestation,
    '/runtime/results/network-path-attestation.json'
  );
});

test('rejects relative paths, unknown options and unsafe namespace ordinals', () => {
  assert.throws(() => parseLiveKitNetworkCampaignArgs([
    '--input', 'input.json',
    '--profile', '/runtime/profile.json',
    '--result-dir', '/runtime/results',
    '--namespace-ordinal', '0',
    '--livekit-port', '7880',
    '--binary-version', 'ivekit-browser-capacity@1.5.0'
  ]), /absolute path/i);
  assert.throws(() => parseLiveKitNetworkCampaignArgs([
    '--input', '/runtime/input.json',
    '--profile', '/runtime/profile.json',
    '--result-dir', '/runtime/results',
    '--namespace-ordinal', '200',
    '--livekit-port', '7880',
    '--unknown', 'value'
  ]), /unknown|ordinal/i);
});
