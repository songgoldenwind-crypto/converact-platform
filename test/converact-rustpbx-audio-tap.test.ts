import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-realtime-audio-tap.patch';
const patch = readFileSync(PATCH_PATH, 'utf8');
const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

function addedSource(): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('RustPBX realtime audio tap is bounded and cannot backpressure media', () => {
  const source = addedSource();
  const captureBody = source.match(
    /pub fn try_capture[\s\S]*?\n    }\n\n    pub fn dropped_frames/
  )?.[0] || '';

  assert.match(source, /mpsc::channel\(config\.channel_capacity\)/);
  assert.match(captureBody, /self\.tx\.try_send\(frame\)/);
  assert.doesNotMatch(captureBody, /\.await/);
  assert.match(source, /TrySendError::Full/);
  assert.match(source, /TrySendError::Closed/);
  assert.match(source, /full_audio_tap_queue_does_not_block_bridge_forwarding/);
  assert.match(source, /audio_tap_full_channel_does_not_block_media/);
});

test('RustPBX realtime audio tap emits negotiated speech PCM without DTMF', () => {
  const source = addedSource();

  assert.match(source, /AUDIO_TAP_SAMPLE_RATE: u32 = 16_000/);
  assert.match(source, /DecoderState::new\(input\.codec\)/);
  assert.match(source, /frame\.payload_type != Some\(input\.audio_payload_type\)/);
  assert.match(source, /source_codec: source_audio\.codec/);
  assert.match(source, /audio_payload_type: profile\.source_pt/);
  assert.match(source, /Leg::A => 0/);
  assert.match(source, /Leg::B => 1/);
  assert.match(source, /pcmu_decoder_normalizes_to_pcm16_16khz/);
  assert.match(source, /audio_tap_capture\.is_none\(\)/);
});

test('RustPBX realtime audio tap trusts only the routed short-lived token', () => {
  const source = addedSource();

  assert.match(source, /AUDIO_TAP_TOKEN_HEADER: &str = "x-ivekit-audio-tap-token"/);
  assert.match(source, /context\.dialplan\.routed_headers\.as_deref\(\)/);
  assert.match(source, /AudioTapAuthorizationError::Missing/);
  assert.match(source, /AudioTapAuthorizationError::Invalid/);
  assert.match(source, /Some\(&authorization\.token\)/);
  assert.match(source, /UnixStream::connect\(Path::new\(&config\.socket_path\)\)/);
  assert.match(source, /socket\.write_all\(&header\)\.await/);
  assert.match(source, /socket\.write_all\(payload\)\.await/);
  assert.match(source, /stream_frame_prefix_is_big_endian_payload_length/);
  assert.match(source, /audio_tap_token: Option<String>/);
  assert.match(source, /attach_audio_tap_token\(&mut result, audio_tap_token\)/);
  assert.match(source, /audio_tap_snapshot_token_validation_degrades_closed/);
  assert.doesNotMatch(source, /reqwest|sqlx|object_store|nats::/);
});

test('RustPBX reproducible build applies the realtime audio tap before HTTP capacity', () => {
  assert.match(
    build,
    /rustpbx-ivekit-webphone-edge-auth\.patch"[\s\S]*apply --check "\$PATCH_DIR\/rustpbx-ivekit-realtime-audio-tap\.patch"[\s\S]*apply "\$PATCH_DIR\/rustpbx-ivekit-realtime-audio-tap\.patch"[\s\S]*rustpbx-ivekit-http-client-capacity\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.47"/);
});
