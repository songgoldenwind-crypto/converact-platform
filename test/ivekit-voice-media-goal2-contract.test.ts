import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const RTPENGINE_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';
const RTPENGINE_ARCHIVE_SHA256 =
  'a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143';

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function contract(): Record<string, any> {
  const schema = json(
    'docs/capacity/schemas/voice-media-goal2.schema.json'
  );
  const document = json(
    'docs/capacity/contracts/voice-media-goal2-v1.json'
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === value;
    }
  });
  const validate = ajv.compile(schema);
  assert.equal(
    validate(document),
    true,
    ajv.errorsText(validate.errors, { separator: '\n' })
  );
  return document;
}

test('Goal 2 freezes exact RTPengine source and patch identities', () => {
  const document = contract();
  assert.equal(document.source.version, 'mr26.0.1.13');
  assert.equal(document.source.commit, RTPENGINE_COMMIT);
  assert.equal(document.source.archive_sha256, RTPENGINE_ARCHIVE_SHA256);
  assert.equal(document.source.archive_size_bytes, 6_987_926);
  assert.deepEqual(
    document.source.required_patch_ids,
    [
      'rtpengine-tcp-ng-bounded-frame-v1',
      'rtpengine-ivekit-owner-fence-v1',
      'rtpengine-ivekit-drain-capacity-v1',
      'rtpengine-ivekit-low-cardinality-metrics-v1'
    ]
  );
});

test('Goal 2 maps every media-control action without weakening authority', () => {
  const document = contract();
  assert.equal(document.authority.call_dialog_owner, 'rustpbx');
  assert.equal(document.authority.wire_transport_owner, 'rtpengine');
  assert.equal(document.authority.command_authority, 'media_control_agent');
  assert.equal(document.authority.packet_path_remote_dependency, false);

  const mappings = new Map<string, Record<string, any>>(
    document.actions.map((item: Record<string, any>) => [
      item.action,
      item
    ])
  );
  const expected: Record<string, string> = {
    offer: 'offer',
    answer: 'answer',
    update: 'offer_or_answer',
    delete: 'delete',
    query: 'query',
    block_media: 'block media',
    unblock_media: 'unblock media',
    start_forward: 'start forwarding',
    stop_forward: 'stop forwarding',
    start_recording_fork: 'start recording',
    stop_recording_fork: 'stop recording',
    play_media: 'play media',
    stop_media: 'stop media',
    inject_dtmf: 'play DTMF',
    subscribe_quality: 'query',
    drain_node: 'ivekit drain'
  };
  assert.equal(mappings.size, Object.keys(expected).length);
  for (const [action, command] of Object.entries(expected)) {
    const mapping = mappings.get(action);
    assert.ok(mapping, action);
    assert.equal(mapping.rtpengine_command, command, action);
  }
});

test('Goal 2 separates runtime modes and capacity claims', () => {
  const document = contract();
  const modes = new Map<string, Record<string, any>>(
    document.runtime_modes.map((item: Record<string, any>) => [
      item.mode,
      item
    ])
  );
  assert.equal(modes.get('userspace')?.capacity_profile, 'distinct');
  assert.equal(modes.get('kernel')?.requires_module_identity, true);
  assert.equal(modes.get('recording')?.capacity_profile, 'distinct');
  assert.equal(modes.get('transcoding')?.capacity_profile, 'distinct');
  assert.equal(document.claim.benchmark, 'not_run');
  assert.equal(document.claim.capacity_claim, 'none');
  assert.equal(document.claim.production_eligible, false);
});

test('Goal 2 failure contract preserves established media where required', () => {
  const document = contract();
  const failures = new Map<string, Record<string, any>>(
    document.failure_matrix.map((item: Record<string, any>) => [
      item.failure_id,
      item
    ])
  );
  for (const failureId of [
    'stale-owner-epoch',
    'command-replay',
    'before-apply-timeout',
    'after-apply-disconnect',
    'media-control-restart',
    'cell-admission-unavailable',
    'postgres-unavailable',
    'recorder-unavailable',
    'object-storage-unavailable',
    'rtpengine-unavailable',
    'kernel-unavailable',
    'load-generator-exhausted'
  ]) {
    assert.ok(failures.has(failureId), failureId);
  }
  for (const failureId of [
    'media-control-restart',
    'cell-admission-unavailable',
    'postgres-unavailable',
    'recorder-unavailable',
    'object-storage-unavailable'
  ]) {
    assert.equal(
      failures.get(failureId)?.established_media,
      'continue',
      failureId
    );
  }
  assert.equal(
    failures.get('rtpengine-unavailable')?.established_media,
    'interrupt_visible'
  );
  assert.equal(
    failures.get('load-generator-exhausted')?.claim_effect,
    'invalid_generator_capacity'
  );
});

test('Goal 2 requires bounded evidence and honest verification states', () => {
  const document = contract();
  assert.deepEqual(document.evidence.required_identity, [
    'source_archive_sha256',
    'source_commit',
    'patch_set_sha256',
    'builder_image_digest',
    'runtime_image_digest',
    'runtime_config_sha256',
    'host_kernel',
    'kernel_module_sha256'
  ]);
  assert.equal(document.evidence.retain_invalid_attempts, true);
  assert.equal(document.evidence.forbid_secret_material, true);
  assert.equal(document.verification.source_identity, 'passed');
  for (const key of [
    'patch_apply',
    'compile',
    'unit',
    'integration',
    'real_environment',
    'benchmark'
  ]) {
    assert.equal(document.verification[key], 'not_run', key);
  }
});
