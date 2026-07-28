import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const RUSTPBX_COMMIT =
  '6c49ee76baa54fdbf8f98020cc9bee158c7c15de';
const RUSTRTC_COMMIT =
  '166c6d22984429eb6b509920c14fcd69f974f0b3';
const RTPENGINE_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function validator(schemaPath: string): ReturnType<Ajv2020['compile']> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === value;
    }
  });
  return ajv.compile(json(schemaPath));
}

function validated(
  schemaPath: string,
  documentPath: string
): Record<string, any> {
  const document = json(documentPath);
  const validate = validator(schemaPath);
  assert.equal(
    validate(document),
    true,
    validate.errors?.map((error) =>
      `${error.instancePath || '/'} ${error.message}`
    ).join('\n')
  );
  return document;
}

function contract(): Record<string, any> {
  return validated(
    'docs/capacity/schemas/voice-media-goal4.schema.json',
    'docs/capacity/contracts/voice-media-goal4-v1.json'
  );
}

function profile(): Record<string, any> {
  return validated(
    'docs/capacity/schemas/voice-media-processing-profile.schema.json',
    'docs/capacity/profiles/vos-eq-v3-g711-opus-1k-v1.json'
  );
}

test('Goal 4 freezes the processing source and authority boundary', () => {
  const document = contract();
  assert.deepEqual(document.sources, {
    rustpbx: {
      repository: 'https://github.com/restsend/rustpbx',
      commit: RUSTPBX_COMMIT
    },
    rustrtc: {
      repository: 'https://github.com/restsend/rustrtc',
      commit: RUSTRTC_COMMIT
    },
    rtpengine: {
      repository: 'https://github.com/sipwise/rtpengine',
      commit: RTPENGINE_COMMIT
    },
    audio_codec: {
      crate: 'audio-codec',
      version: '0.3.40'
    },
    processing_service: {
      path: 'services/voice-media-rs',
      version: '0.2.0'
    }
  });
  assert.equal(document.authority.call_dialog_owner, 'rustpbx');
  assert.equal(document.authority.fast_path_owner, 'rtpengine');
  assert.equal(document.authority.processing_owner, 'voice-media-rs');
  assert.equal(document.authority.packet_path_remote_dependency, false);
  assert.equal(document.authority.ordinary_relay_enters_processing_pool, false);
});

test('Goal 4 freezes the first directed codec-pair slice', () => {
  const document = contract();
  const slice = document.codec_slices.find(
    (entry: Record<string, any>) => entry.slice_id === 'g711-opus-v1'
  );
  assert.ok(slice);
  assert.deepEqual(slice.codecs, ['PCMU', 'PCMA', 'OPUS']);
  assert.deepEqual(slice.packetization_ms, [20]);
  assert.deepEqual(slice.codec_pairs, [
    'PCMU_TO_PCMA',
    'PCMA_TO_PCMU',
    'PCMU_TO_OPUS',
    'OPUS_TO_PCMU',
    'PCMA_TO_OPUS',
    'OPUS_TO_PCMA'
  ]);
  assert.equal(slice.capacity_profile_id, 'vos-eq-v3-g711-opus-1k-v1');
  assert.equal(slice.verification, 'not_run');
});

test('Goal 4 makes every realtime queue and codec slot bounded', () => {
  const runtime = contract().processing_runtime;
  assert.equal(runtime.codec_pair_slots_bounded, true);
  assert.equal(runtime.rtp_receive_queue_bounded, true);
  assert.equal(runtime.jitter_buffer_bounded, true);
  assert.equal(runtime.playback_queue_bounded, true);
  assert.equal(runtime.event_queue_bounded, true);
  assert.equal(runtime.unknown_codec_fail_closed, true);
  assert.equal(runtime.cross_pair_slot_borrowing, false);
  assert.equal(runtime.control_plane_failure_established_media, 'continue');
});

test('Goal 4 metric labels are bounded and reject interaction identity', () => {
  const metrics = contract().metrics;
  assert.deepEqual(metrics.allowed_labels, [
    'codec_pair',
    'direction',
    'profile',
    'result',
    'failure_stage',
    'runtime_mode'
  ]);
  for (const forbidden of [
    'tenant_id',
    'call_id',
    'leg_id',
    'reservation_id',
    'phone_number',
    'ssrc'
  ]) {
    assert.ok(metrics.forbidden_labels.includes(forbidden), forbidden);
    assert.ok(!metrics.allowed_labels.includes(forbidden), forbidden);
  }
});

test('Goal 4 profile binds a separate generator and 1K processing target', () => {
  const document = profile();
  assert.equal(document.primary_sut.role, 'processing');
  assert.equal(document.primary_sut.component_id, 'voice-media-rs');
  assert.equal(document.workload.active_processing_sessions, 1_000);
  assert.equal(document.workload.rtp_legs, 2_000);
  assert.equal(document.workload.packetization_ms, 20);
  assert.equal(document.workload.transcoding, true);
  assert.equal(document.generator.separate_from_sut, true);
  assert.equal(document.generator.minimum_nodes, 2);
  assert.equal(document.generator.maximum_cpu_utilization_ratio, 0.7);
  assert.equal(document.thresholds.processing_latency_p99_ms, 10);
  assert.equal(document.thresholds.server_packet_loss_ratio, 0.001);
  assert.equal(document.thresholds.unexpected_ordinary_relay_termination_count, 0);
});

test('Goal 4 failure matrix isolates ordinary relay from processing failures', () => {
  const failures = new Map<string, Record<string, any>>(
    contract().failure_matrix.map((entry: Record<string, any>) => [
      entry.failure_id,
      entry
    ])
  );
  for (const id of [
    'processing-capacity-exhausted',
    'processing-control-unavailable',
    'processing-worker-restart',
    'postgres-unavailable',
    'nats-unavailable',
    'recorder-unavailable',
    'object-storage-unavailable'
  ]) {
    assert.ok(failures.has(id), id);
    assert.equal(failures.get(id)?.ordinary_relay, 'continue', id);
  }
  assert.equal(
    failures.get('processing-capacity-exhausted')?.new_processing_admission,
    'reject'
  );
});

test('Goal 4 starts with no functional or capacity claim', () => {
  const document = contract();
  for (const [key, value] of Object.entries(document.verification)) {
    assert.equal(value, 'not_run', key);
  }
  assert.deepEqual(document.claim, {
    functional: 'not_run',
    production: 'not_run',
    benchmark: 'not_run',
    capacity_claim: 'none',
    production_eligible: false
  });
  assert.equal(profile().claim.capacity_claim, 'none');
});
