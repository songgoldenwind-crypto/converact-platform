import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRustPbxMediaControlProfile
} from '../src/agent-runtime/ivekit/voice/media-control-profile.js';
import type {
  VoiceDeploymentProfile
} from '../src/agent-runtime/ivekit/voice/types.js';

test('RustPBX media profile defaults to the ordinary G.711 relay path', () => {
  assert.deepEqual(resolveRustPbxMediaControlProfile(profile({})), {
    media_profile_id: 'g711-relay-v1'
  });
});

test('RustPBX processing media profile freezes codec pair, payload types, and ptime', () => {
  assert.deepEqual(resolveRustPbxMediaControlProfile(profile({
    media_control_profile: {
      media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
      leg_a_codec: 'PCMU',
      leg_b_codec: 'OPUS',
      leg_a_payload_type: 0,
      leg_b_payload_type: 111,
      packetization_ms: 20
    }
  })), {
    media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
    leg_a_codec: 'PCMU',
    leg_b_codec: 'OPUS',
    leg_a_payload_type: 0,
    leg_b_payload_type: 111,
    packetization_ms: 20
  });
});

test('RustPBX processing media profile fails closed on partial or inconsistent codec facts', () => {
  for (const mediaControlProfile of [
    {
      media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
      leg_a_codec: 'PCMU',
      leg_b_codec: 'OPUS',
      leg_a_payload_type: 0,
      leg_b_payload_type: 111
    },
    {
      media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
      leg_a_codec: 'PCMU',
      leg_b_codec: 'OPUS',
      leg_a_payload_type: 8,
      leg_b_payload_type: 111,
      packetization_ms: 20
    },
    {
      media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
      leg_a_codec: 'OPUS',
      leg_b_codec: 'OPUS',
      leg_a_payload_type: 111,
      leg_b_payload_type: 112,
      packetization_ms: 20
    },
    {
      media_profile_id: 'VOICE-IVR-G711-OPUS-V1',
      leg_a_codec: 'PCMU',
      leg_b_codec: 'PCMA',
      leg_a_payload_type: 0,
      leg_b_payload_type: 8,
      packetization_ms: 20
    },
    {
      media_profile_id: 'unknown-profile'
    }
  ]) {
    assert.throws(
      () => resolveRustPbxMediaControlProfile(profile({
        media_control_profile: mediaControlProfile
      })),
      /voice_media_control_profile_invalid/
    );
  }
});

function profile(config: Record<string, unknown>): VoiceDeploymentProfile {
  return {
    id: 'profile-a',
    tenant_id: 'tenant-a',
    name: 'RustPBX',
    adapter: 'rustpbx',
    status: 'enabled',
    base_url: 'https://rustpbx.internal',
    desired_version: '0.4.11-ivekit',
    config,
    secret_refs: {},
    revision: 1,
    created_by: 'system',
    updated_by: 'system',
    created_at: '2026-07-28T00:00:00.000Z',
    updated_at: '2026-07-28T00:00:00.000Z'
  };
}
