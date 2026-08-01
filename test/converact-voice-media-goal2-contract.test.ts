import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const RTPENGINE_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';
const RTPENGINE_ARCHIVE_SHA256 =
  'a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143';
const RTPENGINE_PATCH_SET_SHA256 =
  '51f842076f044d5d914ef8f89ad0a72a9ab1e6a2d26ee5899a5e457d09efd0f3';

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
  assert.equal(
    document.source.source_lock_path,
    'infra/converact/rtpengine/source-lock.json'
  );
  assert.equal(
    document.source.patch_set_id,
    'ivekit-rtpengine-mr26.0.1.13.2'
  );
  assert.equal(document.source.patch_set_sha256, RTPENGINE_PATCH_SET_SHA256);
  assert.deepEqual(
    document.source.required_patch_ids,
    [
      'rtpengine-tcp-ng-bounded-frame-v1',
      'rtpengine-ivekit-owner-fence-v1',
      'rtpengine-ivekit-drain-capacity-v1',
      'rtpengine-ivekit-low-cardinality-metrics-v1',
      'rtpengine-ivekit-durable-replay-v1'
    ]
  );

  const lock = json(document.source.source_lock_path);
  assert.equal(lock.patch_set.id, document.source.patch_set_id);
  assert.deepEqual(
    lock.patch_set.patches.map((entry: Record<string, any>) => entry.id),
    document.source.required_patch_ids
  );
  const hash = createHash('sha256');
  for (const patch of lock.patch_set.patches) {
    hash.update(`${patch.id}\0${patch.path}\0`);
    hash.update(readFileSync(`infra/converact/rtpengine/${patch.path}`));
    hash.update('\0');
  }
  assert.equal(hash.digest('hex'), document.source.patch_set_sha256);
});

