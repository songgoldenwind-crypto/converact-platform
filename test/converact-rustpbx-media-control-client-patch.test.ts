import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-media-control-client.patch';

test('RustPBX media-control client patch is ordered and exact-source applicable', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

  assert.equal(
    spawnSync('git', ['apply', '--numstat', PATCH_PATH]).status,
    0
  );
  assert.match(
    build,
    /rustpbx-ivekit-http-client-capacity\.patch"[\s\S]*rustpbx-ivekit-media-control-client\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.73"/);
  assert.match(patch, /pub mod ivekit_media_control/);
  assert.match(patch, /src\/ivekit_media_control\.rs/);
  assert.match(patch, /ivekit\.media-control\.v1/);
  assert.match(patch, /MediaControlClient/);
});

test('RustPBX media-control client fails closed at bounded local boundaries', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8');
  const effective = patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');

  assert.match(effective, /Semaphore/);
  assert.match(effective, /try_acquire_owned/);
  assert.match(effective, /max_inflight/);
  assert.match(effective, /max_response_bytes/);
  assert.match(effective, /request_timeout/);
  assert.match(effective, /bytes_stream/);
  assert.match(effective, /response_too_large/);
  assert.match(effective, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(effective, /SecondsFormat::Millis/);
  assert.match(effective, /production.*HTTPS|production_requires_https/);
  assert.match(effective, /Identity::from_pem/);
  assert.match(effective, /Certificate::from_pem/);
  assert.match(effective, /service_token_file/);
  assert.match(effective, /reject_symlink/);
  assert.doesNotMatch(effective, /Authorization.*tracing|service_token.*debug/);
  assert.doesNotMatch(
    effective,
    /forwarding_track\.rs|rtc_track\.rs|RtpPacket|media\/engine/
  );
});

test('RustPBX media-control client preserves command and uncertainty semantics', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8');
  const effective = patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');

  assert.match(effective, /owner_epoch/);
  assert.match(effective, /command_sequence/);
  assert.match(effective, /admission_reservation_id/);
  assert.match(effective, /media_reservation_id/);
  assert.match(effective, /idempotency_key/);
  assert.match(effective, /payload_hash/);
  assert.match(effective, /canonical_json/);
  assert.match(effective, /command_id_for/);
  assert.match(effective, /Unknown/);
  assert.match(effective, /unknown_after_transport_failure/);
  assert.match(effective, /rejected_before_transport/);
  assert.match(effective, /cross_language_command_id_vector/);
  assert.match(effective, /response_limit_is_enforced_incrementally/);
  assert.match(effective, /production_rejects_plain_http/);
  assert.match(effective, /inflight_limit_rejects_before_transport/);
  assert.match(
    effective,
    /malformed_rejection_is_not_projected_as_deterministic/
  );
});

test('RustPBX deployment examples remain on qualified ivekit.40', () => {
  for (const path of [
    'infra/env.example',
    'infra/converact/env.example',
    'services/converact-service/env.example'
  ]) {
    assert.match(
      readFileSync(path, 'utf8'),
      /RUSTPBX_IMAGE=ghcr\.io\/songgoldenwind-crypto\/converact-rustpbx:0\.4\.11-ivekit\.40-6c49ee76/,
      path
    );
  }
});

test('RustPBX media tracing patch follows dual-leg CDR and is exact-source applicable', () => {
  const tracingPatchPath =
    'infra/converact/rustpbx/patches/rustpbx-ivekit-media-tracing.patch';
  const tracingPatch = readFileSync(tracingPatchPath, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

  assert.equal(
    spawnSync('git', ['apply', '--numstat', tracingPatchPath]).status,
    0
  );
  assert.match(
    build,
    /rustpbx-ivekit-dual-leg-cdr\.patch"[\s\S]*rustpbx-ivekit-cdr-mtls-noop\.patch"[\s\S]*rustpbx-ivekit-media-tracing\.patch"/
  );
  assert.match(tracingPatch, /trace_sample_ratio/);
  assert.match(tracingPatch, /traceparent/);
});
