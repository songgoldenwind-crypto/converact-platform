import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const RUSTPBX_COMMIT =
  '6c49ee76baa54fdbf8f98020cc9bee158c7c15de';
const RSIPSTACK_COMMIT =
  '8318e97b1170de4e5245b120afec1cdf53e3d716';
const RUSTRTC_COMMIT =
  '166c6d22984429eb6b509920c14fcd69f974f0b3';
const RTPENGINE_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function contract(): Record<string, any> {
  const schema = json(
    'docs/capacity/schemas/voice-media-goal3.schema.json'
  );
  const document = json(
    'docs/capacity/contracts/voice-media-goal3-v1.json'
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

test('Goal 3 freezes every media orchestration source identity', () => {
  const document = contract();
  assert.deepEqual(document.sources, {
    rustpbx: {
      repository: 'https://github.com/restsend/rustpbx',
      commit: RUSTPBX_COMMIT
    },
    rsipstack: {
      repository: 'https://github.com/restsend/rsipstack',
      commit: RSIPSTACK_COMMIT
    },
    rustrtc: {
      repository: 'https://github.com/restsend/rustrtc',
      commit: RUSTRTC_COMMIT
    },
    rtpengine: {
      repository: 'https://github.com/sipwise/rtpengine',
      commit: RTPENGINE_COMMIT
    }
  });
  assert.deepEqual(document.required_patch_ids, [
    'rustpbx-ivekit-media-control-client-v1',
    'rustpbx-ivekit-media-lifecycle-v1',
    'rustpbx-ivekit-dialog-shadow-v1',
    'rustpbx-ivekit-dialog-recovery-v1',
    'rustpbx-ivekit-dual-leg-cdr-v1',
    'rustpbx-ivekit-cdr-mtls-noop-v1'
  ]);
  assert.ok(document.evidence.required_identity.includes('opc_image_digest'));
  assert.ok(
    document.evidence.required_identity.includes('media_control_image_digest')
  );
});

test('Goal 3 preserves authority and packet-path independence', () => {
  const document = contract();
  assert.equal(document.authority.call_dialog_owner, 'rustpbx');
  assert.equal(document.authority.logical_media_graph_owner, 'rustpbx');
  assert.equal(document.authority.wire_transport_owner, 'rtpengine');
  assert.equal(document.authority.command_authority, 'media_control_agent');
  assert.equal(document.authority.packet_path_remote_dependency, false);
  assert.equal(document.authority.ordinary_profile_sync_shadow_quorum, false);
  assert.equal(document.authority.t1_profile_sync_shadow_quorum, true);
});

test('Goal 3 covers the complete SIP and media lifecycle', () => {
  const document = contract();
  assert.deepEqual(document.media_actions, [
    'offer',
    'answer',
    'update',
    'delete',
    'query',
    'reconcile',
    'inject_dtmf',
    'media_timeout',
    'drain',
    'owner_takeover'
  ]);
  assert.deepEqual(document.sip_scenarios, [
    'invite',
    '180',
    '183',
    'prack',
    'update',
    '200',
    'ack',
    'cancel',
    '487',
    'bye',
    'reinvite',
    'hold',
    'resume',
    'session_timer'
  ]);
  assert.deepEqual(document.legs, ['caller', 'callee']);
});

test('Goal 3 separates ordinary and T1 availability claims', () => {
  const document = contract();
  const profiles = new Map<string, Record<string, any>>(
    document.profiles.map((profile: Record<string, any>) => [
      profile.profile_id,
      profile
    ])
  );
  assert.equal(profiles.get('voice-ordinary')?.shadow_quorum_required, false);
  assert.equal(
    profiles.get('voice-ordinary')?.rustpbx_failure_media_behavior,
    'continue_media_control_recovery_required'
  );
  assert.equal(profiles.get('voice-ha-t1')?.shadow_quorum_required, true);
  assert.equal(profiles.get('voice-ha-t1')?.takeover_rto_target_ms, 5_000);
  assert.equal(profiles.get('voice-ha-t1')?.shadow_fault_domains, 2);
});

test('Goal 3 failure contract keeps established media independent', () => {
  const document = contract();
  const failures = new Map<string, Record<string, any>>(
    document.failure_matrix.map((failure: Record<string, any>) => [
      failure.failure_id,
      failure
    ])
  );
  const required = [
    'unknown-command-outcome',
    'stale-owner-epoch',
    'command-sequence-gap',
    'media-capacity-rejected',
    'media-control-restart',
    'rustpbx-owner-restart',
    'rtpengine-restart',
    'shadow-quorum-unavailable',
    'postgres-unavailable',
    'nats-unavailable',
    'recorder-unavailable',
    'object-storage-unavailable'
  ];
  for (const failureId of required) assert.ok(failures.has(failureId), failureId);
  for (const failureId of [
    'unknown-command-outcome',
    'stale-owner-epoch',
    'command-sequence-gap',
    'media-capacity-rejected',
    'media-control-restart',
    'rustpbx-owner-restart',
    'shadow-quorum-unavailable',
    'postgres-unavailable',
    'nats-unavailable',
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
    failures.get('rtpengine-restart')?.established_media,
    'interrupt_visible'
  );
});

test('Goal 3 starts with honest verification and no capacity claim', () => {
  const document = contract();
  assert.equal(document.evidence.retain_invalid_attempts, true);
  assert.equal(document.evidence.forbid_secret_material, true);
  assert.deepEqual(document.evidence.required_identity, [
    'rustpbx_commit',
    'rsipstack_commit',
    'rustrtc_commit',
    'rtpengine_commit',
    'rustpbx_patch_set_sha256',
    'rtpengine_patch_set_sha256',
    'opc_image_digest',
    'media_control_image_digest',
    'rustpbx_image_digest',
    'rtpengine_image_digest',
    'runtime_config_sha256',
    'host_kernel'
  ]);
  for (const [key, value] of Object.entries(document.verification)) {
    assert.equal(value, 'not_run', key);
  }
  assert.equal(document.claim.functional, 'not_run');
  assert.equal(document.claim.production, 'not_run');
  assert.equal(document.claim.benchmark, 'not_run');
  assert.equal(document.claim.capacity_claim, 'none');
});