test('Goal 2 maps every media-control action without weakening authority', () => {
  const document = contract();
  assert.equal(document.authority.call_dialog_owner, 'rustpbx');
  assert.equal(document.authority.media_plan_owner, 'rustpbx');
  assert.equal(
    document.authority.edge_binding_authority,
    'rustpbx_media_engine_facade'
  );
  assert.equal(document.authority.writer_scope, 'directed_media_edge');
  assert.equal(
    document.authority.ordinary_edge_runtime_default,
    'rtpengine'
  );
  assert.equal(
    document.authority.command_authority,
    'rustpbx_media_engine_facade'
  );
  assert.equal(document.authority.packet_path_remote_dependency, false);
  assert.deepEqual(document.edge_command_identity.required_fields, [
    'media_plan_id',
    'media_plan_revision',
    'edge_id',
    'edge_generation',
    'binding_revision',
    'binding_group_id',
    'binding_group_generation',
    'flow_selector',
    'backend_id',
    'writer_fence'
  ]);
  assert.equal(
    document.edge_command_identity.duplex_model,
    'two_independent_directed_edges'
  );
  assert.equal(
    document.edge_command_identity.active_writer_limit_per_edge,
    1
  );
  assert.equal(document.edge_command_identity.prepared_edge_can_emit, false);
  assert.equal(
    document.edge_command_identity.handoff_writer_overlap_allowed,
    false
  );
  assert.equal(
    document.edge_command_identity.logical_release_scope,
    'directed_media_edge_generation_detach'
  );
  assert.equal(
    document.edge_command_identity.physical_release_scope,
    'backend_binding_group_generation_atomic_zero_live_ref'
  );
  assert.equal(
    document.binding_group_model.physical_authority_unit,
    'backend_binding_group_generation'
  );
  assert.equal(
    document.binding_group_model.effective_sdp_scope,
    'wire_transport_bundle'
  );
  assert.equal(
    document.binding_group_model.edge_release,
    'detach_membership_and_decrement_refcount'
  );
  assert.equal(
    document.binding_group_model.physical_release,
    'atomic_delete_once_at_zero_live_member_ref'
  );
  assert.equal(
    document.binding_group_model.edge_binding_cardinality,
    'each_edge_generation_binding_maps_to_exactly_one_group_flow'
  );
  assert.equal(
    document.binding_group_model.reverse_mapping_rule,
    'group_member_set_exactly_matches_forward_edge_bindings'
  );
  assert.equal(
    document.binding_group_model.orphan_edge_or_group_members_allowed,
    false
  );
  assert.equal(
    document.binding_group_model.group_backend_instance_rule,
    'exactly_one_backend_instance_per_generation'
  );
  assert.equal(
    document.binding_group_model.live_member_refcount_matches_bound_edges,
    true
  );
  assert.ok(
    document.binding_group_model.member_identity_fields.includes(
      'flow_selector'
    )
  );
  assert.equal(
    document.binding_group_model.group_membership_rule,
    'immutable_within_generation_change_requires_new_generation'
  );
  assert.equal(
    document.binding_group_model.packet_lookup_rule,
    'precompiled_flow_selector_to_edge_binding_O1_no_member_scan'
  );
  assert.equal(
    document.binding_group_model.security_persistence_rule,
    'raw_srtp_keys_forbidden_persist_references_states_and_digests_only'
  );
  assert.equal(
    document.binding_lifecycle_protocol.required_future_patch_status,
    'not_present'
  );
  assert.equal(
    document.binding_lifecycle_protocol.required_future_patch_verification,
    'not_run'
  );
  assert.ok(
    !document.source.required_patch_ids.includes(
      document.binding_lifecycle_protocol.required_future_patch_id
    )
  );
  assert.equal(
    document.binding_lifecycle_protocol.stock_ng_atomicity_assumed,
    false
  );
  assert.deepEqual(
    document.binding_lifecycle_protocol.required_operations.map(
      (entry: Record<string, any>) => entry.operation
    ),
    ['prepare', 'commit', 'abort', 'revoke', 'query', 'reconcile']
  );
  assert.deepEqual(document.binding_lifecycle_protocol.states, [
    'absent',
    'prepared_blocked',
    'active',
    'revoked_receive_only',
    'released',
    'unknown'
  ]);
  for (const forbidden of [
    'offer_then_block_media_as_prepare',
    'prepared_blocked_to_emit_without_commit',
    'active_to_released_via_abort',
    'unknown_to_new_allocation',
    'revoked_generation_to_active'
  ]) {
    assert.ok(
      document.binding_lifecycle_protocol.forbidden_transitions.includes(
        forbidden
      ),
      forbidden
    );
  }
  assert.equal(document.handoff_policy.outbound_writer_overlap_allowed, false);
  assert.equal(
    document.handoff_policy.inbound_read_only_dual_receive_grace_allowed,
    true
  );
  assert.equal(
    document.handoff_policy.profile_path,
    'docs/capacity/profiles/vos-eq-v1-rtp-10k-v1.json'
  );
  assert.equal(document.handoff_policy.zero_packet_loss_claim, false);
  assert.equal(document.handoff_policy.inbound_grace_ms_target, 500);
  assert.equal(document.handoff_policy.handoff_rto_ms_target, 5000);
  assert.equal(document.handoff_policy.max_writer_gap_ms_target, 100);
  assert.equal(
    document.handoff_policy.max_migration_loss_ratio_target,
    0.001
  );
  assert.equal(document.handoff_policy.target_verification, 'not_run');
  assert.equal(
    document.handoff_policy.old_generation_grace_behavior,
    'authenticate_count_drop_only_no_forward_dtmf_recording_or_ai'
  );
  const handoffProfile = json(document.handoff_policy.profile_path);
  assert.equal(
    handoffProfile.handoff.inbound_grace_ms,
    document.handoff_policy.inbound_grace_ms_target
  );
  assert.equal(
    handoffProfile.handoff.handoff_rto_ms,
    document.handoff_policy.handoff_rto_ms_target
  );
  assert.equal(
    handoffProfile.handoff.max_writer_gap_ms,
    document.handoff_policy.max_writer_gap_ms_target
  );
  assert.equal(
    handoffProfile.handoff.max_migration_loss_ratio,
    document.handoff_policy.max_migration_loss_ratio_target
  );
  assert.equal(
    document.planning_sequence.preparation_prefix[0],
    'draft_graph_validated'
  );
  assert.equal(
    document.planning_sequence.preparation_prefix[3],
    'backend_specific_capacity_reserved'
  );
  assert.equal(
    document.planning_sequence.candidate_sdp_visibility_is_writer_commit,
    false
  );
  assert.deepEqual(
    document.planning_sequence.active_migration_suffix.slice(3, 5),
    [
      'revoke_old_writer_and_wait_zero_output_ack',
      'commit_new_group_and_record_writer_gap'
    ]
  );
  const migrationSteps =
    document.planning_sequence.active_migration_suffix as string[];
  assert.ok(
    migrationSteps.indexOf('revoke_old_writer_and_wait_zero_output_ack') <
      migrationSteps.indexOf('commit_new_group_and_record_writer_gap')
  );
  const initialSteps =
    document.planning_sequence.initial_admission_suffix as string[];
  assert.ok(
    initialSteps.indexOf('mark_committed_after_all_required_acks') <
      initialSteps.indexOf('expose_initial_effective_sdp')
  );
  assert.equal(
    document.planning_sequence.pre_decision_failure,
    'abort_prepared_groups_reverse_order_then_cancel_reservations'
  );
  assert.equal(
    document.planning_sequence.post_decision_partial_commit_failure,
    'decision_immutable_query_reconcile_then_predeclared_compensation_to_compensated_failed'
  );

  const mappings = new Map<string, Record<string, any>>(
    document.actions.map((item: Record<string, any>) => [
      item.action,
      item
    ])
  );
  const expected: Record<string, string> = {
    prepare_binding_group: 'ivekit prepare',
    commit_binding_group: 'ivekit commit',
    abort_binding_group: 'ivekit abort',
    revoke_binding_group: 'ivekit revoke',
    reconcile_binding_group: 'query then durable reconcile',
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
  for (const blocker of [
    'atomic-binding-lifecycle-not-run',
    'precommit-zero-egress-not-run',
    'post-revoke-zero-egress-not-run',
    'active-handoff-not-run'
  ]) {
    assert.ok(document.claim.blocking_reasons.includes(blocker), blocker);
  }
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
